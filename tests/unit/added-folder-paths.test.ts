import { describe, expect, it } from "vitest";
import { App, TFolder } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { resolveUnit } from "../../src/unit-display";
import { seedRoot } from "../helpers";
import type { AddedItem, UnitRef } from "../../src/types";

const folder = (path: string): UnitRef => ({ kind: "folder", path });
const file = (path: string): UnitRef => ({ kind: "file", path });

interface Fixture {
	app: App;
	index: UnitIndex;
	views: ViewsManager;
	viewId: string;
}

/** A vault with `Jobs/Acme/` (added folder), sibling-prefix names (`Jobs/Acme Ltd/`, `Jobs/Acme.md`),
 * an excluded folder and an empty folder. The vault mock doesn't move children on folder rename, so
 * these tests drive `UnitIndex`/`ViewsManager` rename handling directly — the same calls
 * `main.ts`'s rename event makes — and assert no vault mutation came from the index itself. */
function makeFixture(addedItems: AddedItem[], settings: Partial<AtlasSettings> = {}): Fixture {
	const app = new App();
	seedRoot(
		app,
		["Jobs/Acme/brief.md", "Jobs/Acme/notes.md", "Jobs/Acme/Acme.md", "Jobs/Acme.md", "Jobs/Acme Ltd/x.md", "Archive/Old.md", "Other/Source.md"],
		["Jobs", "Jobs/Acme", "Jobs/Acme Ltd", "Jobs/Empty", "Archive", "Other"]
	);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, excludedFolders: ["Archive"], ...settings }, [], {}, [], addedItems);
	index.rebuild();
	const views = new ViewsManager({} as App, [], "", () => {});
	return { app, index, views, viewId: views.getViews()[0].id };
}

/** Mimics `main.ts`'s rename event for a folder: the vault changes, then both the index and the views
 * rewrite their refs. Returns the vault calls made by the index/views step alone. */
async function renameFolder(f: Fixture, oldPath: string, newPath: string): Promise<string[]> {
	const entry = f.app.vault.getAbstractFileByPath(oldPath) as TFolder;
	await f.app.vault.rename(entry, newPath);
	f.app.vault.calls = [];
	f.index.onVaultRename(entry, oldPath);
	f.views.onVaultRename(oldPath, newPath);
	return [...f.app.vault.calls];
}

describe("G9 — rename/move rewrites an added-folder ref by path prefix (nested, siblings, root, excluded)", () => {
	it("a plain rename rewrites the entry and keeps the tag", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		await renameFolder(f, "Jobs/Acme", "Jobs/Acme Ltd 2");

		expect(f.index.getAddedItems()).toEqual([{ ref: folder("Jobs/Acme Ltd 2"), tag: "added" }]);
		expect(f.index.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme Ltd 2" });
	});

	it("nested: a folder rename rewrites every added descendant ref too", async () => {
		const f = makeFixture([
			{ ref: folder("Jobs/Acme"), tag: "added" },
			{ ref: folder("Jobs/Acme/Sub"), tag: "added" },
		]);
		await renameFolder(f, "Jobs", "Clients");

		expect(f.index.getAddedItems().map((item) => item.ref)).toEqual([folder("Clients/Acme"), folder("Clients/Acme/Sub")]);
	});

	it("sibling prefix: renaming Jobs/Acme does not rewrite Jobs/Acme Ltd (folder) or Jobs/Acme.md (file)", async () => {
		const f = makeFixture([
			{ ref: folder("Jobs/Acme"), tag: "added" },
			{ ref: folder("Jobs/Acme Ltd"), tag: "added" },
			{ ref: file("Jobs/Acme.md"), tag: "added" },
		]);
		await renameFolder(f, "Jobs/Acme", "Jobs/Acme 2");

		expect(f.index.getAddedItems().map((item) => item.ref)).toEqual([
			folder("Jobs/Acme 2"),
			folder("Jobs/Acme Ltd"),
			file("Jobs/Acme.md"),
		]);
	});

	it("vault-root move (E7): the entry is dropped and the folder is a plain folder-unit", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		f.views.placeUnit(f.viewId, folder("Jobs/Acme"), null);
		await renameFolder(f, "Jobs/Acme", "Acme");

		expect(f.index.getAddedItems()).toEqual([]);
		expect(f.index.isAdded(folder("Acme"))).toBe(false);
		const units = f.index.getUnits();
		expect(units.some((u) => u.type === "added-folder")).toBe(false);
		expect(units).toContainEqual({ type: "folder-unit", path: "Acme" });
	});

	it("vault-root move keeps the placement as a top-level module", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		f.views.placeUnit(f.viewId, folder("Jobs/Acme"), null);
		await renameFolder(f, "Jobs/Acme", "Acme");

		const view = f.views.getViews()[0];
		expect(view.root).toHaveLength(1);
		expect(view.root[0].ref).toEqual(folder("Acme"));
	});

	it("excluded-folder move (E8): the entry stays, the row stays, still tagged added", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		await renameFolder(f, "Jobs/Acme", "Archive/Acme");

		expect(f.index.getAddedItems()).toEqual([{ ref: folder("Archive/Acme"), tag: "added" }]);
		expect(f.index.getUnits()).toContainEqual({ type: "added-folder", path: "Archive/Acme" });
	});

	it("tag and placement survive: the placed node's ref and the entry's tag are both rewritten", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		f.views.placeUnit(f.viewId, folder("Jobs/Acme"), null);
		await renameFolder(f, "Jobs/Acme", "Jobs/Acme Ltd 2");

		expect(f.index.getAddedItems()).toEqual([{ ref: folder("Jobs/Acme Ltd 2"), tag: "added" }]);
		expect(f.views.getViews()[0].root[0].ref).toEqual(folder("Jobs/Acme Ltd 2"));
	});
});

describe("G10 — delete leaves the entry in place; recreate at the same path resolves again", () => {
	it("deleting the folder leaves addedItems untouched and removes the resolved row", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		await f.app.vault.delete(f.app.vault.getAbstractFileByPath("Jobs/Acme")!, true);
		f.index.onVaultDelete("Jobs/Acme");

		expect(f.index.getAddedItems()).toEqual([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		// The index keeps the entry (it never checks the disk); the inbox row disappears because it no longer resolves.
		expect(await resolveUnit(f.app, DEFAULT_SETTINGS, { type: "added-folder", path: "Jobs/Acme" })).toBeNull();
		expect(f.index.isAdded(folder("Jobs/Acme"))).toBe(true);
	});

	it("recreating the folder at the same path brings the row back, no longer missing", async () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		await f.app.vault.delete(f.app.vault.getAbstractFileByPath("Jobs/Acme")!, true);
		f.index.onVaultDelete("Jobs/Acme");

		await f.app.vault.createFolder("Jobs/Acme");
		f.index.onVaultCreate(f.app.vault.getAbstractFileByPath("Jobs/Acme")!);

		expect(f.index.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
	});
});

describe("F5 — adding and renaming make no disk changes from the index itself", () => {
	it("markAdded and onVaultRename record no vault calls", async () => {
		const f = makeFixture([]);
		f.app.vault.calls = [];
		f.index.markAdded(folder("Jobs/Empty"));
		f.index.markAdded(folder("Jobs/Acme"));
		f.index.onVaultRename(f.app.vault.getAbstractFileByPath("Jobs/Acme")!, "Jobs/Acme");
		expect(f.app.vault.calls).toEqual([]);
	});
});

describe("E1 — an empty added folder is addable and places like any module", () => {
	it("an empty added folder appears as an added-folder row and can be placed", () => {
		const f = makeFixture([]);
		f.index.markAdded(folder("Jobs/Empty"));
		f.views.placeUnit(f.viewId, folder("Jobs/Empty"), null);

		expect(f.index.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Empty" });
		expect(f.views.getViews()[0].root[0].ref).toEqual(folder("Jobs/Empty"));
	});
});

describe("G4 — an added folder places, nests, removes and dismisses like any module row", () => {
	it("nests under a parent, then removes the placement, with the entry still added", () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }, { ref: folder("Other"), tag: "added" }]);
		f.views.placeUnit(f.viewId, folder("Other"), null);
		f.views.placeUnit(f.viewId, folder("Jobs/Acme"), null);
		const [parent, child] = f.views.getViews()[0].root;
		expect(f.views.moveNode(f.viewId, child.id, parent.id, 0)).toBe(true);
		expect(f.views.getViews()[0].root[0].children[0].ref).toEqual(folder("Jobs/Acme"));

		f.views.unplaceNode(f.viewId, child.id);

		expect(f.views.getViews()[0].root.flatMap((n) => n.children)).toEqual([]);
		expect(f.index.isAdded(folder("Jobs/Acme"))).toBe(true);
	});

	it("dismissing records against the folder ref and leaves the added entry alone", () => {
		const f = makeFixture([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		f.index.setDismissed(folder("Jobs/Acme"), "view", true, f.viewId);

		expect(f.index.isDismissed(folder("Jobs/Acme"), "view", f.viewId)).toBe(true);
		expect(f.index.isAdded(folder("Jobs/Acme"))).toBe(true);
	});
});

describe("Edge: removing the folder entry does not touch files inside it or their entries", () => {
	it("an added file inside the folder keeps its own entry when the folder entry is gone", () => {
		const insideFile: AddedItem = { ref: file("Jobs/Acme/brief.md"), tag: "added" };
		const f = makeFixture([insideFile]);

		expect(f.index.getUnits()).toContainEqual({ type: "added-file", path: "Jobs/Acme/brief.md" });
		expect(f.index.getAddedItems()).toEqual([insideFile]);
	});
});
