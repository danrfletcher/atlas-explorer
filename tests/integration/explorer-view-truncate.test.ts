import { describe, expect, it, vi } from "vitest";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, realNode, rowOrder, view } from "../unit/explorer-view-sort-truncate-helpers";
import { DEFAULT_SETTINGS } from "../../src/settings";

/** PR-1.F2 integration: a row hidden by its Folder source's YAML rules is excluded before the truncate
 * pass, so it never fills a truncation group or changes its count. The hidden set is driven through the
 * same `managedRowFilterState` the real `ViewsManager` answers with. */
function explorerWithHidden(hidden: Set<string>) {
	const sm = makeStatusesManager();
	const fake = makeFakeExplorer(sm, {
		plugin: {
			statusesManager: sm,
			settings: DEFAULT_SETTINGS,
			viewsManager: {
				setApiItemStatus: vi.fn(),
				managedRowFilterState: vi.fn((_viewId: string, node: { id: string }) => (hidden.has(node.id) ? "hidden" : "shown")),
			},
		} as never,
	});
	Object.assign(fake, { selectedBucketNodeIds: new Set<string>() });
	return fake;
}

describe("PR-1.F2 — truncate: hidden rows are excluded before truncation and do not count in a group", () => {
	it("a hidden row is not counted, so the group shows 2 where it would have shown 3", async () => {
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });
		const real3 = realNode("real-3", { explicitStatusId: "todo" });

		const fake = explorerWithHidden(new Set(["real-3"]));
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2, real3], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
		expect(fake.renderTruncationGroupHeader).toHaveBeenCalledTimes(1);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});

	it("a hidden row never forms a group of one with a sibling that is left alone", async () => {
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = explorerWithHidden(new Set(["real-2"]));
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("expanding the group lists only the rows that are shown, never the hidden one", async () => {
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });
		const real3 = realNode("real-3", { explicitStatusId: "todo" });

		const fake = explorerWithHidden(new Set(["real-3"]));
		fake.expandedTruncationGroups.add("node:folder:todo");
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2, real3], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo", "real-1", "real-2"]);
	});
});
