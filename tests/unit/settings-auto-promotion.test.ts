import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { AtlasSettingTab, DEFAULT_SETTINGS, normalizeAutoPromotion } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";

/** PR-1 (G1): the `autoPromotion` setting — default, schema, load/save round trip and the settings-tab
 * toggle. `Setting` is replaced with a recorder (same technique as `mcp-settings.test.ts`); every other
 * export of the obsidian mock is kept. */

interface Row {
	name: string;
	desc: string;
	toggles: { value?: boolean; onChange?: (v: boolean) => unknown }[];
}

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	class FakeSetting {
		static rows: Row[] = [];
		private row: Row = { name: "", desc: "", toggles: [] };
		constructor(public containerEl: HTMLElement) {
			FakeSetting.rows.push(this.row);
		}
		setName(name: string) {
			this.row.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.row.desc = desc;
			return this;
		}
		setHeading() {
			return this;
		}
		addToggle(cb: (c: unknown) => void) {
			const state: Row["toggles"][number] = {};
			const component = {
				setValue: (v: boolean) => ((state.value = v), component),
				onChange: (fn: (v: boolean) => unknown) => ((state.onChange = fn), component),
			};
			cb(component);
			this.row.toggles.push(state);
			return this;
		}
		// The other controls on the Basic tab are not under test here; each accepts its callback and ignores it.
		addText(cb: (c: unknown) => void) {
			cb(inert());
			return this;
		}
		addTextArea(cb: (c: unknown) => void) {
			cb(inert());
			return this;
		}
		addDropdown(cb: (c: unknown) => void) {
			cb(inert());
			return this;
		}
	}
	function inert(): unknown {
		const proxy: unknown = new Proxy({}, { get: () => () => proxy });
		return proxy;
	}
	return { ...actual, Setting: FakeSetting, Platform: { ...actual.Platform, isMobile: true } };
});

const loadFromData = (plugin: AtlasPlugin, data: unknown) => (plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(data);
const settingsOf = (plugin: AtlasPlugin) => (plugin as unknown as { settings: AtlasSettings }).settings;
const makePlugin = () => Object.create(AtlasPlugin.prototype) as AtlasPlugin;

describe("autoPromotion: schema and default", () => {
	it("DEFAULT_SETTINGS.autoPromotion is the boolean false", () => {
		expect(DEFAULT_SETTINGS.autoPromotion).toBe(false);
		expect(typeof DEFAULT_SETTINGS.autoPromotion).toBe("boolean");
	});

	it.each([
		[true, true],
		[false, false],
		[undefined, false],
		[null, false],
		["true", false],
		["false", false],
		[1, false],
		[0, false],
		[{}, false],
		[[], false],
	])("normalizeAutoPromotion(%j) is %s: only a real boolean is carried through", (raw, expected) => {
		expect(normalizeAutoPromotion(raw)).toBe(expected);
	});
});

describe("autoPromotion: loading data.json", () => {
	it("a legacy data.json without the key loads as off, and every other setting is kept", () => {
		const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/data-v0.2.1.json"), "utf8"));
		expect("autoPromotion" in fixture.settings).toBe(false);
		const plugin = makePlugin();
		loadFromData(plugin, fixture);
		const settings = settingsOf(plugin);
		expect(settings.autoPromotion).toBe(false);
		for (const [key, value] of Object.entries(fixture.settings)) {
			if (key === "noAutoPromoteFolders") continue; // normalised on load
			expect(settings[key as keyof AtlasSettings], key).toEqual(value);
		}
	});

	it("no data.json at all (first install) loads as off", () => {
		const plugin = makePlugin();
		(plugin as unknown as { app: App }).app = new App();
		loadFromData(plugin, null);
		expect(settingsOf(plugin).autoPromotion).toBe(false);
	});

	it("an explicit true is kept", () => {
		const plugin = makePlugin();
		loadFromData(plugin, { settings: { poolFolder: "_pool", autoPromotion: true } });
		expect(settingsOf(plugin).autoPromotion).toBe(true);
	});

	it.each(["true", 1, null, {}])("a hand-edited non-boolean (%j) loads as off, not truthy", (raw) => {
		const plugin = makePlugin();
		loadFromData(plugin, { settings: { poolFolder: "_pool", autoPromotion: raw } });
		expect(settingsOf(plugin).autoPromotion).toBe(false);
	});

	it("loading never changes DEFAULT_SETTINGS", () => {
		const plugin = makePlugin();
		loadFromData(plugin, { settings: { poolFolder: "_pool", autoPromotion: true } });
		expect(DEFAULT_SETTINGS.autoPromotion).toBe(false);
	});
});

describe("autoPromotion: serialization through persistNow and loadFromData", () => {
	function persistingPlugin(settings: AtlasSettings, saved: unknown[]): AtlasPlugin {
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

	it.each([true, false])("a saved %s survives a reload, and it is stored inside `settings`, not as a new top-level key", async (value) => {
		const saved: unknown[] = [];
		const plugin = persistingPlugin({ ...DEFAULT_SETTINGS, autoPromotion: value }, saved);
		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();
		const data = saved[0] as { settings: AtlasSettings } & Record<string, unknown>;
		expect(data.settings.autoPromotion).toBe(value);
		expect("autoPromotion" in data).toBe(false);

		const reloaded = makePlugin();
		loadFromData(reloaded, JSON.parse(JSON.stringify(saved[0])));
		expect(settingsOf(reloaded).autoPromotion).toBe(value);
	});

	it("an old file saved by this version gains exactly the one key", async () => {
		const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/data-v0.2.1.json"), "utf8"));
		const plugin = makePlugin();
		loadFromData(plugin, fixture);
		const saved: unknown[] = [];
		const loaded = settingsOf(plugin);
		const persister = persistingPlugin(loaded, saved);
		await (persister as unknown as { persistNow(): Promise<void> }).persistNow();
		const keys = Object.keys((saved[0] as { settings: AtlasSettings }).settings);
		expect(keys).toContain("autoPromotion");
		expect(Object.keys(fixture.settings).filter((k) => !keys.includes(k))).toEqual([]);
	});
});

describe("autoPromotion: the settings-tab toggle", () => {
	async function renderBasicTab(autoPromotion: boolean) {
		const { Setting } = await import("obsidian");
		const rows = (Setting as unknown as { rows: Row[] }).rows;
		rows.length = 0;
		const refreshExplorerViews = vi.fn();
		const plugin = {
			settings: { ...DEFAULT_SETTINGS, autoPromotion } as AtlasSettings,
			saveSettings: vi.fn(async () => {}),
			refreshExplorerViews,
			unitIndex: { rebuild: vi.fn() },
		};
		const tab = new AtlasSettingTab(new App() as never, plugin as never);
		(tab as unknown as { renderBasicTab(el: HTMLElement): void }).renderBasicTab(document.createElement("div"));
		const row = rows.find((r) => r.name === "Auto-promote linked items");
		return { row, plugin };
	}

	it("shows an 'Auto-promote linked items' toggle in the Basic tab, off by default", async () => {
		const { row } = await renderBasicTab(DEFAULT_SETTINGS.autoPromotion);
		expect(row).toBeDefined();
		expect(row!.toggles).toHaveLength(1);
		expect(row!.toggles[0].value).toBe(false);
		expect(row!.desc.length).toBeGreaterThan(0);
	});

	it("shows the saved state when it is on", async () => {
		const { row } = await renderBasicTab(true);
		expect(row!.toggles[0].value).toBe(true);
	});

	it("flipping it sets the setting, saves, and repaints the explorer; flipping back reverses it", async () => {
		const { row, plugin } = await renderBasicTab(false);
		await row!.toggles[0].onChange!(true);
		expect(plugin.settings.autoPromotion).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.refreshExplorerViews).toHaveBeenCalledTimes(1);
		await row!.toggles[0].onChange!(false);
		expect(plugin.settings.autoPromotion).toBe(false);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
		expect(plugin.refreshExplorerViews).toHaveBeenCalledTimes(2);
	});

	it("saves before it repaints, so the explorer never draws a state that is not yet on disk", async () => {
		const { row, plugin } = await renderBasicTab(false);
		const order: string[] = [];
		plugin.saveSettings.mockImplementation(async () => {
			order.push("save");
		});
		plugin.refreshExplorerViews.mockImplementation(() => order.push("refresh"));
		await row!.toggles[0].onChange!(true);
		expect(order).toEqual(["save", "refresh"]);
	});

	it("the toggle does not rebuild the index (promotion itself is unchanged)", async () => {
		const { row, plugin } = await renderBasicTab(false);
		await row!.toggles[0].onChange!(true);
		expect(plugin.unitIndex.rebuild).not.toHaveBeenCalled();
	});
});
