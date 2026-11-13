import { describe, expect, it, vi } from "vitest";
import { openRepaintRig } from "../integration/repaint-rig";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { AtlasSettings, DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
import { McpTokenStore } from "../../src/mcp-token-store";
import type { AddedItem, UnitRef } from "../../src/types";

/** Bypasses `AtlasPlugin`'s constructor (which needs a real Obsidian `app`/`manifest`) so these
 * tests can call `loadFromData`/`persistNow` directly against a minimal stub, per R1. */
function makePlugin(): AtlasPlugin {
	return Object.create(AtlasPlugin.prototype) as AtlasPlugin;
}

describe("AtlasPlugin.loadFromData", () => {
	it("loads a data.json missing dismissedByView/dismissedGlobal/addedItems without throwing, defaulting to empty", () => {
		const plugin = makePlugin();
		// Shaped like a pre-PR-2 data.json (tests/fixtures/data-v0.2.1.json): the three new fields
		// are entirely absent, not just empty.
		const preExistingData = {
			settings: DEFAULT_SETTINGS,
			manualPromotions: [],
			views: [],
			activeViewId: "default",
			expandedModuleFolders: [],
			statusSets: [],
			colorPalette: ["#ff0000"],
		};

		expect(() => (plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(preExistingData)).not.toThrow();

		const loaded = plugin as unknown as { dismissedByView: unknown; dismissedGlobal: unknown; addedItems: unknown };
		expect(loaded.dismissedByView).toEqual({});
		expect(loaded.dismissedGlobal).toEqual([]);
		expect(loaded.addedItems).toEqual([]);
	});
});

describe("AtlasPlugin.persistNow", () => {
	it("includes dismissedByView, dismissedGlobal and addedItems in the saved shape", async () => {
		const plugin = makePlugin();
		const app = new App();
		const ref: UnitRef = { kind: "file", path: "Foo.md" };
		const addedItem: AddedItem = { ref, tag: "added" };
		const unitIndex = new UnitIndex(app, DEFAULT_SETTINGS, [], { v1: [ref] }, [], [addedItem]);
		const viewsManager = new ViewsManager(app, [], "default", () => {});
		const statusesManager = new StatusesManager([], [], () => {});

		const saved: unknown[] = [];
		Object.assign(plugin, {
			settings: DEFAULT_SETTINGS,
			unitIndex,
			viewsManager,
			statusesManager,
			expandedModuleFolders: new Set<string>(),
			saveData: async (data: unknown) => {
				saved.push(data);
			},
		});

		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

		expect(saved).toHaveLength(1);
		const data = saved[0] as { dismissedByView: unknown; dismissedGlobal: unknown; addedItems: unknown };
		expect(data.dismissedByView).toEqual({ v1: [ref] });
		expect(data.dismissedGlobal).toEqual([]);
		expect(data.addedItems).toEqual([addedItem]);
	});
});

describe("noAutoPromoteFolders persistence (G1)", () => {
	it("a data.json without the key loads as []", () => {
		const plugin = makePlugin();
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData({
			settings: { poolFolder: "_pool", excludedFolders: [] },
			manualPromotions: [],
			views: [],
			activeViewId: "default",
			expandedModuleFolders: [],
			statusSets: [],
			colorPalette: [],
		});
		expect((plugin as unknown as { settings: AtlasSettings }).settings.noAutoPromoteFolders).toEqual([]);
	});

	it("the loaded array is never shared with DEFAULT_SETTINGS or with an earlier load", () => {
		const plugin = makePlugin();
		const load = () => {
			(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData({ settings: { poolFolder: "_pool" } });
			return (plugin as unknown as { settings: AtlasSettings }).settings.noAutoPromoteFolders;
		};
		const first = load();
		first.push("Mutated");
		const second = load();
		expect(second).toEqual([]);
		expect(second).not.toBe(first);
		expect(DEFAULT_SETTINGS.noAutoPromoteFolders).toEqual([]);
	});

	it("a hand-edited entry is normalised on load", () => {
		const plugin = makePlugin();
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData({
			settings: { poolFolder: "_pool", noAutoPromoteFolders: [" /Attachments/ ", "", "_pool/"] },
		});
		expect((plugin as unknown as { settings: AtlasSettings }).settings.noAutoPromoteFolders).toEqual(["Attachments"]);
	});

	it("save and reload round-trips the list", async () => {
		const plugin = makePlugin();
		const app = new App();
		const settings: AtlasSettings = { ...DEFAULT_SETTINGS, poolFolder: "_pool", noAutoPromoteFolders: ["Attachments", "Projects/Old/assets"] };
		const saved: unknown[] = [];
		Object.assign(plugin, {
			settings,
			unitIndex: new UnitIndex(app, settings, []),
			viewsManager: new ViewsManager(app, [], "default", () => {}),
			statusesManager: new StatusesManager([], [], () => {}),
			expandedModuleFolders: new Set<string>(),
			saveData: async (data: unknown) => {
				saved.push(data);
			},
		});
		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(saved[0]);
		expect((plugin as unknown as { settings: AtlasSettings }).settings.noAutoPromoteFolders).toEqual(["Attachments", "Projects/Old/assets"]);
	});
});

describe("highlightOpenNote persistence (PR-1.F2, F3)", () => {
	function makeFullPlugin(settings: AtlasSettings, saved: unknown[]): AtlasPlugin {
		const plugin = makePlugin();
		const app = new App();
		Object.assign(plugin, {
			settings,
			unitIndex: new UnitIndex(app, settings, []),
			viewsManager: new ViewsManager(app, [], "default", () => {}),
			statusesManager: new StatusesManager([], [], () => {}),
			expandedModuleFolders: new Set<string>(),
			saveData: async (data: unknown) => {
				saved.push(data);
			},
		});
		return plugin;
	}

	it("saving and reloading round-trips the key, both when on and when off", async () => {
		for (const value of [true, false]) {
			const settings: AtlasSettings = { ...DEFAULT_SETTINGS, highlightOpenNote: value };
			const saved: unknown[] = [];
			const plugin = makeFullPlugin(settings, saved);
			await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

			const reloaded = makePlugin();
			(reloaded as unknown as { loadFromData(d: unknown): void }).loadFromData(saved[0]);
			expect((reloaded as unknown as { settings: AtlasSettings }).settings.highlightOpenNote).toBe(value);
		}
	});

	it("F3: adds no key to the saved settings object other than highlightOpenNote itself", async () => {
		const before: AtlasSettings = { ...DEFAULT_SETTINGS };
		const after: AtlasSettings = { ...DEFAULT_SETTINGS, highlightOpenNote: false };
		const savedBefore: unknown[] = [];
		const savedAfter: unknown[] = [];
		await (makeFullPlugin(before, savedBefore) as unknown as { persistNow(): Promise<void> }).persistNow();
		await (makeFullPlugin(after, savedAfter) as unknown as { persistNow(): Promise<void> }).persistNow();

		const keysBefore = Object.keys((savedBefore[0] as { settings: AtlasSettings }).settings).sort();
		const keysAfter = Object.keys((savedAfter[0] as { settings: AtlasSettings }).settings).sort();
		expect(keysAfter).toEqual(keysBefore);
	});

	it("F3: loading the v0.2.1 fixture through loadFromData and persisting it adds no settings key other than noAutoPromoteFolders and highlightOpenNote, and no new top-level key", async () => {
		// Real end-to-end load -> persist against pre-PR-1.F1/F2 data, not a comparison of two
		// post-PR saves that differ only in highlightOpenNote's value (which can't catch a stray
		// extra key landing on both sides identically).
		const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/data-v0.2.1.json"), "utf8"));

		const plugin = makePlugin();
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(fixture);
		const loaded = plugin as unknown as {
			settings: AtlasSettings;
			manualPromotions: UnitRef[];
			dismissedByView: Record<string, UnitRef[]>;
			dismissedGlobal: UnitRef[];
			addedItems: AddedItem[];
		};

		const app = new App();
		const saved: unknown[] = [];
		// Mirrors `AtlasPlugin.onload`'s own construction of these from the loaded data, so
		// `persistNow` sees exactly what a real reload of this fixture would.
		Object.assign(plugin, {
			unitIndex: new UnitIndex(app, loaded.settings, loaded.manualPromotions, loaded.dismissedByView, loaded.dismissedGlobal, loaded.addedItems),
			viewsManager: new ViewsManager(app, fixture.views ?? [], fixture.activeViewId ?? "", () => {}),
			statusesManager: new StatusesManager(fixture.statusSets ?? [], fixture.colorPalette ?? [], () => {}),
			saveData: async (data: unknown) => {
				saved.push(data);
			},
		});

		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();
		expect(saved).toHaveLength(1);
		const persisted = saved[0] as Record<string, unknown>;

		const settingsKeys = Object.keys(persisted.settings as AtlasSettings).sort();
		expect(settingsKeys).toEqual([...Object.keys(fixture.settings), "noAutoPromoteFolders", "highlightOpenNote", "mcpServerEnabled", "autoPromotion", "tephraMode", "tephraLinkFallback"].sort());

		// No top-level key beyond what PR-2 already established (dismissedByView/dismissedGlobal/
		// addedItems, defaulted here since the fixture predates them) and atlas-17 PR-2's
		// hiddenModuleItems — PR-1.F2 adds none of its own.
		const topLevelKeys = Object.keys(persisted).sort();
		expect(topLevelKeys).toEqual(
			["settings", "manualPromotions", "views", "activeViewId", "expandedModuleFolders", "statusSets", "colorPalette", "dismissedByView", "dismissedGlobal", "addedItems", "hiddenModuleItems"].sort()
		);
	});

	it("atlas-15 PR-2 F1: after the explorer has rendered, skipped and re-rendered, the saved views, promotions, status sets and palette are byte-identical to the v0.2.1 fixture", async () => {
		// The staged render and the notify gating read the stored data and must never write to it: load the
		// fixture, drive real renders over it (first paint, then identical ones that are skipped), persist, compare.
		const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/data-v0.2.1.json"), "utf8"));
		const plugin = makePlugin();
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(fixture);
		const loaded = plugin as unknown as {
			settings: AtlasSettings;
			manualPromotions: UnitRef[];
			dismissedByView: Record<string, UnitRef[]>;
			dismissedGlobal: UnitRef[];
			addedItems: AddedItem[];
		};
		const app = new App();
		const saved: Record<string, unknown>[] = [];
		const viewsManager = new ViewsManager(app, fixture.views ?? [], fixture.activeViewId ?? "", () => {});
		const unitIndex = new UnitIndex(app, loaded.settings, loaded.manualPromotions, loaded.dismissedByView, loaded.dismissedGlobal, loaded.addedItems);
		Object.assign(plugin, {
			unitIndex,
			viewsManager,
			statusesManager: new StatusesManager(fixture.statusSets ?? [], fixture.colorPalette ?? [], () => {}),
			saveData: async (data: Record<string, unknown>) => {
				saved.push(data);
			},
		});

		vi.useFakeTimers();
		const rig = await openRepaintRig({ unitIndex, viewsManager });
		try {
			unitIndex.onMetadataResolved(); // notifies; the render it queues finds identical output
			viewsManager.onMetadataResolved();
			await rig.settle();
			unitIndex.onMetadataResolved();
			await rig.settle();
		} finally {
			rig.close();
			vi.useRealTimers();
		}
		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

		const persisted = saved[0];
		for (const key of ["views", "manualPromotions", "statusSets", "colorPalette", "activeViewId"] as const) {
			expect(JSON.stringify(persisted[key]), key).toBe(JSON.stringify(fixture[key] ?? (key === "activeViewId" ? "" : [])));
		}
		expect(Object.keys(persisted).sort()).toEqual(
			["settings", "manualPromotions", "views", "activeViewId", "expandedModuleFolders", "statusSets", "colorPalette", "dismissedByView", "dismissedGlobal", "addedItems", "hiddenModuleItems"].sort()
		);
	});
});

describe("R6/F6 — the MCP bearer token never reaches data.json", () => {
	it("persistNow's saved object contains no trace of the real MCP token, anywhere, at any depth", async () => {
		const plugin = makePlugin();
		const app = new App();
		const settings: AtlasSettings = { ...DEFAULT_SETTINGS, mcpServerEnabled: true };
		const saved: unknown[] = [];

		// A real token, generated the same way `McpTokenStore` does — present on the plugin
		// instance (as it would be on a real one, via `initMcpServer`) but never wired into
		// anything `persistNow` reads from, since the token store writes to Obsidian's own
		// per-device `localStorage`, never through `saveData`/`data.json`.
		app.saveLocalStorage("atlas-mcp-server", { port: 27202, token: "f6-leak-canary-00112233" });

		Object.assign(plugin, {
			settings,
			unitIndex: new UnitIndex(app, settings, []),
			viewsManager: new ViewsManager(app, [], "default", () => {}),
			statusesManager: new StatusesManager([], [], () => {}),
			expandedModuleFolders: new Set<string>(),
			mcpTokenStore: new McpTokenStore(app),
			saveData: async (data: unknown) => {
				saved.push(data);
			},
		});

		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

		expect(saved).toHaveLength(1);
		expect(JSON.stringify(saved[0])).not.toContain("f6-leak-canary-00112233");
	});
});

describe("render log vs data.json", () => {
	it("persistNow output has no render-log key, and the key set is the pre-render-log one", async () => {
		const plugin = makePlugin();
		const app = new App();
		const unitIndex = new UnitIndex(app, DEFAULT_SETTINGS, [], {}, [], []);
		const viewsManager = new ViewsManager(app, [], "default", () => {});
		const statusesManager = new StatusesManager([], [], () => {});
		const saved: Record<string, unknown>[] = [];
		Object.assign(plugin, {
			settings: DEFAULT_SETTINGS,
			unitIndex,
			viewsManager,
			statusesManager,
			expandedModuleFolders: new Set<string>(),
			// A plugin that owns a render log with entries in it must still not write them to data.json.
			renderLog: { entries: () => [{ kind: "other", at: 1, durationMs: 1, changed: true }], serialize: () => "[...]" },
			saveData: async (data: Record<string, unknown>) => {
				saved.push(data);
			},
		});

		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

		expect(Object.keys(saved[0]).sort()).toEqual(
			[
				"activeViewId",
				"addedItems",
				"colorPalette",
				"dismissedByView",
				"dismissedGlobal",
				"expandedModuleFolders",
				"hiddenModuleItems",
				"manualPromotions",
				"settings",
				"statusSets",
				"views",
			].sort()
		);
		expect(JSON.stringify(saved[0])).not.toMatch(/render|durationMs/i);
	});
});
