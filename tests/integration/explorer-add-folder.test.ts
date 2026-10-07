import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { AddFileSuggestModal, AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { seedRoot } from "../helpers";
import type { Unit } from "../../src/types";

// Real UnitIndex and ViewsManager; only the Obsidian API is the mock. The "+" modal's `open` is
// stubbed so the test can read the candidate list the explorer built and pick from it.

type Plugin = {
	app: App;
	settings: typeof DEFAULT_SETTINGS;
	unitIndex: UnitIndex;
	viewsManager: ViewsManager;
	flushSave: ReturnType<typeof vi.fn>;
};

function setup(folders: string[], files: string[], addedFolders: string[] = []) {
	const app = new App();
	seedRoot(app, files, folders);
	const unitIndex = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
	unitIndex.rebuild();
	for (const path of addedFolders) unitIndex.markAdded({ kind: "folder", path });
	const viewsManager = new ViewsManager(app, [], "", () => {});
	const plugin: Plugin = { app, settings: { ...DEFAULT_SETTINGS }, unitIndex, viewsManager, flushSave: vi.fn(async () => {}) };
	const fake = { plugin, render: vi.fn(async () => {}) };
	return { app, unitIndex, viewsManager, plugin, fake };
}

/** Opens "+" through the real explorer method and returns the candidate paths it listed, with a folder as `path/`. */
function openPlus(fake: { plugin: Plugin; render: ReturnType<typeof vi.fn> }): { candidates: string[]; modal: AddFileSuggestModal } {
	let captured: AddFileSuggestModal | undefined;
	const spy = vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
		captured = this;
	});
	(AtlasExplorerView.prototype as unknown as { openAddFileModal: (this: unknown) => void }).openAddFileModal.call(fake);
	spy.mockRestore();
	if (!captured) throw new Error("modal did not open");
	const modal = captured;
	return { candidates: modal.getItems().map((item) => modal.getItemText(item)).sort(), modal };
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("explorer '+' picker adds a sub-folder (GP2, GP6, E2, E6)", () => {
	it("GP2: 'acme' lists Jobs/Acme/ and its two files; the note is still offered before the folder is added", () => {
		const { fake } = setup(["Jobs", "Jobs/Acme"], ["Jobs/Acme/brief.md", "Jobs/Acme/notes.md", "Jobs/Acme/Acme.md"]);
		const { candidates } = openPlus(fake);
		expect(candidates).toEqual(["Jobs/Acme/", "Jobs/Acme/Acme.md", "Jobs/Acme/brief.md", "Jobs/Acme/notes.md"]);
	});

	it("GP6: after adding Jobs/Acme/, '+' no longer lists the folder or its note, but still offers brief.md; the add is saved at once", () => {
		const { app, plugin, fake } = setup(["Jobs", "Jobs/Acme"], ["Jobs/Acme/brief.md", "Jobs/Acme/notes.md", "Jobs/Acme/Acme.md"]);
		const { modal } = openPlus(fake);
		modal.onChooseItem(app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder);

		expect(plugin.unitIndex.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" } satisfies Unit);
		expect(plugin.unitIndex.getAddedItems()).toContainEqual(expect.objectContaining({ ref: { kind: "folder", path: "Jobs/Acme" }, tag: "added" }));
		expect(plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);

		const { candidates } = openPlus(fake);
		expect(candidates).not.toContain("Jobs/Acme/");
		expect(candidates).not.toContain("Jobs/Acme/Acme.md");
		expect(candidates).toContain("Jobs/Acme/brief.md");
		expect(candidates).toContain("Jobs/Acme/notes.md");
	});

	it("GP6: the picked folder survives a reload (saved data rebuilds the same added-folder unit)", () => {
		const { app, plugin, fake } = setup(["Jobs", "Jobs/Acme"], ["Jobs/Acme/brief.md"]);
		const { modal } = openPlus(fake);
		modal.onChooseItem(app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder);
		const saved = plugin.unitIndex.getAddedItems();

		const reloaded = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], saved);
		reloaded.rebuild();
		expect(reloaded.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
	});

	it("E2: a sub-folder inside an added folder is offered and addable on its own", () => {
		const { app, plugin, fake } = setup(["Jobs", "Jobs/Acme", "Jobs/Acme/Deep"], ["Jobs/Acme/Deep/x.md"], ["Jobs/Acme"]);
		const { candidates, modal } = openPlus(fake);
		expect(candidates).toContain("Jobs/Acme/Deep/");

		modal.onChooseItem(app.vault.getAbstractFileByPath("Jobs/Acme/Deep") as TFolder);
		expect(plugin.unitIndex.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme/Deep" });
		expect(plugin.unitIndex.getUnits()).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
	});

	it("E6: a note added first, then its folder: both rows stay", () => {
		const { app, plugin, fake } = setup(["Jobs", "Jobs/Acme"], ["Jobs/Acme/Acme.md"]);
		const first = openPlus(fake);
		first.modal.onChooseItem(app.vault.getAbstractFileByPath("Jobs/Acme/Acme.md") as TFile);
		const second = openPlus(fake);
		expect(second.candidates).toContain("Jobs/Acme/");
		second.modal.onChooseItem(app.vault.getAbstractFileByPath("Jobs/Acme") as TFolder);

		const units = plugin.unitIndex.getUnits();
		expect(units).toContainEqual({ type: "added-file", path: "Jobs/Acme/Acme.md" });
		expect(units).toContainEqual({ type: "added-folder", path: "Jobs/Acme" });
	});

	it("E9 + F2: the pool folder's sub-folders are never listed, however deep", () => {
		const { fake } = setup(["_pool", "_pool/a", "_pool/a/b", "Jobs", "Jobs/Acme"], []);
		const { candidates } = openPlus(fake);
		expect(candidates).toEqual(["Jobs/Acme/"]);
	});

	it("a folder placed in a view is not offered, even when no unit exists for it (placed-set clause)", () => {
		const { viewsManager, fake } = setup(["Jobs", "Jobs/Acme"], []);
		viewsManager.placeUnit(viewsManager.getViews()[0].id, { kind: "folder", path: "Jobs/Acme" }, null);
		expect(openPlus(fake).candidates).toEqual([]);
	});

	it("empty vault: the picker opens with nothing to offer and no crash (edge)", () => {
		const { fake } = setup([], []);
		expect(openPlus(fake).candidates).toEqual([]);
	});
});
