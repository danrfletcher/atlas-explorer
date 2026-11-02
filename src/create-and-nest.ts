import { App, Notice, TFile, TFolder } from "obsidian";
import { generateBlockId } from "./display-text";
import { UnitRef } from "./types";

/** PR-1.S1: the shared create-and-nest foundation. Lifted out of the Folder-only Create path
 * (`create-from-meta.ts`) so any later "add under" kind can create a block, file or module on disk,
 * hold it out of the Inbox, roll it back on failure, and take a per-parent lock — all without any
 * UI change here. `createFromMeta` is rebuilt on these helpers and still behaves exactly as before;
 * the Add under menu entry and the actual nest-as-child flows for Block/File/Module/Folder land in
 * later PRs (PR-1.S2 onward). */

/** What a meta folder can become, and what "add under" can create. A free block is a `file`-kind
 * ref, so Block and File resolve to the same status "apply to" switch; only Module differs. */
export type CreateKind = "block" | "file" | "module";

/** In menu order. */
export const CREATE_KINDS: ReadonlyArray<{ kind: CreateKind; label: string; icon: string }> = [
	{ kind: "block", label: "Block", icon: "square" },
	{ kind: "file", label: "File", icon: "file" },
	{ kind: "module", label: "Module", icon: "folder" },
];

/** The chosen name with surrounding whitespace dropped. Inner text is kept exactly as typed. Shared
 * with `create-from-meta.ts` so the two never drift. */
export function trimmed(name: string): string {
	return name.trim();
}

/** Body of every file Create (and, later, Add under) writes: a heading with the name, one trailing newline. */
export function buildBlockContent(name: string): string {
	return `# ${trimmed(name)}\n`;
}

/** `<pool>/<ID>.md`, the same shape Add block makes. */
export function blockPath(poolFolder: string, now: Date, random: () => number = Math.random): string {
	return `${poolFolder}/${generateBlockId(now, random)}.md`;
}

export function filePath(name: string): string {
	return `${trimmed(name)}.md`;
}

export function modulePaths(name: string): { folder: string; note: string } {
	const folder = trimmed(name);
	return { folder, note: `${folder}/${folder}.md` };
}

/** The pool folder path without trailing slashes, or null when the setting can't hold a file (empty,
 * or the vault root itself). */
export function usablePoolFolder(setting: string): string | null {
	const pool = setting.trim().replace(/\/+$/, "");
	return pool === "" || pool === "." ? null : pool;
}

/** Give up on finding a free ID after this many collisions (it can only happen with a broken random source). */
const MAX_ID_ATTEMPTS = 100;

/** The first `<pool>/<ID>.md` path nothing occupies yet. Never returns an existing path. */
export function freeBlockPath(vault: Pick<App["vault"], "getAbstractFileByPath">, poolFolder: string, now: Date, random: () => number = Math.random): string | null {
	for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
		const path = blockPath(poolFolder, now, random);
		if (!vault.getAbstractFileByPath(path)) return path;
	}
	return null;
}

/** An error's message, or its string form when it isn't an `Error`. Shared with `create-from-meta.ts`
 * and the add-under flows. */
export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface CreateOnDiskDeps {
	app: Pick<App, "vault">;
	getPoolFolder(): string;
	/** Keeps the unit at `path` out of the unit index's list until the returned release is called, so
	 * the vault create event can't show the new item as unplaced before it is nested (replaced in
	 * place for Create, or appended as a child for a later add-under kind). */
	holdUnit(path: string): () => void;
	/** Clock and random source for the block ID (injectable for tests). */
	now?(): Date;
	random?(): number;
}

export type CreateOnDiskResult =
	| { ok: true; ref: UnitRef; path: string; rollback: () => Promise<string>; release: () => void }
	| { ok: false; reason: string; leftover: string };

/** Creates the one new item on disk for `kind` — block in the pool, file at the vault root, or a
 * module folder plus its same-named note — and takes the inbox hold before the first write. `name`
 * is assumed already trimmed and validated by the caller (the dialog wording differs by caller, so
 * that stays with them). `content`, when given, is written verbatim instead of
 * `buildBlockContent(name)` — PR-3.F1's Add under > Block has no name dialog at all and writes a
 * genuinely empty file (same shape as the toolbar's "Add block"), where `createFromMeta`'s Block
 * replace-in-place path (prompted, non-empty name) still gets its usual `# <name>` heading by
 * omitting this param.
 *
 * On success, returns `{ ref, path, rollback, release }`: the hold is still held, and it's the
 * caller's job to call `release()` once the item has actually been nested (replaced in place, or
 * placed as a child) — on both success and failure of that nest step — so nothing can flash into
 * the Inbox as an unplaced unit in between. `rollback()` removes exactly what this call made (files
 * first, then an empty module folder, then a pool folder this call created), best-effort, and
 * reports a leftover folder it couldn't remove.
 *
 * On failure, this function has already rolled back anything it made and released the hold; the
 * caller only needs to show its own Notice with `reason` (+ `leftover` if non-empty). */
export async function createOnDisk(deps: CreateOnDiskDeps, kind: CreateKind, name: string, content?: string): Promise<CreateOnDiskResult> {
	const { vault } = deps.app;
	const made: { file?: TFile; folder?: TFolder; pool?: TFolder } = {};
	/** Removes what this run made (files first), each only if it is still what we created. Best effort. */
	const rollback = async (): Promise<string> => {
		let leftover = "";
		try {
			if (made.file) await vault.delete(made.file);
			// `force` is required for a folder (Obsidian's plain delete throws EISDIR on one); the emptiness
			// check is what makes the recursive removal safe.
			if (made.folder && made.folder.children.length === 0) await vault.delete(made.folder, true);
			else if (made.folder) leftover = `. The folder "${made.folder.path}" isn't empty, so Atlas left it in place`;
			if (made.pool && made.pool.children.length === 0) await vault.delete(made.pool, true);
		} catch (error) {
			leftover = `. Atlas couldn't clean up what it had made (${describe(error)})`;
		}
		return leftover;
	};

	let ref: UnitRef;
	let path: string;
	let release: () => void = () => {};
	const hold = (target: string): void => {
		release = deps.holdUnit(target);
	};
	try {
		if (kind === "block") {
			const pool = usablePoolFolder(deps.getPoolFolder());
			if (!pool) return { ok: false, reason: "the pool folder setting is empty or the vault root", leftover: "" };
			if (!(vault.getAbstractFileByPath(pool) instanceof TFolder)) made.pool = await vault.createFolder(pool);
			const free = freeBlockPath(vault, pool, deps.now?.() ?? new Date(), deps.random);
			if (!free) return { ok: false, reason: "no free block ID was available", leftover: await rollback() };
			hold(free);
			made.file = await vault.create(free, content ?? buildBlockContent(name));
			path = free;
			ref = { kind: "file", path };
		} else if (kind === "file") {
			path = filePath(name);
			hold(path);
			made.file = await vault.create(path, content ?? buildBlockContent(name));
			ref = { kind: "file", path };
		} else {
			const paths = modulePaths(name);
			hold(paths.folder);
			made.folder = await vault.createFolder(paths.folder);
			made.file = await vault.create(paths.note, content ?? buildBlockContent(name));
			path = paths.folder;
			ref = { kind: "folder", path };
		}
	} catch (error) {
		// Only things this run created are in `made` (a create call that threw made nothing), so a
		// half-made module leaves nothing behind and an existing file is never touched.
		const leftover = await rollback();
		release();
		return { ok: false, reason: describe(error), leftover };
	}

	return { ok: true, ref, path, rollback, release };
}

/** `viewId:parentId` keys with a create-and-nest run in progress (dialog open, or the disk/nest
 * step under way). Shared by Create (whose "parent" is the meta folder it's replacing) and every
 * later add-under kind (whose parent is the row being added under), so the two can never race on
 * the same row. */
const running = new Set<string>();

/** Takes the lock for `viewId:parentId`, or returns null if it's already held. The caller must call
 * the returned release function exactly once, on every outcome (success, failure, cancel, or a
 * thrown error), so the same parent can be run again. Create ignores a busy key silently
 * (`notifyBusy: false`); later add-under kinds pass `true` so the user sees why nothing happened. */
export function acquireParentLock(viewId: string, parentId: string, notifyBusy: boolean): (() => void) | null {
	const key = `${viewId}:${parentId}`;
	if (running.has(key)) {
		if (notifyBusy) new Notice("Atlas: already adding something here");
		return null;
	}
	running.add(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		running.delete(key);
	};
}

export interface ParentExistsDeps {
	getNode(viewId: string, parentId: string): unknown | null;
}

/** True only if `getNode` still finds a node — unit or meta — at `parentId` in `viewId`. Call this
 * before the name dialog opens and again immediately before nesting: `placeUnit` and `addMetaFolder`
 * silently fall back to appending at the view root when the parent id is gone, which would plant the
 * new item somewhere the user never asked for instead of refusing. */
export function parentExists(deps: ParentExistsDeps, viewId: string, parentId: string): boolean {
	return deps.getNode(viewId, parentId) != null;
}
