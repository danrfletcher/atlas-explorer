import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import { describeUnresolved, resolveSourceLink, SourceFileIndex } from "../../src/source-links";
import { buildRig, openAt, SPEC_PATHS, suggestionsFor, texts, triggerFor, type Rig } from "../link-suggest-harness";
import { seedPaths } from "../sources-vault";

// The mock's fuzzy matcher never matches, so give the suggester a plain substring match to score against.
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		prepareFuzzySearch: (query: string) => (text: string) => (text.toLowerCase().includes(query.toLowerCase()) ? { score: 1, matches: [] } : null),
	};
});

const rigs: Rig[] = [];
async function rig(options: Parameters<typeof buildRig>[0] = {}): Promise<Rig> {
	const r = await buildRig(options);
	rigs.push(r);
	return r;
}
afterEach(() => {
	while (rigs.length) rigs.pop()!.dispose();
	document.body.innerHTML = "";
});

const VAULT_NOTE = "Weekly Review.md";
const WHOOP_NOTE = "Sources/whoop/Workout Plan.md";

describe("[[text searches the note's own source only (G8)", () => {
	it("a note under Sources/whoop/ sees only whoop files", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "", WHOOP_NOTE);
		expect(texts(items).sort()).toEqual(["Leg Day", "Workout Plan"]);
		expect(items.every((item) => item.file!.path.startsWith("Sources/whoop/"))).toBe(true);
	});

	it("a vault note sees vault files and nothing under Sources/", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "", VAULT_NOTE);
		expect(texts(items)).toEqual(["Weekly Review"]);
		for (const item of await suggestionsFor(r, "readme", VAULT_NOTE)) throw new Error(`unexpected ${item.text}`);
	});

	it("matching is case-insensitive and a typed `leg` finds only whoop's Leg Day from a whoop note", async () => {
		const r = await rig();
		expect(texts(await suggestionsFor(r, "LEG", WHOOP_NOTE))).toEqual(["Leg Day"]);
	});

	it("a note in tephra sees tephra's files, not whoop's", async () => {
		const r = await rig();
		expect(texts(await suggestionsFor(r, "readme", "Sources/tephra/README.md")).sort()).toEqual(["README", "README"]);
		expect(texts(await suggestionsFor(r, "work", "Sources/tephra/README.md"))).toEqual([]);
	});

	it("a file directly under Sources/ is in no source: it is never offered, and its own popup falls back to the vault", async () => {
		const r = await rig({ paths: [...SPEC_PATHS, "Sources/stray.md"] });
		expect(texts(await suggestionsFor(r, "stray", VAULT_NOTE))).toEqual([]);
		expect(texts(await suggestionsFor(r, "stray", "Sources/whoop/Leg Day.md"))).toEqual([]);
		expect(texts(await suggestionsFor(r, "stray", "Sources/stray.md"))).toEqual([]);
	});
});

describe("[[@ lists sources (G8)", () => {
	it("`[[@` has All sources first, then the vault and every source A-Z", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@", VAULT_NOTE);
		expect(texts(items)).toEqual(["All sources", "notes", "tephra", "whoop"]);
		expect(items[0]).toMatchObject({ kind: "source", all: true, name: "*" });
	});

	it("`[[@wh` filters source names only: whoop, with All sources still first", async () => {
		const r = await rig();
		expect(texts(await suggestionsFor(r, "@wh", VAULT_NOTE))).toEqual(["All sources", "whoop"]);
	});

	it("`[[@WH` matches whoop (case-insensitive)", async () => {
		const r = await rig();
		expect(texts(await suggestionsFor(r, "@WH", VAULT_NOTE))).toEqual(["All sources", "whoop"]);
	});

	it("a name that matches no source gives only the message `No source named wh`", async () => {
		const r = await rig({ sources: [{ name: "tephra", path: "/t", status: "online" }] });
		const items = await suggestionsFor(r, "@wh", VAULT_NOTE);
		expect(items).toEqual([{ kind: "message", text: "No source named wh" }]);
	});

	it("source files are not matched by the filter: `[[@work` lists no file", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@work", VAULT_NOTE);
		expect(items).toEqual([{ kind: "message", text: "No source named work" }]);
	});

	it("a missing source (E5) is listed, greyed with `(missing)`, and searching it is an empty result with no error", async () => {
		const r = await rig({
			sources: [
				{ name: "whoop", path: "/w", status: "missing" },
				{ name: "tephra", path: "/t", status: "online" },
			],
		});
		const items = await suggestionsFor(r, "@", VAULT_NOTE);
		expect(items.find((item) => item.name === "whoop")).toMatchObject({ text: "whoop (missing)", missing: true });
		const row = document.createElement("div");
		r.suggest.renderSuggestion(items.find((item) => item.name === "whoop") as never, row);
		expect(row.classList.contains("atlas-link-suggest-missing")).toBe(true);
		expect(await suggestionsFor(r, "@whoop:work", VAULT_NOTE)).toEqual([]);
	});

	it("names with - _ and . parse and are found (`[[@github-atlas:`)", async () => {
		const r = await rig({
			paths: [...SPEC_PATHS, "Sources/github-atlas/Issue 1.md", "Sources/my_src.v2/Note.md"],
			sources: [
				{ name: "github-atlas", path: "/g", status: "online" },
				{ name: "my_src.v2", path: "/m", status: "online" },
			],
		});
		expect(texts(await suggestionsFor(r, "@github-atlas:", VAULT_NOTE))).toEqual(["Issue 1"]);
		expect(texts(await suggestionsFor(r, "@my_src.v2:", VAULT_NOTE))).toEqual(["Note"]);
		expect(texts(await suggestionsFor(r, "@GITHUB-ATLAS:iss", VAULT_NOTE))).toEqual(["Issue 1"]);
	});
});

describe("[[@whoop:text and [[@*:text (G8)", () => {
	it("`[[@whoop:work` finds Workout Plan, in whoop only", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@whoop:work", VAULT_NOTE);
		expect(texts(items)).toEqual(["Workout Plan"]);
		expect(items[0].file!.path).toBe("Sources/whoop/Workout Plan.md");
	});

	it("the source name is case-insensitive", async () => {
		const r = await rig();
		expect(texts(await suggestionsFor(r, "@WhOoP:leg", VAULT_NOTE))).toEqual(["Leg Day"]);
	});

	it("`[[@*:readme` searches every source and every row carries its source pill", async () => {
		const r = await rig({ paths: [...SPEC_PATHS, "README.md"] });
		const items = await suggestionsFor(r, "@*:readme", VAULT_NOTE);
		expect(items.map((item) => [item.text, item.pill]).sort()).toEqual([
			["README", "notes"],
			["README", "tephra"],
			["README", "tephra"],
		]);
	});

	it("`[[@*:` rows name where the file is, inside its source (second line)", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@*:registry", VAULT_NOTE);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ pill: "tephra", secondary: "crates/tephrad/src/registry.rs" });
		const row = document.createElement("div");
		r.suggest.renderSuggestion(items[0] as never, row);
		expect(row.querySelector(".atlas-link-suggest-pill")?.textContent).toBe("tephra");
	});

	it("a single-source search shows no pill", async () => {
		const r = await rig();
		expect((await suggestionsFor(r, "@whoop:work", VAULT_NOTE))[0].pill).toBeUndefined();
	});

	it("`[[@nosuch:` shows only `No source named nosuch`, and picking that row inserts nothing (E11)", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@nosuch:", VAULT_NOTE);
		expect(items).toEqual([{ kind: "message", text: "No source named nosuch" }]);
		const { replaceRange, setCursor } = openAt(r, "[[@nosuch:", VAULT_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, new KeyboardEvent("keydown", { key: "Enter" }));
		await r.suggest.selectSuggestion(items[0] as never, new MouseEvent("click"));
		expect(replaceRange).not.toHaveBeenCalled();
		expect(setCursor).not.toHaveBeenCalled();
	});

	it("an empty name `[[@:` shows `No source named`", async () => {
		const r = await rig();
		expect(await suggestionsFor(r, "@:", VAULT_NOTE)).toEqual([{ kind: "message", text: "No source named" }]);
	});
});

describe("modules, free blocks and promoted blocks stay vault-source kinds (G8)", () => {
	const VAULT_WITH_MODULE = [...SPEC_PATHS, "Jobs/Acme/brief.md", "Jobs/Acme/Acme.md", "Sources/whoop/Acme Notes.md"];
	const prepare = (app: App) => app.vault.seedFolder("Jobs");

	async function withModule(): Promise<Rig> {
		const r = await rig({ paths: VAULT_WITH_MODULE, prepare });
		r.index.markAdded({ kind: "folder", path: "Jobs/Acme" });
		return r;
	}

	it("a vault note's `[[acme` lists the module", async () => {
		const r = await withModule();
		expect(await suggestionsFor(r, "acme", VAULT_NOTE)).toContainEqual(expect.objectContaining({ kind: "folder-unit", text: "Acme" }));
	});

	it("`[[@notes:acme` and `[[@*:acme` list it too; `[[@whoop:acme` and a whoop note's `[[acme` do not", async () => {
		const r = await withModule();
		expect(await suggestionsFor(r, "@notes:acme", WHOOP_NOTE)).toContainEqual(expect.objectContaining({ kind: "folder-unit", text: "Acme" }));
		expect(await suggestionsFor(r, "@*:acme", WHOOP_NOTE)).toContainEqual(expect.objectContaining({ kind: "folder-unit", text: "Acme", pill: "notes" }));
		expect((await suggestionsFor(r, "@whoop:acme", VAULT_NOTE)).map((item) => item.kind)).toEqual(["file"]);
		expect((await suggestionsFor(r, "acme", WHOOP_NOTE)).map((item) => item.kind)).toEqual(["file"]);
	});

	it("picking the module from a vault note inserts exactly what today's popup inserts (F9)", async () => {
		const r = await withModule();
		const items = await suggestionsFor(r, "acme", VAULT_NOTE);
		const { replaceRange } = openAt(r, "[[acme", VAULT_NOTE);
		await r.suggest.selectSuggestion(items.find((item) => item.kind === "folder-unit") as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[TODAY:Jobs/Acme/Acme.md]]", expect.anything(), expect.anything());
	});

	it("a free block and a promoted block insert with the alias, as today", async () => {
		const r = await rig({ paths: [...SPEC_PATHS, "_pool/20260101000000-abcd.md"] });
		r.app.vault.contents.set("_pool/20260101000000-abcd.md", "Remember the milk");
		r.index.rebuild();
		const items = await suggestionsFor(r, "milk", VAULT_NOTE);
		const block = items.find((item) => item.kind === "free-block");
		expect(block).toBeDefined();
		const { replaceRange } = openAt(r, "[[milk", VAULT_NOTE);
		await r.suggest.selectSuggestion(block as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith(expect.stringMatching(/^\[\[TODAY:_pool\/20260101000000-abcd\.md\|.*milk/), expect.anything(), expect.anything());
	});
});

describe("inserted text (G8, F9)", () => {
	it("GP4: `[[@whoop:work` + pick Workout Plan inserts `[[@whoop:Workout Plan]]` and consumes the auto-closed `]]`", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@whoop:work", VAULT_NOTE);
		const { replaceRange, setCursor } = openAt(r, "[[@whoop:work", VAULT_NOTE, "]]");
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[@whoop:Workout Plan]]", { line: 0, ch: 0 }, { line: 0, ch: 15 });
		expect(setCursor).toHaveBeenCalledWith({ line: 0, ch: "[[@whoop:Workout Plan]]".length });
	});

	it("GP4: picking the source row leaves `[[@whoop:` with the cursor after the colon", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@wh", VAULT_NOTE);
		const { replaceRange, setCursor } = openAt(r, "[[@wh", VAULT_NOTE, "]]");
		await r.suggest.selectSuggestion(items.find((item) => item.name === "whoop") as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[@whoop:", { line: 0, ch: 0 }, { line: 0, ch: 5 });
		expect(setCursor).toHaveBeenCalledWith({ line: 0, ch: 9 });
	});

	it("picking All sources leaves `[[@*:`", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@", VAULT_NOTE);
		const { replaceRange } = openAt(r, "[[@", VAULT_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[@*:", expect.anything(), expect.anything());
	});

	it("GP6: inside a whoop note `[[leg` inserts `[[Leg Day]]`", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "leg", WHOOP_NOTE);
		expect(texts(items)).toEqual(["Leg Day"]);
		const { replaceRange } = openAt(r, "[[leg", WHOOP_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[Leg Day]]", expect.anything(), expect.anything());
	});

	it("a pick from `[[@*:` in another source inserts `[[@source:path]]`, non-notes keep their extension", async () => {
		const r = await rig();
		const items = await suggestionsFor(r, "@*:registry", VAULT_NOTE);
		const { replaceRange } = openAt(r, "[[@*:registry", VAULT_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[@tephra:registry.rs]]", expect.anything(), expect.anything());
	});

	it("`![[@whoop:` keeps the `!`: the replaced range starts at the `[[`", async () => {
		const r = await rig();
		const line = "![[@whoop:work";
		expect(triggerFor(r, line, VAULT_NOTE)).toEqual({ start: { line: 0, ch: 1 }, end: { line: 0, ch: line.length }, query: "@whoop:work" });
		const items = await suggestionsFor(r, "@whoop:work", VAULT_NOTE);
		const { replaceRange } = openAt(r, line, VAULT_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[@whoop:Workout Plan]]", { line: 0, ch: 1 }, expect.anything());
	});

	it("F9: a vault note's same-source pick is byte-identical to generateMarkdownLink when nothing clashes", async () => {
		const r = await rig({ paths: [...SPEC_PATHS, "Notes/Plan.md"] });
		const items = await suggestionsFor(r, "plan", VAULT_NOTE);
		const { replaceRange } = openAt(r, "[[plan", VAULT_NOTE);
		await r.suggest.selectSuggestion(items.find((item) => item.file?.path === "Notes/Plan.md") as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[TODAY:Notes/Plan.md]]", expect.anything(), expect.anything());
	});

	it("E3: two tied files each insert a path that resolves back to them, and a hand-typed ambiguous link is broken with both listed", async () => {
		const paths = [...SPEC_PATHS, "Sources/whoop/a/Plan.md", "Sources/whoop/b/Plan.md"];
		const r = await rig({ paths });
		const items = await suggestionsFor(r, "@whoop:plan", VAULT_NOTE);
		const planRows = items.filter((item) => item.text === "Plan");
		expect(planRows).toHaveLength(2);
		const index = new SourceFileIndex<TFile>(() => r.app.vault.getFiles());
		const inserted: string[] = [];
		for (const row of planRows) {
			const { replaceRange } = openAt(r, "[[@whoop:plan", VAULT_NOTE);
			await r.suggest.selectSuggestion(row as never, {} as KeyboardEvent);
			const text = replaceRange.mock.calls[0][0] as string;
			inserted.push(text);
			const outcome = resolveSourceLink(index, text.slice(2, -2));
			expect(outcome).toMatchObject({ kind: "resolved" });
			expect((outcome as { file: TFile }).file.path).toBe(row.file!.path);
		}
		expect(inserted.sort()).toEqual(["[[@whoop:a/Plan]]", "[[@whoop:b/Plan]]"]);
		const broken = resolveSourceLink(index, "@whoop:Plan");
		expect(broken).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
		const message = describeUnresolved(broken as never, "@whoop:Plan");
		expect(message).toContain("2 matches in whoop");
		expect(message).toContain("Sources/whoop/a/Plan.md");
		expect(message).toContain("Sources/whoop/b/Plan.md");
	});

	it("E3: a root file and a nested file of the same name are not a tie: the bare name opens the root copy, the nested row inserts its path", async () => {
		// "Tie" means a tie on the shortest path (plan E3). Leg Day.md is shorter than Sub/Leg Day.md, so the
		// bare name is not ambiguous; only a tie (a/Plan.md vs b/Plan.md above) makes `[[@whoop:name]]` broken.
		const paths = [...SPEC_PATHS, "Sources/whoop/Sub/Leg Day.md"];
		const r = await rig({ paths });
		const rows = (await suggestionsFor(r, "@whoop:leg day", VAULT_NOTE)).filter((item) => item.text === "Leg Day");
		expect(rows).toHaveLength(2);
		const index = new SourceFileIndex<TFile>(() => r.app.vault.getFiles());
		const inserted: Record<string, string> = {};
		for (const row of rows) {
			const { replaceRange } = openAt(r, "[[@whoop:leg day", VAULT_NOTE);
			await r.suggest.selectSuggestion(row as never, {} as KeyboardEvent);
			const text = replaceRange.mock.calls[0][0] as string;
			inserted[row.file!.path] = text;
			const outcome = resolveSourceLink(index, text.slice(2, -2));
			expect(outcome).toMatchObject({ kind: "resolved" });
			expect((outcome as { file: TFile }).file.path).toBe(row.file!.path);
		}
		expect(inserted).toEqual({
			"Sources/whoop/Leg Day.md": "[[@whoop:Leg Day]]",
			"Sources/whoop/Sub/Leg Day.md": "[[@whoop:Sub/Leg Day]]",
		});
		expect(resolveSourceLink(index, "@whoop:Leg Day")).toMatchObject({ kind: "resolved" });
	});

	it("Q13: in fallback mode a same-source pick whose plain name clashes with another source inserts the full vault path", async () => {
		const r = await rig({ fallback: true });
		const items = await suggestionsFor(r, "readme", "Sources/tephra/README.md");
		const root = items.find((item) => item.file?.path === "Sources/tephra/README.md");
		const nested = items.find((item) => item.file?.path === "Sources/tephra/crates/tephrad/README.md");
		const { replaceRange } = openAt(r, "[[readme", "Sources/tephra/README.md");
		await r.suggest.selectSuggestion(root as never, {} as KeyboardEvent);
		await r.suggest.selectSuggestion(nested as never, {} as KeyboardEvent);
		// Both READMEs are in tephra, so their plain name clashes with a file in the same source only: the
		// popup falls back to the vault path only for a clash with ANOTHER source.
		expect(replaceRange.mock.calls.map((c) => c[0])).toEqual(["[[README]]", "[[crates/tephrad/README]]"]);
	});

	it("Q13: a name that exists in two sources gets the full vault path in fallback mode and the bare name with the hook", async () => {
		const paths = [...SPEC_PATHS, "Sources/whoop/README.md"];
		const fallback = await rig({ fallback: true, paths });
		const picked = (await suggestionsFor(fallback, "readme", "Sources/whoop/Leg Day.md"))[0];
		const a = openAt(fallback, "[[readme", "Sources/whoop/Leg Day.md");
		await fallback.suggest.selectSuggestion(picked as never, {} as KeyboardEvent);
		expect(a.replaceRange).toHaveBeenCalledWith("[[Sources/whoop/README]]", expect.anything(), expect.anything());

		const hook = await rig({ fallback: false, paths });
		const hookPicked = (await suggestionsFor(hook, "readme", "Sources/whoop/Leg Day.md"))[0];
		const b = openAt(hook, "[[readme", "Sources/whoop/Leg Day.md");
		await hook.suggest.selectSuggestion(hookPicked as never, {} as KeyboardEvent);
		expect(b.replaceRange).toHaveBeenCalledWith("[[README]]", expect.anything(), expect.anything());
	});
});

describe("triggers (G8)", () => {
	it("an alias after an @ target returns null; so does one inside a code block", async () => {
		const r = await rig();
		expect(triggerFor(r, "[[@whoop:Workout Plan|wp", VAULT_NOTE)).toBeNull();
		expect(triggerFor(r, "[[@wh|x", VAULT_NOTE)).toBeNull();
		r.app.metadataCache.getFileCache = (() => ({
			sections: [{ type: "code", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 2, col: 0, offset: 0 } } }],
		})) as unknown as App["metadataCache"]["getFileCache"];
		expect(triggerFor(r, "[[@whoop:", VAULT_NOTE)).toBeNull();
	});

	it("`[[@`, `[[@wh`, `[[@whoop:` and `[[@*:` trigger", async () => {
		const r = await rig();
		for (const line of ["[[@", "[[@wh", "[[@whoop:", "[[@*:t", "[[@:", "[[@nosuch:"]) expect(triggerFor(r, line, VAULT_NOTE), line).not.toBeNull();
	});

	it("`#` and `^` after a plain note target still go to Obsidian's popup, as before", async () => {
		const r = await rig();
		for (const line of ["[[Leg Day#", "[[Leg Day^", "[[#", "[[^", "![[Leg Day#"]) expect(triggerFor(r, line, VAULT_NOTE), line).toBeNull();
	});

	it("`#`/`^` after an @source: target, or after a non-note file, are Atlas's (Tephra's) search", async () => {
		const r = await rig();
		for (const line of ["[[@tephra:crates/tephrad/src/registry.rs#", "[[@whoop:Leg Day#^", "[[@whoop:Leg Day^", "[[@tephra:registry.rs#Foo"]) {
			expect(triggerFor(r, line, VAULT_NOTE), line).not.toBeNull();
		}
		expect(triggerFor(r, "[[@tephra:registry.rs#Foo|alias", VAULT_NOTE)).toBeNull();
	});

	it("`[[@wh#` (no file yet) and `[[@*:#` have nothing to search inside: null", async () => {
		const r = await rig();
		expect(triggerFor(r, "[[@wh#", VAULT_NOTE)).toBeNull();
		expect(triggerFor(r, "[[@whoop:#", VAULT_NOTE)).toBeNull();
		expect(triggerFor(r, "[[@*:readme#", VAULT_NOTE)).toBeNull();
	});

	it("a plain `[[text|alias` still triggers with the whole text, as today", async () => {
		const r = await rig();
		expect(triggerFor(r, "[[Leg|al", VAULT_NOTE)?.query).toBe("Leg|al");
	});
});

describe("Tephra offline: [[text, [[@ and [[@name:text keep working (E1/G13)", () => {
	it("`[[@` lists the sources Atlas linked and the folders under Sources/, none greyed", async () => {
		const r = await rig({ sources: null, tephraLinks: { zeta: "/z" } });
		expect(r.connection.getSnapshot().state).toBe("offline");
		expect(texts(await suggestionsFor(r, "@", VAULT_NOTE))).toEqual(["All sources", "notes", "tephra", "whoop", "zeta"]);
	});

	it("`[[@whoop:work` and `[[work` (in whoop) search the Sources/ vault files", async () => {
		const r = await rig({ sources: null });
		expect(texts(await suggestionsFor(r, "@whoop:work", VAULT_NOTE))).toEqual(["Workout Plan"]);
		expect(texts(await suggestionsFor(r, "work", WHOOP_NOTE))).toEqual(["Workout Plan"]);
	});

	it("an unknown source is still `No source named …` offline", async () => {
		const r = await rig({ sources: null });
		expect(await suggestionsFor(r, "@nosuch:", VAULT_NOTE)).toEqual([{ kind: "message", text: "No source named nosuch" }]);
	});
});

describe("toggle off (G16): the popup behaves exactly as today", () => {
	it("`[[@wh` is fuzzy-matched as plain text over every vault file, and Tephra is never touched", async () => {
		const r = await rig({ enabled: false, paths: [...SPEC_PATHS, "@wh notes.md"] });
		const items = await suggestionsFor(r, "@wh", VAULT_NOTE);
		expect(items.map((item) => item.kind)).toEqual(["file"]);
		expect(texts(items)).toEqual(["@wh notes"]);
		expect(r.listSources).not.toHaveBeenCalled();
		expect(r.calls).toEqual([]);
	});

	it("`[[text` searches every file in the vault, `Sources/` included, as today", async () => {
		const r = await rig({ enabled: false });
		expect(texts(await suggestionsFor(r, "work", VAULT_NOTE))).toEqual(["Workout Plan"]);
	});

	it("picks go through generateMarkdownLink untouched", async () => {
		const r = await rig({ enabled: false });
		const items = await suggestionsFor(r, "work", VAULT_NOTE);
		const { replaceRange } = openAt(r, "[[work", VAULT_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(replaceRange).toHaveBeenCalledWith("[[TODAY:Sources/whoop/Workout Plan.md]]", expect.anything(), expect.anything());
	});

	it("`#`/`^` step aside and `@…` queries trigger like any text", async () => {
		const r = await rig({ enabled: false });
		expect(triggerFor(r, "[[@tephra:registry.rs#", VAULT_NOTE)).toBeNull();
		expect(triggerFor(r, "[[@wh", VAULT_NOTE)?.query).toBe("@wh");
		expect(triggerFor(r, "[[@whoop:Workout Plan|wp", VAULT_NOTE)?.query).toBe("@whoop:Workout Plan|wp");
	});
});

describe("large sources", () => {
	it("`[[@*:a` over a 20k-file vault returns at most 50 rows, in under 200 ms", async () => {
		const paths = ["Weekly Review.md"];
		for (let i = 0; i < 10_000; i++) paths.push(`Sources/big/dir${i % 100}/a-file-${i}.md`);
		for (let i = 0; i < 10_000; i++) paths.push(`Sources/other/dir${i % 100}/a-note-${i}.md`);
		const r = await rig({
			paths,
			sources: [
				{ name: "big", path: "/b", status: "online" },
				{ name: "other", path: "/o", status: "online" },
			],
		});
		await suggestionsFor(r, "@*:a", VAULT_NOTE); // warm-up: the first call pays module and JIT cost
		const started = performance.now();
		const items = await suggestionsFor(r, "@*:a", VAULT_NOTE);
		const elapsed = performance.now() - started;
		expect(items).toHaveLength(50);
		expect(elapsed).toBeLessThan(200);
	});
});

describe("fences (F1, F3)", () => {
	it("nothing is written to data.json, the vault or any file across a full session of searches and picks", async () => {
		const r = await rig();
		const before = JSON.stringify(r.settings);
		for (const query of ["", "@", "@wh", "@whoop:work", "@*:readme", "@nosuch:", "work"]) await suggestionsFor(r, query, VAULT_NOTE);
		const items = await suggestionsFor(r, "@whoop:work", VAULT_NOTE);
		openAt(r, "[[@whoop:work", VAULT_NOTE);
		await r.suggest.selectSuggestion(items[0] as never, {} as KeyboardEvent);
		expect(JSON.stringify(r.settings)).toBe(before);
		expect(r.app.vault.calls.filter((call) => ["modify", "create", "createFolder", "delete", "rename", "process"].includes(call))).toEqual([]);
		expect((r.plugin as unknown as { saveData?: unknown }).saveData).toBeUndefined();
	});

	it("the popup keeps no index: a file added after the last search is found by the next one", async () => {
		const r = await rig();
		expect(texts(await suggestionsFor(r, "@whoop:sleep", VAULT_NOTE))).toEqual([]);
		seedPaths(r.app, ["Sources/whoop/Sleep Log.md"]);
		expect(texts(await suggestionsFor(r, "@whoop:sleep", VAULT_NOTE))).toEqual(["Sleep Log"]);
	});
});
