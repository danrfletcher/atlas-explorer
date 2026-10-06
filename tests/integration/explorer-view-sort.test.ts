import { describe, expect, it, vi } from "vitest";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, realNode, rowOrder, view } from "../unit/explorer-view-sort-truncate-helpers";
import { DEFAULT_SETTINGS } from "../../src/settings";

/** PR-1.F2 integration: a row hidden by its Folder source's YAML rules is excluded before the sort pass,
 * so it neither appears in the sorted order nor shifts the rows around it. */
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

describe("PR-1.F2 — sort: hidden rows are excluded before the sort pass", () => {
	it("status sort: a hidden row that would have ranked first is absent, and the rest keep their order", async () => {
		// ranks (index into STATUS_SET.statuses): todo=0, doing=1, done=2
		const folder = folderGovernor({ sortMode: "status" });
		const hiddenTodo = realNode("hidden-todo", { explicitStatusId: "todo" });
		const doing = realNode("real-doing", { explicitStatusId: "doing" });
		const done = realNode("real-done", { explicitStatusId: "done" });

		const fake = explorerWithHidden(new Set(["hidden-todo"]));
		const container = document.createElement("div");
		await callRenderNodeList(fake, [done, hiddenTodo, doing], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-doing", "real-done"]);
	});

	it("manual sort: a hidden row is dropped from the list, and the shown rows keep their build order", async () => {
		const folder = folderGovernor({ sortMode: "manual" });
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });
		const real3 = realNode("real-3", { explicitStatusId: "doing" });

		const fake = explorerWithHidden(new Set(["real-2"]));
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2, real3], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "real-3"]);
	});
});
