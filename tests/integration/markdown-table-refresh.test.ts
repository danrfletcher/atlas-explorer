import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { MarkdownTableSourceController } from "../../src/markdown-table-source-controller";
import { MarkdownTableSourceConfig, View, ViewNode } from "../../src/types";

function makeNode(id: string): ViewNode {
	return { id, type: "meta", label: "Markdown table folder", children: [] };
}

function baseSource(path: string, overrides: Partial<MarkdownTableSourceConfig> = {}): MarkdownTableSourceConfig {
	return {
		path,
		tableIndex: 0,
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		...overrides,
	};
}

/** PR-8 (R3 fix): same `(AtlasExplorerView.prototype as ...).method.call(fake, ...)` pattern already
 * used by create-module.test.ts/explorer-view-sort-truncate-helpers.ts to exercise a real,
 * non-stubbed `AtlasExplorerView` method without constructing a full Obsidian `ItemView`. Calling the
 * real `notifyMarkdownTableFileModified` here (instead of hand-rolling a `vault.on("modify")` handler
 * that calls `controller.refresh` directly) is what actually proves main.ts's wiring —
 * `onVaultModifyEvent` -> `AtlasExplorerView.notifyMarkdownTableFileModified` ->
 * `refreshMarkdownTableSource` -> `MarkdownTableSourceController.refresh` — still holds end to end. A
 * regression in any one of those links (e.g. the node-walk, the path match, or the trigger argument)
 * would fail this test; the old hand-rolled handler could not have caught any of them. */
type ProtoMethods = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as ProtoMethods;

function makeFakeView(app: App, view: View, controller: MarkdownTableSourceController, notifyExternalMutation = vi.fn()) {
	return {
		plugin: {
			app,
			viewsManager: { getActiveView: () => view, notifyExternalMutation },
			markdownTableSourceController: controller,
		},
		openConfirmDeleteModals: [] as unknown[],
		// Real, non-stubbed prototype methods — `notifyMarkdownTableFileModified` calls both of these
		// as `this.collectMarkdownTableSourceNodes(...)`/`this.refreshMarkdownTableSource(...)`, so
		// they need to exist on `fake` itself for that real call chain to run unmodified.
		collectMarkdownTableSourceNodes: proto.collectMarkdownTableSourceNodes,
		refreshMarkdownTableSource: proto.refreshMarkdownTableSource,
	};
}

/** `refreshMarkdownTableSource`/`notifyMarkdownTableFileModified` are both fire-and-forget (`void
 * ...refresh(...)`) by design — nothing in the real call chain exposes the refresh's own promise.
 * `vi.spyOn` observes it without changing the controller's real behaviour, purely so the test can
 * await the same refresh main.ts's listener would have fired and left running in the background. */
function lastRefreshPromise(spy: { mock: { results: { value: unknown }[] } }): Promise<void> {
	const result = spy.mock.results[spy.mock.results.length - 1];
	return (result?.value as Promise<void>) ?? Promise.resolve();
}

describe("MarkdownTableSourceController — integration: save-triggered refresh (reuses the existing refresh-toggle plumbing, no new refresh UI)", () => {
	it("saving the watched .md file triggers a re-parse that picks up the new rows, via the real main.ts modify -> notifyMarkdownTableFileModified -> refreshMarkdownTableSource plumbing", async () => {
		const app = new App();
		const file = await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const node = makeNode("n1");
		node.markdownTableSource = baseSource("table.md");
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const controller = new MarkdownTableSourceController();
		const refreshSpy = vi.spyOn(controller, "refresh");
		const fake = makeFakeView(app, view, controller);

		// Manual load, through the real refresh path too — not the controller directly.
		proto.refreshMarkdownTableSource.call(fake, view, node, "manual");
		await lastRefreshPromise(refreshSpy);
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }]);

		app.vault.on("modify", (modified) => {
			proto.notifyMarkdownTableFileModified.call(fake, modified.path);
		});
		await app.vault.modify(file, "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n");
		await lastRefreshPromise(refreshSpy); // the file-save-triggered automatic refresh, via the real notify method

		expect(node.apiCache?.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
		expect(refreshSpy).toHaveBeenLastCalledWith(node, node.markdownTableSource, expect.any(Function), expect.objectContaining({ trigger: "automatic" }));
	});

	it("notifyMarkdownTableFileModified only refreshes nodes whose own markdownTableSource.path matches the saved file, walking the real view tree", async () => {
		const app = new App();
		await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		await app.vault.create("other.md", "| id | name |\n|---|---|\n| 9 | Nine |\n");
		const matching = makeNode("n1");
		matching.markdownTableSource = baseSource("table.md");
		const other = makeNode("n2");
		other.markdownTableSource = baseSource("other.md");
		const parent: ViewNode = { id: "parent", type: "meta", label: "Parent", children: [matching, other] };
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [parent] };
		const controller = new MarkdownTableSourceController();
		const refreshSpy = vi.spyOn(controller, "refresh");
		const fake = makeFakeView(app, view, controller);

		proto.notifyMarkdownTableFileModified.call(fake, "table.md");
		await lastRefreshPromise(refreshSpy);

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(matching.apiCache?.rows).toEqual([{ id: "1", label: "One" }]);
		expect(other.apiCache).toBeUndefined();
	});

	it("a save that changes which table lives at the configured index is read as-is on the next refresh — no drift detection (G24/F9)", async () => {
		const app = new App();
		const file = await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();
		const refresh = () => controller.refresh(node, baseSource("table.md", { tableIndex: 0 }), () => {}, { vault: app.vault, now: () => 1000 });

		await refresh();
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }]);

		// A new table is inserted before the configured index 0.
		await app.vault.modify(file, "| id | name |\n|---|---|\n| a | Widget |\n\n| id | name |\n|---|---|\n| 1 | One |\n");
		await refresh();

		// Index 0 now points at the newly-inserted table — read silently, no error/warning.
		expect(node.apiCache?.ok).toBe(true);
		expect(node.apiCache?.rows).toEqual([{ id: "a", label: "Widget" }]);
	});

	it("PR-1 R4: a refresh that finds the table unchanged reports changed=false, so the caller can skip persisting", async () => {
		const app = new App();
		await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n");
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();
		const changes: boolean[] = [];
		const refresh = (now: number) =>
			controller.refresh(node, baseSource("table.md"), (changed) => changes.push(changed), { vault: app.vault, now: () => now });

		await refresh(1000);
		expect(changes).toEqual([true]); // first refresh always moves apiCache.ok from undefined to true

		await refresh(2000);
		expect(changes).toEqual([true, false]); // same rows/itemState/order the second time — nothing to persist
	});
});
