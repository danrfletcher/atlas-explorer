/**
 * G10/G12 — what Atlas reads from Tephra's link graph, and how a Tephra id becomes a vault path. Wire shape read
 * from Tephra's `dev` code (`crates/tephra-graph/src/model.rs`, `crates/tephrad/src/rpc/dispatch.rs`), not assumed:
 *
 *   graph.get_backlinks {id: "@source:rel/path[#^block]"}  -> Edge[]   (one row per link occurrence)
 *   graph.get_edges                                        -> Edge[]   (one row per (from, target); no block info
 *                                                                       survives when the same file also links the
 *                                                                       whole unit)
 *   Edge = { from: "@source:rel", to: {resolved: "@source:rel"} | "dangling", to_raw: string,
 *            kind: "wikilink"|"markdown", offline: boolean, line: number|null }
 *
 * `line` is 1-based and null for a document (docx, pptx, PDF) and for a cache written before lines were stored.
 *
 * Nothing here writes, stores or crawls anything (F1, F3): each call is one request and its answer.
 */
import { isUnderSourcesFolder, NOTES_SOURCE, ownSourceOf, parseSourceLink } from "./source-links";
import { SOURCES_FOLDER, sourceLinkPath } from "./sources-path";

/** One Tephra edge, reduced to what Atlas reads. */
export interface TephraEdge {
	/** Federated id of the file the link is written in. */
	from: string;
	/** Federated id of the unit it resolved to; null for a dangling edge. */
	to: string | null;
	/** The link's raw target text. */
	toRaw: string;
	/** What follows `#` in `toRaw` (a `^id` or a heading, without the `#`); empty for a plain link. */
	subpath: string;
	/** 1-based line in `from`, or null (a document, or a cache without lines). */
	line: number | null;
	kind: string;
	offline: boolean;
}

/** The part of `TephraConnection` these calls use. */
export interface TephraCaller {
	call(method: string, params?: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: unknown }>;
}

/** Rows without a usable `from` are dropped; a missing or non-integer `line` is null. Null when `value` isn't a list. */
export function parseTephraEdges(value: unknown): TephraEdge[] | null {
	if (!Array.isArray(value)) return null;
	const edges: TephraEdge[] = [];
	for (const row of value) {
		if (typeof row !== "object" || row === null) continue;
		const { from, to, to_raw: toRaw, kind, offline, line } = row as Record<string, unknown>;
		if (typeof from !== "string" || from.length === 0) continue;
		let target: string | null = null;
		if (typeof to === "object" && to !== null && typeof (to as Record<string, unknown>).resolved === "string") {
			target = (to as Record<string, string>).resolved;
		}
		const raw = typeof toRaw === "string" ? toRaw : "";
		edges.push({
			from,
			to: target,
			toRaw: raw,
			subpath: subpathOf(raw),
			line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null,
			kind: typeof kind === "string" ? kind : "",
			offline: offline === true,
		});
	}
	return edges;
}

/** What follows the first `#` of a raw link target, minus an `|alias`. `""` when there is none. */
function subpathOf(raw: string): string {
	const hash = raw.indexOf("#");
	if (hash === -1) return "";
	const rest = raw.slice(hash + 1);
	const bar = rest.indexOf("|");
	return (bar === -1 ? rest : rest.slice(0, bar)).trim();
}

/** A Tephra id read once: its source, and the vault path it names, written as if that source were listed. */
export interface TephraPath {
	/** `notes` or the source's name, exactly as in the id. */
	source: string;
	/** `x` for `@notes:x`, `Sources/<name>/x` for `@<name>:x`. The extension is kept. */
	path: string;
}

/**
 * Reads `@notes:x` -> `x` and `@<name>:x` -> `Sources/<name>/x` with PR-1's own resolver: `parseSourceLink` decides
 * what a well-formed id is (the source name, no empty, `.` or `..` segment, no backslash or control character) and
 * `sourceLinkPath` builds the folder, so Atlas has one rule for both. Two things differ and are handled here, not
 * in a second parser: `parseSourceLink` drops a trailing `.md` (a Tephra id keeps its extension, so the dropped
 * suffix is put back), and it reads `#` as a subpath (a file id is never split, so `#` and `%` are escaped around
 * the call and restored after). A malformed id is null; `@notes:Sources/…` is null (`Sources/` is Atlas's links,
 * never the vault's own). Whether the source is one Atlas lists is the caller's check (`tephraIdToVaultPath`).
 */
export function parseTephraId(id: string): TephraPath | null {
	if (typeof id !== "string") return null;
	const escaped = id.replace(/%/g, "%25").replace(/#/g, "%23");
	const parsed = parseSourceLink(escaped);
	if (parsed === null) return null;
	const written = escaped.slice(escaped.indexOf(":") + 1);
	const rel = (parsed.path + written.slice(parsed.path.length)).replace(/%23/g, "#").replace(/%25/g, "%");
	if (parsed.source === NOTES_SOURCE) return isUnderSourcesFolder(rel) ? null : { source: NOTES_SOURCE, path: rel };
	return { source: parsed.source, path: `${sourceLinkPath(parsed.source)}/${rel}` };
}

/**
 * `@notes:x` -> `x` and `@<name>:x` -> `Sources/<name>/x`, for a source Atlas knows. An unknown or removed source,
 * a malformed id and an unsafe path are null (skipped silently by every caller). See `parseTephraId`.
 */
export function tephraIdToVaultPath(id: string, knownSources: ReadonlySet<string>): string | null {
	const parsed = parseTephraId(id);
	return parsed !== null && isListedTephraSource(parsed, knownSources) ? parsed.path : null;
}

/** `parsed` names `notes` or a source in `knownSources`; a known name is matched exactly, as Tephra matches it. */
export function isListedTephraSource(parsed: TephraPath, knownSources: ReadonlySet<string>): boolean {
	return parsed.source === NOTES_SOURCE || knownSources.has(parsed.source);
}

/** The reverse, by PR-1's `ownSourceOf`: `x` -> `@notes:x`, `Sources/<name>/x` -> `@<name>:x`. Null for the bare
 * `Sources/<name>` folder link itself or a path directly under `Sources/` (neither is a file of a source). */
export function vaultPathToTephraId(path: string): string | null {
	const source = ownSourceOf(path);
	if (source === NOTES_SOURCE) return path.startsWith(`${SOURCES_FOLDER}/`) ? null : `@${NOTES_SOURCE}:${path}`;
	const rel = path.slice(SOURCES_FOLDER.length + 1 + source.length + 1);
	return rel === "" ? null : `@${source}:${rel}`;
}

/** One row of the "Also linked from (Tephra)" list. */
export interface BacklinkRow {
	/** Vault path of the file the link is written in. */
	path: string;
	/** 1-based, or null: the row then shows the path alone and opens the file at the top. */
	line: number | null;
}

/**
 * Is `file` a note Obsidian indexes? Only a markdown file with a file cache is. Don't decide by `getFileCache(file)
 * === null` alone: Obsidian 1.14 returns `{}` (not null) for a non-markdown file such as `.rs`, `.sh` or `.pdf`, so a
 * code file would read as a note and its Tephra edges would be dropped. A markdown file with no cache (not indexed
 * yet, or in a folder Obsidian excludes) is still not a note Obsidian indexes.
 */
export function isIndexedNote(file: { extension: string }, cache: unknown): boolean {
	return file.extension.toLowerCase() === "md" && cache !== null && cache !== undefined;
}

/** What the row builder needs to know about the vault. Both lookups are by vault path. */
export interface BacklinkContext {
	knownSources: ReadonlySet<string>;
	/** True when `path` is a file in the vault. */
	fileExists: (path: string) => boolean;
	/** True when `path` is a note Obsidian indexes (see `isIndexedNote`: markdown with a file cache). */
	hasFileCache: (path: string) => boolean;
	/** The file the list is for. */
	activePath: string;
	/** Under the Q13 fallback Obsidian's own Backlinks can't list a cross-source note-to-note link, so those
	 * (a note in another source than the active file's) are listed here too. */
	includeCrossSourceNotes: boolean;
}

/**
 * Edges -> rows. A row is kept only when its `from` id maps to a file that exists in the vault and is not a note
 * Obsidian indexes (a note-to-note link is Obsidian's own Backlinks' business, so it never shows twice); an unknown
 * or removed source and a path with no vault file are skipped silently. Sorted by path, then line (a row with no
 * line first); a repeated `(path, line)` is one row.
 */
export function backlinkRows(edges: readonly TephraEdge[], context: BacklinkContext): BacklinkRow[] {
	const seen = new Set<string>();
	const rows: BacklinkRow[] = [];
	const activeSource = ownSourceOf(context.activePath);
	for (const edge of edges) {
		const path = tephraIdToVaultPath(edge.from, context.knownSources);
		if (path === null || path === context.activePath || !context.fileExists(path)) continue;
		if (context.hasFileCache(path) && !(context.includeCrossSourceNotes && ownSourceOf(path) !== activeSource)) continue;
		const key = `${path}\u0000${edge.line ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({ path, line: edge.line });
	}
	return rows.sort((a, b) => compareStrings(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0));
}

/** Plain code-unit order, not the locale's: the same list on every machine. */
function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export type BacklinksResult = { ok: true; rows: BacklinkRow[] } | { ok: false };

/**
 * `graph.get_backlinks` for one vault file, as rows. Never throws; a failed or timed-out call, a refused id and an
 * answer that isn't a list are all `{ ok: false }` (the section then shows nothing; PR-9 owns the wording).
 */
export async function fetchBacklinkRows(caller: TephraCaller, path: string, context: Omit<BacklinkContext, "activePath">): Promise<BacklinksResult> {
	const id = vaultPathToTephraId(path);
	if (id === null) return { ok: false };
	try {
		const answer = await caller.call("graph.get_backlinks", { id });
		if (!answer.ok) return { ok: false };
		const edges = parseTephraEdges(answer.result);
		if (edges === null) return { ok: false };
		return { ok: true, rows: backlinkRows(edges, { ...context, activePath: path }) };
	} catch {
		return { ok: false };
	}
}

/** `graph.get_edges`: every edge in Tephra's graph, for the promotion rule. Null on any failure. */
export async function fetchAllEdges(caller: TephraCaller): Promise<TephraEdge[] | null> {
	try {
		const answer = await caller.call("graph.get_edges");
		return answer.ok ? parseTephraEdges(answer.result) : null;
	} catch {
		return null;
	}
}
