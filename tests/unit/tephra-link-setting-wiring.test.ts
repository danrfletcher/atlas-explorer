import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { TephraController } from "../../src/tephra-controller";
import { TephraTeardownRegistry } from "../../src/tephra-teardown";
import { ALWAYS_UPDATE_LINKS_KEY, TephraLinkSetting } from "../../src/tephra-link-setting";
import { normalizeSavedLinkSetting, type SavedLinkSetting } from "../../src/settings";
import type { TephraConnection } from "../../src/tephra-connection";

/** G11: the toggle's two paths, through the real `TephraController`, the real teardown registry and the plugin's own
 * `onTephraToggled`; the vault config is the mock's. Turning on saves the old value, then switches Obsidian's setting off;
 * turning off puts it back; reaching only the off path through the registry is `main.ts`'s own wiring. */
function build(initial: unknown) {
	const app = new App();
	if (initial !== undefined) app.vault.config[ALWAYS_UPDATE_LINKS_KEY] = initial;
	const settings: { tephraEnabled: boolean; tephraSavedLinkSetting?: SavedLinkSetting | null } = { tephraEnabled: false };
	const disk: { tephraEnabled: boolean; saved: unknown; configAtSave: unknown[] }[] = [];
	const save = async () => {
		disk.push({ tephraEnabled: settings.tephraEnabled, saved: structuredClone(settings.tephraSavedLinkSetting ?? null), configAtSave: [app.vault.getConfig(ALWAYS_UPDATE_LINKS_KEY)] });
	};
	const tephraActive = () => settings.tephraEnabled;
	const linkSetting = new TephraLinkSetting({
		getConfig: (key) => app.vault.getConfig(key),
		setConfig: (key, value) => {
			if (value === undefined) delete app.vault.config[key];
			else app.vault.setConfig(key, value);
		},
		getSaved: () => normalizeSavedLinkSetting(settings.tephraSavedLinkSetting),
		setSaved: (saved) => {
			settings.tephraSavedLinkSetting = saved;
		},
		save,
		isActive: tephraActive,
		isMobile: () => false,
	});
	const registry = new TephraTeardownRegistry();
	registry.register({ name: "Obsidian link-update setting", run: () => linkSetting.restore() });
	const renames = { load: vi.fn(), kick: vi.fn() };
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	Object.assign(plugin, {
		sourcesFolder: { start: vi.fn() },
		tephraGraphSync: { unbind: vi.fn() },
		tephraBacklinks: { refresh: vi.fn() },
		sourceLinks: { getMode: () => "live", sync: vi.fn() },
		unitIndex: { rebuild: vi.fn() },
		refreshExplorerViews: vi.fn(),
		tephraLinkSetting: linkSetting,
		tephraRenames: renames,
	});
	const controller = new TephraController({
		getEnabled: () => settings.tephraEnabled,
		setEnabled: (enabled) => {
			settings.tephraEnabled = enabled;
		},
		save,
		isMobile: () => false,
		createConnection: () => ({ start: vi.fn(), stop: vi.fn() }) as unknown as TephraConnection,
		runTeardown: () => registry.run(),
		reportTeardownFailures: () => {},
		afterChange: (enabled) => plugin.onTephraToggled(enabled),
	});
	return { app, settings, disk, controller, renames, registry };
}

const value = (app: App) => app.vault.getConfig(ALWAYS_UPDATE_LINKS_KEY);

describe("the toggle's on and off paths drive Obsidian's link setting", () => {
	it.each([[true], [false], [undefined]])("on then off with the old value %s: switched off while on, put back exactly afterwards", async (initial) => {
		const t = build(initial);
		await t.controller.setEnabled(true);
		await vi.waitFor(() => expect(value(t.app)).toBe(false));
		expect(t.settings.tephraSavedLinkSetting).toEqual(initial === undefined ? { present: false } : { present: true, value: initial });
		// saved to data.json before the setting changed: the last save that saw the old value already carries the record
		const withRecord = t.disk.find((entry) => entry.saved !== null)!;
		expect(withRecord.configAtSave[0]).toBe(initial);
		expect(t.renames.load).toHaveBeenCalled();
		expect(t.renames.kick).toHaveBeenCalled();

		await t.controller.setEnabled(false);
		expect(value(t.app)).toBe(initial);
		expect(Object.hasOwn(t.app.vault.config, ALWAYS_UPDATE_LINKS_KEY)).toBe(initial !== undefined);
		expect(t.settings.tephraSavedLinkSetting).toBeNull();
		expect(t.disk.at(-1)).toMatchObject({ tephraEnabled: false, saved: null }); // the cleared record is on disk with the toggle
	});

	it("off then on again: the old value is saved afresh, and Atlas never touches the setting in between", async () => {
		const t = build(true);
		await t.controller.setEnabled(true);
		await t.controller.setEnabled(false);
		t.app.vault.config[ALWAYS_UPDATE_LINKS_KEY] = false; // Dan changes it while the toggle is off
		const setConfig = vi.spyOn(t.app.vault, "setConfig");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(setConfig).not.toHaveBeenCalled();
		await t.controller.setEnabled(true);
		await vi.waitFor(() => expect(t.settings.tephraSavedLinkSetting).toEqual({ present: true, value: false }));
		await t.controller.setEnabled(false);
		expect(value(t.app)).toBe(false);
	});
});

describe("main.ts wiring (source checks)", () => {
	const main = readFileSync(join(__dirname, "../../src/main.ts"), "utf8");

	it("the link setting's restore is a registered teardown step: the toggle's off path is its only caller", () => {
		expect(main).toMatch(/registerTephraTeardown\(\{ name: "Obsidian link-update setting", run: \(\) => this\.tephraLinkSetting\.restore\(\) \}\)/);
		expect(main.match(/tephraLinkSetting\.restore\(/g)).toHaveLength(1);
	});

	it("ensureOff runs at load while the toggle is on, and the Tephra tab runs it when opened", () => {
		expect(main).toMatch(/if \(this\.tephraActive\(\)\) \{\s*this\.tephraRenames\.load\(\);\s*void this\.tephraLinkSetting\.ensureOff\(\);/);
		expect(readFileSync(join(__dirname, "../../src/settings.ts"), "utf8")).toMatch(/private renderTephraTab\(containerEl: HTMLElement\): void \{[^}]*tephraLinkSetting\?\.ensureOff\(\)/);
	});

	it("every afterMove path suppresses the notice while the toggle is on", () => {
		expect(main).toMatch(/afterMove: \(\) => void noticeIfLinksNotUpdated\(this\.app, undefined, \(\) => this\.tephraActive\(\)\)/);
		expect(readFileSync(join(__dirname, "../../src/explorer-view.ts"), "utf8")).toMatch(/afterMove: \(\) => void noticeIfLinksNotUpdated\(plugin\.app, undefined, \(\) => plugin\.tephraActive\(\)\)/);
		// no other caller of the notice that skips the predicate
		const callers = ["main.ts", "explorer-view.ts", "commands.ts", "f10-commands.ts", "swap.ts", "modals.ts", "views.ts"].flatMap((f) =>
			(readFileSync(join(__dirname, "../../src", f), "utf8").match(/noticeIfLinksNotUpdated\([^)]*\)[^;\n]*/g) ?? []).filter((c) => !c.includes("tephraActive"))
		);
		expect(callers).toEqual([]);
	});

	it("the rename event records before any other handling, so a throw further down can't lose it", () => {
		const handler = main.slice(main.indexOf("onVaultRenameEvent(file: TAbstractFile"));
		expect(handler.indexOf("this.tephraRenames?.record(")).toBeGreaterThan(-1);
		expect(handler.indexOf("this.tephraRenames?.record(")).toBeLessThan(handler.indexOf("this.unitIndex.onVaultRename("));
	});
});
