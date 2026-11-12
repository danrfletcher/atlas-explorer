import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pointOutsideRect } from "../../src/module-contents-drag";
import { MODULE_DRAG_OUT_CLASS, MODULE_ITEM_DRAG_MIME } from "../../src/explorer-view";
import { unitRefKey, unitToRef } from "../../src/types";
import { dragEvent, fileRef, itemRow, makeModuleRig, sizeModal } from "./module-contents-fixtures";

afterEach(() => {
	document.body.innerHTML = "";
});

const FILES = ["Mod/a.md", "Mod/b.md"];
const FOLDERS = ["Mod"];
const INSIDE: [number, number] = [200, 200];
const OUTSIDE: [number, number] = [20, 20];

function startDrag(rig: ReturnType<typeof makeModuleRig>, name = "a.md") {
	const modal = rig.openModal();
	sizeModal(modal);
	const row = itemRow(modal, name);
	row.dispatchEvent(dragEvent("dragstart"));
	return { modal, row };
}
const over = (x: number, y: number) => document.dispatchEvent(dragEvent("dragover", x, y));
const dimmed = (modal: { containerEl: HTMLElement }) => modal.containerEl.classList.contains(MODULE_DRAG_OUT_CLASS);

/** The opacity that wins the cascade for `el`, from the real styles.css plus the element's inline style.
 * jsdom's getComputedStyle ignores `!important` against inline styles, so resolve it here: a stylesheet
 * `!important` beats inline, inline beats a normal stylesheet rule. */
const stylesheet = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function effectiveOpacity(el: HTMLElement): string {
	let normal = "";
	let important = "";
	for (const m of stylesheet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		if (!m[1].split(",").some((sel) => el.matches(sel.trim()))) continue;
		const decl = /(?:^|;)\s*opacity\s*:\s*([\d.]+)\s*(!important)?\s*(?=;|$)/.exec(m[2]);
		if (!decl) continue;
		if (decl[2]) important = decl[1];
		else normal = decl[1];
	}
	return important || el.style.opacity || normal;
}

describe("pointOutsideRect", () => {
	const rect = { left: 100, top: 100, right: 400, bottom: 300 };
	it("inside and on every edge is inside (no flicker at the frame)", () => {
		for (const [x, y] of [[200, 200], [100, 100], [400, 300], [100, 300], [400, 100]]) expect(pointOutsideRect(x, y, rect)).toBe(false);
	});
	it("one pixel past any edge is outside", () => {
		for (const [x, y] of [[99, 200], [401, 200], [200, 99], [200, 301]]) expect(pointOutsideRect(x, y, rect)).toBe(true);
	});
});

describe("G2 dragging a Module Contents row across the modal boundary", () => {
	it("a row is draggable and arms the explorer's drop zones with a module-item payload", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { row } = startDrag(rig);
		expect(row.getAttribute("draggable")).toBe("true");
		expect(rig.explorer.dragPayload).toEqual({ kind: "module-item", ref: fileRef("Mod/a.md") });
	});

	it("R1: the drag carries no text/plain, so a drop on a note's editor cannot insert the path", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		const data = new Map<string, string>();
		const evt = dragEvent("dragstart");
		Object.defineProperty(evt, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" } });
		itemRow(modal, "a.md").dispatchEvent(evt);
		expect(data.has("text/plain")).toBe(false);
		expect(data.has("Text")).toBe(false);
		expect([...data.keys()]).toEqual([MODULE_ITEM_DRAG_MIME]);
		expect(rig.explorer.dragPayload).toEqual({ kind: "module-item", ref: fileRef("Mod/a.md") });
	});

	it("dims the modal frame and backdrop once the pointer leaves it, restores it on coming back inside", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		over(...INSIDE);
		expect(dimmed(modal)).toBe(false);
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(true);
		over(...INSIDE);
		expect(dimmed(modal)).toBe(false);
	});

	it("T1: during drag-out the backdrop's effective opacity is 0.25 even with Obsidian's inline opacity: 0.85", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		// Obsidian's real backdrop carries an inline opacity; the mock modal has none, so add it.
		const bg = modal.containerEl.createDiv({ cls: "modal-bg" });
		bg.style.opacity = "0.85";
		expect(effectiveOpacity(bg)).toBe("0.85");
		over(...OUTSIDE);
		expect(effectiveOpacity(bg)).toBe("0.25");
		expect(effectiveOpacity(modal.modalEl)).toBe("0.25");
		over(...INSIDE);
		expect(effectiveOpacity(bg)).toBe("0.85");
	});

	it("returning inside and releasing there is not a drop on anything underneath: nothing is promoted", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		over(...INSIDE);
		const drop = dragEvent("drop", ...INSIDE);
		document.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(true); // swallowed, so no outside zone takes it
		row.dispatchEvent(dragEvent("dragend", ...INSIDE));
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(dimmed(modal)).toBe(false);
		expect(document.body.contains(modal.containerEl)).toBe(true); // nothing committed, modal stays
		expect(rig.explorer.dragPayload).toBeNull();
	});

	it("E4: released outside any valid drop target, the drag is cancelled: opacity back, nothing promoted, modal stays open", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(true);
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE)); // no drop event reached any zone
		expect(dimmed(modal)).toBe(false);
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([]);
		expect(rig.views.getViews()[0].root).toEqual([]);
		expect(rig.flushSave).not.toHaveBeenCalled();
		expect(rig.explorer.dragPayload).toBeNull();
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("after a cancelled drag the modal's listeners are gone: later pointer moves do not dim it", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		row.dispatchEvent(dragEvent("dragend"));
		over(...OUTSIDE);
		expect(dimmed(modal)).toBe(false);
	});

	it("closing the modal mid-drag removes the dim class and the listeners", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = startDrag(rig);
		over(...OUTSIDE);
		modal.close();
		expect(dimmed(modal)).toBe(false);
	});

	it("valid drop on the Inbox registers the unit as 'added', saves at once, and closes the modal", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		// The Inbox drop zone's own handler: the real handleDrop.
		(rig.explorer.handleDrop as (t: unknown) => void)({ kind: "inbox-area", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));

		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/a.md"), tag: "added" }]);
		const unit = rig.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === "file:Mod/a.md");
		expect(unit?.type).toBe("added-file");
		expect(rig.flushSave).toHaveBeenCalled();
		expect(rig.views.getViews()[0].root).toEqual([]); // inbox, not the bucket
		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(dimmed(modal)).toBe(false);
	});

	it("valid drop on the view bucket promotes the item and places it at the bucket root", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = startDrag(rig);
		over(...OUTSIDE);
		(rig.explorer.handleDrop as (t: unknown) => void)({ kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", ...OUTSIDE));

		expect(rig.views.getViews()[0].root.map((n) => n.ref)).toEqual([fileRef("Mod/a.md")]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Mod/a.md")]);
		expect(rig.saveManualPromotions).toHaveBeenCalled();
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("a drop that took no payload (nothing armed) is a no-op and closes nothing", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const modal = rig.openModal();
		(rig.explorer.handleDrop as (t: unknown) => void)({ kind: "inbox-area", viewId: "v1" });
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("never touches the disk (F1)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const calls = [...rig.app.vault.calls];
		const { row } = startDrag(rig);
		(rig.explorer.handleDrop as (t: unknown) => void)({ kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend"));
		expect(rig.app.vault.calls).toEqual(calls);
	});

	it("a module-item drag is never a real move onto a module icon: singleDragRef refuses it", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		startDrag(rig);
		const payload = rig.explorer.dragPayload;
		expect((rig.explorer.singleDragRef as (p: unknown) => unknown)(payload)).toBeNull();
	});
});
