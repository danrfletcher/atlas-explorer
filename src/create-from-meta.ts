import { App, Menu, Notice } from "obsidian";
import { openNameDialog } from "./name-dialog";
import { collectRootEntries, validateName } from "./name-rules";
import { UnitRef, ViewNode } from "./types";
import {
	CreateKind,
	CREATE_KINDS,
	acquireParentLock,
	blockPath,
	buildBlockContent,
	createOnDisk,
	describe,
	filePath,
	freeBlockPath,
	modulePaths,
	parentExists,
	trimmed,
	usablePoolFolder,
} from "./create-and-nest";

// Re-exported for every existing caller/test that still imports builders and `CreateKind` from here
// (PR-1.S1 moved the shared disk-creation logic to `create-and-nest.ts`; this file now only adds the
// Folder-replace-in-place behaviour on top of it).
export type { CreateKind };
export { CREATE_KINDS, blockPath, buildBlockContent, filePath, freeBlockPath, modulePaths, usablePoolFolder };

export const CREATE_ITEM_TITLE = "Replace with…";

export function createDialogTitle(kind: CreateKind): string {
	const { label } = CREATE_KINDS.find((entry) => entry.kind === kind)!;
	return `Create ${label}`;
}

export interface CreateFromMetaDeps {
	app: Pick<App, "vault">;
	getPoolFolder(): string;
	getExcludedFolders(): string[];
	/** The views manager's read and replace calls (data only, never disk). */
	getNode(viewId: string, nodeId: string): ViewNode | null;
	replaceMetaNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean;
	/** Keeps the unit at `path` out of the unit index's list until the returned release is called, so
	 * the vault create event can't show the new item as unplaced before its view node is swapped in. */
	holdUnit(path: string): () => void;
	/** Writes data.json now, so a reload right after Create can't bring the meta folder back. */
	save(): Promise<void>;
	/** Clock and random source for the block ID (injectable for tests). */
	now?(): Date;
	random?(): number;
}

export type CreateFromMetaResult = { ok: true; ref: UnitRef; path: string } | { ok: false; reason: string };

const ERROR_NOTICE_MS = 8000;

/** Creates the one new item on disk for `kind` (via the shared `createOnDisk`), then swaps the meta
 * node for it in the view. The node is replaced only after the disk step succeeded; if that step
 * fails, whatever Atlas made is removed again and the meta folder is left exactly as it was. Never
 * opens the new item and never touches any other file. Always resolves; failures show as one error
 * notice. PR-1.S1: this is the Folder-only "replace in place" step added on top of the shared
 * create-and-hold-out-of-inbox helper — everything else (disk create, hold, rollback) is lifted out
 * to `create-and-nest.ts` unchanged, so a future unit-row "add under" can reuse it too. */
export async function createFromMeta(deps: CreateFromMetaDeps, kind: CreateKind, viewId: string, nodeId: string, rawName: string): Promise<CreateFromMetaResult> {
	const { vault } = deps.app;
	const name = trimmed(rawName);
	const fail = (reason: string, extra = ""): CreateFromMetaResult => {
		new Notice(`Atlas: couldn't create ${kind} "${name}": ${reason}${extra}`, ERROR_NOTICE_MS);
		return { ok: false, reason };
	};

	// The dialog may have been open a while: the folder must still be there, and the name still free.
	if (!parentExists(deps, viewId, nodeId) || deps.getNode(viewId, nodeId)?.type !== "meta") return fail("the folder no longer exists");
	const validation = validateName(name, {
		mode: kind === "block" ? "non-empty" : "full",
		root: kind === "block" ? [] : collectRootEntries(vault),
		poolFolder: deps.getPoolFolder(),
		excludedFolders: deps.getExcludedFolders(),
	});
	if (!validation.valid) return fail(validation.message);

	const made = await createOnDisk(deps, kind, name);
	if (!made.ok) return fail(made.reason, made.leftover);

	// The folder may have gone while the disk step ran (a data sync): don't leave an orphan behind.
	// The unit stays held through the swap and is released right after it, so any redraw (the release
	// tells the index's listeners) sees the new node and the unit together, never the unit while the
	// meta node is still in the tree. `parentExists` is the same pre-nest guard every later add-under
	// kind uses; `replaceMetaNodeWithUnit`'s own existence check still runs too, since it's also the
	// thing that does the actual swap.
	if (!parentExists(deps, viewId, nodeId) || !deps.replaceMetaNodeWithUnit(viewId, nodeId, made.ref)) {
		const leftover = await made.rollback();
		made.release();
		return fail("the folder no longer exists", leftover);
	}
	made.release();
	try {
		await deps.save();
	} catch (error) {
		new Notice(`Atlas: "${name}" was created, but saving the views failed: ${describe(error)}`, ERROR_NOTICE_MS);
	}
	return { ok: true, ref: made.ref, path: made.path };
}

export interface CreateFromMetaFlowDeps extends CreateFromMetaDeps {
	app: App;
}

/** The menu action: name dialog prefilled with the meta folder's current label, then `createFromMeta`.
 * Cancel does nothing at all. PR-1.S1: the busy/cancel lock is now the shared per-parent lock keyed
 * `viewId:parentId` (here, `parentId` is the meta folder's own id, since Create's "parent" is the row
 * it's replacing) — the same set a later add-under kind will take its lock from, so the two can never
 * run on the same row at once. Create still ignores a busy key silently (no Notice). */
export async function startCreateFromMeta(deps: CreateFromMetaFlowDeps, kind: CreateKind, viewId: string, nodeId: string): Promise<void> {
	const release = acquireParentLock(viewId, nodeId, false);
	if (!release) return;
	try {
		const node = parentExists(deps, viewId, nodeId) ? deps.getNode(viewId, nodeId) : null;
		if (!node || node.type !== "meta") return;
		const name = await openNameDialog(deps.app, {
			title: createDialogTitle(kind),
			initialValue: node.label ?? "",
			mode: kind === "block" ? "non-empty" : "full",
			poolFolder: deps.getPoolFolder(),
			excludedFolders: deps.getExcludedFolders(),
		});
		if (name === null) return;
		await createFromMeta(deps, kind, viewId, nodeId, name);
	} finally {
		release();
	}
}

/** Adds "Replace with…" to a meta folder's menu (PR-1.F1: renamed from "Create" to sit alongside
 * "Swap with…"; the operation itself — replace the folder in place with a new Block, File or Module —
 * is unchanged). Obsidian's public Menu API has no submenu, so choosing it pops a second small menu
 * with Block, File and Module at the same spot: two clicks either way. */
export function addCreateItem(menu: Menu, evt: Pick<MouseEvent, "clientX" | "clientY">, onChoose: (kind: CreateKind) => void): void {
	menu.addItem((item) =>
		item
			.setTitle(CREATE_ITEM_TITLE)
			.setIcon("plus-circle")
			.onClick(() => {
				const chooser = new Menu();
				for (const { kind, label, icon } of CREATE_KINDS) {
					chooser.addItem((entry) => entry.setTitle(label).setIcon(icon).onClick(() => onChoose(kind)));
				}
				chooser.showAtPosition({ x: evt.clientX, y: evt.clientY });
			})
	);
}
