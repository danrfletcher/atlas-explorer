import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { unitRefKey } from "../../src/types";
import type { AddedItem, UnitRef } from "../../src/types";
import { view } from "./explorer-view-sort-truncate-helpers";

/** PR-1.F2 (G10): the inbox "(missing)" row. Calls the real `renderInboxRow` and
 * `removeMissingAddedRow` on a fake `this` (same `.call(fake, ...)` pattern as the sort helpers),
 * with a real `UnitIndex` so Remove's effect on `addedItems` is what gets asserted. */

type ProtoMethods = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as ProtoMethods;

const file = (path: string): UnitRef => ({ kind: "file", path });
const folder = (path: string): UnitRef => ({ kind: "folder", path });

const missingInfo = (text: string, icon: string) => ({ text, icon, promoted: false, added: false, missing: true });
const liveInfo = (text: string, icon: string, extra: { added?: boolean; promoted?: boolean } = {}) => ({
	text,
	icon,
	promoted: extra.promoted ?? false,
	added: extra.added ?? false,
	missing: false,
});

function makeIndex(addedItems: AddedItem[], dismissedGlobal: UnitRef[] = []): UnitIndex {
	return new UnitIndex(new App(), { ...DEFAULT_SETTINGS }, [], {}, dismissedGlobal, addedItems);
}

function makeExplorer(index: UnitIndex) {
	const fake = {
		plugin: { unitIndex: index, flushSave: vi.fn(async () => {}) },
		selectedInboxRefKeys: new Set<string>(),
		inboxSelectOrder: [] as string[],
		dragPayload: null as unknown,
		handleSelectionClick: vi.fn(() => false),
		openRef: vi.fn(async () => {}),
		wireModuleRow: vi.fn(),
		setPlacementTooltip: vi.fn(),
		buildInboxDragPayload: vi.fn(() => ({ kind: "inbox" })),
		showInboxUnitMenu: vi.fn(),
		render: vi.fn(async () => {}),
		removeMissingAddedRow: proto.removeMissingAddedRow,
	};
	const renderInboxRow = (ref: UnitRef, info: ReturnType<typeof missingInfo>, hidden = false): HTMLElement => {
		const container = document.createElement("div");
		(proto.renderInboxRow as unknown as (...a: unknown[]) => HTMLElement).call(fake, container, ref, info, view, hidden);
		return container.firstElementChild as HTMLElement;
	};
	return { fake, renderInboxRow };
}

const removeButton = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-row-action");

describe("G10 inbox missing row — rendering", () => {
	it("a missing added file: greyed, '(missing)', Remove button, draggable off", () => {
		const index = makeIndex([{ ref: file("Notes/gone.md"), tag: "added" }]);
		const { renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(file("Notes/gone.md"), missingInfo("gone", "file"));

		expect(row.classList.contains("atlas-missing")).toBe(true);
		expect(row.textContent).toContain("(missing)");
		expect(removeButton(row)).not.toBeNull();
		expect(row.getAttribute("draggable")).toBe("false");
	});

	it("a missing added folder: same greyed row, never module-wired", () => {
		const index = makeIndex([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(folder("Jobs/Acme"), missingInfo("Acme", "folder"));

		expect(row.classList.contains("atlas-missing")).toBe(true);
		expect(row.textContent).toContain("(missing)");
		expect(removeButton(row)).not.toBeNull();
		expect(row.getAttribute("draggable")).toBe("false");
		expect(fake.wireModuleRow).not.toHaveBeenCalled();
	});

	it("a missing added row also carrying the 'hidden' badge still shows '(missing)' and Remove", () => {
		const index = makeIndex([{ ref: file("gone.md"), tag: "added" }]);
		const { renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(file("gone.md"), missingInfo("gone", "file"), true);

		expect(row.textContent).toContain("hidden");
		expect(row.textContent).toContain("(missing)");
		expect(removeButton(row)).not.toBeNull();
	});

	it("a missing added row does not open on click", () => {
		const index = makeIndex([{ ref: file("gone.md"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(file("gone.md"), missingInfo("gone", "file"));
		row.click();

		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("a missing added row offers no context menu (Open/Place/Create note would act on a gone file)", () => {
		const index = makeIndex([{ ref: file("gone.md"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		renderInboxRow(file("gone.md"), missingInfo("gone", "file")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

		expect(fake.showInboxUnitMenu).not.toHaveBeenCalled();
	});

	it("a live added row still opens its context menu", () => {
		const index = makeIndex([{ ref: file("live.md"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		renderInboxRow(file("live.md"), liveInfo("live", "file", { added: true })).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

		expect(fake.showInboxUnitMenu).toHaveBeenCalledTimes(1);
	});

	it("a missing row that is not 'added' (promoted/link-derived) renders exactly as today", () => {
		const index = makeIndex([]);
		const { fake, renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(file("linked.md"), missingInfo("linked", "file"));

		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(row.textContent).not.toContain("(missing)");
		expect(removeButton(row)).toBeNull();
		expect(row.getAttribute("draggable")).toBe("true");
		row.click();
		expect(fake.openRef).toHaveBeenCalledTimes(1);
	});

	it("a missing non-added folder is still module-wired, as today", () => {
		const index = makeIndex([]);
		const { fake, renderInboxRow } = makeExplorer(index);
		renderInboxRow(folder("Promoted"), missingInfo("Promoted", "folder"));

		expect(fake.wireModuleRow).toHaveBeenCalledTimes(1);
	});

	it("a non-missing added row renders unchanged: no greyed state, no '(missing)', wired, opens on click", () => {
		const index = makeIndex([{ ref: file("live.md"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(file("live.md"), liveInfo("live", "file", { added: true }));

		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(row.textContent).toContain("added");
		expect(row.textContent).not.toContain("(missing)");
		expect(removeButton(row)).toBeNull();
		expect(row.getAttribute("draggable")).toBe("true");
		row.click();
		expect(fake.openRef).toHaveBeenCalledTimes(1);
	});

	it("a non-missing added folder is module-wired as before", () => {
		const index = makeIndex([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		renderInboxRow(folder("Jobs/Acme"), liveInfo("Acme", "folder", { added: true }));

		expect(fake.wireModuleRow).toHaveBeenCalledWith(expect.any(HTMLElement), expect.any(HTMLElement), "Jobs/Acme");
	});

	it("a missing added row that is also selected keeps its selected class until Remove clears it", () => {
		const index = makeIndex([{ ref: file("gone.md"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		fake.selectedInboxRefKeys.add(unitRefKey(file("gone.md")));
		const row = renderInboxRow(file("gone.md"), missingInfo("gone", "file"));

		expect(row.classList.contains("is-selected")).toBe(true);
	});
});

describe("G10 inbox missing row — Remove", () => {
	it("Remove takes the item out of addedItems, saves immediately, re-renders, and does not open the row", () => {
		const index = makeIndex([{ ref: file("gone.md"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		const row = renderInboxRow(file("gone.md"), missingInfo("gone", "file"));

		removeButton(row)!.click();

		expect(index.getAddedItems()).toEqual([]);
		expect(index.isAdded(file("gone.md"))).toBe(false);
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("Remove on a row that is also selected clears it from the selection (no ghost row)", () => {
		const index = makeIndex([{ ref: folder("Jobs/Acme"), tag: "added" }]);
		const { fake, renderInboxRow } = makeExplorer(index);
		fake.selectedInboxRefKeys.add(unitRefKey(folder("Jobs/Acme")));
		const row = renderInboxRow(folder("Jobs/Acme"), missingInfo("Acme", "folder"));

		removeButton(row)!.click();

		expect(fake.selectedInboxRefKeys.size).toBe(0);
	});

	it("two missing rows removed in quick succession both leave addedItems and nothing else", () => {
		const dismissed = [file("kept-dismissed.md")];
		const index = makeIndex(
			[
				{ ref: file("a.md"), tag: "added" },
				{ ref: folder("Jobs/B"), tag: "added" },
				{ ref: file("live.md"), tag: "added" },
			],
			dismissed
		);
		const { renderInboxRow } = makeExplorer(index);
		const rowA = renderInboxRow(file("a.md"), missingInfo("a", "file"));
		const rowB = renderInboxRow(folder("Jobs/B"), missingInfo("B", "folder"));

		removeButton(rowA)!.click();
		removeButton(rowB)!.click();

		expect(index.getAddedItems()).toEqual([{ ref: file("live.md"), tag: "added" }]);
		expect(index.getDismissedGlobal()).toEqual(dismissed);
	});

	it("Remove never auto-removes: rendering the same missing row again leaves it in addedItems", () => {
		const index = makeIndex([{ ref: file("gone.md"), tag: "added" }]);
		const { renderInboxRow } = makeExplorer(index);
		renderInboxRow(file("gone.md"), missingInfo("gone", "file"));
		const again = renderInboxRow(file("gone.md"), missingInfo("gone", "file"));

		expect(again.classList.contains("atlas-missing")).toBe(true);
		expect(index.isAdded(file("gone.md"))).toBe(true);
	});
});
