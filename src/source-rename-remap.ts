import { sourceLinkPath } from "./sources-path";
import { rewritePathString } from "./types";

/**
 * PR-11 (G4, R3-4): the pure half of a source rename. Everything Atlas keeps keyed by a vault path under
 * `Sources/<old>/` moves to `Sources/<new>/`. Nothing here reads a file, builds an index of the source, or
 * calls Tephra (F1): it only rewrites strings Atlas already stores.
 *
 * Every rewrite goes through `rewritePathString`, the helper `ViewsManager.onVaultRename` uses for its refs, so
 * the prefix test is on whole path segments: `Sources/whoop` covers `Sources/whoop` and `Sources/whoop/a.md`,
 * never `Sources/whoopee/a.md` or a vault note called `Sources-whoop.md`.
 */

/** The vault path of a source's link, and so the prefix every one of its paths starts with. */
export function sourcePrefix(name: string): string {
	return sourceLinkPath(name);
}

/** One stored vault path, moved from under `Sources/<old>` to under `Sources/<new>`. Unchanged (same string) if it isn't. */
export function remapSourcePath(path: string, oldName: string, newName: string): string {
	return rewritePathString(path, sourcePrefix(oldName), sourcePrefix(newName));
}

function escapeRegex(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * One Obsidian Excluded-files line (R3-2). A path entry (`Sources/<old>/` or `Sources/<old>/target/`) is a
 * prefix and moves like a path, but only when it names `<old>` itself: `Sources/<old>` without a slash after it
 * is not an entry Atlas writes and is left alone. A regex entry Atlas made from a `.gitignore` glob starts with
 * the escaped `^Sources/<old>/`; it moves the same way. Any other line is the user's and is never touched.
 */
export function remapExcludeEntry(entry: string, oldName: string, newName: string): string {
	const oldBase = `${sourcePrefix(oldName)}/`;
	const newBase = `${sourcePrefix(newName)}/`;
	if (entry.startsWith(oldBase)) return `${newBase}${entry.slice(oldBase.length)}`;
	const oldRegexHead = `/^${escapeRegex(oldBase)}`;
	if (entry.startsWith(oldRegexHead)) return `/^${escapeRegex(newBase)}${entry.slice(oldRegexHead.length)}`;
	return entry;
}

/** The list with every moved entry in place (same order, no duplicates created), or null when none moved. */
export function remapExcludeList(entries: readonly string[], oldName: string, newName: string): string[] | null {
	let moved = false;
	const out: string[] = [];
	for (const entry of entries) {
		const next = remapExcludeEntry(entry, oldName, newName);
		if (next !== entry) moved = true;
		if (!out.includes(next)) out.push(next);
	}
	return moved ? out : null;
}

/** A path list (a set of paths in `data.json`): each entry under `Sources/<old>` moved; null when none moved. */
export function remapPathList(paths: readonly string[], oldName: string, newName: string): string[] | null {
	const moved = paths.map((path) => remapSourcePath(path, oldName, newName));
	return moved.some((path, i) => path !== paths[i]) ? moved : null;
}

/** The records `data.json` keeps by source name. The link record (`tephraLinks`) is not here: it follows the
 * link itself, in `SourcesFolder.swapSource`, once the link has really moved. */
export interface SourceRenameStores {
	/** `settings.noAutoPromoteFolders`: vault folder paths. */
	noAutoPromoteFolders: readonly string[];
	/** `expandedModuleFolders`: vault folder paths. */
	expandedModuleFolders: readonly string[];
	/** `settings.tephraSourceSettings`: per-source "Show in Obsidian search & graph" (G15). */
	sourceSettings: Readonly<Record<string, { showInSearch: boolean }>>;
	/** `settings.tephraExcludes`: the Excluded-files entries Atlas added, by source (R3-2). */
	excludes: Readonly<Record<string, readonly string[]>>;
}

export interface SourceRenameRemap {
	/** Present only for a store that changed. */
	noAutoPromoteFolders?: string[];
	expandedModuleFolders?: string[];
	sourceSettings?: Record<string, { showInSearch: boolean }>;
	excludes?: Record<string, string[]>;
	changed: boolean;
}

function hasOwn(record: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** The records keyed by name, with `old`'s entry under `new` (it replaces any stale `new` entry), or null if `old` has none. */
function moveKey<T, U>(record: Readonly<Record<string, T>>, oldName: string, newName: string, copy: (value: T) => U, move: (value: T) => U): Record<string, U> | null {
	if (!hasOwn(record, oldName)) return null;
	const next: Record<string, U> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === oldName || key === newName) continue;
		next[key] = copy(value);
	}
	next[newName] = move(record[oldName]);
	return next;
}

/**
 * Moves every name- and path-keyed record that is not a view, a manual promotion or a dismissed/added ref (those
 * live in `ViewsManager` and `UnitIndex`, which rewrite their own) from `<old>` to `<new>`. A no-op returns
 * `{ changed: false }` with no store set. Never mutates its input.
 */
export function remapSourceStores(stores: SourceRenameStores, oldName: string, newName: string): SourceRenameRemap {
	const result: SourceRenameRemap = { changed: false };
	if (oldName === newName) return result;

	const noAutoPromote = remapPathList(stores.noAutoPromoteFolders, oldName, newName);
	if (noAutoPromote) result.noAutoPromoteFolders = noAutoPromote;
	const expanded = remapPathList(stores.expandedModuleFolders, oldName, newName);
	if (expanded) result.expandedModuleFolders = expanded;
	const settings = moveKey(stores.sourceSettings, oldName, newName, (value) => ({ ...value }), (value) => ({ ...value }));
	if (settings) result.sourceSettings = settings;
	const excludes = moveKey(stores.excludes, oldName, newName, (entries) => [...entries], (entries) => remapExcludeList(entries, oldName, newName) ?? [...entries]);
	if (excludes) result.excludes = excludes;

	result.changed = noAutoPromote !== null || expanded !== null || settings !== null || excludes !== null;
	return result;
}
