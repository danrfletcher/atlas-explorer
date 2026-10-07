import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { resolveUnit } from "../../src/unit-display";
import { seedRoot } from "../helpers";
import { unitToRef } from "../../src/types";
import type { AddedItem, Unit, UnitRef } from "../../src/types";

const folder = (path: string): UnitRef => ({ kind: "folder", path });
const file = (path: string): UnitRef => ({ kind: "file", path });

interface Harness {
	app: App;
	index: UnitIndex;
	caches: Record<string, CachedMetadata>;
	resolve: Record<string, string>;
}

/** Wires `getFileCache`/`getFirstLinkpathDest` from mutable maps, so a test can add a link and then
 * call `onMetadataResolved()` to model Obsidian's own `resolved` event. */
function makeHarness(
	files: string[],
	folders: string[],
	addedItems: AddedItem[] = [],
	manualPromotions: UnitRef[] = []
): Harness {
	const app = new App();
	seedRoot(app, files, folders);
	const caches: Record<string, CachedMetadata> = {};
	const resolve: Record<string, string> = {};
	app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const destPath = resolve[linkpath];
		return destPath ? (app.vault.getAbstractFileByPath(destPath) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, manualPromotions, {}, [], addedItems);
	index.rebuild();
	return { app, index, caches, resolve };
}

const ACME_FILES = ["Jobs/Acme/brief.md", "Jobs/Acme/notes.md", "Other/Source.md"];
const ACME_FOLDERS = ["Jobs", "Jobs/Acme", "Other"];

const rowsFor = (units: Unit[], path: string) => units.filter((u) => unitToRef(u).kind === "folder" && u.path === path);

describe("G2 — markAdded accepts a folder ref and adds an added-folder unit", () => {
	it("adds an added-folder unit tagged 'added' and stores it as {kind:'folder', path}", () => {
		const { index } = makeHarness(ACME_FILES, ACME_FOLDERS);
		index.markAdded(folder("Jobs/Acme"));

		expect(index.getAddedItems()).toEqual([{ ref: { kind: "folder", path: "Jobs/Acme" }, tag: "added" }]);
		expect(index.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
		expect(index.isAdded(folder("Jobs/Acme"))).toBe(true);
	});

	it("round-trips through a reload unchanged", () => {
		const { index } = makeHarness(ACME_FILES, ACME_FOLDERS);
		index.markAdded(folder("Jobs/Acme"));
		const saved = JSON.parse(JSON.stringify(index.getAddedItems())) as AddedItem[];

		const reloaded = makeHarness(ACME_FILES, ACME_FOLDERS, saved).index;

		expect(reloaded.getAddedItems()).toEqual(saved);
		expect(reloaded.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
	});

	it("is idempotent: adding the same folder twice gives one entry and one row", () => {
		const { index } = makeHarness(ACME_FILES, ACME_FOLDERS);
		index.markAdded(folder("Jobs/Acme"));
		index.markAdded(folder("Jobs/Acme"));

		expect(index.getAddedItems()).toHaveLength(1);
		expect(rowsFor(index.getUnits(), "Jobs/Acme")).toHaveLength(1);
	});

	it("de-duplicates an addedItems list that already holds the same folder twice", () => {
		const dup: AddedItem[] = [
			{ ref: folder("Jobs/Acme"), tag: "added" },
			{ ref: folder("Jobs/Acme"), tag: "added" },
		];
		const { index } = makeHarness(ACME_FILES, ACME_FOLDERS, dup);

		expect(rowsFor(index.getUnits(), "Jobs/Acme")).toHaveLength(1);
	});

	it("never touches the vault: markAdded records no vault calls", () => {
		const { app, index } = makeHarness(ACME_FILES, ACME_FOLDERS);
		app.vault.calls = [];
		index.markAdded(folder("Jobs/Acme"));
		expect(app.vault.calls).toEqual([]);
	});
});

describe("unitToRef maps added-folder to a folder ref (module treatment)", () => {
	it("maps added-folder to { kind: 'folder', path }", () => {
		expect(unitToRef({ type: "added-folder", path: "Jobs/Acme" })).toEqual({ kind: "folder", path: "Jobs/Acme" });
	});

	it("leaves added-file mapping as a file ref", () => {
		expect(unitToRef({ type: "added-file", path: "Jobs/Acme/brief.md" })).toEqual({ kind: "file", path: "Jobs/Acme/brief.md" });
	});
});

describe("G2 — an added folder resolves as a folder-icon row named after the folder", () => {
	it("row text is the folder name (not the path), icon is folder, badge 'added' set, not promoted", async () => {
		const { app, index } = makeHarness(ACME_FILES, ACME_FOLDERS);
		index.markAdded(folder("Jobs/Acme"));
		const unit = rowsFor(index.getUnits(), "Jobs/Acme")[0];

		const resolved = await resolveUnit(app, DEFAULT_SETTINGS, unit);

		expect(resolved).toMatchObject({ text: "Acme", icon: "folder", added: true, promoted: false });
	});

	it("row name follows a rename of the folder", async () => {
		const { app, index } = makeHarness(ACME_FILES, ACME_FOLDERS);
		index.markAdded(folder("Jobs/Acme"));
		const folderEntry = app.vault.getAbstractFileByPath("Jobs/Acme")!;
		await app.vault.rename(folderEntry, "Jobs/Acme Ltd");
		index.onVaultRename(folderEntry, "Jobs/Acme");

		const unit = rowsFor(index.getUnits(), "Jobs/Acme Ltd")[0];
		const resolved = await resolveUnit(app, DEFAULT_SETTINGS, unit);

		expect(resolved?.text).toBe("Acme Ltd");
	});
});

/** G8 / E3: every route that can promote the same folder key. The added-folder row must win in
 * every order, leaving exactly one row for the key, still tagged "added". */
const PROMOTION_ROUTES: {
	label: string;
	promote: (h: Harness) => void;
}[] = [
	{
		label: "link (interface-note link from another module)",
		promote: (h) => {
			h.caches["Other/Source.md"] = { links: [{ link: "Acme/Acme", original: "[[Acme/Acme]]" } as never] };
			h.resolve["Acme/Acme"] = "Jobs/Acme/Acme.md";
			h.index.onMetadataResolved();
		},
	},
	{
		label: "manual promotion (Module Contents promote-and-place)",
		promote: (h) => h.index.addManualPromotion(folder("Jobs/Acme")),
	},
	{
		label: "Folder source",
		promote: (h) => h.index.setFolderSourceRefs([folder("Jobs/Acme")]),
	},
];

describe.each(PROMOTION_ROUTES)("G8/E3 — later promotion via $label keeps exactly one added row", ({ promote }) => {
	it("added first, promoted second: one row, added-folder, no promoted-folder for the key", () => {
		const h = makeHarness(["Jobs/Acme/brief.md", "Jobs/Acme/Acme.md", "Other/Source.md"], ACME_FOLDERS, [
			{ ref: folder("Jobs/Acme"), tag: "added" },
		]);
		promote(h);

		const rows = rowsFor(h.index.getUnits(), "Jobs/Acme");
		expect(rows).toEqual([{ type: "added-folder", path: "Jobs/Acme" }]);
	});

	it("promoted first, added second: one row, added-folder", () => {
		const h = makeHarness(["Jobs/Acme/brief.md", "Jobs/Acme/Acme.md", "Other/Source.md"], ACME_FOLDERS);
		promote(h);
		expect(rowsFor(h.index.getUnits(), "Jobs/Acme").map((u) => u.type)).toEqual(["promoted-folder"]);

		h.index.markAdded(folder("Jobs/Acme"));

		expect(rowsFor(h.index.getUnits(), "Jobs/Acme")).toEqual([{ type: "added-folder", path: "Jobs/Acme" }]);
	});
});

describe("G8 — the added folder stays 'added' after promotion, and promotion alone never adds it", () => {
	it("a promoted folder without an added entry is still a promoted-folder row", () => {
		const h = makeHarness(ACME_FILES, ACME_FOLDERS);
		h.index.addManualPromotion(folder("Jobs/Acme"));
		expect(rowsFor(h.index.getUnits(), "Jobs/Acme")).toEqual([{ type: "promoted-folder", path: "Jobs/Acme", topLevelFolder: "Jobs" }]);
	});
});

describe("R3 and R1 still hold for files alongside the folder rule", () => {
	it("R3: an added file suppresses a promoted-file for the same path", () => {
		const h = makeHarness(["Jobs/Acme/brief.md", "Other/Source.md"], ACME_FOLDERS, [{ ref: file("Jobs/Acme/brief.md"), tag: "added" }]);
		h.index.addManualPromotion(file("Jobs/Acme/brief.md"));
		const units = h.index.getUnits().filter((u) => u.path === "Jobs/Acme/brief.md");
		expect(units).toEqual([{ type: "added-file", path: "Jobs/Acme/brief.md" }]);
	});

	it("an added folder does not suppress a promoted-file for a file inside it", () => {
		const h = makeHarness(ACME_FILES, ACME_FOLDERS, [{ ref: folder("Jobs/Acme"), tag: "added" }]);
		h.index.addManualPromotion(file("Jobs/Acme/brief.md"));
		const units = h.index.getUnits();
		expect(units).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
		expect(units).toContainEqual({ type: "promoted-file", path: "Jobs/Acme/brief.md", topLevelFolder: "Jobs" });
	});
});

describe("Edge: corrupt or unknown-kind addedItems entries are ignored without throwing", () => {
	it("skips null, empty, unknown-kind and path-less entries; keeps valid ones", () => {
		const junk = [
			null,
			{},
			{ ref: undefined, tag: "added" },
			{ ref: { kind: "weird", path: "X" }, tag: "added" },
			{ ref: { kind: "folder" }, tag: "added" },
		] as unknown as AddedItem[];
		const h = makeHarness(ACME_FILES, ACME_FOLDERS, [...junk, { ref: folder("Jobs/Acme"), tag: "added" }]);

		expect(() => h.index.getUnits()).not.toThrow();
		expect(() => h.index.isAdded(folder("Jobs/Acme"))).not.toThrow();
		expect(h.index.isAdded(folder("Jobs/Acme"))).toBe(true);
		expect(rowsFor(h.index.getUnits(), "Jobs/Acme")).toEqual([{ type: "added-folder", path: "Jobs/Acme" }]);
	});
});

describe("Edge: an empty folder is addable and shows as a row", () => {
	it("an empty added folder yields a row", () => {
		const h = makeHarness(["Other/Source.md"], ["Other", "Jobs", "Jobs/Empty"]);
		h.index.markAdded(folder("Jobs/Empty"));
		expect(rowsFor(h.index.getUnits(), "Jobs/Empty")).toEqual([{ type: "added-folder", path: "Jobs/Empty" }]);
	});
});

describe("Edge: an added folder's files stay independent of the folder entry", () => {
	it("removing the folder entry leaves an added file inside it listed and tagged", () => {
		const addedFile: AddedItem = { ref: file("Jobs/Acme/brief.md"), tag: "added" };
		const both = makeHarness(ACME_FILES, ACME_FOLDERS, [{ ref: folder("Jobs/Acme"), tag: "added" }, addedFile]);
		expect(both.index.getUnits()).toEqual(expect.arrayContaining([{ type: "added-folder", path: "Jobs/Acme" }, { type: "added-file", path: "Jobs/Acme/brief.md" }]));

		const folderEntryRemoved = makeHarness(ACME_FILES, ACME_FOLDERS, [addedFile]);
		const units = folderEntryRemoved.index.getUnits();
		expect(units.some((u) => u.type === "added-folder")).toBe(false);
		expect(units).toContainEqual({ type: "added-file", path: "Jobs/Acme/brief.md" });
		expect(folderEntryRemoved.index.isAdded(file("Jobs/Acme/brief.md"))).toBe(true);
	});
});
