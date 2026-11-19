import { TEPHRA_VAULT_SOURCE_NAME } from "./settings";
import { isUsableSourceName, type TephraSource } from "./tephra-client";
import { getPromotedRoots, vaultRootOfSource, type PromotedRootLike } from "./source-links";
import { isInSourcesFolder, isSameOrUnder, sourceLinkPath, SOURCES_FOLDER } from "./sources-path";
import { Unit, unitRefKey, unitToRef } from "./types";

/** G1: the Inbox is one section per Tephra source. The vault's section is the existing Inbox; every other
 * source gets its own, headed `[name]`. */
export const VAULT_SECTION_KEY = "inbox";

export interface InboxSection {
	/** `inbox` for the vault section, `source:<name>` for a Tephra source. Stable across renders. */
	key: string;
	kind: "vault" | "source";
	/** The Tephra source name; `null` for the vault section. */
	name: string | null;
	/** Tephra reports the source's folder gone (E5). The header says so and the section has no rows. */
	missing: boolean;
	/** PR-9 (G13/E1): Tephra isn't answering, so this source's list is the last one held in memory. The header says
	 * "(Tephra offline)" and the rows stay. Never set on the vault section, and never together with `missing`. */
	offline: boolean;
	units: Unit[];
}

export function sourceSectionKey(name: string): string {
	return `source:${name}`;
}

export interface GroupInboxSectionsInput {
	/** The Tephra toggle is on and this isn't mobile. Off gives exactly one vault section holding every unit. */
	enabled: boolean;
	/** What the last `source.list` returned; while Tephra is offline, the last list it returned (or the names Atlas
	 * already linked under `Sources/`), with `offline` set. */
	sources: TephraSource[];
	/** PR-9 (G13/E1): Tephra isn't answering. Every source section is then `offline` (never `missing`: a folder
	 * can't be told gone without asking Tephra) and keeps the units it is given. Ignored while `enabled` is false. */
	offline?: boolean;
	/** Every unit the explorer knows: the vault's (index) plus what `unit.list` returned for each source. */
	units: Unit[];
	/** PR-12 (G6): the promoted sources' roots (a folder made its own source). Defaults to the roots the plugin
	 * last read from Tephra's source list. */
	promoted?: readonly PromotedRootLike[];
}

/** Case-insensitive A–Z, with the raw names breaking a tie so the order never depends on input order. */
function compareSourceNames(a: string, b: string): number {
	const lower = a.toLowerCase().localeCompare(b.toLowerCase());
	return lower !== 0 ? lower : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which listed source owns `path`, or null. The longest source root wins and the match is on whole path segments,
 * so `Sources/whoopx/a.md` belongs to `whoopx`, never to `whoop` (the same exact-prefix rule as R3-4). A root is
 * `Sources/<name>` for a top-level source and the folder itself for a promoted one (G6), so
 * `Sources/tephra/crates/tephrad/x.rs` belongs to `tephrad` and `Sources/tephra/crates/tephrad2/x.rs` to `tephra`.
 * A path in no listed source's root (the vault's own, or an unlisted `Sources/<name>`) is null.
 */
export function owningSourceName(path: string, sourceNames: readonly string[], promoted: readonly PromotedRootLike[] = getPromotedRoots()): string | null {
	let best: { name: string; length: number } | null = null;
	for (const root of promoted) {
		if (!sourceNames.includes(root.name) || !isSameOrUnder(path, root.vaultPath)) continue;
		if (best === null || root.vaultPath.length > best.length) best = { name: root.name, length: root.vaultPath.length };
	}
	if (isInSourcesFolder(path) && path !== SOURCES_FOLDER) {
		for (const name of sourceNames) {
			if (promoted.some((root) => root.name === name)) continue; // a promoted source has no `Sources/<name>` of its own
			const root = sourceLinkPath(name);
			if (!isSameOrUnder(path, root)) continue;
			if (best === null || root.length > best.length || (root.length === best.length && name.length > best.name.length)) best = { name, length: root.length };
		}
	}
	return best === null ? null : best.name;
}

/**
 * The ordered Inbox sections (G1). Pure: it reads nothing from the vault, Tephra or the DOM.
 *
 * Off: one vault section with every unit (a real user folder called `Sources` is an ordinary module then).
 * On: the vault section first, holding every unit not under `Sources/`, then one section per Tephra source
 * A–Z (case-insensitive), each holding the units under its own `Sources/<name>/…`. The source Tephra calls
 * `notes` is the vault itself and gets no section of its own. A source whose folder is gone is `missing` and
 * holds no rows; its data (placed refs, added items) is untouched elsewhere. A unit under `Sources/` that no
 * listed source owns appears in no section. With `offline` every source section is `offline` instead (rows kept, no
 * `missing`: PR-9). A unit whose ref is seen twice keeps its first occurrence, so
 * the caller puts the `unit.list` units ahead of the index's.
 */
export function groupInboxSections(input: GroupInboxSectionsInput): InboxSection[] {
	const seen = new Set<string>();
	const promoted = input.promoted ?? getPromotedRoots();
	const units = input.units.filter((unit) => {
		// A promoted folder is the root of its own source: hidden in its parent's section, and not a row of its own
		// either (its section's rows are what is inside it).
		if (input.enabled && promoted.some((root) => root.vaultPath === unit.path && unit.type !== "promoted-block")) return false;
		const key = unitRefKey(unitToRef(unit)); // by ref, never by bare path: a promoted block shares its file's path
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (!input.enabled) return [{ key: VAULT_SECTION_KEY, kind: "vault", name: null, missing: false, offline: false, units }];

	const seenNames = new Set<string>();
	const sources = input.sources
		.filter((source) => {
			if (source.name === TEPHRA_VAULT_SOURCE_NAME || !isUsableSourceName(source.name) || seenNames.has(source.name)) return false;
			seenNames.add(source.name);
			return true;
		})
		.sort((a, b) => compareSourceNames(a.name, b.name));
	const names = sources.map((source) => source.name);

	const sections: InboxSection[] = [
		{ key: VAULT_SECTION_KEY, kind: "vault", name: null, missing: false, offline: false, units: units.filter((unit) => !isInSourcesFolder(unit.path) && !promoted.some((root) => isSameOrUnder(unit.path, root.vaultPath))) },
		...sources.map(
			(source): InboxSection => ({
				key: sourceSectionKey(source.name),
				kind: "source",
				name: source.name,
				missing: input.offline !== true && source.status === "missing",
				offline: input.offline === true,
				units: [],
			})
		),
	];
	const byName = new Map(sections.filter((s) => s.name !== null).map((s) => [s.name as string, s]));
	for (const unit of units) {
		const owner = owningSourceName(unit.path, names, promoted);
		const section = owner === null ? undefined : byName.get(owner);
		if (section && !section.missing) section.units.push(unit);
	}
	return sections;
}

/** One top-level entry of a source, as `unit.list` returns it (only the fields Atlas reads). */
export interface TephraListedEntry {
	name: string;
	kind: "folder" | "file";
}

export interface ParsedUnitList {
	/** Tephra answered from its cache because the source's folder is gone: the same as `missing` (E5). */
	offline: boolean;
	entries: TephraListedEntry[];
}

/** A top-level name that may become a row: one path segment, no control characters, and not a dotfile. Tephra
 * never sends `.git`, ignored paths or dotfiles; this is the belt for a daemon that did. */
export function isListableTopLevelName(name: string): boolean {
	return isUsableSourceName(name) && !name.startsWith(".");
}

/**
 * Reads a `unit.list` result (`{ source, folder, offline, entries: [{ name, rel_path, kind, … }] }`) for the
 * source root. Returns null when the result is not that shape. An entry is kept only when it is a top-level
 * one (`rel_path === name`) with a listable name; repeats keep the first. `kind: "folder"` is a folder, anything
 * else a file. The list is read for one render and not kept (F1).
 */
export function parseUnitList(result: unknown): ParsedUnitList | null {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
	const { entries, offline } = result as Record<string, unknown>;
	if (!Array.isArray(entries)) return null;
	const seen = new Set<string>();
	const parsed: TephraListedEntry[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const { name, rel_path: relPath, kind } = entry as Record<string, unknown>;
		if (typeof name !== "string" || typeof relPath !== "string" || relPath !== name) continue;
		if (!isListableTopLevelName(name) || seen.has(name)) continue;
		seen.add(name);
		parsed.push({ name, kind: kind === "folder" ? "folder" : "file" });
	}
	return { offline: offline === true, entries: parsed };
}

/** Top-level entries of source `name` as units keyed by their vault path `<root>/<entry>` (`Sources/<name>/<entry>`, or the promoted folder's own path): folders
 * are modules (`folder-unit`), files are `root-file`s. */
export function sourceUnitsFromEntries(name: string, entries: TephraListedEntry[], root: string = vaultRootOfSource(name)): Unit[] {
	return entries.map(
		(entry): Unit => ({ type: entry.kind === "folder" ? "folder-unit" : "root-file", path: `${root}/${entry.name}` })
	);
}
