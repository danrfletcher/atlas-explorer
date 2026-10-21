import * as fs from "fs";
import { join as joinPath } from "path";
import { UnitRef } from "./types";

/** Minimal read-only filesystem surface this module needs — kept narrow so path resolution stays
 * pure/testable against a fake, without pulling in real `fs` (mirrors `FolderSourceVaultLike` in
 * `folder-source.ts`, the same narrowing principle applied to Node's `fs` instead of `Vault`). */
export interface OutsideFsLike {
	existsSync(path: string): boolean;
	statSync(path: string): { isDirectory(): boolean };
}

/** G6/E8: an Outside-Vault path "resolves" only when it exists on this device *and* is a directory —
 * a path that resolves to a file, is blank/whitespace-only, doesn't exist, or throws on access
 * (permission-denied on a restricted external volume) is uniformly "unresolved," never a thrown
 * error surfaced to the user (every edge case the spec calls out collapses to this one boolean). */
export function resolveOutsidePathWith(fsLike: OutsideFsLike, path: string): boolean {
	const trimmed = path.trim();
	if (!trimmed) return false;
	try {
		if (!fsLike.existsSync(trimmed)) return false;
		return fsLike.statSync(trimmed).isDirectory();
	} catch {
		return false;
	}
}

/** Real-`fs`-backed wrapper — the only call site production code needs; tests exercise
 * `resolveOutsidePathWith` directly against a fake, or this against a real temp-directory fixture. */
export function resolveOutsidePath(path: string): boolean {
	return resolveOutsidePathWith(fs, path);
}

/** `OutsideFsLike` plus the one extra read `listOutsideChildrenWith` needs — kept as its own
 * interface rather than widening `OutsideFsLike` itself, since path resolution alone never needs it. */
export interface OutsideReaddirFsLike extends OutsideFsLike {
	readdirSync(path: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}

/** G6/G3-mirror, R4 fix: the direct children of an Outside-Vault folder, filtered by `showFiles`/
 * `showFolders` exactly like `folderToRows` does for an Inside-Vault one — refs carry the entry's
 * name *relative to the Outside root* (never joined with the absolute `path` passed in), the same
 * "never a device-specific absolute string" contract a vault-relative ref already satisfies for
 * Inside-Vault. The absolute root itself stays exactly where `FolderSourcePathStore` already puts
 * it (device-local, never `data.json`) — joining it back onto `path` here would leak it right back
 * into every synced child node instead. Returns `[]` (never throws) whenever `path` itself doesn't
 * resolve, or enumerating it fails (e.g. permission denied mid-read). */
export function listOutsideChildrenWith(
	fsLike: OutsideReaddirFsLike,
	path: string,
	options: { showFiles: boolean; showFolders: boolean }
): UnitRef[] {
	if (!resolveOutsidePathWith(fsLike, path)) return [];
	const refs: UnitRef[] = [];
	try {
		for (const entry of fsLike.readdirSync(path, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (options.showFolders) refs.push({ kind: "folder", path: entry.name });
			} else if (options.showFiles) {
				refs.push({ kind: "file", path: entry.name });
			}
		}
	} catch {
		return [];
	}
	return refs;
}

export function listOutsideChildren(path: string, options: { showFiles: boolean; showFolders: boolean }): UnitRef[] {
	return listOutsideChildrenWith(fs, path, options);
}

/** The one extra read `outsideChildMtimeWith` needs on top of `OutsideFsLike`. */
export interface OutsideStatFsLike {
	statSync(path: string): { isFile(): boolean; mtimeMs: number };
}

/** PR-1 R2: the file-modified time (ms) of one Outside-Vault Folder-source child, for the Modified
 * sort. Mirrors `listOutsideChildrenWith`'s contract: `ref.path` is the entry's name *relative to
 * the Outside root*, so the real path is `rootPath` + that name — `rootPath` is the device-local
 * absolute path from `FolderSourcePathStore`, never stored on the node. Files report their own
 * mtime; a folder child reports `null` ("no time", G9), the same as an Inside-Vault module with no
 * interface note — an Outside-Vault folder is a plain directory, not a module, and a directory's
 * own mtime only moves when entries are added or removed in it. Also `null` (never throws) when
 * the root is blank or the file can't be stat'ed (deleted since the last scan, permission denied). */
export function outsideChildMtimeWith(fsLike: OutsideStatFsLike, rootPath: string, ref: UnitRef): number | null {
	if (ref.kind !== "file" || !rootPath.trim()) return null;
	try {
		const stat = fsLike.statSync(joinPath(rootPath, ref.path));
		return stat.isFile() && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
	} catch {
		return null;
	}
}

export function outsideChildMtime(rootPath: string, ref: UnitRef): number | null {
	return outsideChildMtimeWith(fs, rootPath, ref);
}
