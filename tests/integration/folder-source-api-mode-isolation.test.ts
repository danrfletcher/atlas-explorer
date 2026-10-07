import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiItemState, ApiSourceConfig, ViewNode } from "../../src/types";

/** Fence: "existing API-source mode reconciliation (refresh behavior) is unaffected by the new
 * Folder-source delete path." The new delete-triggered reconciliation
 * (`reconcileFolderSourceDeletesForPath`/`sweepFolderSourceDeletedPlaceholders`) gates strictly on
 * `node.folderSourceManaged`/`node.folderSource` — an `apiSource` node has neither, so it must stay
 * byte-for-byte untouched except for G27's own pre-existing, unrelated noteRef-clearing sweep. */
function setupApiSourceWithNoteRef(): { vm: ViewsManager; viewId: string; nodeId: string } {
	const apiSource: ApiSourceConfig = {
		type: "api",
		url: "https://example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "label" },
		mode: "merge",
	};
	const apiItemState: Record<string, ApiItemState> = {
		"1": {
			id: "1",
			label: "Row 1",
			kind: "placeholder",
			notFound: false,
			lastSeenAt: "2025-12-31T00:00:00.000Z",
			noteRef: { kind: "file", path: "Projects/a.md" },
		},
		"2": {
			id: "2",
			label: "Row 2",
			kind: "placeholder",
			notFound: true,
			lastSeenAt: "2025-06-01T00:00:00.000Z",
		},
	};
	const node: ViewNode = {
		id: "api-node",
		type: "meta",
		label: "My API",
		children: [],
		apiSource,
		apiItemState,
		apiItemOrder: ["1", "2"],
	};
	const persist = vi.fn();
	const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [node] }], "v1", persist);
	return { vm, viewId: "v1", nodeId: "api-node" };
}

describe("folder-source-api-mode-isolation — existing API-source reconciliation is unaffected by the new Folder-source delete path", () => {
	it("deleting the vault file an API row's noteRef points at still clears that noteRef via G27's pre-existing sweep, unchanged", () => {
		const { vm, viewId, nodeId } = setupApiSourceWithNoteRef();

		vm.onVaultDelete("Projects/a.md");

		const node = vm.getNode(viewId, nodeId)!;
		expect(node.apiItemState!["1"].noteRef).toBeUndefined();
	});

	it("every other field of the API row is byte-for-byte unchanged by the delete — nothing from the new Folder-source demotion rule leaks in", () => {
		const { vm, viewId, nodeId } = setupApiSourceWithNoteRef();

		vm.onVaultDelete("Projects/a.md");

		const node = vm.getNode(viewId, nodeId)!;
		// `notFound: false` is normalized away by the ViewsManager constructor's own pre-existing
		// sanitization (only an explicit `true` survives) — unrelated to this PR, so the expectation
		// here omits it rather than asserting a value this code path never set.
		expect(node.apiItemState!["1"]).toEqual({
			id: "1",
			label: "Row 1",
			kind: "placeholder",
			lastSeenAt: "2025-12-31T00:00:00.000Z",
			noteRef: undefined,
		});
	});

	it("an API row with no noteRef at all (row 2) is completely untouched, including its own notFound/lastSeenAt from prior API-refresh reconciliation", () => {
		const { vm, viewId, nodeId } = setupApiSourceWithNoteRef();

		vm.onVaultDelete("Projects/a.md");

		const node = vm.getNode(viewId, nodeId)!;
		expect(node.apiItemState!["2"]).toEqual({
			id: "2",
			label: "Row 2",
			kind: "placeholder",
			notFound: true,
			lastSeenAt: "2025-06-01T00:00:00.000Z",
		});
	});

	it("apiItemOrder is untouched — the new Folder-source delete path never adds, removes, or reorders an API source's rows", () => {
		const { vm, viewId, nodeId } = setupApiSourceWithNoteRef();

		vm.onVaultDelete("Projects/a.md");

		expect(vm.getNode(viewId, nodeId)!.apiItemOrder).toEqual(["1", "2"]);
	});

	it("a node with both an apiSource and populated apiItemState but no folderSource is never swept by the Folder-source reconciliation rule, even when the deleted path matches nothing — no crash, no mutation beyond G27's noteRef clear", () => {
		const { vm, viewId, nodeId } = setupApiSourceWithNoteRef();

		expect(() => vm.onVaultDelete("Some/Unrelated/Path.md")).not.toThrow();

		const node = vm.getNode(viewId, nodeId)!;
		expect(node.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Projects/a.md" });
		expect(Object.keys(node.apiItemState!)).toEqual(["1", "2"]);
	});
});
