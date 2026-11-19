import { SOURCES_FOLDER } from "./sources-path";
import { USER_IGNORE_FILTERS_KEY, sourceExcludeEntry } from "./tephra-exclude";

/** A source's `.gitignore` can't make Obsidian's list grow without bound. */
export const MAX_GITIGNORE_ENTRIES = 500;

export type SkippedReason = "negation" | "invalid-pattern" | "over-limit";

export interface SkippedGitignoreLine {
	line: string;
	reason: SkippedReason;
}

export interface GitignoreMapping {
	/** Obsidian Excluded files entries, in `.gitignore` order, without duplicates. Path entries are
	 * `Sources/<name>/<path>`; globs are `/regex/` entries. */
	entries: string[];
	skipped: SkippedGitignoreLine[];
}

/** Every source's own `.git/` is excluded, whether or not it has a `.gitignore`. */
export function gitDirEntry(sourceName: string): string {
	return `${sourceExcludeEntry(sourceName)}.git/`;
}

function escapeRegex(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

const GLOB_CHARS = /[*?[]/;

/** Trailing whitespace is ignored unless the last space is escaped (`foo\ `), as git does. */
function stripTrailingSpace(line: string): string {
	let end = line.length;
	while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t") && line[end - 2] !== "\\") end--;
	return line.slice(0, end);
}

/** One path segment of a glob as a regex source: `*` is any run but `/`, `?` one char but `/`, `[abc]` a class. */
function segmentToRegex(segment: string): string | null {
	let out = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\") {
			i++;
			if (i >= segment.length) return null; // a dangling escape is not a pattern
			out += escapeRegex(segment[i]);
		} else if (ch === "*") {
			while (segment[i + 1] === "*") i++; // `**` inside a segment behaves as one `*`
			out += "[^/]*";
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch === "[") {
			let j = i + 1;
			if (segment[j] === "!" || segment[j] === "^") j++;
			if (segment[j] === "]") j++;
			while (j < segment.length && segment[j] !== "]") j++;
			if (j >= segment.length) {
				out += "\\["; // no closing bracket: a literal `[`
			} else {
				const body = segment.slice(i + 1, j);
				const negated = body.startsWith("!") || body.startsWith("^");
				const members = (negated ? body.slice(1) : body).replace(/\\/g, "\\\\").replace(/\[/g, "\\[");
				out += `[${negated ? "^" : ""}${members}]`;
				i = j;
			}
		} else {
			out += escapeRegex(ch);
		}
	}
	return out;
}

/** The regex (without the surrounding slashes) that matches the vault paths a glob line covers. */
function globToRegexSource(sourceName: string, body: string, anchored: boolean, dirOnly: boolean): string | null {
	const segments = body.split("/");
	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const last = i === segments.length - 1;
		if (segment === "**") {
			out += last ? ".*" : "(?:.*/)?"; // a `**` segment spans any number of folders, none included
			continue;
		}
		const piece = segmentToRegex(segment);
		if (piece === null) return null;
		out += piece;
		if (!last) out += "/";
	}
	const prefix = `^${escapeRegex(sourceExcludeEntry(sourceName))}`;
	return `${prefix}${anchored ? "" : "(?:.*/)?"}${out}${dirOnly ? "/" : "(?:/|$)"}`;
}

/** Removes the backslash from `\#`, `\!`, `\ ` and `\\` in a path with no glob characters. */
function unescapePlain(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

/**
 * R3-2: maps one source's root `.gitignore` to Obsidian Excluded files entries.
 *
 * - A plain path (no `*`, `?` or `[`) becomes the path entry `Sources/<name>/<path>`, keeping its trailing
 *   slash (`target/` -> `Sources/tephra/target/`). Excluded-files path entries are prefixes, so a name
 *   without a trailing slash also covers longer names that start with it.
 * - A glob becomes a `/regex/` entry. A glob with no `/` in it (other than a trailing one) matches at any
 *   depth, as in git; one with a `/` inside, or a leading `/`, is anchored to the source root.
 * - Comments, blank lines, negations (`!x`) are skipped; negations and lines that don't make a valid pattern
 *   are reported in `skipped`. Nested `.gitignore` files are never read.
 * - `Sources/<name>/.git/` is always included, first.
 */
export function mapGitignore(sourceName: string, text: string | null): GitignoreMapping {
	const entries: string[] = [gitDirEntry(sourceName)];
	const seen = new Set(entries);
	const skipped: SkippedGitignoreLine[] = [];
	const base = sourceExcludeEntry(sourceName);
	if (text === null) return { entries, skipped };

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripTrailingSpace(rawLine);
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("!")) {
			skipped.push({ line: rawLine, reason: "negation" });
			continue;
		}
		const dirOnly = line.endsWith("/") && !line.endsWith("\\/");
		let body = dirOnly ? line.slice(0, -1) : line;
		const leadingSlash = body.startsWith("/");
		if (leadingSlash) body = body.slice(1);
		const danglingEscape = /(?:^|[^\\])(?:\\\\)*\\$/.test(body); // an odd run of backslashes at the end escapes nothing
		if (body === "" || body === "." || body === ".." || body.split("/").some((s) => s === "..") || danglingEscape) {
			skipped.push({ line: rawLine, reason: "invalid-pattern" });
			continue;
		}

		let entry: string | null;
		if (!GLOB_CHARS.test(body.replace(/\\./g, ""))) {
			// Plain: `**` needs a glob character, so there is none here.
			const path = unescapePlain(body).replace(/\/{2,}/g, "/");
			entry = `${base}${path}${dirOnly ? "/" : ""}`;
		} else {
			const anchored = leadingSlash || body.includes("/");
			const source = globToRegexSource(sourceName, body, anchored, dirOnly);
			entry = null;
			if (source !== null) {
				try {
					new RegExp(source);
					entry = `/${source}/`;
				} catch {
					entry = null;
				}
			}
		}
		if (entry === null) {
			skipped.push({ line: rawLine, reason: "invalid-pattern" });
			continue;
		}
		if (seen.has(entry)) continue;
		if (entries.length >= MAX_GITIGNORE_ENTRIES) {
			skipped.push({ line: rawLine, reason: "over-limit" });
			continue;
		}
		seen.add(entry);
		entries.push(entry);
	}
	return { entries, skipped };
}

/** Whether `entry` is a regex entry (`/.../`), as Obsidian reads Excluded files lines. */
export function isRegexEntry(entry: string): boolean {
	return entry.length > 2 && entry.startsWith("/") && entry.endsWith("/");
}

/** The entry as something that tests a vault path: a regex for `/.../`, otherwise a path prefix. */
export function excludeEntryMatcher(entry: string): ((path: string) => boolean) | null {
	if (isRegexEntry(entry)) {
		try {
			const re = new RegExp(entry.slice(1, -1));
			return (path) => re.test(path);
		} catch {
			return null;
		}
	}
	return (path) => path.startsWith(entry);
}

/** `Sources/<name>/` when the source's "Show in Obsidian search & graph" is off. */
export function desiredEntriesForSource(sourceName: string, gitignoreText: string | null, showInSearch: boolean): GitignoreMapping {
	const mapping = mapGitignore(sourceName, gitignoreText);
	if (!showInSearch) mapping.entries.unshift(sourceExcludeEntry(sourceName));
	return mapping;
}

export interface ExcludeConfigAccess {
	get(): unknown;
	set(list: string[]): void;
}

export interface ReconcileInput {
	/** The entries each source should have: `undefined`/absent = none. */
	desired: Record<string, string[]>;
	/** The entries Atlas added earlier, by source (`tephraExcludes` in `data.json`). */
	tracked: Record<string, string[]>;
	/** False while links are still being made: entries are added before a link exists, but stale ones are
	 * kept until the old link is gone so Obsidian doesn't re-index a source that is about to be removed. */
	removeStale: boolean;
}

export interface ReconcileResult {
	tracked: Record<string, string[]>;
	added: string[];
	removed: string[];
}

/**
 * Brings Obsidian's Excluded files in step with `desired`, touching only what Atlas added. An entry the user
 * already had (not tracked by Atlas) is never recorded as Atlas's and never removed. The user's other entries
 * keep their order; new entries go at the end. Writes the list only when something changed.
 */
export function reconcileExcludes(config: ExcludeConfigAccess, input: ReconcileInput): ReconcileResult {
	const rawCurrent = config.get();
	const current = Array.isArray(rawCurrent) ? rawCurrent.filter((item): item is string => typeof item === "string") : [];
	const currentSet = new Set(current);
	const tracked: Record<string, string[]> = {};
	const toAdd: string[] = [];
	const toRemove = new Set<string>();

	// What any source's earlier run added: an entry another source added and this one now wants is Atlas's too.
	const addedBefore = new Set(Object.values(input.tracked).flat());
	const names = new Set([...Object.keys(input.desired), ...Object.keys(input.tracked)]);
	for (const name of names) {
		const previous = getOwn(input.tracked, name) ?? [];
		const desired = getOwn(input.desired, name);
		// Not wanted, but not yet allowed to go (links are still being made): keep what is there.
		const wanted = desired === undefined && !input.removeStale ? previous : (desired ?? []);
		const mine: string[] = [];
		for (const entry of wanted) {
			if (previous.includes(entry)) {
				mine.push(entry);
				if (!currentSet.has(entry)) toAdd.push(entry); // the user removed it: put it back
			} else if (!currentSet.has(entry)) {
				mine.push(entry);
				toAdd.push(entry);
			} else if (addedBefore.has(entry)) {
				mine.push(entry); // handed over from another source: still Atlas's
			}
			// else: already in the list and not ours (the user's own): leave it, don't track it
		}
		for (const entry of previous) if (!wanted.includes(entry)) toRemove.add(entry);
		if (mine.length > 0) tracked[name] = mine;
	}

	// An entry another source still wants (the same text) must stay.
	for (const list of Object.values(tracked)) for (const entry of list) toRemove.delete(entry);

	const added = [...new Set(toAdd)];
	const removed = [...toRemove].filter((entry) => currentSet.has(entry));
	if (added.length > 0 || removed.length > 0) {
		const kept = current.filter((entry) => !removed.includes(entry));
		config.set([...kept, ...added]);
	}
	return { tracked, added, removed };
}

/** An own property only: a source called `constructor` must not read `Object.prototype.constructor`. */
export function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** The vault's Excluded files list through the same `getConfig`/`setConfig` pair `tephra-exclude.ts` uses. */
export function vaultExcludeConfig(vault: { getConfig?: (key: string) => unknown; setConfig?: (key: string, value: unknown) => void }): ExcludeConfigAccess | null {
	if (typeof vault.getConfig !== "function" || typeof vault.setConfig !== "function") return null;
	const { getConfig, setConfig } = vault;
	return {
		get: () => getConfig.call(vault, USER_IGNORE_FILTERS_KEY),
		set: (list) => setConfig.call(vault, USER_IGNORE_FILTERS_KEY, list),
	};
}

/** Whether `name` lives in `Sources/` (used by tests and the orchestrator to build prefixes). */
export function sourceFolderPrefix(sourceName: string): string {
	return `${SOURCES_FOLDER}/${sourceName}`;
}
