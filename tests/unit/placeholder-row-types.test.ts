import { App, Menu } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { mergeApiItems } from "../../src/api-merge";
import { ViewsManager } from "../../src/views";
import { ApiItemState, ApiMappedRow, PLACEHOLDER_ROW_KIND, View, ViewNode } from "../../src/types";

describe("G29 — one general placeholder-row kind tag shared across construction sites", () => {
	it("mergeApiItems tags a brand-new row with PLACEHOLDER_ROW_KIND", () => {
		const row: ApiMappedRow = { id: "1", label: "One" };
		const result = mergeApiItems({}, [], [row], "append", { truncated: false, nowIso: "2026-01-01T00:00:00.000Z" });
		expect(result.itemState["1"].kind).toBe(PLACEHOLDER_ROW_KIND);
	});

	it("load-time sanitization (ViewsManager construction) tags a legacy row, missing kind, with the identical constant", () => {
		const legacyNode = {
			id: "n1",
			type: "meta" as const,
			label: "Folder",
			children: [],
			apiItemState: { "1": { id: "1", label: "One" } } as unknown as Record<string, ApiItemState>,
			apiItemOrder: ["1"],
		};
		const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [legacyNode] }], "v1", vi.fn());
		expect(vm.getNode("v1", "n1")!.apiItemState!["1"].kind).toBe(PLACEHOLDER_ROW_KIND);
	});

	it("both construction sites produce the exact same tag value, not two independently-chosen ones", () => {
		const row: ApiMappedRow = { id: "1", label: "One" };
		const merged = mergeApiItems({}, [], [row], "append", { truncated: false, nowIso: "2026-01-01T00:00:00.000Z" });

		const legacyNode = {
			id: "n1",
			type: "meta" as const,
			label: "Folder",
			children: [],
			apiItemState: { "1": { id: "1", label: "One" } } as unknown as Record<string, ApiItemState>,
			apiItemOrder: ["1"],
		};
		const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [legacyNode] }], "v1", vi.fn());
		const sanitized = vm.getNode("v1", "n1")!.apiItemState!["1"];

		expect(merged.itemState["1"].kind).toBe(sanitized.kind);
	});
});

describe("G29 — menu gating reads the shared kind tag itself, not just notFound/noteRef presence", () => {
	const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };
	const folderNode: ViewNode = { id: "folder", type: "meta", label: "Folder", children: [] };

	function buildMenu(item: ApiItemState) {
		const fake = { plugin: { viewsManager: { removeApiItem: vi.fn(), clearApiItemNoteRef: vi.fn(), getNode: () => ({ ...folderNode, apiItemState: { [item.id]: item } }) } } };
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		(AtlasExplorerView.prototype as unknown as { showApiItemMenu: (...a: unknown[]) => void }).showApiItemMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			view,
			folderNode,
			item
		);
		show.mockRestore();
		return built!;
	}

	it("a row with a different/absent kind never gets Remove or Remove attachment, even with notFound/noteRef set", () => {
		const nonPlaceholder = {
			id: "1",
			label: "One",
			notFound: true,
			noteRef: { kind: "file" as const, path: "Note.md" },
		} as unknown as ApiItemState; // deliberately missing `kind`, simulating a hypothetical non-placeholder row shape
		const menu = buildMenu(nonPlaceholder);
		expect(menu.titles()).not.toContain("Remove");
		expect(menu.titles()).not.toContain("Remove attachment");
	});

	it("a row tagged with the shared kind gets both, under the same notFound/noteRef conditions", () => {
		const placeholder: ApiItemState = {
			id: "1",
			label: "One",
			kind: PLACEHOLDER_ROW_KIND,
			notFound: true,
			noteRef: { kind: "file", path: "Note.md" },
		};
		const menu = buildMenu(placeholder);
		expect(menu.titles()).toContain("Remove");
		expect(menu.titles()).toContain("Remove attachment");
	});
});
