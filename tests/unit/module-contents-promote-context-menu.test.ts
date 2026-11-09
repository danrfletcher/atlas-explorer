import { afterEach, describe, expect, it } from "vitest";
import { unitRefKey, unitToRef } from "../../src/types";
import { clickMenuItem, fileRef, folderRef, itemRow, makeModuleRig, rightClick } from "./module-contents-fixtures";

afterEach(() => {
	document.body.innerHTML = "";
});

const FILES = ["Mod/a.md", "Mod/sub/c.md"];
const FOLDERS = ["Mod", "Mod/sub"];

describe("G2 right-click on a Module Contents item row", () => {
	it("lists 'Promote to inbox' alongside the two existing entries, on a file row and on a folder row", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		for (const name of ["a.md", "sub"]) {
			const titles = rightClick(itemRow(modal, name)).titles();
			expect(titles, name).toContain("Reveal in native explorer");
			expect(titles, name).toContain("Promote to inbox");
			expect(titles.some((t) => t.startsWith("Promote and place in view")), name).toBe(true);
		}
	});

	it("'Promote to inbox' marks the file added in the real index, flushes the save, redraws and closes the modal", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		expect(rig.index.getAddedItems()).toEqual([]);

		clickMenuItem(rightClick(itemRow(modal, "a.md")), "Promote to inbox");

		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
		const unit = rig.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === "file:Mod/a.md");
		expect(unit?.type).toBe("added-file"); // what the inbox renders with the 'added' pill
		expect(rig.flushSave).toHaveBeenCalledTimes(1);
		expect(rig.render).toHaveBeenCalled();
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("on a folder row it registers an added folder (a module)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		clickMenuItem(rightClick(itemRow(modal, "sub")), "Promote to inbox");
		expect(rig.index.getAddedItems()).toEqual([{ ref: folderRef("Mod/sub"), tag: "added" }]);
		const unit = rig.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === "folder:Mod/sub");
		expect(unit?.type).toBe("added-folder");
	});

	it("promoting an item that is already added is idempotent: one entry, no duplicate", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		clickMenuItem(rightClick(itemRow(modal, "a.md")), "Promote to inbox");
		const again = rig.openModal();
		clickMenuItem(rightClick(itemRow(again, "a.md")), "Promote to inbox");
		expect(rig.index.getAddedItems()).toHaveLength(1);
	});

	it("touches nothing on disk (F1) and places nothing in any view (F2)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const calls = [...rig.app.vault.calls];
		const views = JSON.stringify(rig.views.getViews());
		const modal = rig.openModal();
		clickMenuItem(rightClick(itemRow(modal, "a.md")), "Promote to inbox");
		expect(rig.app.vault.calls).toEqual(calls);
		expect(JSON.stringify(rig.views.getViews())).toBe(views);
	});

	it("promoting a hidden item keeps its hidden flag: the two are independent", () => {
		const rig = makeModuleRig(FILES, FOLDERS, { Mod: ["Mod/a.md"] });
		const modal = rig.openModal();
		clickMenuItem(rightClick(itemRow(modal, "a.md")), "Promote to inbox");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
		expect(rig.index.getAddedItems()).toHaveLength(1);
	});
});
