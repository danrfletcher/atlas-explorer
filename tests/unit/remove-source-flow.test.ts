import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../mocks/obsidian";
import { DEFAULT_SETTINGS, showsInSearch, type AtlasSettings } from "../../src/settings";
import { SourceActions } from "../../src/source-actions";
import { SourceDeleteClassifier } from "../../src/source-delete-classifier";
import { vaultExcludeConfig } from "../../src/source-excludes";
import { SourcesFolder } from "../../src/sources-folder";
import { existsOnDisk, nodeSourcesFs, realPath } from "../../src/sources-fs";
import type { SourcesFs } from "../../src/sources-links";
import type { TephraCallResult, TephraSource, TephraSourcesResult } from "../../src/tephra-client";
import { TEPHRA_CHECK_INTERVAL_MS, TephraConnection, type TephraConnectionClient } from "../../src/tephra-connection";
import { inputEl, key, modals } from "../helpers";

/**
 * PR-5 (G5): Remove source, in the order it must happen and with the calls it must never make; and (R3-4) the
 * check that follows an Add or a Remove runs right after Tephra's reply, not at the next 10 s tick.
 */

const NOTES: TephraSource = { name: "notes", path: "/vault", status: "online" };

describe("Remove source: one ordered sequence, and never a delete", () => {
	let tmp: string;
	beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "atlas-remove-flow-"))));
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true }); // only the temp dir this test made
		vi.restoreAllMocks();
	});

	/** A vault with `Sources/whoop` linked to a real folder holding two notes, `SourceActions` over the real `SourcesFolder`. */
	async function build(opts: { unregister?: TephraCallResult; entry?: "link" | "folder" | "foreign-link" } = {}) {
		const vault = join(tmp, "vault");
		const whoop = join(tmp, "Whoop");
		mkdirSync(join(vault, "Sources"), { recursive: true });
		mkdirSync(whoop, { recursive: true });
		writeFileSync(join(whoop, "Workout Plan.md"), "plan");
		writeFileSync(join(whoop, "Leg Day.md"), "legs");
		const entryPath = join(vault, "Sources", "whoop");
		const entry = opts.entry ?? "link";
		if (entry === "folder") {
			mkdirSync(entryPath);
			writeFileSync(join(entryPath, "Mine.md"), "mine");
		} else if (entry === "foreign-link") {
			const elsewhere = join(tmp, "Elsewhere");
			mkdirSync(elsewhere);
			symlinkSync(elsewhere, entryPath, "dir"); // points somewhere else than Whoop and is in no record: not Atlas's
		} else symlinkSync(whoop, entryPath, "dir");

		const log: string[] = []; // one ordered record of everything that touches Tephra or the disk
		const settings: AtlasSettings = {
			...DEFAULT_SETTINGS,
			tephraEnabled: true,
			tephraLinks: entry === "link" ? { whoop } : {},
			tephraExcludes: {},
			tephraSourceSettings: {},
		};
		const fsCalls: { method: string; path: string }[] = [];
		const recordingFs = Object.fromEntries(
			Object.entries(nodeSourcesFs).map(([method, fn]) => [
				method,
				(...args: unknown[]) => {
					fsCalls.push({ method, path: String(args[method === "symlink" ? 1 : 0]) });
					if (method === "unlink") log.push(`unlink ${args[0]}`);
					return (fn as (...a: unknown[]) => unknown)(...args);
				},
			])
		) as unknown as SourcesFs;
		const app = new App();
		const vaultApi = app.vault as unknown as Record<string, unknown>;
		const fileManager = app.fileManager as unknown as Record<string, unknown>;
		fileManager.trashFile ??= async () => {};
		vaultApi.trash ??= async () => {};
		const forbidden = {
			"app.vault.delete": vi.spyOn(vaultApi as { delete: () => Promise<void> }, "delete"),
			"app.vault.trash": vi.spyOn(vaultApi as { trash: () => Promise<void> }, "trash"),
			"app.fileManager.trashFile": vi.spyOn(fileManager as { trashFile: () => Promise<void> }, "trashFile"),
			"fs.promises.rm": vi.spyOn(nodeFs.promises, "rm"),
			"fs.promises.rmdir": vi.spyOn(nodeFs.promises, "rmdir"),
			"fs.rmSync": vi.spyOn(nodeFs, "rmSync"),
			"fs.rm": vi.spyOn(nodeFs, "rm"),
		};
		const classifier = new SourceDeleteClassifier({ getLinkTargets: () => settings.tephraLinks, targetExists: existsOnDisk });
		const sourcesFolder = new SourcesFolder({
			fs: recordingFs,
			getVaultPath: () => vault,
			isMobile: () => false,
			records: {
				getLinks: () => settings.tephraLinks,
				setLinks: (next) => void (settings.tephraLinks = next),
				getExcludes: () => settings.tephraExcludes,
				setExcludes: (next) => void (settings.tephraExcludes = next),
				save: async () => {},
			},
			excludeConfig: () => vaultExcludeConfig(app.vault as never),
			showsInSearch: (name) => showsInSearch(settings, name),
			classifier,
			notify: () => {},
		});
		sourcesFolder.start();
		const listed: TephraSource[] = [NOTES, { name: "whoop", path: whoop, status: "online" }];
		await sourcesFolder.sync(listed);
		await sourcesFolder.whenIdle();
		fsCalls.length = 0;
		log.length = 0;

		const notices: string[] = [];
		let confirmed: (() => void) | null = null;
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolve) => (settle = resolve)); // the removal ended: the link step ran, or a notice said why not
		const actions = new SourceActions({
			app: app as never,
			getConnection: () => ({
				getSnapshot: () => ({ state: "online", checked: true, sources: listed, error: null }) as never,
				call: async (method, params) => {
					log.push(`rpc ${method} ${JSON.stringify(params)}`);
					return opts.unregister ?? { ok: true, result: null };
				},
				requestCheck: () => void log.push("requestCheck"),
			}),
			pickFolder: async () => null,
			getVaultPath: () => vault,
			fs: recordingFs,
			realpath: realPath,
			sourcesFolder: {
				removeSource: async (name, remaining) => {
					const outcome = await sourcesFolder.removeSource(name, remaining);
					settle();
					return outcome;
				},
			},
			confirm: (_m, _l, run) => void (confirmed = run),
			notify: (message) => {
				notices.push(message);
				settle();
			},
		});
		const remove = async () => {
			actions.removeSource("whoop");
			confirmed!();
			await settled;
			await sourcesFolder.whenIdle();
			await new Promise((resolve) => setTimeout(resolve, 0)); // the notice that follows `removeSource`, if any
		};
		return { vault, whoop, entryPath, log, fsCalls, forbidden, notices, remove, settings };
	}

	const noForbiddenCall = (h: Awaited<ReturnType<typeof build>>) => {
		for (const [name, spy] of Object.entries(h.forbidden)) expect(spy, `${name} was called`).not.toHaveBeenCalled();
		// (`fs.promises.rmdir` is spied too: Atlas's own adapter calls it only for the empty `Sources/` folder, never during Remove.)
		// The adapter's `rmdir` is non-recursive, and never aimed at the source's entry or what is inside it.
		expect(h.fsCalls.filter((c) => c.method === "rmdir" && c.path.includes("Sources/whoop"))).toEqual([]);
	};

	it("unregisters first, asks for the check, and only then unlinks the link: one unregister, one unlink, in that order", async () => {
		const h = await build();
		await h.remove();
		expect(h.log).toEqual([`rpc source.unregister ${JSON.stringify({ name: "whoop" })}`, "requestCheck", `unlink ${h.entryPath}`]);
		expect(h.fsCalls.filter((c) => c.method === "unlink")).toEqual([{ method: "unlink", path: h.entryPath }]);
		expect(() => lstatSync(h.entryPath)).toThrow(); // the link is gone…
		expect(readFileSync(join(h.whoop, "Workout Plan.md"), "utf8")).toBe("plan"); // …and nothing it pointed at
		expect(readFileSync(join(h.whoop, "Leg Day.md"), "utf8")).toBe("legs");
		noForbiddenCall(h);
	});

	it("never calls app.vault.delete, app.vault.trash, app.fileManager.trashFile or fs.rm (recursive or not) while removing", async () => {
		const h = await build();
		await h.remove();
		noForbiddenCall(h);
		expect(h.notices).toEqual([]);
	});

	it("Tephra refusing the unregister unlinks nothing and deletes nothing", async () => {
		const h = await build({ unregister: { ok: false, error: { kind: "rpc", message: "Tephra error: busy", code: -32000 } } });
		await h.remove();
		expect(h.log).toEqual([`rpc source.unregister ${JSON.stringify({ name: "whoop" })}`]);
		expect(h.fsCalls.filter((c) => c.method === "unlink")).toEqual([]);
		expect(lstatSync(h.entryPath).isSymbolicLink()).toBe(true);
		expect(h.notices).toEqual(["Atlas: couldn't remove whoop: busy"]);
		noForbiddenCall(h);
	});

	it("a real folder at Sources/whoop is left alone, with its files, and nothing is deleted", async () => {
		const h = await build({ entry: "folder" });
		await h.remove();
		expect(h.fsCalls.filter((c) => c.method === "unlink" || c.method === "rmdir")).toEqual([]);
		expect(readFileSync(join(h.entryPath, "Mine.md"), "utf8")).toBe("mine");
		expect(h.notices).toEqual(["Atlas: whoop is no longer a source, but Sources/whoop is a real folder, not a link, so Atlas left it alone."]);
		noForbiddenCall(h);
	});

	it("a link Atlas didn't make is left alone, and nothing is deleted", async () => {
		const h = await build({ entry: "foreign-link" });
		await h.remove();
		expect(h.fsCalls.filter((c) => c.method === "unlink")).toEqual([]);
		expect(lstatSync(h.entryPath).isSymbolicLink()).toBe(true);
		expect(h.notices).toEqual(["Atlas: whoop is no longer a source, but Sources/whoop is a link Atlas didn't make, so Atlas left it alone."]);
		noForbiddenCall(h);
	});
});

describe("Add and Remove: source.list runs right after the reply, before the 10 s interval (R3-4)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		if (modals().length) key("Escape");
		document.body.innerHTML = "";
		vi.useRealTimers();
	});

	/** A real `TephraConnection` over a fake client: `source.list` answers are queued and counted, `call` is scripted. */
	async function online() {
		const listings: { at: number }[] = [];
		const calls: { method: string; at: number }[] = [];
		let sources: TephraSource[] = [NOTES];
		const client: TephraConnectionClient = {
			listSources: async (): Promise<TephraSourcesResult> => (listings.push({ at: Date.now() }), { ok: true, sources }),
			call: async (method) => (calls.push({ method, at: Date.now() }), { ok: true, result: null }),
		};
		const connection = new TephraConnection(client);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot().state).toBe("online");
		expect(listings).toHaveLength(1); // the first check, on start
		const started = Date.now();
		const notices: string[] = [];
		const removeSource = vi.fn(async () => "unlinked" as const);
		let confirmed: (() => void) | null = null;
		const actions = new SourceActions({
			app: new App() as never,
			getConnection: () => connection,
			pickFolder: async () => "/Users/dan/Documents/Whoop",
			getVaultPath: () => "/Users/dan/Vault",
			fs: { lstat: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })), readdir: async () => [] } as never, // nothing in Sources/
			realpath: async (path) => path,
			sourcesFolder: { removeSource },
			confirm: (_m, _l, run) => void (confirmed = run),
			notify: (message) => void notices.push(message),
		});
		return {
			connection,
			listings,
			calls,
			started,
			notices,
			actions,
			removeSource,
			confirm: () => confirmed!(),
			serve: (next: TephraSource[]) => void (sources = next),
		};
	}

	it("Add: the check runs as the register reply arrives, with the 10 s timer not yet due, and the new source is in the snapshot", async () => {
		const h = await online();
		h.serve([NOTES, { name: "whoop", path: "/Users/dan/Documents/Whoop", status: "online" }]);
		const flow = h.actions.addSource();
		await vi.advanceTimersByTimeAsync(0);
		expect(inputEl().value).toBe("whoop");
		key("Enter");
		await vi.advanceTimersByTimeAsync(0);
		await flow;

		expect(h.calls.map((c) => c.method)).toEqual(["source.register"]);
		expect(h.listings).toHaveLength(2); // the check after the reply…
		expect(Date.now() - h.started).toBeLessThan(TEPHRA_CHECK_INTERVAL_MS); // …with no timer advanced to get there
		expect(h.listings[1].at).toBe(h.calls[0].at); // the same instant as the reply
		expect(h.connection.getSnapshot().sources.map((s) => s.name)).toEqual(["notes", "whoop"]);
		expect(h.notices).toEqual([]);
		// The interval is still ahead: it will make the third check, no earlier than its due time.
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS - 1);
		expect(h.listings).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.listings).toHaveLength(3);
	});

	it("Remove: the check runs as the unregister reply arrives, with the 10 s timer not yet due, and the source leaves the snapshot", async () => {
		const h = await online();
		h.serve([NOTES, { name: "whoop", path: "/Users/dan/Documents/Whoop", status: "online" }]);
		await h.connection.check();
		expect(h.listings).toHaveLength(2);
		const before = Date.now();
		h.serve([NOTES]); // what Tephra lists once it has unregistered
		h.actions.removeSource("whoop");
		h.confirm();
		await vi.advanceTimersByTimeAsync(0);

		expect(h.calls.map((c) => c.method)).toEqual(["source.unregister"]);
		expect(h.listings).toHaveLength(3); // the check after the reply…
		expect(Date.now()).toBe(before); // …with no time passing, so well before the interval
		expect(h.listings[2].at).toBe(h.calls[0].at);
		expect(h.connection.getSnapshot().sources.map((s) => s.name)).toEqual(["notes"]);
		expect(h.removeSource).toHaveBeenCalledWith("whoop", [NOTES]);
	});
});
