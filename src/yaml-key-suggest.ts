import type { App } from "obsidian";

const MAX_KEY_SUGGESTIONS = 50;

/** PR-1.F1 (G1): every frontmatter key across the vault, read from `app.metadataCache` only. Files
 * without frontmatter are skipped. Keys that differ only by case show once: the all-lowercase
 * spelling wins, otherwise the plain-code-unit smaller one, so the result never depends on vault
 * order. The list is sorted case-insensitively. */
export function collectFrontmatterKeys(app: App): string[] {
	const byLower = new Map<string, string>();
	for (const file of app.vault.getFiles()) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) continue;
		for (const rawKey of Object.keys(frontmatter)) {
			const key = rawKey.trim();
			if (key === "") continue;
			const lower = key.toLowerCase();
			const existing = byLower.get(lower);
			if (existing === undefined || (key === lower && existing !== lower) || (existing !== lower && key < existing)) {
				byLower.set(lower, key);
			}
		}
	}
	return [...byLower.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** PR-1.F1 (G1): the key suggestions for what the user has typed. Matching is a case-insensitive
 * substring test, with prefix matches listed first, capped at the suggestion limit. Empty text
 * suggests from the start of the list. */
export function filterYamlKeySuggestions(keys: string[], typed: string): string[] {
	const query = typed.trim().toLowerCase();
	const matches = keys.filter((key) => key.toLowerCase().includes(query));
	const prefixFirst = (key: string) => (key.toLowerCase().startsWith(query) ? 0 : 1);
	matches.sort((a, b) => prefixFirst(a) - prefixFirst(b));
	return matches.slice(0, MAX_KEY_SUGGESTIONS);
}
