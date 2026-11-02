import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Menu } from "obsidian";
import { ADD_UNDER_KINDS, AddUnderKind } from "../../src/add-under";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ViewNode, createEmptyView } from "../../src/types";
import { ViewsManager } from "../../src/views";

const view = createEmptyView("v1", "Default");

beforeEach(() => {
	Menu.shownAtPosition = [];
});

function fakeHost(over: { selectedBucketNodeIds?: Set<string> } = {}) {
	return {
		plugin: {
			app: new App(),
			unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] },
			viewsManager: { getNode: () => null, managedRowFilterState: () => "shown" },
		},
		startAddUnder: vi.fn(),
		startCreateFromMeta: vi.fn(),
		startCreateModule: vi.fn(),
		openStatusesModal: vi.fn(),
		openSwapPicker: vi.fn(),
		openSwapForFolder: vi.fn(),
		duplicateFolder: vi.fn(),
		selectedBucketNodeIds: over.selectedBucketNodeIds ?? new Set<string>(),
	};
}

function build(method: "showUnitMenu" | "showMetaFolderMenu", node: ViewNode, fake = fakeHost()) {
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	const evt = new MouseEvent("contextmenu", { clientX: 42, clientY: 7 });
	const args = method === "showUnitMenu" ? [evt, { kind: "file", path: "U.md" }, view, node, "U"] : [evt, node, view];
	(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
	show.mockRestore();
	return { menu: built!, fake, evt };
}

const unitNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], ...over });
const metaNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "m", type: "meta", label: "Folder", children: [], ...over });

describe("PR-2.F1 — \"Add under…\" menu item (G6/G7/E5/E8)", () => {
	it("on a unit row, sits directly above Duplicate (Meta)", () => {
		const titles = build("showUnitMenu", unitNode()).menu.titles();
		const at = titles.indexOf("Duplicate (Meta)");
		expect(titles[at - 1]).toBe("Add under…");
	});

	it("on a Folder (meta) row, sits directly above Replace with…, right after Rename folder", () => {
		const titles = build("showMetaFolderMenu", metaNode()).menu.titles();
		const renameAt = titles.indexOf("Rename folder");
		expect(titles[renameAt + 1]).toBe("Add under…");
		expect(titles[renameAt + 2]).toBe("Replace with…");
	});

	it("is not offered on a missing unit row", () => {
		const fake = fakeHost();
		// No unit resolves to this row's ref at all: missing.
		fake.plugin.unitIndex.getUnits = () => [];
		const titles = build("showUnitMenu", unitNode(), fake).menu.titles();
		expect(titles).not.toContain("Add under…");
	});

	it("is not offered on a greyed 'filtered out' row", () => {
		const fake = fakeHost();
		fake.plugin.viewsManager.managedRowFilterState = () => "filteredOut";
		const titles = build("showUnitMenu", unitNode(), fake).menu.titles();
		expect(titles).not.toContain("Add under…");
	});

	it("is not offered on a Folder with a data source configured", () => {
		const titles = build("showMetaFolderMenu", metaNode({ apiSource: { url: "https://x" } as never })).menu.titles();
		expect(titles).not.toContain("Add under…");
	});

	it("choosing it pops a second menu with exactly Block, File, Module, Folder, at the click position", () => {
		const { menu } = build("showUnitMenu", unitNode());
		menu.items.find((i) => i.title === "Add under…")!.clickHandler!();
		expect(Menu.shownAtPosition).toHaveLength(1);
		const chooser = Menu.shownAtPosition[0];
		expect(chooser.titles()).toEqual(ADD_UNDER_KINDS.map((k) => k.label));
		expect(chooser.titles()).toEqual(["Block", "File", "Module", "Folder"]);
	});

	it("G7: the chooser is shown at the click position, on a unit row and on a Folder row", () => {
		for (const [method, node] of [
			["showUnitMenu", unitNode()],
			["showMetaFolderMenu", metaNode()],
		] as const) {
			Menu.shownAtPosition = [];
			const { menu } = build(method, node); // the click is at clientX 42, clientY 7
			expect(Menu.shownAtPosition).toHaveLength(0); // nothing pops until "Add under…" is chosen
			menu.items.find((i) => i.title === "Add under…")!.clickHandler!();
			expect(Menu.shownAtPosition).toHaveLength(1);
			expect(Menu.shownAtPosition[0].position).toEqual({ x: 42, y: 7 });
		}
	});

	it.each<[AddUnderKind, string]>([
		["block", "Block"],
		["file", "File"],
		["module", "Module"],
		["folder", "Folder"],
	])("choosing %s in the chooser calls startAddUnder(%s, view, node) with this exact row", (kind, label) => {
		const node = unitNode();
		const { menu, fake } = build("showUnitMenu", node);
		menu.items.find((i) => i.title === "Add under…")!.clickHandler!();
		const chooser = Menu.shownAtPosition[0];
		chooser.items.find((i) => i.title === label)!.clickHandler!();
		expect(fake.startAddUnder).toHaveBeenCalledWith(kind, view, node);
	});

	it("dismissing the chooser without a choice never calls startAddUnder", () => {
		const { menu, fake } = build("showUnitMenu", unitNode());
		menu.items.find((i) => i.title === "Add under…")!.clickHandler!();
		// The chooser is shown but nothing in it is clicked — the Esc/click-away case.
		expect(fake.startAddUnder).not.toHaveBeenCalled();
	});

	it("E5/F3: right-clicking a row with a multi-selection active leaves the selection untouched, and the choice acts on only the clicked node", () => {
		const selected = new Set(["a", "b", "c"]);
		const fake = fakeHost({ selectedBucketNodeIds: selected });
		const node = unitNode({ id: "a" });
		const { menu } = build("showUnitMenu", node, fake);
		expect(fake.selectedBucketNodeIds).toBe(selected);
		expect([...fake.selectedBucketNodeIds]).toEqual(["a", "b", "c"]);

		menu.items.find((i) => i.title === "Add under…")!.clickHandler!();
		Menu.shownAtPosition[0].items.find((i) => i.title === "File")!.clickHandler!();

		expect(fake.startAddUnder).toHaveBeenCalledWith("file", view, node);
		expect(fake.startAddUnder).toHaveBeenCalledTimes(1);
		// The selection itself is never read or written by any of this.
		expect(fake.selectedBucketNodeIds).toBe(selected);
		expect([...fake.selectedBucketNodeIds]).toEqual(["a", "b", "c"]);
	});

	it("F1: an inbox row's menu (showInboxUnitMenu) never offers it", () => {
		const fake = {
			plugin: { app: new App(), unitIndex: { isDismissed: () => false, isAdded: () => false } },
			openRef: vi.fn(),
			revealInNativeExplorer: vi.fn(),
			copyLink: vi.fn(),
			placeInViewFlow: vi.fn(),
		};
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showInboxUnitMenu: (...a: unknown[]) => void }).showInboxUnitMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			{ kind: "file", path: "U.md" },
			view
		);
		show.mockRestore();
		expect(built!.titles()).not.toContain("Add under…");
	});

	it("F1: an API/Table item row's menu (showApiItemMenu) never offers it", () => {
		const fake = { plugin: { viewsManager: { removeApiItem: vi.fn(), clearApiItemNoteRef: vi.fn() } } };
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showApiItemMenu: (...a: unknown[]) => void }).showApiItemMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			view,
			metaNode({ id: "folder" }),
			{ id: "1", label: "Row", kind: "placeholder", notFound: true, noteRef: { kind: "file", path: "N.md" } }
		);
		show.mockRestore();
		expect(built!.titles()).not.toContain("Add under…");
	});
});

// PR-2.F1 R3 (polish): eligibility is judged when the menu is built, not when the row was rendered. A
// real ViewsManager is used so the data source lands on the node through the real setters, which
// mutate the same node object in place.
describe("PR-2.F1 R3 — a row that became ineligible after it rendered is judged at menu-build time", () => {
	function realHost(root: ViewNode[]) {
		const app = new App();
		const vm = new ViewsManager(app as never, [{ id: "v1", name: "Default", inboxMode: "view", root }], "v1", () => {});
		const fake = {
			plugin: { app, unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] }, viewsManager: vm },
			startAddUnder: vi.fn(),
		};
		return { vm, fake, view: vm.getView("v1")!, app };
	}
	const offered = (menu: Menu) => menu.titles().includes("Add under…");

	function buildReal(method: "showUnitMenu" | "showMetaFolderMenu", fake: ReturnType<typeof realHost>["fake"], viewObj: ReturnType<typeof realHost>["view"], node: ViewNode) {
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const evt = new MouseEvent("contextmenu");
		const args = method === "showUnitMenu" ? [evt, { kind: "file", path: "U.md" }, viewObj, node, "U"] : [evt, node, viewObj];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
		show.mockRestore();
		return built!;
	}

	it("a Folder row: offered, then an API source is added through the real setter, then the same node's menu no longer offers it", () => {
		const { vm, fake, view: viewObj } = realHost([metaNode({ id: "m" })]);
		const node = vm.getNode("v1", "m")!; // the row as it was rendered
		expect(offered(buildReal("showMetaFolderMenu", fake, viewObj, node))).toBe(true);

		vm.setApiSource("v1", "m", { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false });
		expect(node.apiSource).toBeDefined(); // same object, mutated in place
		expect(offered(buildReal("showMetaFolderMenu", fake, viewObj, node))).toBe(false);
	});

	it("a Folder row: an Inside-Vault Folder source added after render also removes it", () => {
		const { vm, fake, view: viewObj } = realHost([metaNode({ id: "m" })]);
		const node = vm.getNode("v1", "m")!;
		expect(offered(buildReal("showMetaFolderMenu", fake, viewObj, node))).toBe(true);
		vm.setFolderSource("v1", "m", { location: "inside", path: "Archive" } as never);
		expect(node.folderSource).toBeDefined();
		expect(offered(buildReal("showMetaFolderMenu", fake, viewObj, node))).toBe(false);
	});

	it("a unit row: offered, then an API source is added, then it is no longer offered", () => {
		const { vm, fake, view: viewObj } = realHost([unitNode({ id: "u" })]);
		const node = vm.getNode("v1", "u")!;
		expect(offered(buildReal("showUnitMenu", fake, viewObj, node))).toBe(true);
		vm.setApiSource("v1", "u", { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false });
		expect(node.apiSource).toBeDefined();
		expect(offered(buildReal("showUnitMenu", fake, viewObj, node))).toBe(false);
	});

	it("a unit row that goes missing after render (its file is gone from the index) is judged missing at menu-build time", () => {
		const { vm, fake, view: viewObj } = realHost([unitNode({ id: "u" })]);
		const node = vm.getNode("v1", "u")!;
		expect(offered(buildReal("showUnitMenu", fake, viewObj, node))).toBe(true);
		fake.plugin.unitIndex.getUnits = () => [];
		expect(offered(buildReal("showUnitMenu", fake, viewObj, node))).toBe(false);
	});
});

// PR-2.F1 R1 (polish): the spec's "no disk write, no data.json write" for the menu path, as behaviour
// rather than a static scan. Every vault write method on the mock vault is spied, plus the view
// manager's persist callback and the plugin's save hooks; building the menu, opening the chooser,
// dismissing it, and choosing a kind (which only calls the view's startAddUnder seam, stubbed here —
// each kind's own flow is tested in its own file) must touch none of them.
describe("PR-2.F1 R1 — the menu path writes nothing to the vault or to data.json", () => {
	const WRITE_METHODS = ["create", "createFolder", "createBinary", "modify", "modifyBinary", "append", "delete", "trash", "rename", "copy"];

	function trackedHost(root: ViewNode[]) {
		const app = new App();
		const vault = app.vault as unknown as Record<string, unknown>;
		const writes = WRITE_METHODS.filter((name) => typeof vault[name] === "function").map((name) => vi.spyOn(vault as never, name as never));
		const rename = vi.fn();
		(app as unknown as { fileManager: unknown }).fileManager = { renameFile: rename };
		const persist = vi.fn();
		const vm = new ViewsManager(app as never, [{ id: "v1", name: "Default", inboxMode: "view", root }], "v1", persist);
		const saves = { saveData: vi.fn(), save: vi.fn(), flushSave: vi.fn() };
		const fake = {
			plugin: { app, unitIndex: { getUnits: () => [{ type: "root-file", path: "U.md" }] }, viewsManager: vm, ...saves },
			startAddUnder: vi.fn(),
		};
		const expectUntouched = () => {
			for (const spy of writes) expect(spy).not.toHaveBeenCalled();
			expect(rename).not.toHaveBeenCalled();
			expect(persist).not.toHaveBeenCalled();
			for (const fn of Object.values(saves)) expect(fn).not.toHaveBeenCalled();
		};
		return { vm, fake, writes, expectUntouched };
	}

	it("the spy set really covers the mock vault's write methods", () => {
		const { writes } = trackedHost([unitNode({ id: "u" })]);
		expect(writes.length).toBeGreaterThanOrEqual(4);
	});

	it.each([
		["showUnitMenu", () => unitNode({ id: "n" })],
		["showMetaFolderMenu", () => metaNode({ id: "n" })],
	] as const)("%s: build the menu, open the chooser, dismiss it, then choose each kind — nothing is written", (method, make) => {
		const { vm, fake, expectUntouched } = trackedHost([make()]);
		const node = vm.getNode("v1", "n")!;
		const viewObj = vm.getView("v1")!;

		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const evt = new MouseEvent("contextmenu");
		const args = method === "showUnitMenu" ? [evt, { kind: "file", path: "U.md" }, viewObj, node, "U"] : [evt, node, viewObj];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
		show.mockRestore();
		expectUntouched(); // building the menu

		Menu.shownAtPosition = [];
		built!.items.find((i) => i.title === "Add under…")!.clickHandler!();
		expect(Menu.shownAtPosition).toHaveLength(1);
		expectUntouched(); // opening the chooser, then dismissing it without a choice

		for (const item of Menu.shownAtPosition[0].items) item.clickHandler!();
		expect(fake.startAddUnder).toHaveBeenCalledTimes(4);
		expectUntouched(); // choosing every kind only calls the seam
	});
});
