import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Menu, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import type { Unit, UnitRef, View } from "../../src/types";
import { createEmptyView } from "../../src/types";
import { seedRoot } from "../helpers";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";

const file = (path: string): UnitRef => ({ kind: "file", path });

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

// --- showInboxUnitMenu: "Dismiss" item registration and click wiring (G4-G6, F1) -------------------

type FakeMenuThis = {
	plugin: {
		unitIndex: {
			setDismissed: ReturnType<typeof vi.fn>;
			isDismissed: ReturnType<typeof vi.fn>;
			isAdded: ReturnType<typeof vi.fn>;
		};
		flushSave: ReturnType<typeof vi.fn>;
	};
	render: ReturnType<typeof vi.fn>;
};

function fakeMenuThis(opts: { isDismissed?: boolean; isAdded?: boolean } = {}): FakeMenuThis {
	return {
		plugin: {
			unitIndex: {
				setDismissed: vi.fn(),
				isDismissed: vi.fn(() => opts.isDismissed ?? false),
				isAdded: vi.fn(() => opts.isAdded ?? false),
			},
			flushSave: vi.fn(async () => {}),
		},
		render: vi.fn(async () => {}),
	};
}

function callShowInboxUnitMenu(fake: FakeMenuThis, ref: UnitRef, view: View): Menu {
	let builtMenu: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		builtMenu = this;
	});
	(
		AtlasExplorerView.prototype as unknown as {
			showInboxUnitMenu: (this: FakeMenuThis, evt: MouseEvent, ref: UnitRef, view: View) => void;
		}
	).showInboxUnitMenu.call(fake, new MouseEvent("contextmenu"), ref, view);
	return builtMenu!;
}

/** Same wiring as `callShowInboxUnitMenu`, but against a real `UnitIndex` instead of a mocked
 * `setDismissed` — needed for R2's G6 regression, which has to assert on real `isAdded`/
 * `getAddedItems`/`getManualPromotions` state after the click, not just on call shape. */
function callShowInboxUnitMenuWithRealIndex(index: UnitIndex, ref: UnitRef, view: View): Menu {
	const fake = {
		plugin: { unitIndex: index, flushSave: vi.fn(async () => {}) },
		render: vi.fn(async () => {}),
	};
	let builtMenu: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		builtMenu = this;
	});
	(
		AtlasExplorerView.prototype as unknown as {
			showInboxUnitMenu: (this: typeof fake, evt: MouseEvent, ref: UnitRef, view: View) => void;
		}
	).showInboxUnitMenu.call(fake, new MouseEvent("contextmenu"), ref, view);
	return builtMenu!;
}

describe("showInboxUnitMenu — Dismiss item (G4)", () => {
	it("registers a 'Dismiss' item alongside the existing items, using the same Menu/addItem pattern", () => {
		const fake = fakeMenuThis();
		const menu = callShowInboxUnitMenu(fake, file("Foo.md"), createEmptyView("v1", "Default"));
		expect(menu.titles()).toEqual(["Open", "Open in new tab", "Reveal in native explorer", "Copy link", "Place in view…", "Dismiss"]);
	});

	it("F1: exactly one removal-type item ('Dismiss') exists — never a second 'remove'/'un-add' item", () => {
		const fake = fakeMenuThis();
		const menu = callShowInboxUnitMenu(fake, file("Foo.md"), createEmptyView("v1", "Default"));
		const removalLike = menu.titles().filter((t) => /dismiss|remove|un-?add/i.test(t));
		expect(removalLike).toEqual(["Dismiss"]);
	});

	it("clicking Dismiss outside Global view calls the per-view write with the current view's id and the ref, and never the global write", () => {
		const fake = fakeMenuThis();
		const view = createEmptyView("v1", "Default"); // inboxMode defaults to "view"
		const ref = file("Foo.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		const dismissItem = menu.items.find((i) => i.title === "Dismiss")!;
		dismissItem.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(1);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "view", true, "v1");
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("G5: clicking Dismiss while in Global view calls the global write exactly once, and never the per-view write", () => {
		const fake = fakeMenuThis();
		const view: View = { ...createEmptyView("v1", "Default"), inboxMode: "global" };
		const ref = file("Foo.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		const dismissItem = menu.items.find((i) => i.title === "Dismiss")!;
		dismissItem.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(1);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "global", true);
	});

	it("G6: dismissing a non-added row calls the per-view write, using the 'Dismiss' label (the default, non-added config of this fake)", () => {
		const fake = fakeMenuThis();
		const view = createEmptyView("v1", "Default");
		const ref = file("Areas/Career/Notes.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		menu.items.find((i) => i.title === "Dismiss")!.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "view", true, "v1");
		// No "un-add"/clear-added call exists on the fake at all — if the implementation tried to call
		// one, this test would throw rather than silently pass.
	});

	it("R2/G6 (real UnitIndex): removing an added + manually-promoted row clears neither marker and removes it from the inbox", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const ref = file("Foo.md");
		const index = new UnitIndex(app, DEFAULT_SETTINGS, [ref]); // seeded manual promotion
		index.markAdded(ref);
		const view = createEmptyView("v1", "Default"); // inboxMode defaults to "view"

		const menu = callShowInboxUnitMenuWithRealIndex(index, ref, view);
		// Polish R1 (PR-4 finding): an added row's removal item reads "Remove", not "Dismiss" — the
		// underlying write (below) is identical either way.
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();

		expect(index.isAdded(ref)).toBe(true);
		expect(index.getAddedItems()).toEqual([{ ref, tag: "added" }]);
		expect(index.getManualPromotions()).toEqual([ref]);

		const views = new ViewsManager(app, [], "v1", () => {});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view", index)).toEqual([]);
	});

	it("idempotency: invoking the Dismiss click handler twice issues two identical writes, matching UnitIndex.setDismissed's own no-op-on-repeat contract (no throw)", () => {
		const fake = fakeMenuThis();
		const view = createEmptyView("v1", "Default");
		const ref = file("Foo.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);
		const dismissItem = menu.items.find((i) => i.title === "Dismiss")!;

		expect(() => {
			dismissItem.clickHandler!();
			dismissItem.clickHandler!();
		}).not.toThrow();
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(2);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenNthCalledWith(1, ref, "view", true, "v1");
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenNthCalledWith(2, ref, "view", true, "v1");
	});

	it("R1: on a real UnitIndex, a repeated per-view and a repeated global dismiss write each leave state unchanged (no duplicate entries)", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		const ref = file("Foo.md");

		index.setDismissed(ref, "view", true, "v1");
		index.setDismissed(ref, "view", true, "v1");
		expect(index.getDismissedByView()).toEqual({ v1: [ref] });

		index.setDismissed(ref, "global", true);
		index.setDismissed(ref, "global", true);
		expect(index.getDismissedGlobal()).toEqual([ref]);
	});
});

// --- Polish R1 (PR-4 finding): "Remove" label for manually-added rows, same dismiss-style write ----

describe("showInboxUnitMenu — 'Remove' label for manually-added rows (Polish R1)", () => {
	it("a manually-added, not-yet-dismissed row's removal item reads 'Remove', not 'Dismiss'", () => {
		const fake = fakeMenuThis({ isAdded: true });
		const menu = callShowInboxUnitMenu(fake, file("Areas/Added.md"), createEmptyView("v1", "Default"));
		expect(menu.titles()).toEqual(["Open", "Open in new tab", "Reveal in native explorer", "Copy link", "Place in view…", "Remove"]);
	});

	it("exactly one removal-type item exists either way — never both 'Dismiss' and 'Remove' at once", () => {
		const fake = fakeMenuThis({ isAdded: true });
		const menu = callShowInboxUnitMenu(fake, file("Areas/Added.md"), createEmptyView("v1", "Default"));
		const removalLike = menu.titles().filter((t) => /dismiss|remove|un-?hide|un-?add/i.test(t));
		expect(removalLike).toEqual(["Remove"]);
	});

	it("clicking 'Remove' writes through the exact same setDismissed(ref, scope, true) call as 'Dismiss'", () => {
		const fake = fakeMenuThis({ isAdded: true });
		const view = createEmptyView("v1", "Default");
		const ref = file("Areas/Added.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		menu.items.find((i) => i.title === "Remove")!.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "view", true, "v1");
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("a non-added row still reads 'Dismiss' (isAdded: false is the default)", () => {
		const fake = fakeMenuThis();
		const menu = callShowInboxUnitMenu(fake, file("Plain.md"), createEmptyView("v1", "Default"));
		expect(menu.titles()).toContain("Dismiss");
		expect(menu.titles()).not.toContain("Remove");
	});
});

// --- Polish R1 (PR-5 finding): "Unhide" item for a dismissed row revealed via Show Dismissed -------

describe("showInboxUnitMenu — 'Unhide' item for a revealed dismissed row (Polish R1)", () => {
	it("a row dismissed in this view (view mode) shows 'Unhide' instead of 'Dismiss'", () => {
		const fake = fakeMenuThis({ isDismissed: true });
		const view = createEmptyView("v1", "Default"); // inboxMode defaults to "view"
		const menu = callShowInboxUnitMenu(fake, file("Hidden.md"), view);
		expect(menu.titles()).toEqual(["Open", "Open in new tab", "Reveal in native explorer", "Copy link", "Place in view…", "Unhide"]);
	});

	it("exactly one removal-type item exists when hidden — 'Unhide' only, never 'Dismiss'/'Remove' alongside it", () => {
		const fake = fakeMenuThis({ isDismissed: true, isAdded: true });
		const view = createEmptyView("v1", "Default");
		const menu = callShowInboxUnitMenu(fake, file("Hidden.md"), view);
		const removalLike = menu.titles().filter((t) => /dismiss|remove|un-?hide|un-?add/i.test(t));
		expect(removalLike).toEqual(["Unhide"]);
	});

	it("clicking 'Unhide' outside Global view clears both the global and this view's own dismiss flag", () => {
		// Clearing only the current mode's scope isn't enough: a "view" mode read of isDismissed is an
		// OR-check against the global flag too, so a globally-dismissed row can show "Unhide" while
		// viewed in "view" mode. Both writes always run so the row actually comes back either way.
		const fake = fakeMenuThis({ isDismissed: true });
		const view = createEmptyView("v1", "Default");
		const ref = file("Hidden.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		menu.items.find((i) => i.title === "Unhide")!.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(2);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "global", false);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "view", false, "v1");
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("clicking 'Unhide' in Global view also clears both flags", () => {
		const fake = fakeMenuThis({ isDismissed: true });
		const view: View = { ...createEmptyView("v1", "Default"), inboxMode: "global" };
		const ref = file("Hidden.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		menu.items.find((i) => i.title === "Unhide")!.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(2);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "global", false);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "view", false, "v1");
	});

	it("'hidden' is scope-matched the same way getDismissedInboxUnits reads it: a view-scoped dismiss alone never shows 'Unhide' while reading in Global mode", () => {
		const fake = fakeMenuThis({ isDismissed: false }); // isDismissed("global") would read false here
		const view: View = { ...createEmptyView("v1", "Default"), inboxMode: "global" };
		const menu = callShowInboxUnitMenu(fake, file("OnlyViewDismissed.md"), view);
		expect(menu.titles()).toContain("Dismiss");
		expect(menu.titles()).not.toContain("Unhide");
		expect(fake.plugin.unitIndex.isDismissed).toHaveBeenCalledWith(file("OnlyViewDismissed.md"), "global");
	});

	it("R2 (real UnitIndex, end to end): Unhide on a globally-dismissed row, viewed in 'view' mode, still un-dismisses it and it reappears in the plain inbox", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const ref = file("Foo.md");
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(ref, "global", true);
		const view = createEmptyView("v1", "Default"); // inboxMode defaults to "view"
		const views = new ViewsManager(app, [], "v1", () => {});

		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view", index)).toEqual([]);

		const menu = callShowInboxUnitMenuWithRealIndex(index, ref, view);
		menu.items.find((i) => i.title === "Unhide")!.clickHandler!();

		expect(index.isDismissed(ref, "global")).toBe(false);
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});

	it("R3 (real UnitIndex): Unhide on a row dismissed only in this view's own set clears it, and the row reappears", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const ref = file("Foo.md");
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(ref, "view", true, "v1");
		const view = createEmptyView("v1", "Default");
		const views = new ViewsManager(app, [], "v1", () => {});

		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view", index)).toEqual([]);

		const menu = callShowInboxUnitMenuWithRealIndex(index, ref, view);
		menu.items.find((i) => i.title === "Unhide")!.clickHandler!();

		expect(index.getDismissedByView()).toEqual({});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});
});

// --- renderInboxRow: contextmenu always targets this row's own ref, ignoring multi-selection -------

interface FakeRowInfo {
	text: string;
	icon: string;
	promoted: boolean;
	added: boolean;
	missing: boolean;
	secondary?: string;
}

function callRenderInboxRowAndContextmenu(ref: UnitRef, view: View, showInboxUnitMenu: ReturnType<typeof vi.fn>): void {
	const fake = {
		selectedInboxRefKeys: new Set<string>(["file:Other.md", "file:AnotherOther.md"]),
		setPlacementTooltip: vi.fn(),
		showInboxUnitMenu,
	};
	const container = document.createElement("div");
	const info: FakeRowInfo = { text: "Foo", icon: "file", promoted: false, added: false, missing: false };
	const row = (
		AtlasExplorerView.prototype as unknown as {
			renderInboxRow: (this: typeof fake, container: HTMLElement, ref: UnitRef, info: FakeRowInfo, view: View) => HTMLElement;
		}
	).renderInboxRow.call(fake, container, ref, info, view);
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("renderInboxRow — contextmenu ignores multi-selection (existing showInboxUnitMenu behavior)", () => {
	it("right-clicking one row of a multi-selected set opens the menu for only that row's own ref", () => {
		const showInboxUnitMenu = vi.fn();
		const view = createEmptyView("v1", "Default");
		const ref = file("Clicked.md");

		callRenderInboxRowAndContextmenu(ref, view, showInboxUnitMenu);

		expect(showInboxUnitMenu).toHaveBeenCalledTimes(1);
		expect(showInboxUnitMenu).toHaveBeenCalledWith(expect.anything(), ref, view);
	});
});

// --- renderInboxRow: "hidden" badge for dismissed rows revealed via Show Dismissed (G8) -------------

function renderRow(ref: UnitRef, info: FakeRowInfo, hidden?: boolean): HTMLElement {
	const fake = {
		selectedInboxRefKeys: new Set<string>(),
		setPlacementTooltip: vi.fn(),
		showInboxUnitMenu: vi.fn(),
	};
	const container = document.createElement("div");
	return (
		AtlasExplorerView.prototype as unknown as {
			renderInboxRow: (this: typeof fake, container: HTMLElement, ref: UnitRef, info: FakeRowInfo, view: View, hidden?: boolean) => HTMLElement;
		}
	).renderInboxRow.call(fake, container, ref, info, createEmptyView("v1", "Default"), hidden);
}

describe("renderInboxRow — 'hidden' badge for Show Dismissed (G8)", () => {
	it("renders a 'hidden' badge, using the same atlas-badge construct as 'promoted'/'added', when hidden is true", () => {
		const info: FakeRowInfo = { text: "Foo", icon: "file", promoted: false, added: false, missing: false };
		const row = renderRow(file("Foo.md"), info, true);
		const badges = Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
		expect(badges).toEqual(["hidden"]);
	});

	it("renders no 'hidden' badge when hidden is false or omitted (default)", () => {
		const info: FakeRowInfo = { text: "Foo", icon: "file", promoted: false, added: false, missing: false };
		expect(Array.from(renderRow(file("Foo.md"), info, false).querySelectorAll(".atlas-badge"))).toEqual([]);
		expect(Array.from(renderRow(file("Foo.md"), info).querySelectorAll(".atlas-badge"))).toEqual([]);
	});

	it("a unit can show 'promoted' (or 'added') and 'hidden' together, without either clobbering the other in the DOM", () => {
		const promotedInfo: FakeRowInfo = { text: "Foo", icon: "file", promoted: true, added: false, missing: false };
		const promotedRow = renderRow(file("Foo.md"), promotedInfo, true);
		expect(Array.from(promotedRow.querySelectorAll(".atlas-badge")).map((b) => b.textContent)).toEqual(["promoted", "hidden"]);

		const addedInfo: FakeRowInfo = { text: "Bar", icon: "file", promoted: false, added: true, missing: false };
		const addedRow = renderRow(file("Bar.md"), addedInfo, true);
		expect(Array.from(addedRow.querySelectorAll(".atlas-badge")).map((b) => b.textContent)).toEqual(["added", "hidden"]);
	});
});

// --- showInboxHeaderMenu: "Show Dismissed" / "Hide Dismissed" toggle (G7) ---------------------------

type FakeHeaderMenuThis = { showDismissed: boolean; render: ReturnType<typeof vi.fn> };

function callShowInboxHeaderMenu(fake: FakeHeaderMenuThis): Menu {
	let builtMenu: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		builtMenu = this;
	});
	(
		AtlasExplorerView.prototype as unknown as {
			showInboxHeaderMenu: (this: FakeHeaderMenuThis, evt: MouseEvent) => void;
		}
	).showInboxHeaderMenu.call(fake, new MouseEvent("contextmenu"));
	return builtMenu!;
}

describe("showInboxHeaderMenu — Show/Hide Dismissed toggle (G7)", () => {
	it("while inactive, opens a menu with a single item reading 'Show Dismissed'", () => {
		const fake: FakeHeaderMenuThis = { showDismissed: false, render: vi.fn(async () => {}) };
		const menu = callShowInboxHeaderMenu(fake);
		expect(menu.titles()).toEqual(["Show Dismissed"]);
	});

	it("while active, the same menu's single item instead reads 'Hide Dismissed'", () => {
		const fake: FakeHeaderMenuThis = { showDismissed: true, render: vi.fn(async () => {}) };
		const menu = callShowInboxHeaderMenu(fake);
		expect(menu.titles()).toEqual(["Hide Dismissed"]);
	});

	it("clicking the toggle flips showDismissed and re-renders, with no persisted write (no flushSave on this fake)", () => {
		const fake: FakeHeaderMenuThis = { showDismissed: false, render: vi.fn(async () => {}) };
		const menu = callShowInboxHeaderMenu(fake);
		menu.items[0].clickHandler!();
		expect(fake.showDismissed).toBe(true);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("GP7: clicking 'Hide Dismissed' while active flips it back off", () => {
		const fake: FakeHeaderMenuThis = { showDismissed: true, render: vi.fn(async () => {}) };
		const menu = callShowInboxHeaderMenu(fake);
		menu.items[0].clickHandler!();
		expect(fake.showDismissed).toBe(false);
	});
});

// --- renderInboxSection: header contextmenu wiring (G7) and dismissed-row merge (G8) ----------------

type FakeInboxSectionThis = {
	inboxCollapsed: boolean;
	showDismissed: boolean;
	plugin: { viewsManager: { setInboxMode: ReturnType<typeof vi.fn> }; app: { vault: App["vault"] } };
	openAddFileModal: ReturnType<typeof vi.fn>;
	matchesFilter: ReturnType<typeof vi.fn>;
	sortMode: string;
	inboxSelectOrder: string[];
	inboxRefByKey: Map<string, UnitRef>;
	resolveRef: ReturnType<typeof vi.fn>;
	renderVirtualizedInboxRows: ReturnType<typeof vi.fn>;
	makeDropZone: ReturnType<typeof vi.fn>;
	showInboxHeaderMenu: ReturnType<typeof vi.fn>;
};

function fakeInboxSectionThis(app: App, infoByPath: Record<string, FakeRowInfo>): FakeInboxSectionThis {
	return {
		inboxCollapsed: false,
		showDismissed: false,
		plugin: { viewsManager: { setInboxMode: vi.fn() }, app: { vault: app.vault } },
		openAddFileModal: vi.fn(),
		matchesFilter: vi.fn(() => true),
		sortMode: "alphabetical",
		inboxSelectOrder: [],
		inboxRefByKey: new Map(),
		resolveRef: vi.fn(async (ref: UnitRef) => infoByPath[ref.path]),
		renderVirtualizedInboxRows: vi.fn(),
		makeDropZone: vi.fn(),
		showInboxHeaderMenu: vi.fn(),
	};
}

function callRenderInboxSectionWithDismissed(
	fake: FakeInboxSectionThis,
	container: HTMLElement,
	view: View,
	units: Unit[],
	dismissedUnits: Unit[]
): Promise<void> {
	return (
		AtlasExplorerView.prototype as unknown as {
			renderInboxSection: (
				this: FakeInboxSectionThis,
				container: HTMLElement,
				view: View,
				units: Unit[],
				dismissedUnits: Unit[],
				viewportScrollTop: number
			) => Promise<void>;
		}
	).renderInboxSection.call(fake, container, view, units, dismissedUnits, 0);
}

describe("renderInboxSection — header contextmenu is additive (G7)", () => {
	it("right-clicking the header opens the new menu via a dedicated contextmenu listener, without touching the existing collapse click listener", async () => {
		const app = new App();
		const fake = fakeInboxSectionThis(app, {});
		const container = document.createElement("div");

		await callRenderInboxSectionWithDismissed(fake, container, createEmptyView("v1", "Default"), [], []);

		const header = container.querySelector(".atlas-section-header")!;
		header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		expect(fake.showInboxHeaderMenu).toHaveBeenCalledTimes(1);

		// The header's own collapse-toggling click listener is wired in the same call and is
		// independent of the new contextmenu listener above (G7's "two separate listeners" note).
		expect(fake.inboxCollapsed).toBe(false);
		header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(fake.showInboxHeaderMenu).toHaveBeenCalledTimes(1); // still just the one contextmenu call
	});
});

describe("renderInboxSection — dismissed rows merge into the ordinary inbox list (G8)", () => {
	it("units and dismissedUnits are merged, sorted, and handed to renderVirtualizedInboxRows tagged hidden:true/false respectively", async () => {
		const app = new App();
		seedRoot(app, ["Alpha.md", "Beta.md"]);
		const fake = fakeInboxSectionThis(app, {
			"Alpha.md": { text: "Alpha", icon: "file", promoted: false, added: false, missing: false },
			"Beta.md": { text: "Beta", icon: "file", promoted: false, added: false, missing: false },
		});
		const container = document.createElement("div");
		const alpha = { type: "root-file", path: "Alpha.md" } as Unit;
		const beta = { type: "root-file", path: "Beta.md" } as Unit;

		await callRenderInboxSectionWithDismissed(fake, container, createEmptyView("v1", "Default"), [alpha], [beta]);

		expect(fake.renderVirtualizedInboxRows).toHaveBeenCalledTimes(1);
		const sorted = fake.renderVirtualizedInboxRows.mock.calls[0][1] as { ref: UnitRef; hidden: boolean }[];
		expect(sorted.map((r) => ({ path: r.ref.path, hidden: r.hidden }))).toEqual([
			{ path: "Alpha.md", hidden: false },
			{ path: "Beta.md", hidden: true },
		]);
	});

	it("with Show Dismissed off, dismissedUnits is empty (the caller's own gate) so no dismissed row reaches the merge at all", async () => {
		const app = new App();
		seedRoot(app, ["Alpha.md"]);
		const fake = fakeInboxSectionThis(app, {
			"Alpha.md": { text: "Alpha", icon: "file", promoted: false, added: false, missing: false },
		});
		const container = document.createElement("div");
		const alpha = { type: "root-file", path: "Alpha.md" } as Unit;

		await callRenderInboxSectionWithDismissed(fake, container, createEmptyView("v1", "Default"), [alpha], []);

		const sorted = fake.renderVirtualizedInboxRows.mock.calls[0][1] as { ref: UnitRef; hidden: boolean }[];
		expect(sorted).toEqual([{ ref: file("Alpha.md"), hidden: false, info: expect.anything(), unit: alpha }]);
	});

	it("the count badge reflects only the real (undismissed) inbox size, unaffected by Show Dismissed revealing extra rows", async () => {
		const app = new App();
		seedRoot(app, ["Alpha.md", "Beta.md"]);
		const fake = fakeInboxSectionThis(app, {
			"Alpha.md": { text: "Alpha", icon: "file", promoted: false, added: false, missing: false },
			"Beta.md": { text: "Beta", icon: "file", promoted: false, added: false, missing: false },
		});
		const container = document.createElement("div");
		const alpha = { type: "root-file", path: "Alpha.md" } as Unit;
		const beta = { type: "root-file", path: "Beta.md" } as Unit;

		await callRenderInboxSectionWithDismissed(fake, container, createEmptyView("v1", "Default"), [alpha], [beta]);

		const header = container.querySelector(".atlas-section-header")!;
		expect(header.querySelector(".atlas-count-badge")!.textContent).toBe("1");
	});
});

// --- getInboxUnits: dismissed-state render-time filter (G4/G5 OR-check) ----------------------------

function makeUnits(paths: string[]): Unit[] {
	return paths.map((path) => ({ type: "root-file", path }) as Unit);
}

describe("ViewsManager.getInboxUnits — dismissed-state OR-check (G4, G5, E7)", () => {
	it("a row whose ref is in the global dismiss set is excluded from every view's inbox, including a view with no per-view entry at all", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "global", true);
		const views = new ViewsManager(app, [], "v1", () => {});

		const units = makeUnits(["Foo.md"]);
		expect(views.getInboxUnits(units, "v1", "view", index)).toEqual([]);
		expect(views.getInboxUnits(units, "a-view-never-seen-before", "view", index)).toEqual([]);
		expect(views.getInboxUnits(units, "v1", "global", index)).toEqual([]);
	});

	it("a row dismissed only in one view's per-view map still appears in another view's resolved inbox and in Global's", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "view", true, "v1");
		const views = new ViewsManager(app, [], "v1", () => {});

		const units = makeUnits(["Foo.md"]);
		expect(views.getInboxUnits(units, "v1", "view", index)).toEqual([]);
		expect(views.getInboxUnits(units, "v2", "view", index).map((u) => u.path)).toEqual(["Foo.md"]);
		expect(views.getInboxUnits(units, "v1", "global", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});

	it("G4: a non-Global dismiss never writes to the global set, so Global's own inbox is unaffected", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "view", true, "v1");
		const views = new ViewsManager(app, [], "v1", () => {});

		expect(index.getDismissedGlobal()).toEqual([]);
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "global", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});

	it("E7: a view that exists but was never rendered still has a prior Global dismiss applied once resolved, with no per-view write needed", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "global", true);
		const views = new ViewsManager(app, [], "v1", () => {});

		// "never-rendered-view" never got a per-view dismiss entry of its own — the global entry alone
		// must still exclude the row once this view is resolved.
		expect(index.getDismissedByView()).toEqual({});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "never-rendered-view", "view", index)).toEqual([]);
	});

	it("without a unitIndex argument, behaves exactly as before (back-compat for existing callers)", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const views = new ViewsManager(app, [], "v1", () => {});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view").map((u) => u.path)).toEqual(["Foo.md"]);
	});
});

describe("ViewsManager.getDismissedInboxUnits — the complement of getInboxUnits (G8)", () => {
	it("returns exactly the units getInboxUnits excludes for the same (viewId, mode) — a global dismiss, read in view mode", () => {
		const app = new App();
		seedRoot(app, ["Foo.md", "Bar.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "global", true);
		const views = new ViewsManager(app, [], "v1", () => {});
		const units = makeUnits(["Foo.md", "Bar.md"]);

		expect(views.getInboxUnits(units, "v1", "view", index).map((u) => u.path)).toEqual(["Bar.md"]);
		expect(views.getDismissedInboxUnits(units, "v1", "view", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});

	it("a per-view dismiss is only revealed by Show Dismissed in that same view, not in a sibling view or Global", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "view", true, "v1");
		const views = new ViewsManager(app, [], "v1", () => {});
		const units = makeUnits(["Foo.md"]);

		expect(views.getDismissedInboxUnits(units, "v1", "view", index).map((u) => u.path)).toEqual(["Foo.md"]);
		expect(views.getDismissedInboxUnits(units, "v2", "view", index)).toEqual([]);
		expect(views.getDismissedInboxUnits(units, "v1", "global", index)).toEqual([]);
	});

	it("G4: mirrors getInboxUnits' own mode semantics — global mode only ever reads the global dismiss set", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "view", true, "v1");
		const views = new ViewsManager(app, [], "v1", () => {});

		expect(views.getDismissedInboxUnits(makeUnits(["Foo.md"]), "v1", "global", index)).toEqual([]);
	});

	it("never reveals a unit that's placed somewhere (dismissed-but-placed is not a real state, but the placed-filter still applies first)", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "global", true);
		const views = new ViewsManager(app, [], "v1", () => {});
		const viewId = views.getActiveViewId();
		views.placeUnit(viewId, file("Foo.md"), null);

		expect(views.getDismissedInboxUnits(makeUnits(["Foo.md"]), viewId, "view", index)).toEqual([]);
	});
});

// --- Integration: PR-2 (dismiss) + PR-4 (inbox filtering) + PR-5 (Show Dismissed reveal), end to
// end through a real UnitIndex, real ViewsManager, and the actual renderInboxSection render path
// (G10 end-to-end) -------------------------------------------------------------------------------

describe("renderInboxSection — dismiss wins over re-promotion, end to end (G10)", () => {
	it("a dismissed file that gains a new outside-module link stays out of the plain inbox, and is only revealed — tagged 'hidden' — once Show Dismissed is on", async () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Source.md", "ModuleB/Target.md"], ["ModuleA", "ModuleB"]);
		const caches: Record<string, CachedMetadata> = {};
		const resolve: Record<string, string> = {};
		app.metadataCache.getFileCache = ((f: TFile) => caches[f.path] ?? null) as App["metadataCache"]["getFileCache"];
		app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
			const destPath = resolve[linkpath];
			return destPath ? (app.vault.getAbstractFileByPath(destPath) as TFile) : null;
		}) as App["metadataCache"]["getFirstLinkpathDest"];

		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.rebuild();
		const targetRef = file("ModuleB/Target.md");
		index.setDismissed(targetRef, "global", true);

		// A cross-module link now appears — Target.md would normally auto-promote into the inbox.
		caches["ModuleA/Source.md"] = { links: [{ link: "Target", original: "[[Target]]" } as never] };
		resolve["Target"] = "ModuleB/Target.md";
		index.onMetadataResolved();
		expect(index.getUnits().some((u) => u.type === "promoted-file" && u.path === "ModuleB/Target.md")).toBe(true);

		const views = new ViewsManager(app, [], "v1", () => {});
		const viewId = views.getActiveViewId();
		const view = createEmptyView(viewId, "Default");
		const allUnits = index.getUnits();

		async function renderWith(showDismissed: boolean): Promise<HTMLElement> {
			const inboxUnits = views.getInboxUnits(allUnits, view.id, "global", index);
			const dismissedUnits = showDismissed ? views.getDismissedInboxUnits(allUnits, view.id, "global", index) : [];
			const fake = fakeInboxSectionThis(app, {
				"ModuleA": { text: "ModuleA", icon: "folder", promoted: false, added: false, missing: false },
				"ModuleB": { text: "ModuleB", icon: "folder", promoted: false, added: false, missing: false },
				"ModuleB/Target.md": { text: "Target", icon: "file", promoted: true, added: false, missing: false },
			});
			fake.renderVirtualizedInboxRows = vi.fn((listEl: HTMLElement, sorted: { ref: UnitRef; info: FakeRowInfo; hidden: boolean }[]) => {
				for (const { ref, info, hidden } of sorted) {
					(
						AtlasExplorerView.prototype as unknown as {
							renderInboxRow: (this: unknown, container: HTMLElement, ref: UnitRef, info: FakeRowInfo, view: View, hidden?: boolean) => HTMLElement;
						}
					).renderInboxRow.call(
						{ selectedInboxRefKeys: new Set(), setPlacementTooltip: vi.fn(), showInboxUnitMenu: vi.fn(), wireModuleRow: vi.fn() },
						listEl,
						ref,
						info,
						view,
						hidden,
					);
				}
			});
			const container = document.createElement("div");
			await callRenderInboxSectionWithDismissed(fake, container, view, inboxUnits, dismissedUnits);
			return container;
		}

		const plain = await renderWith(false);
		expect(plain.querySelector('[data-ref-key="file:ModuleB/Target.md"]')).toBeNull();

		const revealed = await renderWith(true);
		const row = revealed.querySelector('[data-ref-key="file:ModuleB/Target.md"]')!;
		expect(row).not.toBeNull();
		// It's both newly re-promoted and still dismissed — both badges coexist (G8), and the row
		// is only visible at all because Show Dismissed revealed it (G10).
		expect(Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent)).toEqual(["promoted", "hidden"]);
	});
});
