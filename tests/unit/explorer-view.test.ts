import { describe, expect, it, vi } from "vitest";

/** PR-3: isolates `explorer-view.ts`'s wiring (which fields of `ApiSourceModalResult` it reads, what
 * it does with them) from the real modal's own rendering/validation, which already has full coverage
 * in `tests/unit/api-source-modal.test.ts`. */
vi.mock("../../src/api-source-modal", () => {
	class FakeApiSourceModal {
		static instances: FakeApiSourceModal[] = [];
		onSave: (result: unknown) => void;
		open = vi.fn();
		constructor(public app: unknown, public initial: unknown, public headers: unknown, onSave: (result: unknown) => void) {
			this.onSave = onSave;
			FakeApiSourceModal.instances.push(this);
		}
	}
	return { ApiSourceModal: FakeApiSourceModal };
});

import { Menu } from "obsidian";
import { ApiSourceModal } from "../../src/api-source-modal";
import { AtlasExplorerView } from "../../src/explorer-view";
import { View, ViewNode } from "../../src/types";
import { meta } from "../integration/create-from-meta-fixtures";

const FakeApiSourceModal = ApiSourceModal as unknown as {
	instances: { app: unknown; initial: unknown; headers: unknown; open: () => void; onSave: (result: unknown) => void }[];
};

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

function openApiSourceModal(node: ViewNode, plugin: Record<string, unknown>, refreshApiSource = vi.fn()) {
	(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
		{ plugin, refreshApiSource },
		view,
		node
	);
	return refreshApiSource;
}

describe("PR-3 — explorer-view.ts call sites keep working with the new ApiSourceModalResult.type field", () => {
	it("openApiSourceModal and context-menu entry point still invoke modal and handle onSave result", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");

		// The "Data source…" context-menu item still delegates to openApiSourceModal(view, node), same
		// as before this PR — unchanged by adding `type` to the result.
		const openApiSourceModalSpy = vi.fn();
		let builtMenu: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			builtMenu = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(
			{ plugin: {}, startCreateFromMeta: vi.fn(), openStatusesModal: vi.fn(), openApiSourceModal: openApiSourceModalSpy },
			new MouseEvent("contextmenu"),
			node,
			view
		);
		show.mockRestore();

		const dataSourceItem = builtMenu!.items.find((item) => item.title === "Data source…");
		expect(dataSourceItem).toBeTruthy();
		dataSourceItem!.clickHandler!();
		expect(openApiSourceModalSpy).toHaveBeenCalledWith(view, node);

		// Directly exercise the real openApiSourceModal: it builds the modal with the node's existing
		// headers/apiSource and wires onSave to persist headers + source and trigger a manual refresh.
		const headers = [{ key: "X", value: "Y" }];
		const apiHeadersStore = { get: vi.fn(() => headers), set: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshApiSource = openApiSourceModal(node, plugin);

		expect(FakeApiSourceModal.instances).toHaveLength(1);
		const modal = FakeApiSourceModal.instances[0];
		expect(modal.app).toBe(plugin.app);
		expect(modal.initial).toBeNull();
		expect(modal.headers).toBe(headers);
		expect(apiHeadersStore.get).toHaveBeenCalledWith(node.id);

		// onSave now always receives a `type` field (PR-3) alongside the unchanged `source`/`headers` —
		// explorer-view.ts must keep working without reading or requiring that field.
		const newHeaders = [{ key: "A", value: "B" }];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: newHeaders });

		expect(apiHeadersStore.set).toHaveBeenCalledWith(node.id, newHeaders);
		expect(viewsManager.setApiSource).toHaveBeenCalledWith(view.id, node.id, { url: "https://api.example.com/items" });
		expect(refreshApiSource).toHaveBeenCalledWith(view, node, "manual");
	});
});

describe("R8 — switching API->CSV drops the API source's device-local headers, same as Remove data source", () => {
	it("deletes the ApiHeadersStore entry when a node that had a live apiSource is switched to csv", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		node.apiSource = { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge" };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setCsvSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshCsvSource = vi.fn();
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshCsvSource },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const csvSource = { path: "data/items.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const };
		modal.onSave({ type: "csv", source: csvSource });

		expect(viewsManager.setCsvSource).toHaveBeenCalledWith(view.id, node.id, csvSource);
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshCsvSource).toHaveBeenCalledWith(view, node, "manual");
	});

	it("does not touch ApiHeadersStore when switching to csv from a node that never had an apiSource", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m2", "Folder");

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setCsvSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshCsvSource: vi.fn() },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const csvSource = { path: "data/items.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const };
		modal.onSave({ type: "csv", source: csvSource });

		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
	});
});

// PR-1 (G11b/E-a): the four source walks visit every node and recurse into every node's children,
// including unit children, so a sourced folder nested under a unit still refreshes at load and on timers.
describe("PR-1 G11b/E-a — source walks reach a sourced node nested under units and meta folders", () => {
	type Walk = "collectApiSourceNodes" | "collectFolderSourceNodes" | "collectCsvSourceNodes" | "collectMarkdownTableSourceNodes";
	const proto = AtlasExplorerView.prototype as unknown as Record<Walk, (nodes: ViewNode[]) => ViewNode[]>;
	const WALKS: Array<{ walk: Walk; field: keyof ViewNode; sourced: Partial<ViewNode> }> = [
		{ walk: "collectApiSourceNodes", field: "apiSource", sourced: { apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } } },
		{ walk: "collectFolderSourceNodes", field: "folderSource", sourced: { folderSource: { location: "inside", path: "P", showFiles: true, showFolders: true, refreshOnViewLoad: false } } },
		{ walk: "collectCsvSourceNodes", field: "csvSource", sourced: { csvSource: { path: "d.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } } },
		{
			walk: "collectMarkdownTableSourceNodes",
			field: "markdownTableSource",
			sourced: { markdownTableSource: { path: "t.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } },
		},
	];

	for (const { walk, field, sourced } of WALKS) {
		it(`${walk} finds a source under unit > unit > meta and under unit > unit`, () => {
			const deep: ViewNode = { id: "deep", type: "unit", ref: { kind: "folder", path: "Deep" }, children: [], ...sourced };
			const middle: ViewNode = { id: "mid", type: "unit", ref: { kind: "file", path: "Mid.md" }, children: [deep] };
			const metaWrap: ViewNode = { id: "m", type: "meta", label: "Wrap", children: [middle] };
			const unitUnder: ViewNode = { id: "u2", type: "unit", ref: { kind: "file", path: "Top.md" }, children: [{ ...deep, id: "deep2" }] };
			const found = proto[walk].call(AtlasExplorerView.prototype, [metaWrap, unitUnder]);
			expect(found.map((n) => n.id)).toEqual(["deep", "deep2"]);
			expect(found.every((n) => n[field] !== undefined)).toBe(true);
		});

		it(`${walk} visits a sourced unit that has no children and skips unsourced nodes`, () => {
			const leaf: ViewNode = { id: "leaf", type: "unit", ref: { kind: "file", path: "L.md" }, children: [], ...sourced };
			const plain: ViewNode = { id: "plain", type: "unit", ref: { kind: "file", path: "P.md" }, children: [] };
			expect(proto[walk].call(AtlasExplorerView.prototype, [plain, leaf]).map((n) => n.id)).toEqual(["leaf"]);
		});
	}
});
