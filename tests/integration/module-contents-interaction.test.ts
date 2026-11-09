import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { MODULE_DRAG_OUT_CLASS } from "../../src/explorer-view";
import { unitRefKey, unitToRef } from "../../src/types";
import type { UnitRef, View } from "../../src/types";
import { dragEvent, fileRef, folderRef, itemRow, makeModuleRig, sizeModal } from "../unit/module-contents-fixtures";

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

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

/** The real module-row and inbox-row methods bolted onto the Module Contents rig's explorer; only the
 * chrome this flow never exercises (selection, menus, drop-zone registration) is stubbed. */
function explorerFor(rig: ReturnType<typeof makeModuleRig>) {
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

async function renderInboxRowFor(rig: ReturnType<typeof makeModuleRig>, ref: UnitRef): Promise<HTMLElement> {
	const explorer = explorerFor(rig);
	explorer.unitsByRefKey = new Map(rig.index.getUnits().map((u) => [unitRefKey(unitToRef(u)), u]));
	const info = await (explorer.resolveRef as (r: UnitRef) => Promise<never>)(ref);
	const container = document.body.appendChild(document.createElement("div"));
	(explorer.renderInboxRow as (c: HTMLElement, r: UnitRef, i: unknown, v: View) => HTMLElement)(container, ref, info, rig.views.getViews()[0]);
	return container.querySelector(".atlas-row")!;
}

describe("Module Contents, end to end: long-press -> hide -> promote by boundary drag", () => {
	it("holds a module row open, hides one file, drags another out onto the Inbox: it shows 'added', the hide persists, the view and disk are untouched", async () => {
		const rig = makeModuleRig(["Mod/a.md", "Mod/b.md"], ["Mod"]);
		const diskCallsBefore = [...rig.app.vault.calls];

		// 1. long-press the module's row (500 ms)
		const moduleRow = await renderInboxRowFor(rig, folderRef("Mod"));
		moduleRow.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5, button: 0 }));
		vi.advanceTimersByTime(499);
		expect(rig.explorer.trackModuleModal).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(rig.explorer.trackModuleModal).toHaveBeenCalledTimes(1);
		const modal = (rig.explorer.trackModuleModal as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReturnType<typeof rig.openModal>;
		expect(document.body.contains(modal.containerEl)).toBe(true);
		moduleRow.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

		// 2. hide a.md with its eye button
		const eyeA = itemRow(modal, "a.md").querySelector<HTMLElement>(".atlas-module-item-hide")!;
		eyeA.click();
		expect(itemRow(modal, "a.md").classList.contains("atlas-module-item-hidden")).toBe(true);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
		expect(rig.persistDebounced).toHaveBeenCalledTimes(1);

		// 3. drag b.md across the modal boundary onto the Inbox
		sizeModal(modal);
		const rowB = itemRow(modal, "b.md");
		rowB.dispatchEvent(dragEvent("dragstart"));
		document.dispatchEvent(dragEvent("dragover", 10, 10));
		expect(modal.containerEl.classList.contains(MODULE_DRAG_OUT_CLASS)).toBe(true);
		(rig.explorer.handleDrop as (t: unknown) => void)({ kind: "inbox-area", viewId: "v1" });
		rowB.dispatchEvent(dragEvent("dragend", 10, 10));

		// 4. inbox state: b.md is an added unit and renders with exactly the 'added' pill
		expect(rig.index.getAddedItems()).toEqual([{ ref: fileRef("Mod/b.md"), tag: "added" }]);
		const inboxRow = await renderInboxRowFor(rig, fileRef("Mod/b.md"));
		expect(inboxRow.querySelector(".atlas-row-text")?.textContent).toContain("b");
		expect(Array.from(inboxRow.querySelectorAll(".atlas-badge")).map((b) => b.textContent)).toEqual(["added"]);

		// 5. the modal closed, opacity class gone; a.md is still hidden and was never promoted
		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(modal.containerEl.classList.contains(MODULE_DRAG_OUT_CLASS)).toBe(false);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
		expect(rig.index.getAddedItems().some((i) => i.ref.path === "Mod/a.md")).toBe(false);

		// 6. nothing on disk, nothing placed in a view
		expect(rig.app.vault.calls).toEqual(diskCallsBefore);
		expect(rig.views.getViews()[0].root).toEqual([]);

		// ...and reopening the module shows a.md still hidden.
		const reopened = rig.openModal();
		expect(itemRow(reopened, "a.md").classList.contains("atlas-module-item-hidden")).toBe(true);
	});

	it("an early release (< 500 ms) opens nothing, and the row's own click still runs", async () => {
		const rig = makeModuleRig(["Mod/a.md"], ["Mod"]);
		const moduleRow = await renderInboxRowFor(rig, folderRef("Mod"));
		const clicked = vi.fn();
		moduleRow.addEventListener("click", clicked);
		moduleRow.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5, button: 0 }));
		vi.advanceTimersByTime(300);
		moduleRow.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		moduleRow.click();
		vi.advanceTimersByTime(1000);
		expect(rig.explorer.trackModuleModal).not.toHaveBeenCalled();
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("an empty module opens Module Contents with an empty-state notice and no error", async () => {
		const rig = makeModuleRig([], ["Mod"]);
		const modal = rig.openModal();
		expect(modal.contentEl.querySelector(".atlas-module-modal-empty")?.textContent).toBe("This module is empty.");
		expect(modal.contentEl.querySelectorAll(".atlas-row-internal")).toHaveLength(0);
	});
});
