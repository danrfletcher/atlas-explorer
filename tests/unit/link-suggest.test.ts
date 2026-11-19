import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import type { Editor, EditorSuggestContext } from "obsidian";
import { AtlasLinkSuggest } from "../../src/link-suggest";
import type AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";
import { buildRig, openAt, stubEditor, suggestionsFor, triggerFor } from "../link-suggest-harness";

// The mock's fuzzy matcher never matches, so give the suggester a plain substring match to score against.
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		prepareFuzzySearch: (query: string) => (text: string) =>
			text.toLowerCase().includes(query.toLowerCase()) ? { score: 1, matches: [] } : null,
	};
});

type Item = { kind: string; text: string };

function suggesterFor(app: App, index: UnitIndex): AtlasLinkSuggest {
	const plugin = { app, settings: { ...DEFAULT_SETTINGS }, unitIndex: index } as unknown as AtlasPlugin;
	const suggest = new AtlasLinkSuggest(plugin);
	(app.fileManager as unknown as { generateMarkdownLink: (f: TFile) => string }).generateMarkdownLink = (f: TFile) => `[[${f.path}]]`;
	return suggest;
}

/** Puts `context` in the slot Obsidian fills when a `[[` trigger opens, so `selectSuggestion` can run. */
function openContext(suggest: AtlasLinkSuggest, sourcePath: string): { replaceRange: ReturnType<typeof vi.fn> } {
	const replaceRange = vi.fn();
	const context = {
		file: { path: sourcePath },
		editor: { getLine: () => "[[acme", replaceRange, setCursor: vi.fn() },
		start: { line: 0, ch: 0 },
		end: { line: 0, ch: 6 },
		query: "acme",
	} as unknown as EditorSuggestContext;
	(suggest as unknown as { context: EditorSuggestContext }).context = context;
	return { replaceRange };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("[[ suggestions include added folders (G13)", () => {
	it("an added-folder unit is listed like any module, as a folder-unit suggestion", async () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme/brief.md", "Jobs/Acme/Acme.md"], ["Jobs", "Jobs/Acme"]);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		index.rebuild();
		index.markAdded({ kind: "folder", path: "Jobs/Acme" });

		const items = (await suggesterFor(app, index).getSuggestions({ query: "acme" } as EditorSuggestContext)) as unknown as Item[];
		expect(items).toContainEqual(expect.objectContaining({ kind: "folder-unit", text: "Acme" }));
	});

	it("picking an added folder with no interface note creates it without a prompt, and the unit stays added", async () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme/brief.md"], ["Jobs", "Jobs/Acme"]);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		index.rebuild();
		index.markAdded({ kind: "folder", path: "Jobs/Acme" });
		const suggest = suggesterFor(app, index);
		const { replaceRange } = openContext(suggest, "Notes/Today.md");

		const items = (await suggest.getSuggestions({ query: "acme" } as EditorSuggestContext)) as unknown as Item[];
		const folderItem = items.find((item) => item.kind === "folder-unit" && item.text === "Acme");
		expect(folderItem).toBeDefined();
		await suggest.selectSuggestion(folderItem as never, {} as KeyboardEvent);

		expect(app.vault.getAbstractFileByPath("Jobs/Acme/Acme.md")).toBeInstanceOf(TFile);
		expect(app.vault.calls).toContain("create");
		expect(document.querySelectorAll(".modal")).toHaveLength(0);
		expect(replaceRange).toHaveBeenCalledWith("[[Jobs/Acme/Acme.md]]", expect.anything(), expect.anything());
		expect(index.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
	});

	it("picking an added folder whose interface note already exists creates nothing", async () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme/Acme.md"], ["Jobs", "Jobs/Acme"]);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		index.rebuild();
		index.markAdded({ kind: "folder", path: "Jobs/Acme" });
		const suggest = suggesterFor(app, index);
		openContext(suggest, "Notes/Today.md");

		const items = (await suggest.getSuggestions({ query: "acme" } as EditorSuggestContext)) as unknown as Item[];
		const folderItem = items.find((item) => item.kind === "folder-unit" && item.text === "Acme");
		await suggest.selectSuggestion(folderItem as never, {} as KeyboardEvent);

		expect(app.vault.calls).not.toContain("create");
	});

	it("PR-1.F1 T1: picking a folder whose interface note is a case-variant sibling (deep.md for Deep) does not throw and links to the existing file", async () => {
		const app = new App();
		seedRoot(app, ["Jobs/Acme/Deep/deep.md"], ["Jobs", "Jobs/Acme", "Jobs/Acme/Deep"]);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		index.rebuild();
		index.markAdded({ kind: "folder", path: "Jobs/Acme/Deep" });
		const suggest = suggesterFor(app, index);
		const { replaceRange } = openContext(suggest, "Notes/Today.md");

		const items = (await suggest.getSuggestions({ query: "deep" } as EditorSuggestContext)) as unknown as Item[];
		const folderItem = items.find((item) => item.kind === "folder-unit" && item.text === "Deep");
		expect(folderItem).toBeDefined();

		await expect(suggest.selectSuggestion(folderItem as never, {} as KeyboardEvent)).resolves.not.toThrow();

		expect(app.vault.calls).not.toContain("create");
		expect(replaceRange).toHaveBeenCalledWith("[[Jobs/Acme/Deep/deep.md]]", expect.anything(), expect.anything());
	});
});

describe("onTrigger steps aside for # / ^ headings and blocks (PR-1.B1)", () => {
	function makeSuggester(app: App): AtlasLinkSuggest {
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		return suggesterFor(app, index);
	}

	function stubEditor(line: string): Editor {
		return { getLine: () => line } as unknown as Editor;
	}

	// Rows where `#` or `^` appears before any `|`: onTrigger must return null so Obsidian's own
	// heading/block list gets a turn, covering same-note (`[[#`/`[[^`), named-file (`[[File#`/
	// `[[File^`), all-headings (`[[File##`), embeds (`![[File#`), and text after the marker
	// (`[[File#Heading`).
	const NULL_ROWS = ["[[File#", "[[File^", "[[#", "[[^", "[[File##", "![[File#", "[[File#Heading"];

	it.each(NULL_ROWS)("returns null for %j", (line) => {
		const app = new App();
		const file = app.vault.seedFile("Note.md");
		const suggest = makeSuggester(app);
		const cursor = { line: 0, ch: line.length };
		expect(suggest.onTrigger(cursor, stubEditor(line), file)).toBeNull();
	});

	// Rows that must still trigger Atlas's own popup unchanged: a plain query, an empty query
	// right after `[[`, `|`-alias queries where `#`/`^` comes after the `|` (F4), and a second,
	// still-open `[[` segment after an earlier closed link on the same line.
	const TRIGGER_ROWS: Array<{ line: string; query: string }> = [
		{ line: "[[Fi", query: "Fi" },
		{ line: "[[", query: "" },
		{ line: "[[A|b#c", query: "A|b#c" },
		{ line: "[[A|b^c", query: "A|b^c" },
		{ line: "[[A]] [[B", query: "B" },
	];

	it.each(TRIGGER_ROWS)("still triggers for $line with query $query", ({ line, query }) => {
		const app = new App();
		const file = app.vault.seedFile("Note.md");
		const suggest = makeSuggester(app);
		const cursor = { line: 0, ch: line.length };
		const result = suggest.onTrigger(cursor, stubEditor(line), file);
		expect(result).not.toBeNull();
		expect(result?.query).toBe(query);
		expect(result?.end).toEqual(cursor);
	});

	it("F1 regression: trigger info for [[Fi is deep-equal to the pre-change shape", () => {
		const app = new App();
		const file = app.vault.seedFile("Note.md");
		const suggest = makeSuggester(app);
		const cursor = { line: 2, ch: 6 };
		const result = suggest.onTrigger(cursor, stubEditor("[[Fi"), file);
		expect(result).toEqual({ start: { line: 2, ch: cursor.ch - 4 }, end: cursor, query: "Fi" });
	});

	it("E4: a # right after [[File inside a code block still returns null, same as before the change", () => {
		const app = new App();
		const file = app.vault.seedFile("Note.md");
		app.metadataCache.getFileCache = (() => ({
			sections: [{ type: "code", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 2, col: 0, offset: 0 } } }],
		})) as unknown as App["metadataCache"]["getFileCache"];
		const suggest = makeSuggester(app);
		const cursor = { line: 1, ch: 7 };
		expect(suggest.onTrigger(cursor, stubEditor("[[File#"), file)).toBeNull();
	});

	it("a null file argument still returns null", () => {
		const app = new App();
		const suggest = makeSuggester(app);
		const cursor = { line: 0, ch: 2 };
		expect(suggest.onTrigger(cursor, stubEditor("[["), null)).toBeNull();
	});
});

describe("the same cases with the Tephra toggle on (G8)", () => {
	const note = "Note.md";

	it.each(["[[File#", "[[File^", "[[#", "[[^", "[[File##", "![[File#", "[[File#Heading"])("PR-1.B1: returns null for %j", async (line) => {
		const rig = await buildRig({ paths: [note, "File.md"] });
		expect(triggerFor(rig, line, note)).toBeNull();
		rig.dispose();
	});

	it.each([
		{ line: "[[Fi", query: "Fi" },
		{ line: "[[", query: "" },
		{ line: "[[A|b#c", query: "A|b#c" },
		{ line: "[[A|b^c", query: "A|b^c" },
		{ line: "[[A]] [[B", query: "B" },
	])("still triggers for $line with query $query", async ({ line, query }) => {
		const rig = await buildRig({ paths: [note] });
		const cursor = { line: 0, ch: line.length };
		const result = rig.suggest.onTrigger(cursor, stubEditor(line), rig.app.vault.getAbstractFileByPath(note) as never);
		expect(result?.query).toBe(query);
		expect(result?.end).toEqual(cursor);
		rig.dispose();
	});

	it("F1 regression: trigger info for [[Fi is deep-equal to the pre-change shape", async () => {
		const rig = await buildRig({ paths: [note] });
		const cursor = { line: 2, ch: 6 };
		const result = rig.suggest.onTrigger(cursor, stubEditor("[[Fi"), rig.app.vault.getAbstractFileByPath(note) as never);
		expect(result).toEqual({ start: { line: 2, ch: cursor.ch - 4 }, end: cursor, query: "Fi" });
		rig.dispose();
	});

	it("E4: a # right after [[File inside a code block still returns null", async () => {
		const rig = await buildRig({ paths: [note] });
		rig.app.metadataCache.getFileCache = (() => ({
			sections: [{ type: "code", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 2, col: 0, offset: 0 } } }],
		})) as unknown as App["metadataCache"]["getFileCache"];
		expect(triggerFor(rig, "[[File#", note)).toBeNull();
		expect(triggerFor(rig, "[[Fi", note)).toBeNull();
		rig.dispose();
	});

	it("a null file argument still returns null", async () => {
		const rig = await buildRig({ paths: [note] });
		expect(rig.suggest.onTrigger({ line: 0, ch: 2 }, stubEditor("[["), null)).toBeNull();
		rig.dispose();
	});

	it("G13: an added folder is listed in a vault note and picking it creates its interface note, as with the toggle off", async () => {
		const rig = await buildRig({ paths: [note, "Jobs/Acme/brief.md"], prepare: (app) => app.vault.seedFolder("Jobs") });
		rig.index.markAdded({ kind: "folder", path: "Jobs/Acme" });
		const items = await suggestionsFor(rig, "acme", note);
		const folder = items.find((item) => item.kind === "folder-unit");
		expect(folder).toMatchObject({ text: "Acme" });
		const { replaceRange } = openAt(rig, "[[acme", note);
		await rig.suggest.selectSuggestion(folder as never, {} as KeyboardEvent);
		expect(rig.app.vault.getAbstractFileByPath("Jobs/Acme/Acme.md")).toBeInstanceOf(TFile);
		expect(replaceRange).toHaveBeenCalledWith("[[TODAY:Jobs/Acme/Acme.md]]", expect.anything(), expect.anything());
		expect(document.querySelectorAll(".modal")).toHaveLength(0);
		rig.dispose();
	});
});
