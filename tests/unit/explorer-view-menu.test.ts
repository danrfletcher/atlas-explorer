import { describe, expect, it, vi } from "vitest";
import { Menu } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ApiItemState, View, ViewNode } from "../../src/types";

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
		const plugin = { app: {}, unitIndex: { getUnits: () => [] }, viewsManager: { getNode: () => null } };
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

	it("an Atlas folder without a source offers the same single Data source… item as a unit does", () => {
		const folder: ViewNode = { id: "f", type: "meta", label: "Plain", children: [] };
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		expect(sourceOf(menuTitles("showMetaFolderMenu", folder))).toEqual(["Data source…"]);
		expect(sourceOf(menuTitles("showUnitMenu", unit))).toEqual(["Data source…"]);
	});
});

// PR-2 (G1-G4): Swap items. "Swap with…" on any swappable bucket node; "Swap for Atlas folder" on units only;
// both directly above "Remove from view" on a unit, and "Swap with…" right after "Create" on an Atlas folder.
describe("PR-2 G1-G4 — Swap menu items", () => {
	const SWAP = ["Swap with…", "Swap for Atlas folder"];

	function swapFake() {
		return {
			plugin: { app: {}, unitIndex: { getUnits: () => [] }, viewsManager: { getNode: () => null } },
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
	])("offers both items for %s units", (_label, ref) => {
		const titles = build("showUnitMenu", unitNode({ ref })).menu.titles();
		expect(titles).toEqual(expect.arrayContaining(SWAP));
	});

	it("an Atlas folder offers only Swap with…, straight after Create", () => {
		const titles = build("showMetaFolderMenu", metaNode()).menu.titles();
		expect(titles).not.toContain("Swap for Atlas folder");
		const at = titles.indexOf("Create");
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
