/**
 * G9 — the pure link-resolution rule for Tephra mode. No Obsidian imports: everything here works on
 * plain vault paths, so the rule can be tested against a fake file list and reused by the hook
 * (`link-resolution-hook.ts`) and the Q13 fallback renderer (`source-link-fallback.ts`).
 *
 * The rule, in one place:
 *   - A source is `notes` (every vault path outside `Sources/`) or `Sources/<name>/…`.
 *   - `[[@source:path]]` resolves to a file in that source. It never needs a Tephra connection.
 *   - A plain `[[path]]` always means the linking file's OWN source ("a plain link always means the
 *     linking file's own source"), so a plain link in a vault note never resolves into `Sources/`
 *     and a plain link inside `Sources/whoop/` never reaches the vault root or another source.
 *   - Within a source, matching follows Obsidian's own `getLinkpathDest` (ported below), so a plain
 *     link resolves exactly as it does in Obsidian when only one source is involved (F9).
 */

export const SOURCES_FOLDER = "Sources";
/** The vault itself is a source called `notes` (reserved; a `Sources/notes/` folder is not a source). */
export const NOTES_SOURCE = "notes";

const SOURCE_NAME_RE = /^[a-z0-9._-]+$/i;

/** `[a-z0-9-_.]`, case-insensitive (Obsidian matches names case-insensitively), and not just dots. */
export function isValidSourceName(name: string): boolean {
	return SOURCE_NAME_RE.test(name) && !/^\.+$/.test(name);
}

export interface ParsedSourceLink {
	/** Source name exactly as typed. */
	source: string;
	/** Target path inside the source as typed, with a trailing `.md` dropped. Never empty, never has
	 * empty, `.` or `..` segments. */
	path: string;
	/** `#heading` or `#^id` including the leading `#`, or `""`. */
	subpath: string;
}

/** True for any link text of the shape `@something:…` — the only syntax Atlas adds (F9). A link
 * starting `@` with no `:` (e.g. `[[@home]]`) is a plain link and goes to Obsidian unchanged. */
export function isSourceLinkSyntax(linktext: unknown): linktext is string {
	if (typeof linktext !== "string" || !linktext.startsWith("@")) return false;
	const hash = linktext.indexOf("#");
	return (hash === -1 ? linktext : linktext.slice(0, hash)).includes(":");
}

/**
 * Parses `@source:path[#subpath]`. Returns null when the text is not source-link syntax OR is
 * malformed (empty source or path, a source name outside `[a-z0-9-_.]`, a `.`/`..`/empty path
 * segment, a backslash, a control character). Never throws.
 */
export function parseSourceLink(linktext: unknown): ParsedSourceLink | null {
	if (!isSourceLinkSyntax(linktext)) return null;
	const hash = linktext.indexOf("#");
	const subpath = hash === -1 ? "" : linktext.slice(hash);
	const head = hash === -1 ? linktext : linktext.slice(0, hash);
	const colon = head.indexOf(":");
	if (colon === -1) return null;
	const source = head.slice(1, colon);
	let path = head.slice(colon + 1);
	if (!isValidSourceName(source)) return null;
	if (path.toLowerCase().endsWith(".md")) path = path.slice(0, -3);
	if (path === "" || path.includes("\\") || /[\u0000-\u001f]/.test(path)) return null;
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") return null;
	}
	return { source, path, subpath };
}

/**
 * The source a vault path belongs to: the `<name>` of a `Sources/<name>/…` prefix, else `notes`.
 * The `Sources` folder name is matched exactly (it is the folder Atlas creates), so a file called
 * `Sources.md`, the bare `Sources/` folder, a file directly under `Sources/` and a differently-cased
 * `sources/…` are all `notes`. The name keeps the case it has in the path.
 */
export function ownSourceOf(path: string): string {
	const name = sourceFolderName(path);
	return name === null ? NOTES_SOURCE : name;
}

/** `<name>` for a path inside `Sources/<name>/`, else null. */
function sourceFolderName(path: string): string | null {
	if (typeof path !== "string" || !path.startsWith(`${SOURCES_FOLDER}/`)) return null;
	const rest = path.slice(SOURCES_FOLDER.length + 1);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null; // a file directly under Sources/, or "Sources//x"
	const name = rest.slice(0, slash);
	return isValidSourceName(name) ? name : null;
}

/** True for anything under the `Sources/` folder, valid source name or not. Plain links in vault
 * notes never resolve to these. */
export function isUnderSourcesFolder(path: string): boolean {
	return path === SOURCES_FOLDER || path.startsWith(`${SOURCES_FOLDER}/`);
}

interface IndexedFile<T> {
	file: T;
	/** Path relative to the source root, original case. */
	rel: string;
}

/** What a `SourceFileIndex` needs from a file: a vault path. (Obsidian's `TFile` has it.) */
export interface PathFile {
	path: string;
}

/**
 * Lazily built, per-source view of Obsidian's own file list, keyed by lower-cased file name — a
 * lookup table so one link costs a hash lookup instead of a vault scan (G9 performance). It keeps
 * no content and nothing about other sources beyond paths Obsidian already has (F1). It is rebuilt
 * on the next resolve after `invalidate()`, which the hook calls on vault create, delete and rename.
 */
export class SourceFileIndex<T extends PathFile> {
	private bySource: Map<string, Map<string, IndexedFile<T>[]>> | null = null;

	constructor(private listFiles: () => readonly T[]) {}

	invalidate(): void {
		this.bySource = null;
	}

	/** Files named `nameLower` (lower-case file name incl. extension) in `source`, in vault order. */
	filesNamed(source: string, nameLower: string): readonly IndexedFile<T>[] {
		return this.sourceTable(source).get(nameLower) ?? [];
	}

	private sourceTable(source: string): Map<string, IndexedFile<T>[]> {
		if (!this.bySource) this.bySource = this.build();
		return this.bySource.get(sourceKey(source)) ?? new Map();
	}

	private build(): Map<string, Map<string, IndexedFile<T>[]>> {
		const result = new Map<string, Map<string, IndexedFile<T>[]>>();
		for (const file of this.listFiles()) {
			const path = file.path;
			const folder = sourceFolderName(path);
			let key: string;
			let rel: string;
			if (folder !== null && folder.toLowerCase() !== NOTES_SOURCE) {
				key = folder.toLowerCase();
				rel = path.slice(SOURCES_FOLDER.length + 1 + folder.length + 1);
			} else if (isUnderSourcesFolder(path)) {
				continue; // Sources/notes/…, Sources/<bad name>/…, Sources/x.md: in no source
			} else {
				key = NOTES_KEY;
				rel = path;
			}
			let table = result.get(key);
			if (!table) result.set(key, (table = new Map()));
			const name = baseName(rel).toLowerCase();
			const list = table.get(name);
			if (list) list.push({ file, rel });
			else table.set(name, [{ file, rel }]);
		}
		return result;
	}
}

/** Vault source key: `""` can never be a source name, so it cannot collide with a `Sources/<name>`. */
const NOTES_KEY = "";

function sourceKey(source: string): string {
	const lower = source.toLowerCase();
	return lower === NOTES_SOURCE ? NOTES_KEY : lower;
}

function baseName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

function dirName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Port of Obsidian's `MetadataCache.getLinkpathDest` matching (read from Obsidian 1.14.4 `app.js`),
 * restricted to one source's files. `fromDir` is the linking file's folder relative to the source
 * root. Returns every candidate in Obsidian's preference order, so `[0]` is what Obsidian picks.
 */
function matchPlainLink<T extends PathFile>(index: SourceFileIndex<T>, source: string, linkpath: string, fromDir: string): T[] {
	let o = linkpath.toLowerCase();
	let a = baseName(o);
	let candidates: readonly IndexedFile<T>[] = [];
	if (a.includes(".")) candidates = index.filesNamed(source, a);
	if (candidates.length === 0) {
		o = `${linkpath}.md`.toLowerCase();
		a = baseName(o);
		candidates = index.filesNamed(source, a);
	}
	if (candidates.length === 0) return [];
	if (a === o && candidates.length === 1) return [candidates[0].file];
	let dir = fromDir.toLowerCase();
	if (o.startsWith("./") || o.startsWith("../")) {
		if (o.startsWith("./../")) o = o.slice(2);
		if (o.startsWith("./")) {
			if (dir !== "") dir += "/";
			o = dir + o.slice(2);
		} else {
			while (o.startsWith("../")) {
				o = o.slice(3);
				dir = dirName(dir);
			}
			if (dir !== "") dir += "/";
			o = dir + o;
		}
		for (const c of candidates) if (c.rel.toLowerCase() === o) return [c.file];
	}
	if (o.startsWith("/")) o = o.slice(1);
	for (const c of candidates) if (c.rel.toLowerCase() === o) return [c.file];
	if (linkpath.startsWith("/")) return [];
	const near: IndexedFile<T>[] = [];
	const far: IndexedFile<T>[] = [];
	for (const c of candidates) {
		const lower = c.rel.toLowerCase();
		if (lower.endsWith(o)) (lower.startsWith(dir) ? near : far).push(c);
	}
	const byLength = (x: IndexedFile<T>, y: IndexedFile<T>) => x.rel.length - y.rel.length;
	near.sort(byLength);
	far.sort(byLength);
	return near.concat(far).map((c) => c.file);
}

export type SourceLinkFailure = "malformed" | "not-found" | "ambiguous";

export type SourceLinkOutcome<T> =
	| { kind: "resolved"; file: T }
	| { kind: "unresolved"; reason: SourceLinkFailure; source?: string; path?: string; matches?: string[] };

/**
 * Resolves `@source:path` to a file of that source. Tries `<path>.md` first (notes drop their
 * extension), then `<path>` as written (other files keep theirs). An exact path match relative to
 * the source root wins; otherwise the shortest matching path wins, and a tie on the shortest path
 * is "ambiguous" (E3) — the link stays broken and the outcome lists the tied paths.
 */
export function resolveSourceLink<T extends PathFile>(index: SourceFileIndex<T>, linktext: unknown): SourceLinkOutcome<T> {
	const parsed = parseSourceLink(linktext);
	if (!parsed) return { kind: "unresolved", reason: "malformed" };
	const { source, path } = parsed;
	for (const target of [`${path}.md`.toLowerCase(), path.toLowerCase()]) {
		const candidates = index.filesNamed(source, baseName(target));
		const exact = candidates.find((c) => c.rel.toLowerCase() === target);
		if (exact) return { kind: "resolved", file: exact.file };
		const matches = candidates.filter((c) => c.rel.toLowerCase().endsWith(target)).sort((x, y) => x.rel.length - y.rel.length);
		if (matches.length === 0) continue;
		const tied = matches.filter((c) => c.rel.length === matches[0].rel.length);
		if (tied.length > 1) return { kind: "unresolved", reason: "ambiguous", source, path, matches: tied.map((c) => c.file.path) };
		return { kind: "resolved", file: matches[0].file };
	}
	return { kind: "unresolved", reason: "not-found", source, path };
}

/**
 * Resolves a plain link inside the linking file's own source, by Obsidian's matching rules, or
 * null. `sourcePath` is the linking file's vault path.
 */
export function resolvePlainLinkInOwnSource<T extends PathFile>(index: SourceFileIndex<T>, linkpath: string, sourcePath: string): T | null {
	const source = ownSourceOf(sourcePath);
	const folder = sourceFolderName(sourcePath);
	const rel = folder !== null && folder.toLowerCase() !== NOTES_SOURCE ? sourcePath.slice(SOURCES_FOLDER.length + 1 + folder.length + 1) : sourcePath;
	return matchPlainLink(index, source, linkpath, dirName(rel))[0] ?? null;
}

/** User-facing sentence for an unresolved source link: used by the click notice (E3, broken links). */
export function describeUnresolved(outcome: Extract<SourceLinkOutcome<unknown>, { kind: "unresolved" }>, linktext: string): string {
	if (outcome.reason === "ambiguous" && outcome.matches && outcome.source) {
		return `${outcome.matches.length} matches in ${outcome.source}:\n${outcome.matches.join("\n")}`;
	}
	if (outcome.reason === "not-found" && outcome.source && outcome.path) {
		return `No file ${outcome.path} in ${outcome.source}`;
	}
	return `Can't open "${linktext}": not a valid source link`;
}

/**
 * Q13 helper (PR-7's `[[` popup uses it): the vault paths of every file in `files` whose plain
 * link name — file name without a trailing `.md`, case-insensitive — equals `name`, when two or
 * more share it (so a bare `[[name]]` would be ambiguous and the popup inserts a full vault path,
 * e.g. `[[Sources/tephra/README]]`). Returns `[]` when the name is unique or absent. Pure: no I/O.
 */
export function plainNameClashes(name: string, files: readonly PathFile[]): string[] {
	const wanted = stripMd(baseName(name)).toLowerCase();
	if (wanted === "") return [];
	const matches = files.filter((f) => stripMd(baseName(f.path)).toLowerCase() === wanted).map((f) => f.path);
	return matches.length > 1 ? matches : [];
}

function stripMd(name: string): string {
	return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}
