/**
 * G8 — the rule for the link text the `[[` popup inserts. Pure: works on vault paths only, no Obsidian
 * imports, builds nothing that outlives the call (F1).
 *
 *   same source as the note     `Name`                  (the bare name, or the full path in its source on a clash)
 *   another source              `@source:path`          (same, with the source in front)
 *
 * The bare name is used when it resolves to this file and no other in the file's source (the shortest path
 * wins a bare name, so the root `README` is plain `README` even when a nested one exists). Otherwise the
 * text is the file's full path from the source's root (`crates/tephrad/README`), because Tephra resolves a target with a `/` against the whole path from the root, never a trailing part of
 * it. Notes drop `.md`; every other file keeps its extension. The file's real name and case are used. Files
 * under `Sources/` belong to their own source, so they never count against a vault file's uniqueness (and
 * the other way round).
 *
 * Q13 fallback: when the link hook isn't installed, Obsidian resolves a plain link across the whole
 * vault. A same-source pick whose plain name is also the name of a file in another source then gets the
 * file's full vault path (`Sources/tephra/README`), which no other file can match.
 */
import {
	NOTES_SOURCE,
	SOURCES_FOLDER,
	SourceFileIndex,
	isUnderSourcesFolder,
	isValidSourceName,
	ownSourceOf,
	plainNameClashes,
	resolvePlainLinkInOwnSource,
	resolveSourceLink,
	type PathFile,
} from "./source-links";

/** The source a vault path is a file of, or null when it is in none (`Sources/x.md`, `Sources/notes/…`,
 * `Sources/<not a name>/…`). The name keeps the case it has in the path. */
export function sourceOfVaultPath(path: string): string | null {
	if (!isUnderSourcesFolder(path)) return NOTES_SOURCE;
	// The bare `Sources` entry and a file directly under it are in no source.
	const rest = path.startsWith(`${SOURCES_FOLDER}/`) ? path.slice(SOURCES_FOLDER.length + 1) : "";
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const name = rest.slice(0, slash);
	// `notes` is the vault's reserved name, so `Sources/notes/…` is not a source either.
	return isValidSourceName(name) && name.toLowerCase() !== NOTES_SOURCE ? name : null;
}

/** The path of a vault file relative to its source's root. */
export function pathInSource(path: string, source: string): string {
	if (source.toLowerCase() === NOTES_SOURCE) return path;
	return path.slice(SOURCES_FOLDER.length + 1 + source.length + 1);
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function isNote(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

/** `Foo.md` -> `Foo`; anything else unchanged. */
function dropMd(path: string): string {
	return isNote(path) ? path.slice(0, -3) : path;
}

export interface SourceLinkTextOptions {
	/** The Q13 fallback is active: no hook, so a clashing plain name needs the full vault path. */
	fullPathOnClash: boolean;
}

export type SourceLinkTextKind = "same-source" | "cross-source" | "full-path";

export interface SourceLinkText {
	/** What goes between `[[` and `]]` (before any `#subpath` or `|alias`). */
	text: string;
	kind: SourceLinkTextKind;
	/** The source the picked file is in; null when it is in none (then `text` is its full vault path). */
	source: string | null;
}

/**
 * The text to insert in the note at `fromPath` to link `file`. `files` is every file of the vault (the
 * caller passes `vault.getFiles()`); only the files that share the picked file's source and file name are
 * looked at.
 */
export function sourceLinkText(file: PathFile, fromPath: string, files: readonly PathFile[], options: SourceLinkTextOptions): SourceLinkText {
	const fileSource = sourceOfVaultPath(file.path);
	if (fileSource === null) return { text: dropMd(file.path), kind: "full-path", source: null };
	const same = fileSource.toLowerCase() === ownSourceOf(fromPath).toLowerCase();

	if (same && options.fullPathOnClash) {
		const clashes = plainNameClashes(baseName(file.path), files);
		if (clashes.some((path) => (sourceOfVaultPath(path) ?? "").toLowerCase() !== fileSource.toLowerCase())) {
			return { text: dropMd(file.path), kind: "full-path", source: fileSource };
		}
	}

	const lowerName = baseName(file.path).toLowerCase();
	const sourceLower = fileSource.toLowerCase();
	const group = files.filter((f) => baseName(f.path).toLowerCase() === lowerName && sourceOfVaultPath(f.path)?.toLowerCase() === sourceLower);
	const index = new SourceFileIndex<PathFile>(() => group);

	// The bare name when it resolves to this file and no other in the source; otherwise the full path from the
	// source's root. Never a partial path: Tephra matches a target without `/` by name and a target with `/`
	// against the whole path from the root, so a trailing slice (`tephrad/README`) would dangle there.
	const full = dropMd(pathInSource(file.path, fileSource));
	const bare = dropMd(baseName(file.path));
	// Tephra's rule (the shortest path wins a bare name; a tie is ambiguous) is checked for every pick, and
	// for a same-source pick the note's own resolver must agree too.
	const bareFinds = resolvesTo(index, bare, fileSource, false, fromPath, file.path) && (!same || resolvesTo(index, bare, fileSource, true, fromPath, file.path));
	const found = bareFinds ? bare : full;
	return same ? { text: found, kind: "same-source", source: fileSource } : { text: `@${fileSource}:${found}`, kind: "cross-source", source: fileSource };
}

function resolvesTo(index: SourceFileIndex<PathFile>, candidate: string, source: string, same: boolean, fromPath: string, target: string): boolean {
	if (same) return resolvePlainLinkInOwnSource(index, candidate, fromPath)?.path === target;
	const outcome = resolveSourceLink(index, `@${source}:${candidate}`);
	return outcome.kind === "resolved" && outcome.file.path === target;
}
