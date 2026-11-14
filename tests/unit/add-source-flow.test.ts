import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { SourceActions, TEPHRA_NOT_RUNNING, type SourceActionsConnection } from "../../src/source-actions";
import type { TephraCallResult, TephraSource } from "../../src/tephra-client";
import type { TephraSnapshot } from "../../src/tephra-connection";
import { button, flush, inputEl, key, messageEl, modals, type } from "../helpers";

/** A scripted Tephra: records every call and plays the replies a test queues per method. */
function fakeConnection(sources: TephraSource[] = [{ name: "notes", path: "/vault", status: "online" }, { name: "tephra", path: "/dev/Tephra", status: "online" }]) {
	const calls: { method: string; params: unknown }[] = [];
	const replies = new Map<string, (() => Promise<TephraCallResult>)[]>();
	const state = { snapshot: { state: "online", checked: true, sources, error: null } as TephraSnapshot, checks: 0 };
	const connection: SourceActionsConnection = {
		getSnapshot: () => state.snapshot,
		call: async (method, params) => {
			calls.push({ method, params });
			const next = replies.get(method)?.shift();
			return next ? next() : { ok: true, result: null };
		},
		requestCheck: () => void state.checks++,
	};
	const script = (method: string, ...answers: (TephraCallResult | (() => Promise<TephraCallResult>))[]) =>
		replies.set(method, answers.map((a) => (typeof a === "function" ? a : () => Promise.resolve(a))));
	return { connection, calls, script, state, registerCalls: () => calls.filter((c) => c.method === "source.register") };
}

const rpcError = (message: string): TephraCallResult => ({ ok: false, error: { kind: "rpc", message: `Tephra error: ${message}`, code: -32000 } });
const timeout: TephraCallResult = { ok: false, error: { kind: "timeout", message: "Tephra did not answer in time" } };
const down: TephraCallResult = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };

const VAULT = "/Users/dan/Vault";

function build(over: { connection?: SourceActionsConnection | null; picked?: string | null; sourcesEntries?: string[]; existing?: string[]; realpaths?: Record<string, string>; pickerThrows?: boolean } = {}) {
	const fake = fakeConnection();
	const notices: string[] = [];
	const pickFolder = vi.fn(async () => {
		if (over.pickerThrows) throw new Error("no picker");
		return over.picked === undefined ? "/Users/dan/Documents/Whoop" : over.picked;
	});
	const lstat = vi.fn(async (path: string) => {
		const name = path.slice(`${VAULT}/Sources/`.length);
		if (!(over.existing ?? []).some((e) => e.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return { isSymbolicLink: () => false, isDirectory: () => true };
	});
	const readdir = vi.fn(async () => {
		if (!over.sourcesEntries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return over.sourcesEntries;
	});
	const removeSource = vi.fn(async () => "unlinked" as const);
	const actions = new SourceActions({
		app: new App() as never,
		getConnection: () => (over.connection === undefined ? fake.connection : over.connection),
		pickFolder,
		getVaultPath: () => VAULT,
		fs: { lstat, readdir } as never,
		realpath: async (path) => over.realpaths?.[path] ?? path,
		sourcesFolder: { removeSource },
		confirm: () => {},
		notify: (message) => void notices.push(message),
	});
	return { ...fake, actions, notices, pickFolder, lstat, readdir, removeSource };
}

/** Starts the flow and waits until the name dialog is on screen (or the flow ended without one). */
async function openFlow(h: ReturnType<typeof build>): Promise<{ done: Promise<void> }> {
	const flow = h.actions.addSource();
	await vi.waitFor(() => expect(modals().length > 0 || h.pickFolder.mock.calls.length > 0).toBe(true));
	await flush();
	return { done: flow }; // wrapped: returning the bare promise from an async function would wait for the whole flow
}

afterEach(async () => {
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
});

describe("Add source: the picker (G3)", () => {
	it("cancelling the picker opens no dialog and sends no request", async () => {
		const h = build({ picked: null });
		await h.actions.addSource();
		expect(h.pickFolder).toHaveBeenCalledTimes(1);
		expect(modals()).toHaveLength(0);
		expect(h.calls).toEqual([]);
		expect(h.notices).toEqual([]);
	});

	it("a picker that can't open says so and sends nothing", async () => {
		const h = build({ pickerThrows: true });
		await h.actions.addSource();
		expect(h.notices.join("\n")).toMatch(/couldn't open the folder picker/);
		expect(modals()).toHaveLength(0);
		expect(h.calls).toEqual([]);
	});

	it("Tephra not running: a notice, the picker is never opened and nothing is sent", async () => {
		const h = build();
		h.state.snapshot = { state: "offline", checked: true, sources: [], error: { kind: "network", message: "Tephra is unreachable" } };
		await h.actions.addSource();
		expect(h.notices).toEqual([`Atlas: ${TEPHRA_NOT_RUNNING}.`]);
		expect(h.pickFolder).not.toHaveBeenCalled();
		expect(h.calls).toEqual([]);
	});

	it("no connection at all (the toggle is off): the same refusal, no picker", async () => {
		const h = build({ connection: null });
		await h.actions.addSource();
		expect(h.notices).toEqual([`Atlas: ${TEPHRA_NOT_RUNNING}.`]);
		expect(h.pickFolder).not.toHaveBeenCalled();
	});
});

describe("Add source: folders the vault already holds are refused before any request (E-vault)", () => {
	it.each([
		["a folder inside the vault", `${VAULT}/Projects/Whoop`, /inside the vault/],
		["the vault root itself", VAULT, /the vault itself/],
		["the vault root with a trailing slash", `${VAULT}/`, /the vault itself/],
		["Sources/ itself", `${VAULT}/Sources`, /Sources folder/],
		["a folder under Sources/", `${VAULT}/Sources/whoop/data`, /Sources folder/],
	])("%s", async (_label, picked, reason) => {
		const h = build({ picked });
		await h.actions.addSource();
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toMatch(reason);
		expect(modals()).toHaveLength(0);
		expect(h.calls).toEqual([]);
	});

	it("a folder reached through a link into the vault is refused by its real path", async () => {
		const h = build({ picked: "/tmp/alias-to-vault-notes", realpaths: { "/tmp/alias-to-vault-notes": `${VAULT}/Notes`, [VAULT]: VAULT } });
		await h.actions.addSource();
		expect(h.notices[0]).toMatch(/inside the vault/);
		expect(h.calls).toEqual([]);
	});

	it("when the vault itself is reached through a link (macOS /var vs /private/var), a folder inside it is still refused", async () => {
		const h = build({ picked: "/private/var/v/Vault/Sub", realpaths: { [VAULT]: "/private/var/v/Vault" } });
		await h.actions.addSource();
		expect(h.notices[0]).toMatch(/inside the vault/);
		expect(h.calls).toEqual([]);
	});

	it("a sibling that merely shares the vault's name prefix is fine", async () => {
		const h = build({ picked: `${VAULT}-backup` });
		await openFlow(h);
		expect(modals()).toHaveLength(1);
		expect(h.notices).toEqual([]);
	});
});

describe("Add source: the name dialog (G3)", () => {
	it("is prefilled with the lowercased, dashed base name, green, titled and labelled for adding a source", async () => {
		const h = build({ picked: "/Users/dan/Documents/My Notes" });
		await openFlow(h);
		expect(document.querySelector(".modal-title")!.textContent).toBe("Add source");
		expect(inputEl().value).toBe("my-notes");
		expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
		expect(button("Add").disabled).toBe(false);
	});

	it("Whoop is suggested as whoop", async () => {
		const h = build();
		await openFlow(h);
		expect(inputEl().value).toBe("whoop");
	});

	it("the live check is red with the reason on every keystroke, and confirm stays disabled while it is", async () => {
		const h = build({ sourcesEntries: ["stray-note.md"] });
		await openFlow(h);
		const cases: [string, string][] = [
			["", "Enter a name"],
			["my notes", "A source name can't contain a space"],
			["a/b", 'A source name can\'t contain "/"'],
			["a@b", 'A source name can\'t contain "@"'],
			["who:op", 'A source name can\'t contain ":"'],
			["a*b", 'A source name can\'t contain "*"'],
			["tephra", "A source named tephra already exists"],
			["Tephra", "A source named tephra already exists"],
			["stray-note.md", "Sources/stray-note.md already exists in the vault"],
		];
		for (const [typed, message] of cases) {
			type(typed);
			expect(messageEl().textContent, typed).toBe(message);
			expect(inputEl().classList.contains("atlas-name-invalid"), typed).toBe(true);
			expect(button("Add").disabled, typed).toBe(true);
		}
		type("whoop");
		expect(messageEl().textContent).toBe("");
		expect(button("Add").disabled).toBe(false);
	});

	it("a source registered while the dialog is open turns the name red (the registered names are read live)", async () => {
		const h = build();
		await openFlow(h);
		expect(button("Add").disabled).toBe(false);
		h.state.snapshot = { ...h.state.snapshot, sources: [...h.state.snapshot.sources, { name: "whoop", path: "/x", status: "online" }] };
		type("whoop");
		expect(messageEl().textContent).toBe("A source named whoop already exists");
	});

	it("unicode, an unusable slug (@@@) and a 200+ byte name show as typed and don't crash", async () => {
		for (const [base, valid] of [["Café Œuvre", false], ["@@@", false], ["N".repeat(250), false]] as const) {
			const h = build({ picked: `/Users/dan/${base}` });
			await openFlow(h);
			expect(inputEl().value).toBe(base.toLowerCase().replace(/\s/g, "-"));
			expect(inputEl().classList.contains("atlas-name-valid")).toBe(valid);
			expect(button("Add").disabled).toBe(!valid);
			key("Escape");
			await flush();
		}
	});

	it("an existing entry in Sources/ is checked with lstat when confirming, even if it appeared after the dialog opened", async () => {
		const h = build({ existing: ["whoop"] }); // readdir said nothing was there when the dialog opened
		await openFlow(h);
		key("Enter");
		await flush();
		expect(h.lstat).toHaveBeenCalledWith(`${VAULT}/Sources/whoop`);
		expect(h.registerCalls()).toHaveLength(0);
		expect(messageEl().textContent).toBe("Sources/whoop already exists in the vault");
		expect(modals()).toHaveLength(1);
	});
});

describe("Add source: confirm (G3, E2, E9)", () => {
	it("sends exactly one source.register with {name, root} (the absolute folder path), asks for a check at once and closes", async () => {
		const h = build();
		const flow = await openFlow(h);
		key("Enter");
		await flow.done;
		expect(h.registerCalls()).toEqual([{ method: "source.register", params: { name: "whoop", root: "/Users/dan/Documents/Whoop" } }]);
		expect(h.state.checks).toBe(1);
		expect(modals()).toHaveLength(0);
		expect(h.notices).toEqual([]);
	});

	it("a typed name replaces the suggestion; a trailing slash on the picked path is dropped", async () => {
		const h = build({ picked: "/Users/dan/Documents/Whoop/" });
		const flow = await openFlow(h);
		type("workouts");
		button("Add").click();
		await flow.done;
		expect(h.registerCalls()[0].params).toEqual({ name: "workouts", root: "/Users/dan/Documents/Whoop" });
	});

	it("double-confirm (two clicks, then Enter) gives one request", async () => {
		const h = build();
		let release: (r: TephraCallResult) => void = () => {};
		h.script("source.register", () => new Promise<TephraCallResult>((resolve) => (release = resolve)));
		const flow = await openFlow(h);
		button("Add").click();
		button("Add").click();
		key("Enter");
		await flush();
		expect(h.registerCalls()).toHaveLength(1);
		release({ ok: true, result: null });
		await flow.done;
		expect(h.registerCalls()).toHaveLength(1);
		expect(h.state.checks).toBe(1);
	});

	it("Tephra refusing the name shows its reason, keeps the dialog open with the typed name, shows nothing else and lets the user try again", async () => {
		const h = build();
		h.script("source.register", rpcError("invalid source name: reserved"), { ok: true, result: null });
		const flow = await openFlow(h);
		key("Enter");
		await flush();
		expect(messageEl().textContent).toBe("invalid source name: reserved");
		expect(modals()).toHaveLength(1);
		expect(inputEl().value).toBe("whoop");
		expect(button("Add").disabled).toBe(false);
		expect(h.notices).toEqual([]);
		expect(h.state.checks).toBe(0);

		type("whoop2"); // typing re-runs the live check and clears the reason
		expect(messageEl().textContent).toBe("");
		key("Enter");
		await flow.done;
		expect(h.registerCalls().map((c) => c.params)).toEqual([
			{ name: "whoop", root: "/Users/dan/Documents/Whoop" },
			{ name: "whoop2", root: "/Users/dan/Documents/Whoop" },
		]);
	});

	it("a DuplicateSource race with tephractl shows Tephra's message in the dialog", async () => {
		const h = build();
		h.script("source.register", rpcError("DuplicateSource: a source named whoop already exists"));
		await openFlow(h);
		key("Enter");
		await flush();
		expect(messageEl().textContent).toBe("DuplicateSource: a source named whoop already exists");
		expect(modals()).toHaveLength(1);
	});

	it("E9: a nested folder is sent as is, and Tephra's refusal is shown exactly as returned (Atlas doesn't pre-judge nesting)", async () => {
		const h = build({ picked: "/dev/Tephra/crates" });
		h.script("source.register", rpcError("root /dev/Tephra/crates is inside source tephra"));
		await openFlow(h);
		key("Enter");
		await flush();
		expect(h.registerCalls()).toHaveLength(1);
		expect(messageEl().textContent).toBe("root /dev/Tephra/crates is inside source tephra");
	});

	it("E9: a folder that contains an existing source is also sent, and its success is a success", async () => {
		const h = build({ picked: "/dev" });
		const flow = await openFlow(h);
		key("Enter");
		await flow.done;
		expect(h.registerCalls()).toHaveLength(1);
		expect(h.registerCalls()[0].params).toEqual({ name: "dev", root: "/dev" });
		expect(modals()).toHaveLength(0);
	});

	it("Tephra going away between the check and the click: the dialog stays open and says it isn't running", async () => {
		const h = build();
		h.script("source.register", down);
		await openFlow(h);
		key("Enter");
		await flush();
		expect(messageEl().textContent).toBe(TEPHRA_NOT_RUNNING);
		expect(modals()).toHaveLength(1);
	});

	it("a timeout is not re-sent: source.list is read instead, and a source that is there counts as added", async () => {
		const h = build();
		h.script("source.register", timeout);
		h.script("source.list", { ok: true, result: [{ name: "tephra", path: "/dev/Tephra", status: "active" }, { name: "whoop", path: "/Users/dan/Documents/Whoop", status: "active" }] });
		const flow = await openFlow(h);
		key("Enter");
		await flow.done;
		expect(h.registerCalls()).toHaveLength(1);
		expect(h.calls.map((c) => c.method)).toEqual(["source.register", "source.list"]);
		expect(h.notices).toEqual([]);
		expect(h.state.checks).toBe(1); // the section appears through the normal check
		expect(modals()).toHaveLength(0);
	});

	it("a timeout with no new source in the list says Couldn't confirm whoop was added, and still sends nothing twice", async () => {
		const h = build();
		h.script("source.register", timeout);
		h.script("source.list", { ok: true, result: [{ name: "tephra", path: "/dev/Tephra", status: "active" }] });
		const flow = await openFlow(h);
		key("Enter");
		await flow.done;
		expect(h.registerCalls()).toHaveLength(1);
		expect(h.notices).toEqual(["Atlas: Couldn't confirm whoop was added."]);
		expect(modals()).toHaveLength(0);
	});

	it("a timeout followed by an unreachable source.list also says Couldn't confirm", async () => {
		const h = build();
		h.script("source.register", timeout);
		h.script("source.list", down);
		const flow = await openFlow(h);
		key("Enter");
		await flow.done;
		expect(h.registerCalls()).toHaveLength(1);
		expect(h.notices).toEqual(["Atlas: Couldn't confirm whoop was added."]);
	});

	it("an Add already running ignores a second Add source (one dialog at a time)", async () => {
		const h = build();
		const first = await openFlow(h);
		await h.actions.addSource();
		expect(h.pickFolder).toHaveBeenCalledTimes(1);
		key("Escape");
		await first.done;
	});

	it("Escape cancels: nothing is sent", async () => {
		const h = build();
		const flow = await openFlow(h);
		key("Escape");
		await flow.done;
		expect(h.calls).toEqual([]);
		expect(h.state.checks).toBe(0);
	});
});
