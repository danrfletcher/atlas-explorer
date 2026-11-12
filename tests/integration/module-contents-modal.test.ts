import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView, MODULE_DRAG_OUT_CLASS } from "../../src/explorer-view";
import { unitRefKey, unitToRef } from "../../src/types";
import type { UnitRef, View } from "../../src/types";
import { clickMenuItem, dragEvent, fileRef, folderRef, itemRow, makeModuleRig, rightClick, sizeModal } from "../unit/module-contents-fixtures";

// atlas-17 PR-3 (GP2): Module Contents end to end against the mock Obsidian App/Vault. The module row
// is the real inbox row (real `renderInboxRow` + `wireModuleRow`), the modal is the real
// `ModuleContentsModal`, the menu/drag callbacks are the real explorer methods, and the inbox row that
// comes out is rendered by the real `renderInboxRow` so the 'added' pill is checked where Dan sees it.
// Only chrome the flow never exercises (selection, menus on the row itself, drop-zone registration) is stubbed.

// The Obsidian mock DOM has no `hasClass` (the real API does); the module-row wiring calls it.
if (!(HTMLElement.prototype as { hasClass?: unknown }).hasClass) {
	(HTMLElement.prototype as unknown as { hasClass: (cls: string) => boolean }).hasClass = function (cls: string) {
		return this.classList.contains(cls);
	};
}

type Method = (...args: unknown[]) => unknown;
const proto = AtlasExplorerView.prototype as unknown as Record<string, Method>;
const ROW_METHODS = [
	"renderInboxRow",
	"renderConnectionDots",
	"renderSortIndicator",
	"resolveRef",
	"resolveOutsideManagedRowInfo",
	"isOutsideManagedUnit",
	"wireModuleRow",
	"matchesFilter",
	"findNodeAnywhere",
	"refOfNode",
	"holdsLiveDataSource",
];

const FILES = ["Projects/plan.md", "Projects/notes.md", "Projects/logo.png", "Projects/board.canvas", "Projects/spec.pdf"];
const FOLDERS = ["Projects"];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

type Rig = ReturnType<typeof makeModuleRig>;

function explorerFor(rig: Rig) {
	const explorer = rig.explorer;
	Object.assign(rig.plugin, {
		isModuleFolderExpanded: vi.fn(() => false),
		setModuleFolderExpanded: vi.fn(),
		freeBlockTextCache: undefined,
		folderSourcePathStore: { get: () => undefined },
	});
	Object.assign(explorer, {
		filterText: "",
		unitsByRefKey: new Map(),
		cancelActiveDwell: null,
		renderRowIcon: vi.fn(),
		makeDropZone: vi.fn(),
		setPlacementTooltip: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		buildNodeDragPayload: vi.fn(),
		buildInboxDragPayload: vi.fn(),
		handleRowKeydown: vi.fn(),
		showUnitMenu: vi.fn(),
		showInboxUnitMenu: vi.fn(),
		viewsManager: rig.views,
		openModuleContentsModalForDrag: vi.fn(),
	});
	for (const name of ROW_METHODS) explorer[name] = proto[name].bind(explorer);
	return explorer;
}

async function renderInboxRowFor(rig: Rig, ref: UnitRef): Promise<HTMLElement> {
	const explorer = explorerFor(rig);
	explorer.unitsByRefKey = new Map(rig.index.getUnits().map((u) => [unitRefKey(unitToRef(u)), u]));
	const info = await (explorer.resolveRef as (r: UnitRef) => Promise<never>)(ref);
	const container = document.body.appendChild(document.createElement("div"));
	(explorer.renderInboxRow as (c: HTMLElement, r: UnitRef, i: unknown, v: View) => HTMLElement)(container, ref, info, rig.views.getViews()[0]);
	return container.querySelector(".atlas-row")!;
}

const badges = (row: HTMLElement) => Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
const down = (el: Element) => el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5, button: 0 }));
const up = (el: Element) => el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

/** Long-presses the module row and returns the modal it opened. */
async function openByLongPress(rig: Rig) {
	const moduleRow = await renderInboxRowFor(rig, folderRef("Projects"));
	down(moduleRow);
	vi.advanceTimersByTime(500);
	const modal = (rig.explorer.trackModuleModal as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as ReturnType<Rig["openModal"]>;
	up(moduleRow);
	return { moduleRow, modal };
}

describe("GP2 Module Contents, open -> context-menu promote", () => {
	it("a 500 ms hold opens the modal without selecting the row; right-click 'Promote to inbox' on a file puts it in the Inbox with an 'added' pill", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const calls = [...rig.app.vault.calls];
		const { moduleRow, modal } = await openByLongPress(rig);
		expect(document.body.contains(modal.containerEl)).toBe(true);
		moduleRow.click(); // the click a real release sends: swallowed, never selects or opens the note
		expect(rig.explorer.handleSelectionClick).not.toHaveBeenCalled();
		expect(rig.explorer.openRef).not.toHaveBeenCalled();

		const menu = rightClick(itemRow(modal, "plan.md"));
		expect(menu.titles()).toContain("Promote to inbox");
		clickMenuItem(menu, "Promote to inbox");

		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Projects/plan.md"), tag: "added" }]);
		const inboxRow = await renderInboxRowFor(rig, fileRef("Projects/plan.md"));
		expect(badges(inboxRow)).toEqual(["added"]);
		expect(rig.views.getViews()[0].root).toEqual([]);
		expect(rig.app.vault.calls).toEqual(calls);
	});

	it.each(["logo.png", "board.canvas", "spec.pdf"])("a non-markdown asset (%s) promotes through the same menu and renders in the Inbox", async (name) => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = await openByLongPress(rig);
		clickMenuItem(rightClick(itemRow(modal, name)), "Promote to inbox");
		const ref = fileRef(`Projects/${name}`);
		expect(rig.index.getAddedItems()).toEqual([{ ref, tag: "added" }]);
		const inboxRow = await renderInboxRowFor(rig, ref);
		expect(badges(inboxRow)).toEqual(["added"]);
	});

	it("promoting the same item twice leaves one Inbox row and one entry", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		for (let i = 0; i < 2; i++) {
			const { modal } = await openByLongPress(rig);
			clickMenuItem(rightClick(itemRow(modal, "plan.md")), "Promote to inbox");
		}
		expect(rig.index.getAddedItems()).toHaveLength(1);
		expect(rig.index.getUnits().filter((u) => u.path === "Projects/plan.md")).toHaveLength(1);
	});

	it("hide then reopen: still hidden; the hidden item can still be promoted and stays hidden", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const first = await openByLongPress(rig);
		itemRow(first.modal, "notes.md").querySelector<HTMLElement>(".atlas-module-item-hide")!.click();
		first.modal.close();
		const second = await openByLongPress(rig);
		const row = itemRow(second.modal, "notes.md");
		expect(row.classList.contains("atlas-module-item-hidden")).toBe(true);
		clickMenuItem(rightClick(row), "Promote to inbox");
		expect(rig.index.getHiddenModuleItems()).toEqual({ Projects: ["Projects/notes.md"] });
		expect(rig.index.getAddedItems().map((i) => i.ref.path)).toEqual(["Projects/notes.md"]);
	});
});

describe("GP2 Module Contents, boundary drag handling", () => {
	const startDrag = async (rig: Rig, name: string) => {
		const { modal } = await openByLongPress(rig);
		sizeModal(modal);
		const row = itemRow(modal, name);
		row.dispatchEvent(dragEvent("dragstart"));
		return { modal, row };
	};
	const dropOn = (rig: Rig, target: unknown) => (rig.explorer.handleDrop as (t: unknown) => void)(target);
	const dimmed = (modal: { containerEl: HTMLElement }) => modal.containerEl.classList.contains(MODULE_DRAG_OUT_CLASS);

	it("drag out dims the modal; dropping on the Inbox adds it with an 'added' pill and closes the modal", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = await startDrag(rig, "logo.png");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		expect(dimmed(modal)).toBe(true);
		dropOn(rig, { kind: "inbox-area", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", 10, 10));

		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(dimmed(modal)).toBe(false);
		const inboxRow = await renderInboxRowFor(rig, fileRef("Projects/logo.png"));
		expect(badges(inboxRow)).toEqual(["added"]);
		expect(rig.views.getViews()[0].root).toEqual([]);
	});

	it("dropping on the view's bucket places the unit and promotes it (no 'added' pill in the Inbox)", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = await startDrag(rig, "plan.md");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		dropOn(rig, { kind: "bucket-root", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", 10, 10));
		expect(rig.views.getViews()[0].root.map((n) => n.ref)).toEqual([fileRef("Projects/plan.md")]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Projects/plan.md")]);
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it("E4: released on empty space, the modal comes back to full opacity and nothing changes", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const before = JSON.stringify(rig.views.getViews());
		const { modal, row } = await startDrag(rig, "plan.md");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		expect(dimmed(modal)).toBe(true);
		row.dispatchEvent(dragEvent("dragend", 10, 10));
		expect(dimmed(modal)).toBe(false);
		expect(document.body.contains(modal.containerEl)).toBe(true);
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([]);
		expect(JSON.stringify(rig.views.getViews())).toBe(before);
	});

	it("E4: Escape mid-drag un-dims, keeps the modal open, and a later drop on the Inbox does nothing", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = await startDrag(rig, "plan.md");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(dimmed(modal)).toBe(false);
		expect(document.body.contains(modal.containerEl)).toBe(true);
		dropOn(rig, { kind: "inbox-area", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", 10, 10));
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.views.getViews()[0].root).toEqual([]);
	});

	it("E4: Escape is taken at window capture, before an earlier document listener (Obsidian's own) can close the modal", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = await startDrag(rig, "plan.md");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		const seenByObsidian = vi.fn();
		document.addEventListener("keydown", seenByObsidian, true);
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		document.removeEventListener("keydown", seenByObsidian, true);
		expect(seenByObsidian).not.toHaveBeenCalled();
		expect(dimmed(modal)).toBe(false);
		expect(document.body.contains(modal.containerEl)).toBe(true);
		row.dispatchEvent(dragEvent("dragend", 10, 10));
	});

	it("Escape with no drag in progress is left to Obsidian (modal still closes on it)", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal } = await openByLongPress(rig);
		const seen = vi.fn();
		document.addEventListener("keydown", seen, true);
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		document.removeEventListener("keydown", seen, true);
		expect(seen).toHaveBeenCalledTimes(1);
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});

	it("dropping an already manually promoted item on the Inbox adds no addedItems entry", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.index.addManualPromotion(fileRef("Projects/plan.md"));
		const { row } = await startDrag(rig, "plan.md");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		dropOn(rig, { kind: "inbox-area", viewId: "v1" });
		row.dispatchEvent(dragEvent("dragend", 10, 10));
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(rig.index.getManualPromotions()).toEqual([fileRef("Projects/plan.md")]);
	});

	it("released back inside the modal is not a boundary drop", async () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const { modal, row } = await startDrag(rig, "plan.md");
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		document.dispatchEvent(dragEvent("dragover", 200, 200));
		expect(dimmed(modal)).toBe(false);
		document.dispatchEvent(dragEvent("drop", 200, 200));
		row.dispatchEvent(dragEvent("dragend", 200, 200));
		expect(rig.index.getAddedItems()).toEqual([]);
		expect(document.body.contains(modal.containerEl)).toBe(true);
	});
});
