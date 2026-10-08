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
