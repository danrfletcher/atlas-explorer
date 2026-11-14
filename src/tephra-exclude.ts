import type { App, Vault } from "obsidian";
import { isUsableSourceName } from "./tephra-client";

/** The vault config key behind Settings → Files & links → Excluded files. */
export const USER_IGNORE_FILTERS_KEY = "userIgnoreFilters";

interface VaultConfigAccess {
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => void;
}

/** The Excluded-files entry for one source: a path prefix, so it covers everything under `Sources/<name>/`. */
export function sourceExcludeEntry(sourceName: string): string {
	return `Sources/${sourceName}/`;
}

/**
 * G15 "Show in Obsidian search & graph": off adds `Sources/<name>/` to Obsidian's Excluded files, on removes
 * exactly that entry. Every other entry (the user's own, and other sources') stays, in its order. Adding
 * twice never duplicates, and removing an entry that isn't there changes nothing. `getConfig`/`setConfig`
 * aren't in Obsidian's typings, so this goes through a narrow cast and does nothing if either is missing.
 *
 * Returns true when the list was changed. A name that isn't one safe path segment is refused (false): the
 * entry built from it could cover more than that source.
 */
export function setSourceExcluded(vault: Vault, sourceName: string, excluded: boolean): boolean {
	const config = vault as unknown as VaultConfigAccess;
	if (typeof config.getConfig !== "function" || typeof config.setConfig !== "function") return false;
	if (!isUsableSourceName(sourceName)) return false;

	const entry = sourceExcludeEntry(sourceName);
	const current = config.getConfig(USER_IGNORE_FILTERS_KEY);
	// Anything other than a list of strings is replaced only when we have something to add; it is never
	// "repaired" by a removal.
	const existing = Array.isArray(current) ? current.filter((item): item is string => typeof item === "string") : [];
	const hasEntry = existing.includes(entry);

	if (excluded) {
		if (hasEntry) return false;
		config.setConfig(USER_IGNORE_FILTERS_KEY, [...existing, entry]);
		return true;
	}
	if (!hasEntry) return false;
	config.setConfig(USER_IGNORE_FILTERS_KEY, existing.filter((item) => item !== entry));
	return true;
}

/** Whether `Sources/<name>/` is currently in Obsidian's Excluded files. */
export function isSourceExcluded(vault: Vault, sourceName: string): boolean {
	const current = (vault as unknown as VaultConfigAccess).getConfig?.(USER_IGNORE_FILTERS_KEY);
	return Array.isArray(current) && current.includes(sourceExcludeEntry(sourceName));
}

/** The id of Obsidian's built-in "Files and links" settings tab, which hosts the Excluded files pane. */
const FILES_AND_LINKS_TAB_ID = "file";

interface SettingTabAccess {
	id?: string;
	update?: () => void;
}
interface SettingAccess {
	setting?: { settingTabs?: SettingTabAccess[] };
}

/**
 * Obsidian builds the Excluded files pane (Settings → Files and links) from `userIgnoreFilters` once, and
 * only rebuilds it on its own `update()`. A `setConfig` from outside leaves a pane that was already built
 * listing the old entries, and a later "add" in that pane writes its stale list back, dropping the entry
 * Atlas just added. Call this after changing the list so the pane lists the current entries. It does
 * nothing when the tab or `update()` isn't there (a different Obsidian build, or the mobile app).
 * Verified in Obsidian 1.14.4: `update()` on the tab while another tab is showing refreshes it.
 */
export function refreshExcludedFilesPane(app: App): void {
	try {
		const tab = (app as unknown as SettingAccess).setting?.settingTabs?.find((t) => t.id === FILES_AND_LINKS_TAB_ID);
		tab?.update?.();
	} catch {
		// Cosmetic: a refresh that fails leaves the pane stale, never the config wrong.
	}
}
