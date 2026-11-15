import type { SavedLinkSetting } from "./settings";

/** The Obsidian vault-config key behind Settings → Files & links → "Automatically update internal links". */
export const ALWAYS_UPDATE_LINKS_KEY = "alwaysUpdateLinks";

/**
 * Reads `key` as stored in the vault config, so an absent key is `undefined` (T1). `vault.config` is Obsidian's raw
 * parsed `app.json`, which omits a key that was never set; `vault.getConfig` fills in the default instead. When the raw
 * object isn't there (an Obsidian without it) this falls back to `getConfig`, the best answer left.
 */
export function readStoredVaultConfig(vault: unknown, key: string): unknown {
	const v = vault as { config?: unknown; getConfig?: (key: string) => unknown };
	if (v.config !== null && typeof v.config === "object") return (v.config as Record<string, unknown>)[key];
	return v.getConfig?.(key);
}

export interface TephraLinkSettingDeps {
	/** `app.vault.getConfig(key)`: the effective value. Real Obsidian returns its default (`false`) for an absent key, so this
	 * cannot tell "absent" from "false"; use `getStoredConfig` for that. */
	getConfig(key: string): unknown;
	/** The value as stored in the vault config (`app.json`): `undefined` when the key is absent. This is what decides
	 * "present or absent" for the saved old value. */
	getStoredConfig(key: string): unknown;
	/** `app.vault.setConfig(key, value)`. Passing `undefined` puts the key back to absent. */
	setConfig(key: string, value: unknown): void;
	/** What Atlas saved (`settings.tephraSavedLinkSetting`), or null when it has saved nothing. */
	getSaved(): SavedLinkSetting | null;
	/** Writes `settings.tephraSavedLinkSetting` in memory; `save` persists it. */
	setSaved(saved: SavedLinkSetting | null): void;
	/** Saves `data.json` at once (not debounced): the saved old value must be on disk before the setting changes. */
	save(): Promise<void>;
	/** True while the Tephra toggle is on and this is desktop. */
	isActive(): boolean;
	/** Mobile never touches the setting. */
	isMobile(): boolean;
	onError?(message: string, error: unknown): void;
}

/**
 * G11 (R3-6): while the Tephra toggle is on, Tephra is the only thing that rewrites links, so Obsidian's own
 * "Automatically update internal links" must stay off. This class owns that one vault-config key.
 *
 * - `enable()` (the toggle goes on), plugin load while it is on, and each opening of the Tephra tab all end in `ensureOff()`.
 *   It saves the value found (once, and only if nothing is saved yet) to Atlas's settings BEFORE it
 *   writes `false`, so the saved value survives a restart; if Dan turns Obsidian's setting back on it turns it
 *   off again without touching the saved value.
 * - `restore()` is the toggle's off-path teardown step: it puts the saved value back exactly (an absent key
 *   becomes absent again) and clears the saved record, after which Atlas never touches the key until the next
 *   `enable()`.
 * - Plugin unload calls none of them (E8): only the toggle cleans up (R3-3).
 */
export class TephraLinkSetting {
	/** Bumped by `restore()`: an `ensureOff()` that was waiting on its save must not turn the setting off again afterwards. */
	private epoch = 0;
	/** True from `restore()` until the next `enable()`: the toggle is going off, so a late `ensureOff()` (a settings tab opening
	 * mid-teardown, while `isActive()` still reads true) must not take the setting back. */
	private restored = false;

	constructor(private readonly deps: TephraLinkSettingDeps) {}

	/**
	 * The toggle was just turned on. Forgets any saved record left on disk by an earlier session (a toggle-off whose
	 * clearing save failed): the value to remember is the one found now, not an older one. Then `ensureOff()`.
	 */
	async enable(): Promise<void> {
		this.restored = false;
		this.deps.setSaved(null);
		await this.ensureOff();
	}

	/** Keeps Obsidian's link updating off while the toggle is on: plugin load, and each time the Tephra tab opens. */
	async ensureOff(): Promise<void> {
		const { deps } = this;
		if (this.restored || deps.isMobile() || !deps.isActive()) return;
		const epoch = this.epoch;
		if (deps.getSaved() === null) {
			deps.setSaved(this.describeCurrent());
			try {
				await deps.save();
			} catch (error) {
				// Not saved: the old value would be lost if the setting changed now. Leave Obsidian's setting alone.
				deps.setSaved(null);
				this.report("Atlas: couldn't save Obsidian's link-update setting, so it was left as it is", error);
				return;
			}
		}
		if (epoch !== this.epoch || !deps.isActive() || deps.getSaved() === null) return;
		// Compared with the stored value: an absent key reads `false` through `getConfig` but still gets an explicit `false` here.
		if (deps.getStoredConfig(ALWAYS_UPDATE_LINKS_KEY) !== false) deps.setConfig(ALWAYS_UPDATE_LINKS_KEY, false);
	}

	/** Puts back what `ensureOff()` saved. Safe to run more than once, and a no-op when nothing is saved. */
	async restore(): Promise<void> {
		const { deps } = this;
		this.epoch++;
		this.restored = true;
		if (deps.isMobile()) return;
		const saved = deps.getSaved();
		if (saved === null) return;
		deps.setConfig(ALWAYS_UPDATE_LINKS_KEY, saved.present ? saved.value : undefined);
		deps.setSaved(null);
		await deps.save();
	}

	private describeCurrent(): SavedLinkSetting {
		// The stored value, not `getConfig`: real Obsidian's `getConfig` answers `false` for a key that is absent.
		const value = this.deps.getStoredConfig(ALWAYS_UPDATE_LINKS_KEY);
		// A non-boolean is read as "absent" everywhere else (`isAutoUpdateLinksOn`), so it is saved as absent.
		return typeof value === "boolean" ? { present: true, value } : { present: false };
	}

	private report(message: string, error: unknown): void {
		if (this.deps.onError) this.deps.onError(message, error);
		else console.error("[Atlas]", message, error);
	}
}
