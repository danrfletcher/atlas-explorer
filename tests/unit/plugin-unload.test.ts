import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import AtlasPlugin from "../../src/main";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import { FolderSourceOutsideWatchers } from "../../src/folder-source-outside-watcher";
import { ALWAYS_UPDATE_LINKS_KEY, TephraLinkSetting, readStoredVaultConfig } from "../../src/tephra-link-setting";
import { TephraRenameForwarder } from "../../src/tephra-rename-forwarder";
import { TephraRenameQueue, type QueueStorage } from "../../src/tephra-rename-queue";
import { normalizeSavedLinkSetting, type SavedLinkSetting } from "../../src/settings";

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

/** PR-10 (E8): quitting Obsidian or disabling Atlas restores nothing and clears nothing. Only the Tephra toggle's
 * off path does (R3-3). The forwarder, the queue and the link setting are the real classes; only the file system is in memory. */
describe("AtlasPlugin.onunload — Tephra rename queue and Obsidian's link setting (E8)", () => {
	it("leaves alwaysUpdateLinks off, keeps the saved value, and leaves the queue file byte for byte as it was", async () => {
		vi.useFakeTimers();
		try {
			const app = new App();
			app.vault.config[ALWAYS_UPDATE_LINKS_KEY] = true;
			const settings: { tephraSavedLinkSetting?: SavedLinkSetting | null } = {};
			const setting = new TephraLinkSetting({
				getConfig: (key) => app.vault.getConfig(key),
				getStoredConfig: (key) => readStoredVaultConfig(app.vault, key),
				setConfig: (key, value) => app.vault.setConfig(key, value),
				getSaved: () => normalizeSavedLinkSetting(settings.tephraSavedLinkSetting),
				setSaved: (saved) => {
					settings.tephraSavedLinkSetting = saved;
				},
				save: async () => {},
				isActive: () => true,
				isMobile: () => false,
			});
			await setting.enable();
			expect(app.vault.getConfig(ALWAYS_UPDATE_LINKS_KEY)).toBe(false);

			const files = new Map<string, string>();
			const writes: string[] = [];
			const storage: QueueStorage = {
				read: (path) => files.get(path) ?? null,
				write: (path, text) => {
					writes.push(path);
					files.set(path, text);
				},
				moveAside: () => {
					throw new Error("must not be called");
				},
			};
			let online = false;
			const sent: unknown[] = [];
			const forwarder = new TephraRenameForwarder({
				queue: new TephraRenameQueue({ storage, path: "/q.json", now: () => 1, onCorrupt: () => {}, onWriteError: () => {} }),
				scheduler: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as never) },
				now: () => Date.now(),
				isActive: () => true,
				getConnection: () => ({ isOnline: () => online, call: async (_m, params) => (sent.push(params), { ok: true as const, result: null }) }),
				notify: () => {},
				log: () => {},
			});
			forwarder.load();
			forwarder.record("a.md", "b.md", false); // offline: queued
			vi.advanceTimersByTime(60);
			const queueFile = files.get("/q.json");
			expect(queueFile).toContain("a.md");
			const writesBefore = writes.length;
			const setConfig = vi.spyOn(app.vault, "setConfig");

			const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
			plugin.folderLiveRefresh = { cancelAll: vi.fn() };
			plugin.persistDebounced = undefined;
			plugin.graduation = undefined;
			plugin.app = {} as never;
			plugin.linkSuggest = undefined as never;
			plugin.tephraRenames = forwarder;
			plugin.tephraLinkSetting = setting;
			plugin.onunload();

			// Tephra coming back after the plugin is gone sends nothing, and nothing is written
			online = true;
			forwarder.kick();
			vi.advanceTimersByTime(60_000);
			expect(sent).toEqual([]);
			expect(files.get("/q.json")).toBe(queueFile);
			expect(writes).toHaveLength(writesBefore);
			expect(setConfig).not.toHaveBeenCalled();
			expect(app.vault.getConfig(ALWAYS_UPDATE_LINKS_KEY)).toBe(false); // not restored
			expect(settings.tephraSavedLinkSetting).toEqual({ present: true, value: true }); // still remembered, for the toggle's off path
		} finally {
			vi.useRealTimers();
		}
	});

	it("onunload source names no restore and no queue clearing (the toggle's off path is the only caller)", () => {
		const src = readFileSync(join(__dirname, "../../src/main.ts"), "utf8");
		const start = src.indexOf("\tonunload() {");
		const body = src.slice(start, src.indexOf("\n\t}\n", start));
		expect(body).not.toMatch(/restore\s*\(|ensureOff|\.enable\s*\(|removeWhere|\.remove\s*\(|runTephraTeardown/);
		expect(body).toMatch(/tephraRenames\?\.dispose\(\)/);
	});
});
