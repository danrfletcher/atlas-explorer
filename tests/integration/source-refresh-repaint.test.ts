import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { CsvSourceController } from "../../src/csv-source-controller";
import { MarkdownTableSourceController } from "../../src/markdown-table-source-controller";
import { ApiSourceController } from "../../src/api-source-controller";
import { ViewsManager } from "../../src/views";
import { View, ViewNode } from "../../src/types";

/** PR-2 (S3): a data-source refresh that finds the same data tells the explorer nothing, so the list
 * does not repaint on every view load / focus regain. These call the real `refreshCsvSource`,
 * `refreshMarkdownTableSource` and `refreshApiSource` on `AtlasExplorerView` with the real controllers
 * and a real `ViewsManager`, and count what its change listeners hear. */

type ProtoMethods = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as ProtoMethods;

function setup(node: ViewNode) {
	const app = new App();
	const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
	const persist = vi.fn();
	const viewsManager = new ViewsManager(app, [view], "v1", persist);
	const listener = vi.fn();
	viewsManager.onChange(listener);
	const csvSourceController = new CsvSourceController();
	const markdownTableSourceController = new MarkdownTableSourceController();
	const apiSourceController = new ApiSourceController();
	const refresh = (method: string, spy: { mock: { results: { value: unknown }[] } }) => {
		const fake = {
			plugin: {
				app,
				viewsManager,
				csvSourceController,
				markdownTableSourceController,
				apiSourceController,
				apiHeadersStore: { get: () => [] },
			},
			openConfirmDeleteModals: [],
		};
		proto[method].call(fake, view, node, "automatic");
		return spy.mock.results[spy.mock.results.length - 1].value as Promise<void>;
	};
	return { app, viewsManager, persist, listener, csvSourceController, markdownTableSourceController, apiSourceController, refresh };
}

describe("PR-2 (S3): an unchanged CSV refresh does not repaint", () => {
	it("the first refresh notifies and saves; an identical one afterwards neither", async () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "CSV folder",
			children: [],
			csvSource: { path: "data.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" },
		};
		const t = setup(node);
		await t.app.vault.create("data.csv", "id,name\n1,One\n2,Two\n");
		const spy = vi.spyOn(t.csvSourceController, "refresh");

		await t.refresh("refreshCsvSource", spy);
		expect(t.listener).toHaveBeenCalledTimes(1);
		expect(t.persist).toHaveBeenCalledTimes(1);
		t.listener.mockClear();
		t.persist.mockClear();

		await t.refresh("refreshCsvSource", spy);
		await t.refresh("refreshCsvSource", spy);

		expect(t.listener).not.toHaveBeenCalled();
		expect(t.persist).not.toHaveBeenCalled();
	});

	it("a refresh that finds a changed file still notifies", async () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "CSV folder",
			children: [],
			csvSource: { path: "data.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" },
		};
		const t = setup(node);
		const file = await t.app.vault.create("data.csv", "id,name\n1,One\n");
		const spy = vi.spyOn(t.csvSourceController, "refresh");
		await t.refresh("refreshCsvSource", spy);
		t.listener.mockClear();

		await t.app.vault.modify(file, "id,name\n1,One\n2,Two\n");
		await t.refresh("refreshCsvSource", spy);

		expect(t.listener).toHaveBeenCalledTimes(1);
	});
});

describe("PR-2 (S3): an unchanged Markdown-table refresh does not repaint", () => {
	it("the first refresh notifies; an identical one afterwards does not", async () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Table folder",
			children: [],
			markdownTableSource: { path: "table.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge" },
		};
		const t = setup(node);
		await t.app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const spy = vi.spyOn(t.markdownTableSourceController, "refresh");

		await t.refresh("refreshMarkdownTableSource", spy);
		expect(t.listener).toHaveBeenCalledTimes(1);
		t.listener.mockClear();

		await t.refresh("refreshMarkdownTableSource", spy);

		expect(t.listener).not.toHaveBeenCalled();
		expect(t.persist).toHaveBeenCalledTimes(1); // only the first refresh saved
	});
});

describe("PR-2 (S3): a changed Markdown-table refresh notifies once", () => {
	const tableNode = (): ViewNode => ({
		id: "n1",
		type: "meta",
		label: "Table folder",
		children: [],
		markdownTableSource: { path: "table.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge" },
	});

	it("an edited table cell notifies exactly once, and the refresh after it notifies nobody", async () => {
		const t = setup(tableNode());
		const file = await t.app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const spy = vi.spyOn(t.markdownTableSourceController, "refresh");
		await t.refresh("refreshMarkdownTableSource", spy);
		t.listener.mockClear();

		await t.app.vault.modify(file, "| id | name |\n|---|---|\n| 1 | Uno |\n");
		await t.refresh("refreshMarkdownTableSource", spy);
		expect(t.listener).toHaveBeenCalledTimes(1);
		expect(Object.values(t.viewsManager.getViews()[0].root[0].apiItemState ?? {}).map((item) => item.label)).toContain("Uno");

		await t.refresh("refreshMarkdownTableSource", spy);
		expect(t.listener).toHaveBeenCalledTimes(1);
	});

	it("an added table row notifies exactly once", async () => {
		const t = setup(tableNode());
		const file = await t.app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const spy = vi.spyOn(t.markdownTableSourceController, "refresh");
		await t.refresh("refreshMarkdownTableSource", spy);
		t.listener.mockClear();

		await t.app.vault.modify(file, "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n");
		await t.refresh("refreshMarkdownTableSource", spy);

		expect(t.listener).toHaveBeenCalledTimes(1);
	});
});

describe("PR-2 (S3): an unchanged API refresh does not repaint", () => {
	it("the first refresh notifies; an identical one afterwards does not", async () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "API folder",
			children: [],
			apiSource: { url: "https://example.test/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false },
		};
		const t = setup(node);
		// The explorer calls the module-level `obsidianRequestImpl`; the controller is what takes it, so
		// the real controller is wrapped to hand it a canned response instead.
		const real = t.apiSourceController.refresh.bind(t.apiSourceController);
		const spy = vi.spyOn(t.apiSourceController, "refresh").mockImplementation((n, source, headers, persist, deps) =>
			real(n, source, headers, persist, { ...deps, requestImpl: async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) }) }),
		);

		await t.refresh("refreshApiSource", spy);
		expect(t.listener).toHaveBeenCalledTimes(1);
		t.listener.mockClear();

		await t.refresh("refreshApiSource", spy);
		await t.refresh("refreshApiSource", spy);

		expect(t.listener).not.toHaveBeenCalled();
	});
});
