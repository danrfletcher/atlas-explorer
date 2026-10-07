import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import AtlasPlugin from "../../src/main";
import { FolderSourceOutsideWatchers } from "../../src/folder-source-outside-watcher";

/** PR-2 (G9): `onunload` closes every outside-folder watcher the plugin registered. The registry is real;
 * only `fs.watch` is mocked. */
describe("AtlasPlugin.onunload — outside-folder watchers", () => {
	it("closes every registered watcher, and nothing fires afterwards", () => {
		vi.useFakeTimers();
		try {
			const watchers: EventEmitter[] = [];
			const close = vi.fn();
			const watch = vi.fn(() => {
				const w = Object.assign(new EventEmitter(), { close });
				watchers.push(w);
				return w;
			});
			const onRescan = vi.fn();
			const registry = new FolderSourceOutsideWatchers({ watch, isResolved: () => true, onRescan });
			registry.sync(
				new Map([
					["node-a", "/Docs/Invoices"],
					["node-b", "/Docs/Receipts"],
				])
			);
			watchers[0].emit("change", "rename", "late.pdf");

			const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
			plugin.outsideFolderWatchers = registry;
			plugin.folderLiveRefresh = { cancelAll: vi.fn() };
			plugin.persistDebounced = undefined;
			plugin.graduation = undefined;
			plugin.app = {} as never;
			plugin.linkSuggest = undefined as never;

			plugin.onunload();
			vi.advanceTimersByTime(10_000);

			expect(close).toHaveBeenCalledTimes(2);
			expect(onRescan).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
