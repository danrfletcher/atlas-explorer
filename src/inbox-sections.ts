import { TEPHRA_VAULT_SOURCE_NAME } from "./settings";
import { isUsableSourceName, type TephraSource } from "./tephra-client";
import { isInSourcesFolder, sourceLinkPath, SOURCES_FOLDER } from "./sources-path";
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
	units: Unit[];
}

export function sourceSectionKey(name: string): string {
	return `source:${name}`;
}

export interface GroupInboxSectionsInput {
	/** The Tephra toggle is on and this isn't mobile. Off gives exactly one vault section holding every unit. */
	enabled: boolean;
	/** What the last `source.list` returned; `[]` while Tephra is offline or not yet checked (PR-9 adds
	 * offline sections, so until then an unreachable Tephra shows the vault section alone, never "missing"). */
	sources: TephraSource[];
	/** Every unit the explorer knows: the vault's (index) plus what `unit.list` returned for each source. */
	units: Unit[];
}

/** Case-insensitive A–Z, with the raw names breaking a tie so the order never depends on input order. */
function compareSourceNames(a: string, b: string): number {
	const lower = a.toLowerCase().localeCompare(b.toLowerCase());
	return lower !== 0 ? lower : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which listed source owns `path` (`Sources/<name>` or anything under it), or null. The longest source name
 * wins and the match is on whole path segments, so `Sources/whoopx/a.md` belongs to `whoopx`, never to
 * `whoop` (the same exact-prefix rule as R3-4).
 */
export function owningSourceName(path: string, sourceNames: readonly string[]): string | null {
	if (!isInSourcesFolder(path) || path === SOURCES_FOLDER) return null;
	let best: string | null = null;
	for (const name of sourceNames) {
		const root = sourceLinkPath(name);
		if (path !== root && !path.startsWith(`${root}/`)) continue;
		if (best === null || name.length > best.length) best = name;
	}
	return best;
}

/**
 * The ordered Inbox sections (G1). Pure: it reads nothing from the vault, Tephra or the DOM.
 *
 * Off: one vault section with every unit (a real user folder called `Sources` is an ordinary module then).
 * On: the vault section first, holding every unit not under `Sources/`, then one section per Tephra source
 * A–Z (case-insensitive), each holding the units under its own `Sources/<name>/…`. The source Tephra calls
 * `notes` is the vault itself and gets no section of its own. A source whose folder is gone is `missing` and
 * holds no rows; its data (placed refs, added items) is untouched elsewhere. A unit under `Sources/` that no
 * listed source owns appears in no section. A unit whose ref is seen twice keeps its first occurrence, so
 * the caller puts the `unit.list` units ahead of the index's.
 */
export function groupInboxSections(input: GroupInboxSectionsInput): InboxSection[] {
	const seen = new Set<string>();
	const units = input.units.filter((unit) => {
		const key = unitRefKey(unitToRef(unit)); // by ref, never by bare path: a promoted block shares its file's path
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (!input.enabled) return [{ key: VAULT_SECTION_KEY, kind: "vault", name: null, missing: false, units }];

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
		{ key: VAULT_SECTION_KEY, kind: "vault", name: null, missing: false, units: units.filter((unit) => !isInSourcesFolder(unit.path)) },
		...sources.map(
			(source): InboxSection => ({ key: sourceSectionKey(source.name), kind: "source", name: source.name, missing: source.status === "missing", units: [] })
		),
	];
	const byName = new Map(sections.filter((s) => s.name !== null).map((s) => [s.name as string, s]));
	for (const unit of units) {
		const owner = owningSourceName(unit.path, names);
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

/** Top-level entries of source `name` as units keyed by their vault path `Sources/<name>/<entry>`: folders
 * are modules (`folder-unit`), files are `root-file`s. */
export function sourceUnitsFromEntries(name: string, entries: TephraListedEntry[]): Unit[] {
	return entries.map(
		(entry): Unit => ({ type: entry.kind === "folder" ? "folder-unit" : "root-file", path: `${sourceLinkPath(name)}/${entry.name}` })
	);
}
