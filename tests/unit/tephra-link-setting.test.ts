import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { ALWAYS_UPDATE_LINKS_KEY, TephraLinkSetting, readStoredVaultConfig } from "../../src/tephra-link-setting";
import { isAutoUpdateLinksOn } from "../../src/links-notice";
import { normalizeSavedLinkSetting, type SavedLinkSetting } from "../../src/settings";

/** G11: Obsidian's "Automatically update internal links" (`alwaysUpdateLinks`) while the Tephra toggle is on.
 * The vault config is the mock `Vault`'s own (`getConfig`/`setConfig`); Atlas's `data.json` is a plain object whose
 * on-disk copy (`disk`) only changes when `save()` runs, so a test can tell "saved before changing" from "saved later". */

interface Rig {
	app: App;
	setting: TephraLinkSetting;
	/** In-memory `settings.tephraSavedLinkSetting`. */
	memory: { saved: SavedLinkSetting | null };
	/** What `data.json` holds: a copy taken at each `save()`. */
	disk: { saved: SavedLinkSetting | null };
	/** The vault config value at each `save()`: the saved value must already be on disk when the config changes. */
	configAtSave: unknown[];
	toggle: { on: boolean; mobile: boolean };
	errors: string[];
	failNextSave(): void;
}

function rig(initial: { present: boolean; value?: unknown } = { present: false }, options: { on?: boolean; mobile?: boolean; saved?: SavedLinkSetting | null } = {}): Rig {
	const app = new App();
	if (initial.present) app.vault.config[ALWAYS_UPDATE_LINKS_KEY] = initial.value;
	const memory = { saved: options.saved ?? null };
	const disk = { saved: options.saved ?? null };
	const configAtSave: unknown[] = [];
	const toggle = { on: options.on ?? true, mobile: options.mobile ?? false };
	const errors: string[] = [];
	let failSave = false;
	const setting = new TephraLinkSetting({
		// Real Obsidian's `getConfig` answers its default (`false`) for an absent key; the mock's returns `undefined`.
		getConfig: (key) => app.vault.getConfig(key) ?? false,
		getStoredConfig: (key) => readStoredVaultConfig(app.vault, key),
		setConfig: (key, value) => {
			if (value === undefined) delete app.vault.config[key];
			else app.vault.setConfig(key, value);
		},
		getSaved: () => normalizeSavedLinkSetting(memory.saved),
		setSaved: (saved) => {
			memory.saved = saved;
		},
		save: async () => {
			configAtSave.push(app.vault.getConfig(ALWAYS_UPDATE_LINKS_KEY));
			if (failSave) {
				failSave = false;
				throw new Error("disk full");
			}
			disk.saved = memory.saved === null ? null : { ...memory.saved };
		},
		isActive: () => toggle.on && !toggle.mobile,
		isMobile: () => toggle.mobile,
		onError: (message) => void errors.push(message),
	});
	return { app, setting, memory, disk, configAtSave, toggle, errors, failNextSave: () => (failSave = true) };
}

const config = (r: Rig) => r.app.vault.getConfig(ALWAYS_UPDATE_LINKS_KEY);
const hasKey = (r: Rig) => Object.hasOwn(r.app.vault.config, ALWAYS_UPDATE_LINKS_KEY);

describe("turning the toggle on: save first, then switch Obsidian's setting off", () => {
	it.each([
		["true", { present: true, value: true }, { present: true, value: true }],
		["false", { present: true, value: false }, { present: true, value: false }],
		["absent", { present: false }, { present: false }],
		["a non-boolean (read as absent)", { present: true, value: "yes" }, { present: false }],
	] as const)("old value %s is on disk before the config changes", async (_name, initial, expectedSaved) => {
		const r = rig(initial);
		await r.setting.enable();
		expect(r.disk.saved).toEqual(expectedSaved);
		expect(r.configAtSave[0]).toBe(initial.present ? initial.value : undefined); // the save ran before the write
		expect(config(r)).toBe(false);
		expect(isAutoUpdateLinksOn(r.app)).toBe(false);
	});

	it("T1: an absent key is saved as absent even though getConfig answers false for it (real Obsidian)", async () => {
		const r = rig({ present: false });
		expect(r.app.vault.config).not.toHaveProperty(ALWAYS_UPDATE_LINKS_KEY);
		await r.setting.enable();
		expect(r.memory.saved).toEqual({ present: false });
		expect(r.disk.saved).toEqual({ present: false });
		await r.setting.restore();
		expect(hasKey(r)).toBe(false);
	});

	it("T1: a stored `false` is still saved as present false (distinct from absent)", async () => {
		const r = rig({ present: true, value: false });
		await r.setting.enable();
		expect(r.memory.saved).toEqual({ present: true, value: false });
		await r.setting.restore();
		expect(hasKey(r)).toBe(true);
		expect(config(r)).toBe(false);
	});

	it("a failed save leaves Obsidian's setting alone, saves nothing and says so", async () => {
		const r = rig({ present: true, value: true });
		r.failNextSave();
		await r.setting.enable();
		expect(config(r)).toBe(true);
		expect(r.memory.saved).toBeNull();
		expect(r.errors).toHaveLength(1);
	});
});

describe("turning the toggle off: the saved value comes back exactly", () => {
	it.each([
		["true", { present: true, value: true }],
		["false", { present: true, value: false }],
	] as const)("%s is put back", async (_name, initial) => {
		const r = rig(initial);
		await r.setting.enable();
		await r.setting.restore();
		expect(config(r)).toBe(initial.value);
		expect(r.memory.saved).toBeNull();
		expect(r.disk.saved).toBeNull();
	});

	it("an absent key is absent again, which `isAutoUpdateLinksOn` reads as on", async () => {
		const r = rig({ present: false });
		await r.setting.enable();
		expect(hasKey(r)).toBe(true);
		await r.setting.restore();
		expect(hasKey(r)).toBe(false);
		expect(isAutoUpdateLinksOn(r.app)).toBe(true);
	});

	it("afterwards Atlas never touches the setting until the toggle is next turned on", async () => {
		const r = rig({ present: true, value: true });
		await r.setting.enable();
		await r.setting.restore();
		r.toggle.on = false;
		const setConfig = vi.spyOn(r.app.vault, "setConfig");
		r.app.vault.config[ALWAYS_UPDATE_LINKS_KEY] = false; // Dan switches it off himself
		await r.setting.ensureOff(); // a settings tab opening
		await r.setting.restore(); // a second teardown run
		expect(setConfig).not.toHaveBeenCalled();
		expect(config(r)).toBe(false);
		// turned on again: the value then in force is the one remembered
		r.toggle.on = true;
		await r.setting.enable();
		expect(r.memory.saved).toEqual({ present: true, value: false });
	});

	it("a late ensureOff while the toggle is going off (still reading on) does not take the setting back", async () => {
		const r = rig({ present: true, value: true });
		await r.setting.enable();
		await r.setting.restore();
		await r.setting.ensureOff(); // the toggle flag has not flipped yet
		expect(config(r)).toBe(true);
		expect(r.memory.saved).toBeNull();
	});

	it("a restore that lands while an ensureOff is still saving wins", async () => {
		const r = rig({ present: true, value: true });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const original = r.setting as unknown as { deps: { save: () => Promise<void> } };
		const save = original.deps.save;
		original.deps.save = async () => {
			await gate;
			await save();
		};
		const pending = r.setting.ensureOff();
		const restoring = r.setting.restore();
		release();
		await Promise.all([pending, restoring]);
		expect(config(r)).toBe(true);
	});

	it("a stale record left on disk by an earlier session is replaced, not restored, at the next turn-on", async () => {
		const r = rig({ present: true, value: false }, { saved: { present: true, value: true } });
		await r.setting.enable();
		expect(r.memory.saved).toEqual({ present: true, value: false });
	});
});

describe("Dan turns Obsidian's setting back on while the toggle is on", () => {
	it("the next load (ensureOff) turns it off again and keeps the first saved value", async () => {
		const r = rig({ present: true, value: true });
		await r.setting.enable();
		r.app.vault.config[ALWAYS_UPDATE_LINKS_KEY] = true; // Dan
		await r.setting.ensureOff(); // plugin load, or the Tephra tab opening
		expect(config(r)).toBe(false);
		expect(r.memory.saved).toEqual({ present: true, value: true });
		await r.setting.restore();
		expect(config(r)).toBe(true);
	});

	it("a load after a restart finds the saved value on disk and does not overwrite it with the `false` Atlas set", async () => {
		const r = rig({ present: true, value: false }, { saved: { present: true, value: true } });
		await r.setting.ensureOff(); // load with the toggle on: no `enable()`
		expect(r.memory.saved).toEqual({ present: true, value: true });
		expect(config(r)).toBe(false);
	});

	it("already off: no write at all", async () => {
		const r = rig({ present: true, value: true });
		await r.setting.enable();
		const setConfig = vi.spyOn(r.app.vault, "setConfig");
		await r.setting.ensureOff();
		expect(setConfig).not.toHaveBeenCalled();
	});
});

describe("toggle off and mobile", () => {
	it("toggle off: ensureOff changes nothing and saves nothing", async () => {
		const r = rig({ present: true, value: true }, { on: false });
		await r.setting.ensureOff();
		expect(config(r)).toBe(true);
		expect(r.configAtSave).toHaveLength(0);
	});

	it("mobile behaves as toggle off: enable and restore change nothing", async () => {
		const r = rig({ present: true, value: true }, { mobile: true });
		const setConfig = vi.spyOn(r.app.vault, "setConfig");
		await r.setting.enable();
		await r.setting.restore();
		expect(setConfig).not.toHaveBeenCalled();
		expect(config(r)).toBe(true);
		expect(r.memory.saved).toBeNull();
		expect(r.configAtSave).toHaveLength(0);
	});
});

describe("normalizeSavedLinkSetting (a hand-edited data.json)", () => {
	it.each([
		[{ present: true, value: true }, { present: true, value: true }],
		[{ present: true, value: false }, { present: true, value: false }],
		[{ present: false }, { present: false }],
		[{ present: false, value: true }, { present: false }],
		[null, null],
		[undefined, null],
		["true", null],
		[true, null],
		[[], null],
		[{ present: true }, null],
		[{ present: true, value: "true" }, null],
		[{ present: "yes", value: true }, null],
		[{}, null],
	])("%j -> %j", (raw, expected) => {
		expect(normalizeSavedLinkSetting(raw)).toEqual(expected);
	});
});

describe("readStoredVaultConfig: the value as stored, not Obsidian's default", () => {
	it("reads the raw config, where an absent key stays undefined while getConfig says false", () => {
		const vault = { config: { other: 1 } as Record<string, unknown>, getConfig: () => false };
		expect(readStoredVaultConfig(vault, ALWAYS_UPDATE_LINKS_KEY)).toBeUndefined();
		vault.config[ALWAYS_UPDATE_LINKS_KEY] = true;
		expect(readStoredVaultConfig(vault, ALWAYS_UPDATE_LINKS_KEY)).toBe(true);
	});

	it("falls back to getConfig when the raw config object isn't there", () => {
		expect(readStoredVaultConfig({ getConfig: () => true }, ALWAYS_UPDATE_LINKS_KEY)).toBe(true);
		expect(readStoredVaultConfig({}, ALWAYS_UPDATE_LINKS_KEY)).toBeUndefined();
	});
});
