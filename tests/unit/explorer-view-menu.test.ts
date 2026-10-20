import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Menu, Notice } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ATLAS_SORT_AZ_ICON_ID } from "../../src/sort";
import { ApiItemState, StatusGovernance, View, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import { flush } from "../helpers";
import { meta } from "../integration/create-from-meta-fixtures";

// PR-2.F3: the real Folder add-under flow opens a `TextPromptModal` — recorded here the same way
// `tests/unit/add-under-folder.test.ts` does, so the test below can drive its submit callback
// directly instead of simulating real DOM input.
const captured = vi.hoisted(() => ({
	prompts: [] as { onSubmit: (v: string) => void; onCancel?: () => void }[],
}));

vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingPrompt {
		constructor(_app: unknown, _title: string, _initial: string, public onSubmit: (v: string) => void, _placeholder?: string, public onCancel?: () => void) {
			captured.prompts.push(this);
		}
		open(): void {}
	}
	return { ...actual, TextPromptModal: RecordingPrompt };
});

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };
const folderNode: ViewNode = { id: "folder", type: "meta", label: "Folder", children: [] };

function item(overrides: Partial<ApiItemState> = {}): ApiItemState {
	return { id: "1", label: "Row", kind: "placeholder", ...overrides };
}

function buildMenu(it: ApiItemState, node: ViewNode = folderNode) {
	const fake = {
		plugin: { viewsManager: { removeApiItem: vi.fn(), clearApiItemNoteRef: vi.fn() } },
	};
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	(AtlasExplorerView.prototype as unknown as { showApiItemMenu: (...a: unknown[]) => void }).showApiItemMenu.call(
		fake,
		new MouseEvent("contextmenu"),
		view,
		node,
		it
	);
	show.mockRestore();
	return { menu: built!, fake };
}

describe("G26 — Remove menu item enablement", () => {
	it("appears only when the row is notFound", () => {
		const { menu } = buildMenu(item({ notFound: true }));
		expect(menu.titles()).toContain("Remove");
	});

	it("is absent when the row is not notFound", () => {
		const { menu } = buildMenu(item());
		expect(menu.titles()).not.toContain("Remove");
	});

	it("clicking Remove deletes the apiItemState entry via ViewsManager, and nothing else", () => {
		const { menu, fake } = buildMenu(item({ notFound: true }));
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();
		expect(fake.plugin.viewsManager.removeApiItem).toHaveBeenCalledWith("v1", "folder", "1");
		expect(fake.plugin.viewsManager.clearApiItemNoteRef).not.toHaveBeenCalled();
	});

	it("E6: Remove still removes the entry even if notFound flips back to false between menu-open and click", () => {
		const row = item({ notFound: true });
		const { menu, fake } = buildMenu(row);
		// Mutate the live item after the menu (and its click handler) was already built, simulating
		// the row flipping back to found before the user's click resolves.
		row.notFound = false;
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();
		expect(fake.plugin.viewsManager.removeApiItem).toHaveBeenCalledWith("v1", "folder", "1");
	});
});

describe("G28 — Remove attachment menu item enablement", () => {
	it("appears whenever noteRef is set, regardless of notFound", () => {
		const { menu } = buildMenu(item({ noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles()).toContain("Remove attachment");
	});

	it("is absent when noteRef is unset", () => {
		const { menu } = buildMenu(item());
		expect(menu.titles()).not.toContain("Remove attachment");
	});

	it("clicking Remove attachment clears only the noteRef via ViewsManager", () => {
		const { menu, fake } = buildMenu(item({ noteRef: { kind: "file", path: "Note.md" } }));
		menu.items.find((i) => i.title === "Remove attachment")!.clickHandler!();
		expect(fake.plugin.viewsManager.clearApiItemNoteRef).toHaveBeenCalledWith("v1", "folder", "1");
		expect(fake.plugin.viewsManager.removeApiItem).not.toHaveBeenCalled();
	});

	it("is independent of G27's auto-clear: present even on a row whose notFound is also true", () => {
		const { menu } = buildMenu(item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles()).toContain("Remove attachment");
		expect(menu.titles()).toContain("Remove");
	});
});

describe("F3/F4 — no bulk remove, no undo", () => {
	it("no bulk 'remove all' action appears anywhere in the menu", () => {
		const { menu } = buildMenu(item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles().some((t) => /remove all/i.test(t))).toBe(false);
	});

	it("no undo action appears after Remove or Remove attachment are clicked", () => {
		const { menu } = buildMenu(item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }));
		menu.items.find((i) => i.title === "Remove attachment")!.clickHandler!();
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();
		expect(menu.titles().some((t) => /undo/i.test(t))).toBe(false);
	});
});

describe("G29 — existing API-item behavior is unchanged", () => {
	it("Open attachment / Add note / Add block / Add module keep their existing conditions and ordering", () => {
		const { menu } = buildMenu(item({ noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles().slice(0, 4)).toEqual(["Open attachment", "Add note", "Add block", "Add module"]);
	});

	it("an item with no noteRef and not notFound shows only the unconditional Add actions", () => {
		const { menu } = buildMenu(item());
		expect(menu.titles()).toEqual(["Add note", "Add block", "Add module"]);
	});

	it("Remove/Remove attachment never appear for a non-placeholder-kind item, even with notFound/noteRef set", () => {
		const nonPlaceholder = { ...item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }), kind: "something-else" } as unknown as ApiItemState;
		const { menu } = buildMenu(nonPlaceholder);
		expect(menu.titles()).not.toContain("Remove");
		expect(menu.titles()).not.toContain("Remove attachment");
	});
});

// PR-1 (G11e): Statuses, Data source…, Refresh now and Remove data source come from one shared helper,
// so an Atlas-folder menu and a unit menu list them with the same labels, order and conditions.
describe("PR-1 G11e — shared source/status menu items on a meta and a unit menu", () => {
	const SOURCE_TITLES = ["Data source…", "Refresh now", "Remove data source"];
	const apiSource = { url: "https://x", method: "GET" as const, mapping: { idField: "id", labelField: "name" }, mode: "merge" as const, refreshOnViewLoad: false };

	function fakeFor(): Record<string, unknown> {
		const plugin = { app: {}, unitIndex: { getUnits: () => [] }, viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" } };
		const target: Record<string, unknown> = { plugin };
		return new Proxy(target, {
			get: (t, prop: string) => (prop in t ? t[prop] : vi.fn()),
		});
	}

	function menuTitles(method: "showMetaFolderMenu" | "showUnitMenu", node: ViewNode, ref?: { kind: "file"; path: string }): string[] {
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const args = method === "showUnitMenu" ? [new MouseEvent("contextmenu"), ref ?? { kind: "file", path: "U.md" }, view, node] : [new MouseEvent("contextmenu"), node, view];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fakeFor(), ...args);
		show.mockRestore();
		return built!.titles();
	}

	const sourceOf = (titles: string[]) => titles.filter((t) => SOURCE_TITLES.includes(t));

	it("a unit with no source offers Data source… and no Refresh now or Remove data source", () => {
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		const titles = menuTitles("showUnitMenu", unit);
		expect(titles).toContain("Data source…");
		expect(titles).not.toContain("Refresh now");
		expect(titles).not.toContain("Remove data source");
	});

	it("a unit with an API source lists Data source…, Refresh now, Remove data source in the same order as an Atlas folder", () => {
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], apiSource };
		const folder: ViewNode = { id: "f", type: "meta", label: "Linear issues", children: [], apiSource };
		expect(sourceOf(menuTitles("showUnitMenu", unit))).toEqual(SOURCE_TITLES);
		expect(sourceOf(menuTitles("showMetaFolderMenu", folder))).toEqual(SOURCE_TITLES);
	});

	it.each([
		["an API source", { apiSource }],
		["a CSV source", { csvSource: { url: "https://x/y.csv", mapping: { idField: "id", labelField: "name" } } }],
		["an Inside Vault folder source", { folderSource: { location: "inside", path: "Notes" } }],
		["an Outside Vault folder source", { folderSource: { location: "outside", path: "/tmp/notes" } }],
	])("a Folder row with %s configured still gets 'Replace with…', once, above the source items", (_name, source) => {
		const folder = { id: "f", type: "meta", label: "Sourced", children: [], ...source } as unknown as ViewNode;
		const titles = menuTitles("showMetaFolderMenu", folder);
		expect(titles.filter((t) => t === "Replace with…")).toHaveLength(1);
		expect(titles.indexOf("Replace with…")).toBeLessThan(titles.indexOf("Data source…"));
	});

	it("a Folder row with no source gets 'Replace with…' too (the unchanged baseline)", () => {
		expect(menuTitles("showMetaFolderMenu", { id: "f", type: "meta", label: "Plain", children: [] })).toContain("Replace with…");
	});

	it("an Atlas folder without a source offers the same single Data source… item as a unit does", () => {
		const folder: ViewNode = { id: "f", type: "meta", label: "Plain", children: [] };
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		expect(sourceOf(menuTitles("showMetaFolderMenu", folder))).toEqual(["Data source…"]);
		expect(sourceOf(menuTitles("showUnitMenu", unit))).toEqual(["Data source…"]);
	});
});

// PR-2 (G1-G4): Swap items. "Swap with…" on any swappable bucket node; "Swap for Atlas folder" on units only;
// both directly above "Remove from view" on a unit, and "Swap with…" right after "Replace with…" on an Atlas folder.
describe("PR-2 G1-G4 — Swap menu items", () => {
	const SWAP = ["Swap with…", "Swap for Atlas folder"];

	function swapFake() {
		return {
			plugin: { app: {}, unitIndex: { getUnits: () => [] }, viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" } },
			openSwapPicker: vi.fn(),
			openSwapForFolder: vi.fn(),
		};
	}

	function build(method: "showMetaFolderMenu" | "showUnitMenu", node: ViewNode, ref: { kind: "file"; path: string } = { kind: "file", path: "U.md" }, displayName = "U") {
		const fake = swapFake();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const args = method === "showUnitMenu" ? [new MouseEvent("contextmenu"), ref, view, node, displayName] : [new MouseEvent("contextmenu"), node, view];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
		show.mockRestore();
		return { menu: built!, fake };
	}

	const unitNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], ...over });
	const metaNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "m", type: "meta", label: "Folder", children: [], ...over });

	it("a unit's Swap items sit directly above Remove from view, after Duplicate (Meta)", () => {
		const titles = build("showUnitMenu", unitNode()).menu.titles();
		const at = titles.indexOf("Remove from view");
		expect(titles.slice(at - 3, at)).toEqual(["Duplicate (Meta)", ...SWAP]);
	});

	it.each([
		["a file", { kind: "file" as const, path: "U.md" }],
		["a folder", { kind: "folder" as const, path: "Boat" }],
		["a block", { kind: "block" as const, path: "U.md", subpath: "^abc" }],
		["a promoted folder (nested, not a module)", { kind: "folder" as const, path: "Projects/Career" }],
		["a promoted block", { kind: "block" as const, path: "Projects/Career.md", subpath: "^abc" }],
		["a free block", { kind: "file" as const, path: "_pool/20260101000000-aaaa.md" }],
	])("offers both items for %s units (G1)", (_label, ref) => {
		const titles = build("showUnitMenu", unitNode({ ref })).menu.titles();
		expect(titles).toEqual(expect.arrayContaining(SWAP));
	});

	it("an Atlas folder offers only Swap with…, straight after Replace with…", () => {
		const titles = build("showMetaFolderMenu", metaNode()).menu.titles();
		expect(titles).not.toContain("Swap for Atlas folder");
		const at = titles.indexOf("Replace with…");
		expect(titles[at + 1]).toBe("Swap with…");
	});

	it("a linked-folder (folderSourceManaged) unit has no Swap items at all", () => {
		expect(build("showUnitMenu", unitNode({ folderSourceManaged: true })).menu.titles()).not.toEqual(expect.arrayContaining(SWAP));
	});

	it("a linked-folder Atlas folder has no Swap item", () => {
		expect(build("showMetaFolderMenu", metaNode({ folderSourceManaged: true })).menu.titles()).not.toContain("Swap with…");
	});

	it("Swap with… opens the picker for this exact spot", () => {
		const node = unitNode();
		const { menu, fake } = build("showUnitMenu", node);
		menu.items.find((i) => i.title === "Swap with…")!.clickHandler!();
		expect(fake.openSwapPicker).toHaveBeenCalledWith(view, node);
	});

	it("Swap for Atlas folder opens the name box with the row's display name", () => {
		const node = unitNode();
		const { menu, fake } = build("showUnitMenu", node, { kind: "file", path: "Boat.md" }, "Boat");
		menu.items.find((i) => i.title === "Swap for Atlas folder")!.clickHandler!();
		expect(fake.openSwapForFolder).toHaveBeenCalledWith(view, node, "Boat");
	});

	it("the API-row menu has no Swap item", () => {
		const fake = { plugin: { viewsManager: { removeApiItem: vi.fn(), clearApiItemNoteRef: vi.fn() } } };
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const row: ApiItemState = { id: "1", label: "Row", kind: "placeholder", notFound: true, noteRef: { kind: "file", path: "N.md" } };
		(AtlasExplorerView.prototype as unknown as { showApiItemMenu: (...a: unknown[]) => void }).showApiItemMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			view,
			metaNode({ id: "folder" }),
			row
		);
		show.mockRestore();
		expect(built!.titles()).not.toEqual(expect.arrayContaining(SWAP));
	});
});

// PR-2.F2: extends PR-2.F1's own menu-structure coverage (add-under-menu.test.ts) with the one
// choice this PR wires up for real — picking "Folder" in the second menu, on both row kinds the
// menu supports, still calls the handler with exactly the clicked row's own view/node, never the
// selection. The toolbar's own "Add folder" entry is untouched (F2) — proven by its own existing
// fence test (add-under-fence.test.ts), not re-asserted here.
describe("PR-2.F2 — Add under… > Folder calls startAddUnder(\"folder\", view, node) with the clicked row", () => {
	function fakeHost() {
		return {
			plugin: {
				app: new App(),
				unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] },
				viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" },
			},
			startAddUnder: vi.fn(),
		};
	}

	function chooseFolder(built: Menu): void {
		built.items.find((i) => i.title === "Add under…")!.clickHandler!();
		const chooser = Menu.shownAtPosition[Menu.shownAtPosition.length - 1];
		chooser.items.find((i) => i.title === "Folder")!.clickHandler!();
	}

	it("on a unit row", () => {
		const node: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		const fake = fakeHost();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showUnitMenu: (...a: unknown[]) => void }).showUnitMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			{ kind: "file", path: "U.md" },
			view,
			node,
			"U"
		);
		show.mockRestore();
		chooseFolder(built!);
		expect(fake.startAddUnder).toHaveBeenCalledWith("folder", view, node);
	});

	it("on a Folder row", () => {
		const node: ViewNode = { id: "m", type: "meta", label: "Folder", children: [] };
		const fake = fakeHost();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(fake, new MouseEvent("contextmenu"), node, view);
		show.mockRestore();
		chooseFolder(built!);
		expect(fake.startAddUnder).toHaveBeenCalledWith("folder", view, node);
	});
});

// PR-3.F2: the chooser itself (PR-3.F1's `addAddUnderItem`) is shared by every kind, so this only
// needs to prove the "File" entry reaches the dispatcher with the clicked row's own view/node
// (never the selection) — the real create-and-nest behaviour behind that call is
// `add-under-file.test.ts`'s job, and Block's own equivalent already lives above with its real
// `startAddUnder` dispatch (not a stub) because that test also exercises the filter/hidden-notice
// paths; File has none of those, so a stub here is enough.
describe("PR-3.F2 — Add under… > File calls startAddUnder(\"file\", view, node) with the clicked row", () => {
	function fakeHost() {
		return {
			plugin: {
				app: new App(),
				unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] },
				viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" },
			},
			startAddUnder: vi.fn(),
		};
	}

	function chooseFile(built: Menu): void {
		built.items.find((i) => i.title === "Add under…")!.clickHandler!();
		const chooser = Menu.shownAtPosition[Menu.shownAtPosition.length - 1];
		chooser.items.find((i) => i.title === "File")!.clickHandler!();
	}

	it("on a unit row", () => {
		const node: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		const fake = fakeHost();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showUnitMenu: (...a: unknown[]) => void }).showUnitMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			{ kind: "file", path: "U.md" },
			view,
			node,
			"U"
		);
		show.mockRestore();
		chooseFile(built!);
		expect(fake.startAddUnder).toHaveBeenCalledWith("file", view, node);
	});

	it("on a Folder row", () => {
		const node: ViewNode = { id: "m", type: "meta", label: "Folder", children: [] };
		const fake = fakeHost();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(fake, new MouseEvent("contextmenu"), node, view);
		show.mockRestore();
		chooseFile(built!);
		expect(fake.startAddUnder).toHaveBeenCalledWith("file", view, node);
	});
});

// PR-3.F3: same pattern as PR-3.F2's File block above — the chooser itself is shared, so this only
// needs to prove the "Module" entry reaches the dispatcher with the clicked row's own view/node
// (never the selection). The real create-and-nest behaviour behind that call is
// `add-under-module.test.ts`'s job.
describe("PR-3.F3 — Add under… > Module calls startAddUnder(\"module\", view, node) with the clicked row", () => {
	function fakeHost() {
		return {
			plugin: {
				app: new App(),
				unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] },
				viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" },
			},
			startAddUnder: vi.fn(),
		};
	}

	function chooseModule(built: Menu): void {
		built.items.find((i) => i.title === "Add under…")!.clickHandler!();
		const chooser = Menu.shownAtPosition[Menu.shownAtPosition.length - 1];
		chooser.items.find((i) => i.title === "Module")!.clickHandler!();
	}

	it("on a unit row", () => {
		const node: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		const fake = fakeHost();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showUnitMenu: (...a: unknown[]) => void }).showUnitMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			{ kind: "file", path: "U.md" },
			view,
			node,
			"U"
		);
		show.mockRestore();
		chooseModule(built!);
		expect(fake.startAddUnder).toHaveBeenCalledWith("module", view, node);
	});

	it("on a Folder row", () => {
		const node: ViewNode = { id: "m", type: "meta", label: "Folder", children: [] };
		const fake = fakeHost();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(fake, new MouseEvent("contextmenu"), node, view);
		show.mockRestore();
		chooseModule(built!);
		expect(fake.startAddUnder).toHaveBeenCalledWith("module", view, node);
	});
});

// PR-2.F3 (G10): the real Folder add-under flow against the real `ViewsManager`. R1 fix: a Folder
// (meta) row renders unconditionally in `renderNode`'s meta branch — only a unit row returns early
// on `!matchesFilter` — so an active filter can never be the reason a new Folder's row fails to
// render. These two cases prove that directly: a filter alone (no other cause) gives no Notice at
// all, and a real governance-driven cause (hideCompleted) still gets named correctly even while a
// filter happens to be active, rather than the filter wrongly winning the "named first" tie-break.
// (The old version of this test asserted "(hidden by the current filter)" here, which real
// rendering never produces for a Folder — see R1. The filter-as-cause case only applies to a
// unit-kind row (Block/File/Module) and belongs in PR-3's own tests.)
describe("PR-2.F3 — Add under… > Folder: an active filter is never named as the hidden reason", () => {
	function runAdd(statusesManager: { findGoverningAncestor: () => unknown; resolveNodeStatus: () => unknown }) {
		const app = new App();
		const vm = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [meta("projects", "Projects", [])] }], "v1", () => {});
		const liveView = vm.getViews()[0];
		const parentNode = vm.getNode("v1", "projects")!;

		const fakeThis = {
			plugin: { app, statusesManager, viewsManager: vm },
			filterText: "drone",
			openAddUnderPrompts: new Set<{ close(): void }>(),
			bucketListEl: document.createElement("div"), // never gets the new row appended: a plain fixture, not a real render
			selectedBucketNodeIds: new Set<string>(),
			selectedInboxRefKeys: new Set<string>(),
			selectionAnchor: null as string | null,
			selectionAnchorScope: null as "bucket" | "inbox" | null,
			render: vi.fn(() => Promise.resolve()),
			awaitRenderSettled: vi.fn(() => Promise.resolve()),
		};
		const proto = AtlasExplorerView.prototype as unknown as {
			runAddUnderFolder(view: View, node: ViewNode): Promise<void>;
			addUnderFolderDeps(this: unknown): unknown;
			addUnderHiddenSignals(this: unknown, ...a: unknown[]): unknown;
			ancestorsForNode(this: unknown, ...a: unknown[]): unknown;
		};
		(fakeThis as Record<string, unknown>).addUnderFolderDeps = proto.addUnderFolderDeps;
		(fakeThis as Record<string, unknown>).addUnderHiddenSignals = proto.addUnderHiddenSignals;
		(fakeThis as Record<string, unknown>).addUnderParentLabel = (AtlasExplorerView.prototype as unknown as Record<string, unknown>).addUnderParentLabel;
		(fakeThis as Record<string, unknown>).expandAddUnderParent = (AtlasExplorerView.prototype as unknown as Record<string, unknown>).expandAddUnderParent;
		(fakeThis as Record<string, unknown>).ancestorsForNode = proto.ancestorsForNode;

		return { fakeThis, parentNode, promise: proto.runAddUnderFolder.call(fakeThis, liveView, parentNode) };
	}

	it("filter active, no governance cause: nests the Folder, filterText untouched, no Notice at all", async () => {
		Notice.reset();
		captured.prompts.length = 0;
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { fakeThis, parentNode, promise } = runAdd({ findGoverningAncestor: () => null, resolveNodeStatus: () => null });
			expect(captured.prompts).toHaveLength(1);
			captured.prompts[0].onSubmit("Archive");
			await promise;

			expect(parentNode.children.map((c) => c.label)).toEqual(["Archive"]);
			expect(fakeThis.filterText).toBe("drone"); // the helper only ever reads filterText, per its own doc comment
			// Even though the fixture's bucketListEl never gets the row (a bare, unrendered <div>), no
			// reason applies — a Folder row is never filtered out — so `noticeIfAddedRowHidden` never
			// invents one (its own documented no-op case).
			expect(Notice.instances).toHaveLength(0);
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});

	it("filter active AND hideCompleted governance: Notice names sort/grouping, not the filter", async () => {
		Notice.reset();
		captured.prompts.length = 0;
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { parentNode, promise } = runAdd({
				findGoverningAncestor: () => ({ hideCompleted: true, hideCancelled: false }),
				resolveNodeStatus: () => ({ id: "done", label: "Done", isCompleted: true, isCancelled: false }),
			});
			expect(captured.prompts).toHaveLength(1);
			captured.prompts[0].onSubmit("Archive");
			await promise;

			expect(parentNode.children.map((c) => c.label)).toEqual(["Archive"]);
			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toContain("Added Archive under Projects");
			expect(Notice.instances[0].message).toContain("(hidden by the current sort or grouping)");
			expect(Notice.instances[0].message).not.toContain("filter");
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});
});

// PR-3.F1 (G1): the real Block add-under flow, wired through the private `startAddUnder` dispatcher
// itself (not `runAddUnderBlock` called directly) — proves the menu's "Block" choice actually reaches
// the real create-and-nest flow, not just that the flow works in isolation (that's
// `add-under-block.test.ts`'s job). Block is also the first PR-3 kind to make the filter-as-cause
// branch of `addUnderHiddenSignals` live (R1/PR-3.F1: see its own doc comment) — a unit-kind row, so
// unlike Folder, an active filter that the new (always-empty) block's own display text fails to match
// really is why the row doesn't render, and really is named first on a tie with governance.
describe("PR-3.F1 — Add under… > Block: real flow, wired through startAddUnder", () => {
	function host(statusesManager: { findGoverningAncestor: () => unknown; resolveNodeStatus: () => unknown }, filterText = "") {
		const app = new App();
		(app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({ openFile: vi.fn(async () => {}) }));
		(app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => null);
		const vm = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [meta("projects", "Projects", [])] }], "v1", () => {});
		const liveView = vm.getViews()[0];
		const parentNode = vm.getNode("v1", "projects")!;

		const fakeThis = {
			plugin: {
				app,
				statusesManager,
				viewsManager: vm,
				unitIndex: { holdUnit: () => () => {} },
				settings: { poolFolder: "_pool", blockDisplayLength: 80 },
			},
			filterText,
			bucketListEl: document.createElement("div"), // never gets the new row appended: a plain fixture, not a real render
			selectedBucketNodeIds: new Set<string>(),
			selectedInboxRefKeys: new Set<string>(),
			selectionAnchor: null as string | null,
			selectionAnchorScope: null as "bucket" | "inbox" | null,
			render: vi.fn(() => Promise.resolve()),
			awaitRenderSettled: vi.fn(() => Promise.resolve()),
		};
		const proto = AtlasExplorerView.prototype as unknown as {
			startAddUnder(this: unknown, kind: string, view: View, node: ViewNode): void;
			runAddUnderBlock(this: unknown, view: View, node: ViewNode): Promise<void>;
			addUnderBlockDeps(this: unknown): unknown;
			addUnderHiddenSignals(this: unknown, ...a: unknown[]): unknown;
			ancestorsForNode(this: unknown, ...a: unknown[]): unknown;
			matchesFilter(this: unknown, text: string): boolean;
		};
		for (const key of ["runAddUnderBlock", "addUnderBlockDeps", "addUnderHiddenSignals", "ancestorsForNode", "matchesFilter"] as const) {
			(fakeThis as Record<string, unknown>)[key] = proto[key];
		}
		for (const key of ["addUnderParentLabel", "expandAddUnderParent"]) {
			(fakeThis as Record<string, unknown>)[key] = (AtlasExplorerView.prototype as unknown as Record<string, unknown>)[key];
		}

		return { fakeThis, proto, liveView, parentNode };
	}

	it("startAddUnder(\"block\", view, node) reaches the real flow: a new block is nested, expanded, selected and opened", async () => {
		Notice.reset();
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { fakeThis, proto, liveView, parentNode } = host({ findGoverningAncestor: () => null, resolveNodeStatus: () => null });

			proto.startAddUnder.call(fakeThis, "block", liveView, parentNode);
			await flush();

			const children = fakeThis.plugin.viewsManager.getNode("v1", "projects")!.children;
			expect(children).toHaveLength(1);
			expect(children[0].type).toBe("unit");
			expect((children[0].ref as { path: string }).path).toMatch(/^_pool\/.*\.md$/);
			expect([...fakeThis.selectedBucketNodeIds]).toEqual([children[0].id]);
			expect(fakeThis.render).toHaveBeenCalled();
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});

	it("filter active, no governance cause: the new empty block's own display text doesn't match it, so the filter IS named", async () => {
		Notice.reset();
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { fakeThis, proto, liveView, parentNode } = host({ findGoverningAncestor: () => null, resolveNodeStatus: () => null }, "drone");

			await proto.runAddUnderBlock.call(fakeThis, liveView, parentNode);

			expect(parentNode.children).toHaveLength(1);
			expect(fakeThis.filterText).toBe("drone"); // the helper only ever reads filterText, per its own doc comment
			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toContain("(hidden by the current filter)");
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});

	it("filter active but it matches the new block's own display text (\"(empty block)\"): no Notice at all", async () => {
		Notice.reset();
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { fakeThis, proto, liveView, parentNode } = host({ findGoverningAncestor: () => null, resolveNodeStatus: () => null }, "empty");

			await proto.runAddUnderBlock.call(fakeThis, liveView, parentNode);

			expect(parentNode.children).toHaveLength(1);
			expect(Notice.instances).toHaveLength(0);
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});

	it("filter active AND hideCompleted governance: Notice still names the filter first (E-G10e tie-break), not the sort/grouping", async () => {
		Notice.reset();
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { fakeThis, proto, liveView, parentNode } = host(
				{
					findGoverningAncestor: () => ({ hideCompleted: true, hideCancelled: false }),
					resolveNodeStatus: () => ({ id: "done", label: "Done", isCompleted: true, isCancelled: false }),
				},
				"drone"
			);

			await proto.runAddUnderBlock.call(fakeThis, liveView, parentNode);

			expect(parentNode.children).toHaveLength(1);
			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toContain("(hidden by the current filter)");
			expect(Notice.instances[0].message).not.toContain("sort or grouping");
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});

	it("no filter, hideCompleted governance: Notice names the sort/grouping, same as Folder's own case", async () => {
		Notice.reset();
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
		try {
			const { fakeThis, proto, liveView, parentNode } = host({
				findGoverningAncestor: () => ({ hideCompleted: true, hideCancelled: false }),
				resolveNodeStatus: () => ({ id: "done", label: "Done", isCompleted: true, isCancelled: false }),
			});

			await proto.runAddUnderBlock.call(fakeThis, liveView, parentNode);

			expect(parentNode.children).toHaveLength(1);
			expect(Notice.instances).toHaveLength(1);
			expect(Notice.instances[0].message).toContain("(hidden by the current sort or grouping)");
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});
});


// PR-3.F1 (E3): "Block" is offered on every row whatever the pool setting is. The entry never looks at
// the pool (`canAddUnder`/`addAddUnderItem` take no settings), so a misconfigured pool shows up as the
// flow's own Notice after the click — never as a missing or disabled entry.
describe("PR-3.F1 E3 — the Block chooser entry is present with an empty or root pool folder", () => {
	const POOLS = ["", "  ", ".", "/", "//"];

	function fakeHost(poolFolder: string) {
		return {
			plugin: {
				app: new App(),
				settings: { poolFolder },
				unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] },
				viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" },
			},
			startAddUnder: vi.fn(),
		};
	}

	function chooserFor(method: "showUnitMenu" | "showMetaFolderMenu", node: ViewNode, fake: ReturnType<typeof fakeHost>): Menu {
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const evt = new MouseEvent("contextmenu");
		const proto = AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>;
		if (method === "showUnitMenu") proto.showUnitMenu.call(fake, evt, { kind: "file", path: "U.md" }, view, node, "U");
		else proto.showMetaFolderMenu.call(fake, evt, node, view);
		show.mockRestore();
		built!.items.find((i) => i.title === "Add under…")!.clickHandler!();
		return Menu.shownAtPosition[Menu.shownAtPosition.length - 1];
	}

	const unitNode = (): ViewNode => ({ id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] });
	const folderRow = (): ViewNode => ({ id: "m", type: "meta", label: "Folder", children: [] });

	it.each(POOLS.flatMap((pool) => (["showUnitMenu", "showMetaFolderMenu"] as const).map((method) => [pool, method] as const)))(
		"pool %j, %s: Block is listed, enabled, and reaches startAddUnder(\"block\", view, node)",
		(pool, method) => {
			const fake = fakeHost(pool);
			const node = method === "showUnitMenu" ? unitNode() : folderRow();
			const chooser = chooserFor(method, node, fake);

			expect(chooser.titles()).toEqual(["Block", "File", "Module", "Folder"]);
			const block = chooser.items.find((i) => i.title === "Block")!;
			expect(block.disabled).toBe(false);
			block.clickHandler!();
			expect(fake.startAddUnder).toHaveBeenCalledWith("block", view, node);
		}
	);

	it.each(POOLS)("pool %j, through the real flow: the click gives the pool Notice, writes nothing and adds no node", async (pool) => {
		Notice.reset();
		const app = new App();
		(app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({ openFile: vi.fn(async () => {}) }));
		(app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => null);
		const vm = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [meta("projects", "Projects", [])] }], "v1", () => {});
		const liveView = vm.getViews()[0];
		const parentNode = vm.getNode("v1", "projects")!;
		const createSpy = vi.spyOn(app.vault, "create");
		const fakeThis: Record<string, unknown> = {
			plugin: {
				app,
				statusesManager: { findGoverningAncestor: () => null, resolveNodeStatus: () => null },
				viewsManager: vm,
				unitIndex: { holdUnit: () => () => {}, getUnits: () => [] },
				settings: { poolFolder: pool, blockDisplayLength: 80 },
			},
			filterText: "",
			bucketListEl: document.createElement("div"),
			selectedBucketNodeIds: new Set<string>(["something-else"]),
			selectedInboxRefKeys: new Set<string>(),
			render: vi.fn(() => Promise.resolve()),
			awaitRenderSettled: vi.fn(() => Promise.resolve()),
		};
		const proto = AtlasExplorerView.prototype as unknown as Record<string, unknown>;
		for (const name of ["startAddUnder", "runAddUnderBlock", "addUnderBlockDeps", "addUnderHiddenSignals", "ancestorsForNode", "matchesFilter", "addUnderParentLabel", "expandAddUnderParent"]) {
			fakeThis[name] = proto[name];
		}

		// The entry is there and enabled; choosing it is what runs the flow.
		const chooser = chooserFor("showMetaFolderMenu", parentNode, { ...fakeHost(pool), startAddUnder: (...args: unknown[]) => (proto.startAddUnder as (...a: unknown[]) => void).call(fakeThis, ...args) } as ReturnType<typeof fakeHost>);
		chooser.items.find((i) => i.title === "Block")!.clickHandler!();
		await flush();

		expect(Notice.instances.map((n) => n.message)).toEqual([expect.stringContaining("the pool folder setting is empty or the vault root")]);
		expect(createSpy).not.toHaveBeenCalled();
		expect(parentNode.children).toHaveLength(0);
		expect([...(fakeThis.selectedBucketNodeIds as Set<string>)]).toEqual(["something-else"]); // selection untouched
		expect(fakeThis.render).not.toHaveBeenCalled();
	});
});


// PR-1 (G6/G7/G11/F8/G19): "Sort children…" submenu — same on a unit row, a Folder row and the
// Bucket header, written through the generic updateStatusGovernance(viewId, nodeId, patch).
describe("PR-1 G6/G7 — Sort children… menu", () => {
	beforeEach(() => {
		Menu.shownAtPosition = [];
	});

	function sortFake(statusGovernor: StatusGovernance | null = null) {
		const vault = {
			create: vi.fn(),
			createFolder: vi.fn(),
			createBinary: vi.fn(),
			modify: vi.fn(),
			modifyBinary: vi.fn(),
			append: vi.fn(),
			delete: vi.fn(),
			trash: vi.fn(),
			rename: vi.fn(),
			copy: vi.fn(),
		};
		return {
			plugin: {
				app: { vault, fileManager: { renameFile: vi.fn() } },
				unitIndex: { getUnits: () => [] },
				viewsManager: { getNode: () => null, managedRowFilterState: () => "shown", updateStatusGovernance: vi.fn() },
				statusesManager: { findSortGovernor: vi.fn(() => statusGovernor) },
			},
		};
	}

	/** F1: none of a Vault's disk-write methods (nor `fileManager.renameFile`) were ever called. */
	function expectNoVaultWrite(fake: ReturnType<typeof sortFake>): void {
		const vault = fake.plugin.app.vault as unknown as Record<string, ReturnType<typeof vi.fn>>;
		for (const name of ["create", "createFolder", "createBinary", "modify", "modifyBinary", "append", "delete", "trash", "rename", "copy"]) {
			expect(vault[name]).not.toHaveBeenCalled();
		}
		expect(fake.plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
	}

	function build(
		method: "showMetaFolderMenu" | "showUnitMenu" | "showBucketHeaderMenu",
		node?: ViewNode,
		ref: { kind: "file"; path: string } = { kind: "file", path: "U.md" },
		statusGovernor: StatusGovernance | null = null
	) {
		const fake = sortFake(statusGovernor);
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const evt = new MouseEvent("contextmenu");
		const args = method === "showUnitMenu" ? [evt, ref, view, node] : method === "showMetaFolderMenu" ? [evt, node, view] : [evt, view];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
		show.mockRestore();
		return { menu: built!, fake };
	}

	/** Opens the chooser popped by "Sort children…"'s own click handler. */
	function openChooser(menu: Menu): Menu {
		menu.items.find((i) => i.title === "Sort children…")!.clickHandler!();
		return Menu.shownAtPosition[Menu.shownAtPosition.length - 1];
	}

	const unitNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], ...over });
	const metaNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "m", type: "meta", label: "Folder", children: [], ...over });

	it("appears on a unit row, a Folder row and the Bucket header", () => {
		expect(build("showUnitMenu", unitNode()).menu.titles()).toContain("Sort children…");
		expect(build("showMetaFolderMenu", metaNode()).menu.titles()).toContain("Sort children…");
		expect(build("showBucketHeaderMenu").menu.titles()).toContain("Sort children…");
	});

	// PR-2 (T12): the "Sort children…" item's own icon must resolve to Atlas's registered
	// sort-az id, not a bare or lucide-prefixed Lucide string — neither ever rendered an <svg>
	// through MenuItem.setIcon() in the real Obsidian build across three fix rounds (T5/T9/T12).
	it("its own icon is Atlas's registered sort-az icon id", () => {
		const { menu } = build("showUnitMenu", unitNode());
		expect(menu.items.find((i) => i.title === "Sort children…")!.icon).toBe(ATLAS_SORT_AZ_ICON_ID);
	});

	it("its chooser lists exactly Manual, A-Z, Modified, Time added, then Reverse order", () => {
		const chooser = openChooser(build("showUnitMenu", unitNode()).menu);
		expect(chooser.titles()).toEqual(["Manual", "A-Z", "Modified", "Time added", "Reverse order"]);
	});

	it("ticks the node's current sortMode, defaulting to Manual when unset", () => {
		const unset = openChooser(build("showUnitMenu", unitNode()).menu);
		expect(unset.items.find((i) => i.title === "Manual")!.checked).toBe(true);

		const alpha = openChooser(build("showUnitMenu", unitNode({ sortMode: "alphabetical" })).menu);
		expect(alpha.items.find((i) => i.title === "A-Z")!.checked).toBe(true);
		expect(alpha.items.find((i) => i.title === "Manual")!.checked).toBe(false);
	});

	it("Reverse order is disabled under Manual, and enabled (ticked per sortReverse) otherwise (G11/F8)", () => {
		const manual = openChooser(build("showUnitMenu", unitNode()).menu);
		const manualReverse = manual.items.find((i) => i.title === "Reverse order")!;
		expect(manualReverse.disabled).toBe(true);
		expect(manualReverse.checked).toBe(false);

		const modifiedOn = openChooser(build("showUnitMenu", unitNode({ sortMode: "modified", sortReverse: true })).menu);
		const modifiedReverse = modifiedOn.items.find((i) => i.title === "Reverse order")!;
		expect(modifiedReverse.disabled).toBe(false);
		expect(modifiedReverse.checked).toBe(true);
	});

	it("picking a mode writes sortMode and resets sortReverse to off (G19)", () => {
		const node = unitNode({ sortMode: "modified", sortReverse: true });
		const { menu, fake } = build("showUnitMenu", node);
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "A-Z")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "u", { sortMode: "alphabetical", sortReverse: false });
	});

	it("clicking Reverse order only flips sortReverse, never the mode", () => {
		const node = unitNode({ sortMode: "modified", sortReverse: false });
		const { menu, fake } = build("showUnitMenu", node);
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "Reverse order")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "u", { sortReverse: true });
	});

	it("a Folder row writes through the same mechanism, keyed by the Folder's own node id", () => {
		const node = metaNode({ id: "f1" });
		const { menu, fake } = build("showMetaFolderMenu", node);
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "Modified")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "f1", { sortMode: "modified", sortReverse: false });
	});

	it("the Bucket header writes through the view itself (nodeId: null), per G7", () => {
		const { menu, fake } = build("showBucketHeaderMenu");
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "Time added")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", null, { sortMode: "time-added", sortReverse: false });
	});

	it("F1: picking any sort mode or toggling Reverse never writes, renames or deletes a vault file — only data.json (via updateStatusGovernance) changes", () => {
		const node = unitNode({ sortMode: "modified", sortReverse: true });
		const { menu, fake } = build("showUnitMenu", node);

		const chooser1 = openChooser(menu);
		chooser1.items.find((i) => i.title === "A-Z")!.clickHandler!();
		const chooser2 = openChooser(menu);
		chooser2.items.find((i) => i.title === "Reverse order")!.clickHandler!();
		const chooser3 = openChooser(menu);
		chooser3.items.find((i) => i.title === "Manual")!.clickHandler!();

		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledTimes(3);
		expectNoVaultWrite(fake);
	});

	it("F1: the same holds for a Folder row and the Bucket header", () => {
		const metaFake = build("showMetaFolderMenu", metaNode({ id: "f1" }));
		openChooser(metaFake.menu)
			.items.find((i) => i.title === "Modified")!
			.clickHandler!();
		expectNoVaultWrite(metaFake.fake);

		const bucketFake = build("showBucketHeaderMenu");
		openChooser(bucketFake.menu)
			.items.find((i) => i.title === "Time added")!
			.clickHandler!();
		expectNoVaultWrite(bucketFake.fake);
	});

	// PR-2 (G12/G19/E5/F4): the "Status" item — present only on a governing row (or the Bucket
	// root of a governing view), labeled "(inherited)" when the governor is an ancestor rather
	// than this row itself, and ticked whenever `activeSortFor` resolves to "status".
	describe("PR-2 G12/G19/E5/F4 — Status in the Sort children… menu", () => {
		it("is absent from the menu on a row that does not govern a status set and has no inherited status sort", () => {
			const chooser = openChooser(build("showUnitMenu", unitNode()).menu);
			expect(chooser.titles()).not.toContain("Status");
			expect(chooser.titles()).not.toContain("Status (inherited)");
		});

		it('labels it plain "Status" (not inherited) when this row is itself the governor', () => {
			const node = metaNode({ id: "f1", statusEnabled: true, statusSetId: "S" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.titles()).toContain("Status");
			expect(chooser.titles()).not.toContain("Status (inherited)");
		});

		it('labels it "Status (inherited)" when the governor is an ancestor, not this row itself (E5)', () => {
			const node = metaNode({ id: "f1" }); // no statusEnabled/statusSetId of its own
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" }; // an ancestor's
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.titles()).toContain("Status (inherited)");
			expect(chooser.titles()).not.toContain("Status");
		});

		it('ticks Status when this row\'s own setting is explicitly "status"', () => {
			const node = metaNode({ id: "f1", statusEnabled: true, statusSetId: "S", sortMode: "status" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.items.find((i) => i.title === "Status")!.checked).toBe(true);
		});

		it("E5: ticks Status (inherited) when this row has no setting of its own, following an inherited status sort", () => {
			const node = metaNode({ id: "f1" }); // absent own sortMode
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.items.find((i) => i.title === "Status (inherited)")!.checked).toBe(true);
			// R1: the effective sort here is Status (inherited), not Manual — Manual must not also
			// be ticked, which would claim two contradictory sorts are both active.
			expect(chooser.items.find((i) => i.title === "Manual")!.checked).toBe(false);
		});

		it("does not tick Status (inherited) when this row's own setting explicitly overrides the inherited status sort with another mode", () => {
			const node = metaNode({ id: "f1", sortMode: "alphabetical" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.items.find((i) => i.title === "Status (inherited)")!.checked).toBe(false);
			expect(chooser.items.find((i) => i.title === "A-Z")!.checked).toBe(true);
		});

		it("E5: choosing Manual on a row currently following an inherited status sort stores an explicit Manual", () => {
			const node = metaNode({ id: "f1" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const { menu, fake } = build("showMetaFolderMenu", node, undefined, governor);
			const chooser = openChooser(menu);
			chooser.items.find((i) => i.title === "Manual")!.clickHandler!();
			expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "f1", { sortMode: "manual", sortReverse: false });
		});

		it('clicking Status stores an explicit sortMode: "status" with sortReverse reset off', () => {
			const node = metaNode({ id: "f1", sortMode: "modified", sortReverse: true });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" };
			const { menu, fake } = build("showMetaFolderMenu", node, undefined, governor);
			const chooser = openChooser(menu);
			chooser.items.find((i) => i.title === "Status (inherited)")!.clickHandler!();
			expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "f1", { sortMode: "status", sortReverse: false });
		});

		it("the Bucket root offers Status (plain, not inherited) when the view itself governs a status set", () => {
			const governingView: View = { id: "v2", name: "Governed", inboxMode: "view", root: [], statusEnabled: true, statusSetId: "S" };
			const fake = sortFake({ statusEnabled: true, statusSetId: "S" });
			let built: Menu | undefined;
			const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
				built = this;
			});
			(AtlasExplorerView.prototype as unknown as { showBucketHeaderMenu: (...a: unknown[]) => void }).showBucketHeaderMenu.call(fake, new MouseEvent("contextmenu"), governingView);
			show.mockRestore();
			const chooser = openChooser(built!);
			expect(chooser.titles()).toContain("Status");
			expect(chooser.titles()).not.toContain("Status (inherited)");
		});
	});
});
