import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, View, ViewNode } from "../../src/types";

/** In-memory stand-in for `FolderSourcePathStore`'s public surface — same shape
 * `folder-source-outside-device-local-storage.test.ts` uses, minus the real localStorage host, since
 * this test only cares about get/set ordering relative to `duplicateFolder`'s own notification. */
class FakePathStore {
	private paths = new Map<string, string>();
	get(nodeId: string): string {
		return this.paths.get(nodeId) ?? "";
	}
	set(nodeId: string, path: string): void {
		this.paths.set(nodeId, path);
	}
	delete(nodeId: string): void {
		this.paths.delete(nodeId);
	}
}

function callDuplicateFolder(plugin: Record<string, unknown>, view: View, node: ViewNode): void {
	(AtlasExplorerView.prototype as unknown as { duplicateFolder: (view: View, node: ViewNode) => void }).duplicateFolder.call(
		{ plugin },
		view,
		node
	);
}

describe("PR-2 R4: duplicating an Outside-Vault Folder source registers the clone's path before any watcher-sync listener reads it", () => {
	it("every onChange notification duplicateFolder triggers sees the clone's outside path already set", () => {
		const folderSource: FolderSourceConfig = { type: "folder", location: "outside", path: "", showFiles: true, showFolders: true, mode: "merge" };
		const owner: ViewNode = { id: "owner", type: "meta", label: "Invoices", children: [], folderSource };
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [owner] };
		const viewsManager = new ViewsManager({} as App, [view], "v1", vi.fn());
		const pathStore = new FakePathStore();
		pathStore.set("owner", "/Volumes/External/Invoices");

		// Mirrors main.ts's own `this.viewsManager.onChange(() => this.syncOutsideFolderWatchers())` —
		// a listener that, on every notification, would open/close watchers based on each outside
		// source node's path at that instant.
		const sawClonePathPerNotification: boolean[] = [];
		viewsManager.onChange(() => {
			const clone = view.root.find((n) => n.id !== "owner" && n.folderSource?.location === "outside");
			sawClonePathPerNotification.push(clone !== undefined && pathStore.get(clone.id) === "/Volumes/External/Invoices");
		});

		const plugin = { viewsManager, folderSourcePathStore: pathStore, apiHeadersStore: { get: () => [], set: vi.fn() } };
		callDuplicateFolder(plugin, view, owner);

		expect(sawClonePathPerNotification.length).toBeGreaterThan(0);
		// The bug: `duplicateNode`'s own save fires a notification before the path is copied, so a
		// watcher-sync listener reading at that point sees no path and never opens a watcher for the
		// clone. The fix must guarantee the *last* notification (the one any listener ends up acting
		// on) sees the path already in place.
		expect(sawClonePathPerNotification.at(-1)).toBe(true);
	});

	it("duplicating a Folder source with no Outside-Vault location never re-notifies on its own", () => {
		const owner: ViewNode = { id: "owner", type: "meta", label: "Notes", children: [], folderSource: { type: "folder", location: "inside", path: "Notes" } };
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [owner] };
		const viewsManager = new ViewsManager({} as App, [view], "v1", vi.fn());
		const pathStore = new FakePathStore();

		let notifications = 0;
		viewsManager.onChange(() => notifications++);

		const plugin = { viewsManager, folderSourcePathStore: pathStore, apiHeadersStore: { get: () => [], set: vi.fn() } };
		callDuplicateFolder(plugin, view, owner);

		// Only `duplicateNode`'s own save — no extra notification when there was no outside path to copy.
		expect(notifications).toBe(1);
	});
});
