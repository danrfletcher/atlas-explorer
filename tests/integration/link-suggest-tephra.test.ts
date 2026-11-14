import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import type { TephraCallResult } from "../../src/tephra-client";
import { buildRig, openAt, suggestionsFor, texts, triggerFor, type CallHandler, type Rig } from "../link-suggest-harness";

// The mock's fuzzy matcher never matches, so give the suggester a plain substring match to score against.
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		prepareFuzzySearch: (query: string) => (text: string) => (text.toLowerCase().includes(query.toLowerCase()) ? { score: 1, matches: [] } : null),
	};
});

const VAULT_NOTE = "Weekly Review.md";
const TARGET = "@tephra:crates/tephrad/src/registry.rs";
const UNIT = "@tephra:crates/tephrad/src/registry.rs";

const ok = (result: unknown): TephraCallResult => ({ ok: true, result });
const fail = (kind: "timeout" | "network" | "rpc", message: string): TephraCallResult => ({ ok: false, error: { kind, message } });

const SYMBOLS = [
	{ unit: UNIT, kind: "symbol", name: "Registry", symbol_kind: "struct", line: 12, text: "pub struct Registry" },
	{ unit: UNIT, kind: "symbol", name: "register", symbol_kind: "function", line: 30, block_id: "known1", text: "fn register" },
];
const HEADINGS = [
	{ unit: UNIT, kind: "heading", text: "Design notes", level: 2, line: 3 },
	{ unit: UNIT, kind: "heading", text: "Open # questions | later", level: 3, line: 9 },
];

let rig: Rig;
afterEach(() => {
	rig?.dispose();
	document.body.innerHTML = "";
});
beforeEach(() => Notice.reset());

async function start(onCall: CallHandler, options: Parameters<typeof buildRig>[0] = {}): Promise<Rig> {
	rig = await buildRig({ onCall, ...options });
	return rig;
}

const lastCall = () => rig.calls[rig.calls.length - 1];

/** A popup list Obsidian would own, so a failed pick's message row can be observed. */
function attachList(r: Rig): ReturnType<typeof vi.fn> {
	const setSuggestions = vi.fn();
	(r.suggest as unknown as { suggestions: { setSuggestions: typeof setSuggestions } }).suggestions = { setSuggestions };
	return setSuggestions;
}

describe("# and ^ after an @source: target ask Tephra (G8)", () => {
	it("`#` sends unit.search scope headings for the file and lists the headings", async () => {
		await start(() => ok({ unit: UNIT, scope: "headings", offline: false, text_unavailable: false, results: HEADINGS }));
		const items = await suggestionsFor(rig, `${TARGET}#Des`, VAULT_NOTE);
		expect(rig.calls).toEqual([{ method: "unit.search", params: { query: "Des", scope: "headings", in: UNIT, limit: 50 } }]);
		expect(texts(items)).toEqual(["Design notes", "Open # questions | later"]);
		expect(items.every((item) => item.kind === "in-file")).toBe(true);
	});

	it("picking a heading inserts `[[@tephra:registry.rs#Heading]]` with the link characters it can't carry dropped", async () => {
		await start(() => ok({ results: HEADINGS }));
		const items = await suggestionsFor(rig, `${TARGET}#`, VAULT_NOTE);
		const { replaceRange } = openAt(rig, `[[${TARGET}#`, VAULT_NOTE, "]]");
		await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		await rig.suggest.selectSuggestion(items[1] as never, {} as KeyboardEvent);
		expect(replaceRange.mock.calls.map((call) => call[0])).toEqual(["[[@tephra:registry.rs#Design notes]]", "[[@tephra:registry.rs#Open questions later]]"]);
		expect(replaceRange.mock.calls[0][2]).toEqual({ line: 0, ch: `[[${TARGET}#`.length + 2 }); // the auto-closed `]]` is consumed
	});

	it("`^` sends scope blocks, and the rows show the symbol kind, line and existing ID", async () => {
		await start(() => ok({ results: SYMBOLS }));
		const items = await suggestionsFor(rig, `${TARGET}#^reg`, VAULT_NOTE);
		expect(lastCall().params).toEqual({ query: "reg", scope: "blocks", in: UNIT, limit: 50 });
		expect(texts(items)).toEqual(["Registry", "register"]);
		const row = document.createElement("div");
		rig.suggest.renderSuggestion(items[1] as never, row);
		expect(row.textContent).toContain("function");
		expect(row.textContent).toContain("line 30");
		expect(row.textContent).toContain("^known1");
	});

	it("a block that already has an ID is inserted by it, and block.ensure_id is not called", async () => {
		await start(() => ok({ results: SYMBOLS }));
		const items = await suggestionsFor(rig, `${TARGET}#^`, VAULT_NOTE);
		const { replaceRange } = openAt(rig, `[[${TARGET}#^`, VAULT_NOTE);
		await rig.suggest.selectSuggestion(items[1] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[@tephra:registry.rs#^known1]]", expect.anything(), expect.anything());
		expect(rig.calls.map((call) => call.method)).toEqual(["unit.search"]);
	});

	it("a block with no ID: block.ensure_id is called with the unit and line, and the returned ^id is inserted", async () => {
		await start((method) => (method === "unit.search" ? ok({ results: SYMBOLS }) : ok({ id: "a1b2c3", link: `${UNIT}#^a1b2c3`, created: true })));
		const items = await suggestionsFor(rig, `${TARGET}#^`, VAULT_NOTE);
		const { replaceRange, setCursor } = openAt(rig, `[[${TARGET}#^`, VAULT_NOTE, "]]");
		await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(lastCall()).toEqual({ method: "block.ensure_id", params: { unit: UNIT, line: 12 } });
		expect(replaceRange).toHaveBeenCalledTimes(1);
		expect(replaceRange).toHaveBeenCalledWith("[[@tephra:registry.rs#^a1b2c3]]", { line: 0, ch: 0 }, { line: 0, ch: `[[${TARGET}#^`.length + 2 });
		expect(setCursor).toHaveBeenCalledWith({ line: 0, ch: "[[@tephra:registry.rs#^a1b2c3]]".length });
	});

	it("a non-note file in the note's own source is searched too (`[[registry.rs#` inside tephra)", async () => {
		await start(() => ok({ results: SYMBOLS }));
		const note = "Sources/tephra/README.md";
		expect(triggerFor(rig, "[[registry.rs#^", note)).not.toBeNull();
		await suggestionsFor(rig, "registry.rs#^", note);
		expect(lastCall().params).toMatchObject({ in: UNIT, scope: "blocks" });
		const items = await suggestionsFor(rig, "registry.rs#^", note);
		const { replaceRange } = openAt(rig, "[[registry.rs#^", note);
		await rig.suggest.selectSuggestion(items[1] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[registry.rs#^known1]]", expect.anything(), expect.anything());
	});

	it("a plain note target in the same source still goes to Obsidian's popup (Atlas steps aside, Tephra is not called)", async () => {
		await start(() => ok({ results: [] }));
		expect(triggerFor(rig, "[[Leg Day#", "Sources/whoop/Workout Plan.md")).toBeNull();
		expect(triggerFor(rig, "[[Leg Day^", "Sources/whoop/Workout Plan.md")).toBeNull();
		expect(rig.calls).toEqual([]);
	});

	it("an @ target that does not exist says so, and Tephra is not asked", async () => {
		await start(() => ok({ results: [] }));
		expect(await suggestionsFor(rig, "@tephra:nothing.rs#^", VAULT_NOTE)).toEqual([{ kind: "message", text: "No file nothing.rs to search in" }]);
		expect(rig.calls).toEqual([]);
	});
});

describe("offline, errors and time-outs show one row and insert nothing", () => {
	it("Tephra offline: `#` and `^` on an @ target give a single `Tephra offline` row; nothing is called, nothing throws, no notice", async () => {
		await start(() => ok({ results: SYMBOLS }), { sources: null });
		expect(rig.connection.getSnapshot().state).toBe("offline");
		for (const query of [`${TARGET}#`, `${TARGET}#^`, `${TARGET}#^reg`]) {
			expect(await suggestionsFor(rig, query, VAULT_NOTE)).toEqual([{ kind: "message", text: "Tephra offline" }]);
		}
		expect(rig.calls).toEqual([]);
		expect(Notice.instances).toEqual([]);
	});

	it("offline, the vault part of the popup still works: `[[`, `[[@` and `[[@name:text`", async () => {
		await start(() => ok({ results: [] }), { sources: null });
		expect(texts(await suggestionsFor(rig, "@whoop:work", VAULT_NOTE))).toEqual(["Workout Plan"]);
		expect(texts(await suggestionsFor(rig, "@", VAULT_NOTE))).toContain("whoop");
		expect(texts(await suggestionsFor(rig, "week", VAULT_NOTE))).toEqual(["Weekly Review"]);
	});

	it.each([
		["a timeout", fail("timeout", "Tephra took too long"), "Tephra did not answer in time"],
		["an unreachable daemon", fail("network", "Tephra is unreachable"), "Tephra offline"],
		["an rpc error", fail("rpc", "unknown scope"), "unknown scope"],
	])("unit.search returns %s: one row saying so", async (_name, result, row) => {
		await start(() => result);
		expect(await suggestionsFor(rig, `${TARGET}#`, VAULT_NOTE)).toEqual([{ kind: "message", text: row }]);
	});

	it("unit.search throwing is handled the same way", async () => {
		await start(() => {
			throw new Error("boom");
		});
		expect(await suggestionsFor(rig, `${TARGET}#`, VAULT_NOTE)).toEqual([{ kind: "message", text: "Tephra offline" }]);
	});

	it("an answer that is not a result list is reported, not trusted", async () => {
		await start(() => ok("nonsense"));
		expect(await suggestionsFor(rig, `${TARGET}#`, VAULT_NOTE)).toEqual([{ kind: "message", text: "Tephra's search answer was not understood" }]);
	});

	it("picking a message row inserts nothing", async () => {
		await start(() => fail("timeout", "x"));
		const items = await suggestionsFor(rig, `${TARGET}#`, VAULT_NOTE);
		const { replaceRange } = openAt(rig, `[[${TARGET}#`, VAULT_NOTE);
		await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).not.toHaveBeenCalled();
	});

	it("block.ensure_id says `file changed, try again`: nothing is inserted and the popup stays open with that row on top", async () => {
		await start((method) => (method === "unit.search" ? ok({ results: SYMBOLS }) : fail("rpc", "file changed, try again")));
		const items = await suggestionsFor(rig, `${TARGET}#^`, VAULT_NOTE);
		const setSuggestions = attachList(rig);
		const { replaceRange, setCursor } = openAt(rig, `[[${TARGET}#^`, VAULT_NOTE);
		const close = vi.spyOn(rig.suggest, "close");
		await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).not.toHaveBeenCalled();
		expect(setCursor).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		const shown = setSuggestions.mock.calls[0][0] as Array<{ kind: string; text: string }>;
		expect(shown[0]).toEqual({ kind: "message", text: "file changed, try again" });
		expect(shown.slice(1).map((row) => row.text)).toEqual(["Registry", "register"]); // the real rows are still there
	});

	it("block.ensure_id times out, or returns no ID: a row saying so, nothing inserted", async () => {
		for (const [answer, row] of [
			[fail("timeout", "x"), "Tephra did not answer in time"],
			[ok({ id: null, link: "", created: false }), "Tephra gave no block ID for this line"],
			[ok({ id: "bad id ]]", link: "", created: true }), "Tephra gave no block ID for this line"],
		] as const) {
			await start((method) => (method === "unit.search" ? ok({ results: SYMBOLS }) : answer));
			const items = await suggestionsFor(rig, `${TARGET}#^`, VAULT_NOTE);
			const setSuggestions = attachList(rig);
			const { replaceRange } = openAt(rig, `[[${TARGET}#^`, VAULT_NOTE);
			await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
			expect(replaceRange).not.toHaveBeenCalled();
			expect((setSuggestions.mock.calls[0][0] as Array<{ text: string }>)[0].text).toBe(row);
			rig.dispose();
		}
	});

	it("a block row without a line number can't be given an ID: nothing inserted, no call", async () => {
		await start(() => ok({ results: [{ unit: UNIT, kind: "paragraph", text: "A paragraph", block_id: null, paragraph: 2, line: null }] }));
		const items = await suggestionsFor(rig, `${TARGET}#^`, VAULT_NOTE);
		expect(items).toEqual([]); // dropped at parse time: it can be neither linked nor given an ID
	});

	it("Atlas never writes the file: no vault modify/process call during a pick", async () => {
		await start((method) => (method === "unit.search" ? ok({ results: SYMBOLS }) : ok({ id: "zz9", link: "", created: true })));
		const items = await suggestionsFor(rig, `${TARGET}#^`, VAULT_NOTE);
		openAt(rig, `[[${TARGET}#^`, VAULT_NOTE);
		await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(rig.app.vault.calls.filter((call: string) => ["modify", "create", "process", "delete", "rename"].includes(call))).toEqual([]);
	});
});

describe("stale replies (sequence guard)", () => {
	function deferred() {
		let resolve!: (value: TephraCallResult) => void;
		const promise = new Promise<TephraCallResult>((r) => (resolve = r));
		return { promise, resolve };
	}

	it("an older unit.search reply that lands last never replaces the newer query's rows", async () => {
		const pending = new Map<string, ReturnType<typeof deferred>>();
		await start((_method, params) => {
			const query = (params as { query: string }).query;
			const d = deferred();
			pending.set(query, d);
			return d.promise;
		});
		const first = suggestionsFor(rig, `${TARGET}#a`, VAULT_NOTE);
		const second = suggestionsFor(rig, `${TARGET}#ab`, VAULT_NOTE);
		await vi.waitFor(() => expect(pending.size).toBe(2));
		pending.get("ab")!.resolve(ok({ results: [{ unit: UNIT, kind: "heading", text: "Newer", level: 1, line: 1 }] }));
		pending.get("a")!.resolve(ok({ results: [{ unit: UNIT, kind: "heading", text: "Older", level: 1, line: 1 }] }));
		expect(texts(await second)).toEqual(["Newer"]);
		expect(texts(await first)).toEqual(["Newer"]);
	});

	it("the same holds when the older reply lands first", async () => {
		const pending = new Map<string, ReturnType<typeof deferred>>();
		await start((_method, params) => {
			const d = deferred();
			pending.set((params as { query: string }).query, d);
			return d.promise;
		});
		const first = suggestionsFor(rig, `${TARGET}#a`, VAULT_NOTE);
		const second = suggestionsFor(rig, `${TARGET}#ab`, VAULT_NOTE);
		await vi.waitFor(() => expect(pending.size).toBe(2));
		pending.get("a")!.resolve(ok({ results: [{ unit: UNIT, kind: "heading", text: "Older", level: 1, line: 1 }] }));
		pending.get("ab")!.resolve(ok({ results: [{ unit: UNIT, kind: "heading", text: "Newer", level: 1, line: 1 }] }));
		expect(texts(await first)).toEqual(["Newer"]);
		expect(texts(await second)).toEqual(["Newer"]);
	});

	it("three overlapping queries all end on the newest", async () => {
		const pending = new Map<string, ReturnType<typeof deferred>>();
		await start((_method, params) => {
			const d = deferred();
			pending.set((params as { query: string }).query, d);
			return d.promise;
		});
		const runs = ["a", "ab", "abc"].map((q) => suggestionsFor(rig, `${TARGET}#${q}`, VAULT_NOTE));
		await vi.waitFor(() => expect(pending.size).toBe(3));
		for (const q of ["ab", "abc", "a"]) pending.get(q)!.resolve(ok({ results: [{ unit: UNIT, kind: "heading", text: `for ${q}`, level: 1, line: 1 }] }));
		for (const run of runs) expect(texts(await run)).toEqual(["for abc"]);
	});
});

describe("toggle off (G16): Tephra is never called", () => {
	it("every kind of query leaves the client untouched: call count 0 and no source.list", async () => {
		await start(() => ok({ results: SYMBOLS }), { enabled: false });
		for (const query of ["@wh", "@whoop:work", "@*:a", "Leg", `${TARGET}#`, `${TARGET}#^`]) await suggestionsFor(rig, query, VAULT_NOTE);
		triggerFor(rig, `[[${TARGET}#^`, VAULT_NOTE);
		const items = await suggestionsFor(rig, "work", VAULT_NOTE);
		openAt(rig, "[[work", VAULT_NOTE);
		await rig.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(rig.calls).toHaveLength(0);
		expect(rig.listSources).toHaveBeenCalledTimes(0);
	});
});

describe("source.list feeds the `[[@` list", () => {
	it("a source Tephra reports missing shows up greyed; one it stops reporting disappears on the next check", async () => {
		await start(() => ok({ results: [] }), {
			sources: [
				{ name: "whoop", path: "/w", status: "missing" },
				{ name: "tephra", path: "/t", status: "online" },
			],
		});
		expect(texts(await suggestionsFor(rig, "@", VAULT_NOTE))).toEqual(["All sources", "notes", "tephra", "whoop (missing)"]);
		rig.listSources.mockResolvedValue({ ok: true, sources: [{ name: "tephra", path: "/t", status: "online" }] });
		await rig.connection.check();
		expect(texts(await suggestionsFor(rig, "@", VAULT_NOTE))).toEqual(["All sources", "notes", "tephra"]);
	});
});
