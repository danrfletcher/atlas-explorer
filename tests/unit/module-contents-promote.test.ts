import { afterEach, describe, expect, it, vi } from "vitest";
import { unitRefKey, unitToRef } from "../../src/types";
import type { UnitRef } from "../../src/types";
import { clickMenuItem, fileRef, folderRef, itemRow, makeModuleRig, rightClick } from "./module-contents-fixtures";

// atlas-17 PR-3 (G3): the 'Promote to inbox' context-menu action, through the real modal, the real
// `promoteToInbox` and the real UnitIndex. (PR-2's module-contents-promote-context-menu.test.ts covers the
// menu entries and the markdown file/folder happy path; this file covers dedup, already-promoted items,
// non-markdown assets and the pre-existing menu/click behaviour that must survive.)

afterEach(() => {
	document.body.innerHTML = "";
});

const FILES = ["Mod/a.md", "Mod/b.md", "Mod/pic.png", "Mod/board.canvas", "Mod/spec.pdf", "Mod/sub/c.md"];
const FOLDERS = ["Mod", "Mod/sub"];

const promote = (rig: ReturnType<typeof makeModuleRig>, name: string) => {
	const modal = rig.openModal();
	clickMenuItem(rightClick(itemRow(modal, name)), "Promote to inbox");
	return modal;
};
const unitTypeOf = (rig: ReturnType<typeof makeModuleRig>, ref: UnitRef) =>
	rig.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === unitRefKey(ref))?.type;

describe("G3 'Promote to inbox' adds the ref to addedItems with the 'added' tag", () => {
	it("file", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		promote(rig, "a.md");
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
		expect(unitTypeOf(rig, fileRef("Mod/a.md"))).toBe("added-file");
	});

	it("folder", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		promote(rig, "sub");
		expect(rig.index.getAddedItems()).toEqual([{ ref: folderRef("Mod/sub"), tag: "added" }]);
		expect(unitTypeOf(rig, folderRef("Mod/sub"))).toBe("added-folder");
	});

	// Non-markdown assets are plain file refs: no link or block resolution happens on promote.
	it.each(["pic.png", "board.canvas", "spec.pdf"])("non-markdown asset %s is promoted as a file ref without throwing", (name) => {
		const rig = makeModuleRig(FILES, FOLDERS);
		expect(() => promote(rig, name)).not.toThrow();
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef(`Mod/${name}`), tag: "added" }]);
		expect(unitTypeOf(rig, fileRef(`Mod/${name}`))).toBe("added-file");
	});

	it("saves at once, redraws, and closes the modal", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = promote(rig, "a.md");
		expect(rig.flushSave).toHaveBeenCalledTimes(1);
		expect(rig.render).toHaveBeenCalledTimes(1);
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("promoting several different items gives one entry each, in the order promoted", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		promote(rig, "b.md");
		promote(rig, "a.md");
		expect(rig.index.getAddedItems().map((i) => i.ref.path)).toEqual(["Mod/b.md", "Mod/a.md"]);
	});
});

describe("G3 promoting an item that is already in the inbox or the view creates no duplicate", () => {
	it("already added: still exactly one addedItems entry, and one inbox unit", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		promote(rig, "a.md");
		promote(rig, "a.md");
		promote(rig, "a.md");
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
		expect(rig.index.getUnits().filter((u) => u.path === "Mod/a.md")).toHaveLength(1);
	});

	it("an added item re-promoted keeps its place in the list (order preserved)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		promote(rig, "a.md");
		promote(rig, "b.md");
		promote(rig, "a.md");
		expect(rig.index.getAddedItems().map((i) => i.ref.path)).toEqual(["Mod/a.md", "Mod/b.md"]);
	});

	it("already manually promoted: manualPromotions is not duplicated or reordered", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.addManualPromotion(fileRef("Mod/b.md"));
		rig.index.addManualPromotion(fileRef("Mod/a.md"));
		promote(rig, "a.md");
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/b.md"), fileRef("Mod/a.md")]);
		// Already in `manualPromotions`, so `addedItems` gets no second entry (T2).
		expect(rig.index.getAddedItems()).toEqual([]);
		// One row in the inbox, not a promoted row plus an added row.
		expect(rig.index.getUnits().filter((u) => u.path === "Mod/a.md")).toHaveLength(1);
		expect(unitTypeOf(rig, fileRef("Mod/a.md"))).toBe("promoted-file");
	});

	it("already manually promoted folder: neither list gains an entry", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.addManualPromotion(folderRef("Mod/sub"));
		promote(rig, "sub");
		promote(rig, "sub");
		expect(rig.index.getManualPromotions()).toEqual([folderRef("Mod/sub")]);
		expect(rig.index.getAddedItems()).toEqual([]);
	});

	it("already placed in a view: the placement and its order are untouched (F2)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.addManualPromotion(fileRef("Mod/b.md"));
		rig.index.addManualPromotion(fileRef("Mod/a.md"));
		rig.views.placeUnit("v1", fileRef("Mod/b.md"), null);
		rig.views.placeUnit("v1", fileRef("Mod/a.md"), null);
		const placed = JSON.stringify(rig.views.getViews()[0].root);
		promote(rig, "a.md");
		expect(JSON.stringify(rig.views.getViews()[0].root)).toBe(placed);
		expect(rig.views.getViews()[0].root.map((n) => n.ref)).toEqual([fileRef("Mod/b.md"), fileRef("Mod/a.md")]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/b.md"), fileRef("Mod/a.md")]);
	});
});

describe("G3 the pre-existing Module Contents behaviour survives the new menu entry", () => {
	it("'Reveal in native explorer' still reveals the clicked item and promotes nothing", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		clickMenuItem(rightClick(itemRow(modal, "pic.png")), "Reveal in native explorer");
		expect(rig.explorer.revealInNativeExplorer).toHaveBeenCalledWith("Mod/pic.png");
		expect(rig.index.getAddedItems()).toEqual([]);
	});

	it("clicking a file row opens that file and closes the modal", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		itemRow(modal, "a.md").click();
		expect(rig.explorer.openRef).toHaveBeenCalledWith({ kind: "file", path: "Mod/a.md" });
		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(rig.index.getAddedItems()).toEqual([]);
	});

	it("promote touches no file on disk (F1) and leaves link resolution alone (F3)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const calls = [...rig.app.vault.calls];
		const resolve = vi.spyOn(rig.app.metadataCache, "getFirstLinkpathDest");
		promote(rig, "pic.png");
		expect(rig.app.vault.calls).toEqual(calls);
		expect(resolve).not.toHaveBeenCalled();
	});
});
