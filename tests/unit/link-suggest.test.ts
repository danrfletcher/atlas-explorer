import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import type { EditorSuggestContext } from "obsidian";
import { AtlasLinkSuggest } from "../../src/link-suggest";
import type AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";

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
});
