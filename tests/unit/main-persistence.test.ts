import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
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
