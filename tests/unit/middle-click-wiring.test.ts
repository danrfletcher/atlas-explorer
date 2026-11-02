import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { createEmptyView, unitRefKey } from "../../src/types";
import type { AddedItem, UnitRef, View, ViewNode } from "../../src/types";

/** Wiring of the middle-click gesture on the real `renderNode` (bucket) and `renderInboxRow` (inbox),
 * driven through the fake-`this` `.call(fake, ...)` pattern (see inbox-missing-row / bucket-row-pills).
 * `handleSelectionClick` is the REAL method wrapped in a spy, so selection assertions exercise the real
 * selection code; the vault is a real in-memory vault whose mutating calls are recorded. */

type Proto = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as Proto;

const file: UnitRef = { kind: "file", path: "Projects/Boat.md" };
const block: UnitRef = { kind: "block", path: "_pool/20260101000000-abcd.md", subpath: "^abcd" };
const module_: UnitRef = { kind: "folder", path: "Modules/WithNote" };
const emptyModule: UnitRef = { kind: "folder", path: "Modules/NoNote" };

interface Info {
	text: string;
	icon: string;
	promoted: boolean;
	added: boolean;
	missing: boolean;
}
const liveInfo = (text = "Boat", over: Partial<Info> = {}): Info => ({ text, icon: "file", promoted: false, added: false, missing: false, ...over });

function seedApp(): App {
	const app = new App();
	const v = app.vault;
	v.seedFolder("Projects");
	v.seedFile("Projects/Boat.md");
	v.seedFolder("_pool");
	v.seedFile("_pool/20260101000000-abcd.md");
	v.seedFolder("Modules");
	v.seedFolder("Modules/WithNote");
	v.seedFile("Modules/WithNote/WithNote.md");
	v.seedFolder("Modules/NoNote");
	return app;
}

function makeFake(app: App, index?: UnitIndex) {
	const fake: Record<string, unknown> = {
		plugin: { app, settings: { ...DEFAULT_SETTINGS }, unitIndex: index, viewsManager: { managedRowFilterState: vi.fn(() => "shown") }, flushSave: vi.fn(async () => {}) },
		selectedBucketNodeIds: new Set<string>(["n1", "n2", "n3"]),
		selectedInboxRefKeys: new Set<string>(["file:Other.md"]),
		selectionAnchor: "n2" as string | null,
		selectionAnchorScope: "bucket" as "bucket" | "inbox" | null,
		inboxSelectOrder: [] as string[],
		isOutsideManagedUnit: vi.fn(() => false),
		resolveOutsideManagedRowInfo: vi.fn(() => liveInfo()),
		resolveRef: vi.fn(async () => liveInfo()),
		matchesFilter: vi.fn(() => true),
		renderRowIcon: vi.fn(),
		wireModuleRow: vi.fn(),
		setPlacementTooltip: vi.fn(),
		bucketVisibleOrder: vi.fn(() => ["n1", "n2", "n3"]),
		openRef: vi.fn(async () => {}),
		makeDropZone: vi.fn(),
		buildNodeDragPayload: vi.fn(() => ({})),
		buildInboxDragPayload: vi.fn(() => ({ kind: "inbox" })),
		handleRowKeydown: vi.fn(),
		showUnitMenu: vi.fn(),
		showInboxUnitMenu: vi.fn(),
		renderFoldableChildren: vi.fn(async () => {}),
		render: vi.fn(async () => {}),
		renderConnectionDots: proto.renderConnectionDots,
	};
	fake.handleSelectionClick = vi.fn((...args: unknown[]) => proto.handleSelectionClick.call(fake, ...args));
	return fake as Record<string, ReturnType<typeof vi.fn>> & {
		plugin: { app: App; unitIndex: UnitIndex };
		selectedBucketNodeIds: Set<string>;
		selectedInboxRefKeys: Set<string>;
		selectionAnchor: string | null;
		selectionAnchorScope: string | null;
	};
}
type Fake = ReturnType<typeof makeFake>;

const view: View = createEmptyView("v1", "Default");

async function renderBucketRow(fake: Fake, ref: UnitRef, info: Info, opts: { outsideManaged?: boolean } = {}): Promise<HTMLElement> {
	fake.isOutsideManagedUnit.mockReturnValue(opts.outsideManaged ?? false);
	fake.resolveRef.mockResolvedValue(info);
	fake.resolveOutsideManagedRowInfo.mockReturnValue(info);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const node = { id: "n1", type: "unit", ref, children: [] } as ViewNode;
	await (proto.renderNode as unknown as (...a: unknown[]) => Promise<void>).call(fake, node, container, view, 0, []);
	return container.querySelector<HTMLElement>(".atlas-row-unit")!;
}

function renderInboxRow(fake: Fake, ref: UnitRef, info: Info): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	(proto.renderInboxRow as unknown as (...a: unknown[]) => HTMLElement).call(fake, container, ref, info, view, false);
	return container.firstElementChild as HTMLElement;
}

const aux = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true, ...init }));
const label = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-row-text")!;

let app: App;
beforeEach(() => {
	app = seedApp();
	Notice.reset();
	app.vault.calls.length = 0;
});
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

/** F4: nothing but opening happened — no vault mutation, no notice. */
function expectNoSideEffects(fake: Fake) {
	expect(app.vault.calls).toEqual([]);
	expect(Notice.instances).toEqual([]);
	expect(fake.render).not.toHaveBeenCalled();
	expect(fake.handleSelectionClick).not.toHaveBeenCalled();
}

describe("E1 mousedown guard on every row kind", () => {
	const down = (target: Element, button: number) => {
		const evt = new MouseEvent("mousedown", { button, bubbles: true, cancelable: true });
		target.dispatchEvent(evt);
		return evt;
	};

	it("bucket unit row: button 1 is prevented, buttons 0 and 2 are not, and the row stays focusable", async () => {
		const row = await renderBucketRow(makeFake(app), file, liveInfo());
		expect(down(label(row), 1).defaultPrevented).toBe(true);
		expect(down(label(row), 0).defaultPrevented).toBe(false);
		expect(down(label(row), 2).defaultPrevented).toBe(false);
		expect(row.tabIndex).toBe(0);
	});

	it("bucket unit row: the guard also covers a click that lands on a control (chevron)", async () => {
		const row = await renderBucketRow(makeFake(app), file, liveInfo());
		expect(down(row.querySelector(".atlas-chevron")!, 1).defaultPrevented).toBe(true);
	});

	it("inbox row: button 1 is prevented, buttons 0 and 2 are not, and the row stays focusable", () => {
		const row = renderInboxRow(makeFake(app, new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], [])), file, liveInfo());
		expect(down(label(row), 1).defaultPrevented).toBe(true);
		expect(down(label(row), 0).defaultPrevented).toBe(false);
		expect(down(label(row), 2).defaultPrevented).toBe(false);
		expect(row.tabIndex).toBe(0);
	});

	it("Folder (meta) row: button 1 is prevented, buttons 0 and 2 are not", async () => {
		const fake = makeFake(app);
		fake.computeEffectiveCollapsed = vi.fn(async () => true);
		fake.renderSortIndicator = vi.fn();
		fake.plugin.statusesManager = { findSortGovernor: () => null } as never;
		const container = document.createElement("div");
		const node = { id: "m1", type: "meta", label: "Planning", children: [] } as ViewNode;
		await (proto.renderNode as unknown as (...a: unknown[]) => Promise<void>).call(fake, node, container, view, 0, []);
		const row = container.querySelector<HTMLElement>(".atlas-row-meta")!;
		expect(down(label(row), 1).defaultPrevented).toBe(true);
		expect(down(label(row), 0).defaultPrevented).toBe(false);
		expect(down(label(row), 2).defaultPrevented).toBe(false);
		// ...and middle-click on it opens nothing and changes no selection.
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(fake.selectedBucketNodeIds).toEqual(new Set(["n1", "n2", "n3"]));
	});
});

describe("bucket row middle-click (G1-G3, G10, G14, GP1-GP3, F4, E2, E6)", () => {
	it("GP1/GP2: middle-click on the label opens the ref in a new tab", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo());
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(file, true);
	});

	it("G10/G14/GP3/F4: the clicked row opens; neither selection nor the anchor changes; nothing re-renders or touches the vault", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo());
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledTimes(1);
		expect(fake.selectedBucketNodeIds).toEqual(new Set(["n1", "n2", "n3"]));
		expect(fake.selectedInboxRefKeys).toEqual(new Set(["file:Other.md"]));
		expect(fake.selectionAnchor).toBe("n2");
		expect(fake.selectionAnchorScope).toBe("bucket");
		expect(fake.handleSelectionClick).not.toHaveBeenCalled();
		expect(fake.render).not.toHaveBeenCalled();
		expect(app.vault.calls).toEqual([]);
		expect(Notice.instances).toEqual([]);
	});

	it("GP3: a row that was not selected is not selected afterwards", async () => {
		const fake = makeFake(app);
		fake.selectedBucketNodeIds.clear();
		fake.selectedInboxRefKeys.clear();
		const row = await renderBucketRow(fake, file, liveInfo());
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledTimes(1);
		expect(fake.selectedBucketNodeIds.size).toBe(0);
		expect(fake.selectedInboxRefKeys.size).toBe(0);
		expect(row.classList.contains("is-selected")).toBe(false);
	});

	it("G2: a block opens in a new tab", async () => {
		const fake = makeFake(app);
		aux(label(await renderBucketRow(fake, block, liveInfo("Idea"))));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(block, true);
	});

	it("G3: a module opens through its row body, but not through its icon", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, module_, liveInfo("WithNote", { icon: "folder" }));
		aux(row.querySelector(".atlas-icon")!);
		expect(fake.openRef).not.toHaveBeenCalled();
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(module_, true);
	});

	it("G4: a module's icon in status-dot form does nothing", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, module_, liveInfo("WithNote", { icon: "folder" }));
		const icon = row.querySelector<HTMLElement>(".atlas-icon")!;
		icon.classList.add("atlas-status-dot");
		const circle = icon.createDiv({ cls: "atlas-status-dot-circle" });
		aux(icon);
		aux(circle);
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("G3/E2: a module without an interface note does nothing and creates nothing", async () => {
		const fake = makeFake(app);
		aux(label(await renderBucketRow(fake, emptyModule, liveInfo("NoNote", { icon: "folder" }))));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(app.vault.getAbstractFileByPath("Modules/NoNote/NoNote.md")).toBeNull();
		expectNoSideEffects(fake);
	});

	it("G7/E2: a missing row does nothing, and its Remove control does nothing either", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo("Boat", { missing: true }));
		aux(label(row));
		aux(row.querySelector(".atlas-row-action")!);
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(row.classList.contains("atlas-missing")).toBe(true);
		expectNoSideEffects(fake);
	});

	it("G7/E3: a block row whose file was deleted after render does nothing and creates no file", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, block, liveInfo("Idea"));
		await app.vault.delete(app.vault.getAbstractFileByPath(block.path)!);
		app.vault.calls.length = 0;
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(app.vault.calls).toEqual([]);
	});

	it("G8/E6: an Outside-Vault child does nothing and keeps draggable=false and no drop zone", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo(), { outsideManaged: true });
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(row.getAttribute("draggable")).toBe("false");
		expect(fake.makeDropZone).not.toHaveBeenCalled();
		expectNoSideEffects(fake);
	});

	it("G9: controls (chevron, badge, connection dot, sort indicator, Remove, status dot) do nothing", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo("Boat", { missing: false }));
		const extra = ["atlas-badge", "atlas-api-connection-dot", "atlas-sort-indicator", "atlas-row-action"].map((cls) => row.createDiv({ cls }));
		const dot = row.querySelector<HTMLElement>(".atlas-icon")!;
		dot.classList.add("atlas-status-dot");
		for (const target of [row.querySelector(".atlas-chevron")!, dot, ...extra, extra[3].createSpan()]) aux(target);
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("G12/added: modifiers and buttons 0 and 2 are ignored", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo());
		for (const mod of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) aux(label(row), { [mod]: true });
		aux(label(row), { button: 0 });
		aux(label(row), { button: 2 });
		expect(fake.openRef).not.toHaveBeenCalled();
		expectNoSideEffects(fake);
	});

	it("E4: five rapid middle-clicks make five openRef(ref, true) calls", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo());
		for (let i = 0; i < 5; i++) aux(label(row));
		expect(fake.openRef).toHaveBeenCalledTimes(5);
		for (const call of fake.openRef.mock.calls) expect(call).toEqual([file, true]);
	});
});

describe("fence: other gestures on a bucket row are unchanged (F2, F3)", () => {
	it("F2: Cmd-click toggles selection and opens nothing", async () => {
		const fake = makeFake(app);
		fake.selectedBucketNodeIds.clear();
		const row = await renderBucketRow(fake, file, liveInfo());
		row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		expect(fake.selectedBucketNodeIds).toEqual(new Set(["n1"]));
		expect(fake.openRef).not.toHaveBeenCalled();
		row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
		expect(fake.selectedBucketNodeIds.size).toBe(0);
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("F2: Shift-click range-selects and opens nothing", async () => {
		const fake = makeFake(app);
		fake.selectionAnchor = "n3";
		fake.selectedBucketNodeIds.clear();
		const row = await renderBucketRow(fake, file, liveInfo());
		row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
		expect(fake.selectedBucketNodeIds).toEqual(new Set(["n1", "n2", "n3"]));
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("F3: a plain click still selects the row and opens it in the current tab (no newTab argument)", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo());
		row.click();
		expect(fake.selectedBucketNodeIds).toEqual(new Set(["n1"]));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(file);
	});

	it("F3: right-click still opens the unit menu, and a plain click on an Outside child still opens nothing", async () => {
		const fake = makeFake(app);
		const row = await renderBucketRow(fake, file, liveInfo());
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		expect(fake.showUnitMenu).toHaveBeenCalledTimes(1);
		const outsideFake = makeFake(app);
		const outside = await renderBucketRow(outsideFake, file, liveInfo(), { outsideManaged: true });
		outside.click();
		expect(outsideFake.openRef).not.toHaveBeenCalled();
	});
});

describe("inbox row middle-click (G1-G3, G7, G9, G10, GP4, E6, added)", () => {
	const makeIndex = (added: AddedItem[] = []) => new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], added);
	const ideas: UnitRef = { kind: "file", path: "Notes/Ideas.md" };

	beforeEach(() => {
		app.vault.seedFolder("Notes");
		app.vault.seedFile("Notes/Ideas.md");
	});

	it("GP4: opens the ref in a new tab; selection (inbox and bucket) and anchor are untouched", () => {
		const fake = makeFake(app, makeIndex());
		fake.selectedInboxRefKeys.add(unitRefKey(ideas));
		const row = renderInboxRow(fake, ideas, liveInfo("Ideas"));
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(ideas, true);
		expect(fake.selectedInboxRefKeys).toEqual(new Set(["file:Other.md", unitRefKey(ideas)]));
		expect(fake.selectedBucketNodeIds).toEqual(new Set(["n1", "n2", "n3"]));
		expect(fake.selectionAnchor).toBe("n2");
		expect(fake.selectionAnchorScope).toBe("bucket");
		expectNoSideEffects(fake);
	});

	it("G2/G3: blocks and modules open; a module's icon and a module without a note do not", () => {
		const fake = makeFake(app, makeIndex());
		aux(label(renderInboxRow(fake, block, liveInfo("Idea"))));
		const moduleRow = renderInboxRow(fake, module_, liveInfo("WithNote", { icon: "folder" }));
		aux(moduleRow.querySelector(".atlas-icon")!);
		aux(label(moduleRow));
		aux(label(renderInboxRow(fake, emptyModule, liveInfo("NoNote", { icon: "folder" }))));
		expect(fake.openRef.mock.calls).toEqual([
			[block, true],
			[module_, true],
		]);
	});

	it("G7/E6: a missing added row does nothing and is not removed from addedItems", () => {
		const gone: UnitRef = { kind: "file", path: "gone.md" };
		const index = makeIndex([{ ref: gone, tag: "added" }]);
		const fake = makeFake(app, index);
		const row = renderInboxRow(fake, gone, liveInfo("gone", { missing: true }));
		aux(label(row));
		aux(row.querySelector(".atlas-row-action")!);
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(index.getAddedItems()).toEqual([{ ref: gone, tag: "added" }]);
		expectNoSideEffects(fake);
	});

	it("added: a missing row that is NOT added (promoted/link-derived) does nothing on middle-click although plain click still opens it", () => {
		const linked: UnitRef = { kind: "file", path: "linked.md" };
		const fake = makeFake(app, makeIndex());
		const row = renderInboxRow(fake, linked, liveInfo("linked", { missing: true, promoted: true }));
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		row.click();
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(linked);
	});

	it("G7/E3: an inbox block whose file was deleted does nothing and creates no file", async () => {
		const fake = makeFake(app, makeIndex());
		const row = renderInboxRow(fake, block, liveInfo("Idea"));
		await app.vault.delete(app.vault.getAbstractFileByPath(block.path)!);
		app.vault.calls.length = 0;
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(app.vault.calls).toEqual([]);
	});

	it("G9: the promoted/added/hidden pills and a nested child of Remove do nothing", () => {
		const fake = makeFake(app, makeIndex());
		const row = renderInboxRow(fake, ideas, liveInfo("Ideas", { promoted: true, added: true }));
		const badges = Array.from(row.querySelectorAll(".atlas-badge"));
		expect(badges.length).toBeGreaterThan(0);
		for (const b of badges) aux(b);
		const action = row.createDiv({ cls: "atlas-row-action" });
		aux(action.createSpan());
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("G12: modifiers are ignored; F2: Cmd/Shift-click still select and open nothing", () => {
		const fake = makeFake(app, makeIndex());
		const row = renderInboxRow(fake, ideas, liveInfo("Ideas"));
		for (const mod of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) aux(label(row), { [mod]: true });
		expect(fake.openRef).not.toHaveBeenCalled();
		row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		expect(fake.selectedInboxRefKeys.has(unitRefKey(ideas))).toBe(true);
		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("F3: plain click and right-click on an inbox row are unchanged", () => {
		const fake = makeFake(app, makeIndex());
		const row = renderInboxRow(fake, ideas, liveInfo("Ideas"));
		row.click();
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(ideas);
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		expect(fake.showInboxUnitMenu).toHaveBeenCalledTimes(1);
	});
});

/** Atlas #13 PR-1 (GP4): the REAL `resolveRef` feeds the real `renderNode`, so a placed file that is
 * not a unit (it is in no `unitsByRefKey`) is judged by whether it still exists, and middle-click
 * follows. `refTargetExists` is checked against the shared presence rule. */
describe("Atlas #13 PR-1 — middle-click on a placed ref that is not a unit", () => {
	const moved: UnitRef = { kind: "file", path: "Modules/WithNote/Moved.md" };
	const pdf: UnitRef = { kind: "file", path: "Modules/WithNote/scan.pdf" };

	async function realBucketRow(ref: UnitRef, opts: { skipSeed?: boolean } = {}) {
		if (!opts.skipSeed) {
			app.vault.seedFile(moved.path);
			app.vault.seedFile(pdf.path);
		}
		const fake = makeFake(app);
		(fake as unknown as Record<string, unknown>).unitsByRefKey = new Map();
		fake.resolveRef = ((r: UnitRef) => (proto.resolveRef as (r: UnitRef) => Promise<unknown>).call(fake, r)) as never;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const node = { id: "n1", type: "unit", ref, children: [] } as ViewNode;
		await (proto.renderNode as unknown as (...a: unknown[]) => Promise<void>).call(fake, node, container, view, 0, []);
		return { fake, row: container.querySelector<HTMLElement>(".atlas-row-unit")! };
	}

	it("a present non-unit file reads normally and middle-click calls openRef(ref, true)", async () => {
		const { fake, row } = await realBucketRow(moved);
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(label(row).textContent).toBe("Moved");
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(moved, true);
		expectNoSideEffects(fake);
	});

	it("E11: a present non-unit PDF opens the same way", async () => {
		const { fake, row } = await realBucketRow(pdf);
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(pdf, true);
	});

	it("a file deleted after render does nothing on middle-click", async () => {
		const { fake, row } = await realBucketRow(moved);
		await app.vault.delete(app.vault.getAbstractFileByPath(moved.path)!);
		app.vault.calls.length = 0;
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(app.vault.calls).toEqual([]);
	});

	it("a target deleted before render renders missing and middle-click does nothing", async () => {
		app.vault.seedFile(moved.path);
		await app.vault.delete(app.vault.getAbstractFileByPath(moved.path)!);
		const fakeNode = await realBucketRow({ kind: "file", path: moved.path }, { skipSeed: true });
		expect(fakeNode.row.classList.contains("atlas-missing")).toBe(true);
		aux(label(fakeNode.row));
		expect(fakeNode.fake.openRef).not.toHaveBeenCalled();
	});

	it("a present non-unit folder with no interface note: normal module row, middle-click does nothing", async () => {
		const { fake, row } = await realBucketRow(emptyModule);
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(label(row).textContent).toBe("NoNote");
		aux(label(row));
		expect(fake.openRef).not.toHaveBeenCalled();
		expect(app.vault.getAbstractFileByPath("Modules/NoNote/NoNote.md")).toBeNull();
	});

	it("a present non-unit folder with an interface note opens it on middle-click", async () => {
		const { fake, row } = await realBucketRow(module_);
		aux(label(row));
		expect(fake.openRef).toHaveBeenCalledExactlyOnceWith(module_, true);
	});
});
