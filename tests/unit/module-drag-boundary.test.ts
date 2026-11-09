import { afterEach, describe, expect, it } from "vitest";
import { MODULE_DRAG_OUT_CLASS } from "../../src/explorer-view";
import { dragEvent, fileRef, folderRef, itemRow, makeModuleRig, sizeModal } from "./module-contents-fixtures";

// atlas-17 PR-3 (G3/E4): dragging a Module Contents row across the modal boundary. Real modal, real
// explorer drag/drop methods (`startModuleItemDrag`, `handleDrop`, `endModuleItemDrag`), real UnitIndex
// and ViewsManager. The Inbox and view drop zones' own listeners are just `handleDrop(target)`, which is
// what the explorer calls from them. (PR-2's module-contents-boundary-drag.test.ts covers the happy path,
// the dim/opacity cascade and R1; this file adds Escape, the node target, dedup, assets and E4 variants.)

// A drag left in progress keeps its document listeners until its modal closes, so close every modal a
// test opened; otherwise one test's Escape/dragover handlers would answer the next test's events.
const opened: { close(): void }[] = [];
afterEach(() => {
	for (const modal of opened.splice(0)) modal.close();
	document.body.innerHTML = "";
});

const FILES = ["Mod/a.md", "Mod/b.md", "Mod/pic.png", "Mod/board.canvas", "Mod/sub/c.md", "Other/x.md"];
const FOLDERS = ["Mod", "Mod/sub", "Other"];
const INSIDE: [number, number] = [200, 200];
const OUTSIDE: [number, number] = [20, 20];

type Rig = ReturnType<typeof makeModuleRig>;
const drop = (rig: Rig, target: unknown) => (rig.explorer.handleDrop as (t: unknown) => void)(target);
const over = (x: number, y: number) => document.dispatchEvent(dragEvent("dragover", x, y));
const dimmed = (modal: { containerEl: HTMLElement }) => modal.containerEl.classList.contains(MODULE_DRAG_OUT_CLASS);
const escape = () => {
	const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	document.body.dispatchEvent(evt);
	return evt;
};
const inView = (rig: Rig) => JSON.stringify(rig.views.getViews()[0].root);

function startDrag(rig: Rig, name = "a.md") {
	const modal = rig.openModal();
	opened.push(modal);
	sizeModal(modal);
	const row = itemRow(modal, name);
	row.dispatchEvent(dragEvent("dragstart"));
	return { modal, row };
}

describe("G3 boundary drag: dim and pointer position", () => {
	it("dims on leaving the frame, undims on returning, and a release inside promotes nothing", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(true);
		over(...INSIDE);
		expect(dimmed(modal)).toBe(false);

		const release = dragEvent("drop", ...INSIDE);
		document.dispatchEvent(release);
		expect(release.defaultPrevented).toBe(true); // swallowed: no zone underneath receives it
		row.dispatchEvent(dragEvent("dragend", ...INSIDE));
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([]);
		expect(inView(rig)).toBe("[]");
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("a release over the frame's edge counts as inside: swallowed, nothing promoted", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { row } = startDrag(rig);
		const edge = dragEvent("drop", 100, 100); // the modal's own top-left corner
		document.dispatchEvent(edge);
		expect(edge.defaultPrevented).toBe(true);
		row.dispatchEvent(dragEvent("dragend", 100, 100));
		expect(rig.index.getAddedItems()).toEqual([]);
	});

	it("a release outside is not swallowed, so the zone underneath can take it", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		startDrag(rig);
		const outside = dragEvent("drop", ...OUTSIDE);
		document.dispatchEvent(outside);
		expect(outside.defaultPrevented).toBe(false);
	});
});

describe("G3 boundary drop onto the Inbox", () => {
	it.each([
		["a markdown file", "a.md", fileRef("Mod/a.md"), "added-file"],
		["a folder", "sub", folderRef("Mod/sub"), "added-folder"],
		["an image", "pic.png", fileRef("Mod/pic.png"), "added-file"],
		["a canvas", "board.canvas", fileRef("Mod/board.canvas"), "added-file"],
	])("%s lands as an 'added' unit, saved at once, and the modal closes", (_label, name, ref, type) => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig, name);
		over(...OUTSIDE);
		expect(() => drop(rig, { kind: "inbox-area", viewId: "v1" })).not.toThrow();
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));

		expect(rig.index.getAddedItems()).toEqual([{ ref, tag: "added" }]);
		expect(rig.index.getUnits().find((u) => u.path === ref.path)?.type).toBe(type);
		expect(rig.flushSave).toHaveBeenCalled();
		expect(inView(rig)).toBe("[]");
		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(dimmed(modal)).toBe(false);
	});

	it("an item already in the inbox is not duplicated by dropping it again", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.markAdded(fileRef("Mod/a.md"));
		const { row } = startDrag(rig);
		drop(rig, { kind: "inbox-area", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
		expect(rig.index.getUnits().filter((u) => u.path === "Mod/a.md")).toHaveLength(1);
	});
});

describe("G3 boundary drop onto a view / bucket target", () => {
	it("bucket-root: placed at the root and added to manualPromotions", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		drop(rig, { kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(rig.views.getViews()[0].root.map((n) => n.ref)).toEqual([fileRef("Mod/a.md")]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/a.md")]);
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("node: nests under the target node and is added to manualPromotions", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const parent = rig.views.placeUnit("v1", fileRef("Mod/b.md"), null)!;
		const { row } = startDrag(rig);
		drop(rig, { kind: "node", viewId: "v1", nodeId: parent.id });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		const root = rig.views.getViews()[0].root;
		expect(root).toHaveLength(1);
		expect(root[0].children.map((n) => n.ref)).toEqual([fileRef("Mod/a.md")]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/a.md")]);
	});

	it("a non-markdown asset is placed the same way, with no link resolution", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { row } = startDrag(rig, "pic.png");
		drop(rig, { kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(rig.views.getViews()[0].root.map((n) => n.ref)).toEqual([fileRef("Mod/pic.png")]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/pic.png")]);
	});

	it("an item already promoted gets no duplicate manualPromotions entry, and other placements keep their order (F2)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.addManualPromotion(fileRef("Mod/a.md"));
		rig.views.placeUnit("v1", fileRef("Other/x.md"), null);
		rig.views.placeUnit("v1", fileRef("Mod/b.md"), null);
		const { row } = startDrag(rig);
		drop(rig, { kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/a.md")]);
		expect(rig.views.getViews()[0].root.map((n) => n.ref)).toEqual([fileRef("Other/x.md"), fileRef("Mod/b.md"), fileRef("Mod/a.md")]);
	});
});

describe("E4 a drag that does not end on a valid target changes nothing", () => {
	it("released outside every drop target: opacity restored, nothing promoted or placed, modal stays", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(true);
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE)); // no drop event reached any zone
		expect(dimmed(modal)).toBe(false);
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([]);
		expect(inView(rig)).toBe("[]");
		expect(rig.flushSave).not.toHaveBeenCalled();
		expect(rig.saveManualPromotions).not.toHaveBeenCalled();
		expect(rig.explorer.dragPayload).toBeNull();
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("a drop on a non-drop-target (target of an unknown kind) is not a promotion", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		drop(rig, { kind: "inbox-area", viewId: "v1" }); // a stray drop after the drag is over: nothing armed
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("a folder row dragged to empty space is cancelled the same way", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig, "sub");
		over(...OUTSIDE);
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(dimmed(modal)).toBe(false);
		expect(rig.index.getAddedItems()).toEqual([]);
	});

	it("the modal's dim and listeners are gone after the cancel: a later move does not dim it", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(false);
	});
});

describe("E4 Escape aborts the boundary drag", () => {
	it("un-dims the modal, disarms the explorer's drop zones, promotes and places nothing", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(true);
		expect(rig.explorer.dragPayload).not.toBeNull();

		escape();

		expect(dimmed(modal)).toBe(false);
		expect(rig.explorer.dragPayload).toBeNull();
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([]);
		expect(inView(rig)).toBe("[]");
		expect(rig.flushSave).not.toHaveBeenCalled();
	});

	it("is consumed, so it does not also close the modal", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		const evt = escape();
		expect(evt.defaultPrevented).toBe(true);
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("a drop that still arrives after Escape does not promote (payload already gone)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { row } = startDrag(rig);
		over(...OUTSIDE);
		escape();
		drop(rig, { kind: "inbox-area", viewId: "v1" });
		drop(rig, { kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE)); // the browser's own dragend
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([]);
		expect(inView(rig)).toBe("[]");
	});

	it("only Escape aborts: another key leaves the drag in progress", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		over(...OUTSIDE);
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(dimmed(modal)).toBe(true);
		expect(rig.explorer.dragPayload).not.toBeNull();
	});

	it("Escape with no drag in progress is left alone (the modal's own Escape still works)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		opened.push(rig.openModal());
		expect(escape().defaultPrevented).toBe(false);
	});

	it("Escape after a finished drag is left alone: the listener was removed at dragend", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { row } = startDrag(rig);
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(escape().defaultPrevented).toBe(false);
	});

	it("the next drag works normally after an Escape", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		escape();
		row.dispatchEvent(dragEvent("dragstart"));
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(true);
		drop(rig, { kind: "inbox-area", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
	});

	it("the modal being torn down under a drag (onClose) also disarms the explorer's drop zones", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		modal.onClose();
		expect(rig.explorer.dragPayload).toBeNull();
		drop(rig, { kind: "inbox-area", viewId: "v1" });
		expect(rig.index.getAddedItems()).toEqual([]);
	});

	// Live finding (T5): Obsidian's own window-capture keydown listener is registered before any plugin's
	// and calls modal.close() on Escape, which tears down the plugin's Escape listener before it runs. The
	// mock has no such listener, so this one stands in for it, registered first like the real one.
	describe("Obsidian's Escape handling (a window-capture listener registered first, calling modal.close())", () => {
		let removeObsidian: () => void = () => {};
		const obsidianEscapeCloses = (modal: { close(): void }) => {
			const onKey = (e: KeyboardEvent) => {
				if (e.key === "Escape") modal.close();
			};
			window.addEventListener("keydown", onKey, true);
			removeObsidian = () => window.removeEventListener("keydown", onKey, true);
		};
		afterEach(() => removeObsidian());

		it("Escape mid-drag aborts the drag and the modal stays open at full opacity", () => {
			const rig = makeModuleRig(FILES, FOLDERS);
			const modal = rig.openModal();
			opened.push(modal);
			sizeModal(modal);
			obsidianEscapeCloses(modal); // before dragstart, so before the plugin's own listener
			itemRow(modal, "a.md").dispatchEvent(dragEvent("dragstart"));
			over(...OUTSIDE);
			expect(dimmed(modal)).toBe(true);

			escape();

			expect(document.body.contains(modal.containerEl)).toBe(true);
			expect(dimmed(modal)).toBe(false);
			expect(rig.explorer.dragPayload).toBeNull();
			drop(rig, { kind: "inbox-area", viewId: "v1" });
			expect(rig.index.getAddedItems()).toEqual([]);
			expect(rig.index.getManualPromotions()).toEqual([]);
			expect(inView(rig)).toBe("[]");
		});

		it("a second Escape, with no drag in progress, closes the modal as usual", () => {
			const rig = makeModuleRig(FILES, FOLDERS);
			const modal = rig.openModal();
			opened.push(modal);
			sizeModal(modal);
			obsidianEscapeCloses(modal);
			itemRow(modal, "a.md").dispatchEvent(dragEvent("dragstart"));
			escape();
			expect(document.body.contains(modal.containerEl)).toBe(true);
			escape();
			expect(document.body.contains(modal.containerEl)).toBe(false);
		});

		it("a drop on the Inbox still closes the modal after dragend", () => {
			const rig = makeModuleRig(FILES, FOLDERS);
			const modal = rig.openModal();
			opened.push(modal);
			sizeModal(modal);
			const row = itemRow(modal, "a.md");
			row.dispatchEvent(dragEvent("dragstart"));
			over(...OUTSIDE);
			drop(rig, { kind: "inbox-area", viewId: "v1" });
			row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
			expect(document.body.contains(modal.containerEl)).toBe(false);
			expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
		});
	});
});

describe("F1 a boundary drag never touches the disk", () => {
	it.each(["inbox-area", "bucket-root"])("%s drop: no vault call", (kind) => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const calls = [...rig.app.vault.calls];
		const { row } = startDrag(rig, "pic.png");
		drop(rig, { kind, viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));
		expect(rig.app.vault.calls).toEqual(calls);
	});
});
