import { App, MarkdownView, Notice, TFile } from "obsidian";
import { CreateOnDiskDeps, ParentExistsDeps, acquireParentLock, createOnDisk, describe, parentExists } from "./create-and-nest";
import { UnitRef, ViewNode } from "./types";

const ERROR_NOTICE_MS = 8000;

/** PR-3.F1 (G1): "Add under… > Block" on the clicked row — an empty free block in the pool, nested
 * as the clicked row's last child, then opened in the editor. Runs on PR-1.S1's shared
 * create-and-hold foundation (`createOnDisk`, `acquireParentLock`, `parentExists` — all from
 * `create-and-nest.ts`), never on the toolbar's `addBlock` (`commands.ts`), which skips the pool
 * check and the inbox hold (fence F6). `createOnDisk` is called with an explicit empty `content`
 * override so the new block is written with no heading at all, matching the toolbar's own "Add
 * block" shape — `createFromMeta`'s Block replace-in-place path (which prompts for a name) still
 * gets its usual `# <name>` body by never passing that override. */
export interface AddUnderBlockDeps extends CreateOnDiskDeps, ParentExistsDeps {
	app: App;
	/** `ViewsManager.placeUnit` — nests `ref` as the clicked row's last child and returns the new
	 * node, or `null` only if the view itself is gone (not expected mid-flow, but handled the same
	 * way as a vanished parent: a Notice, no node). */
	placeUnit(viewId: string, ref: UnitRef, parentId: string): ViewNode | null;
	/** Expands the clicked row so the new child is visible without a further click (G1). */
	expandParent(viewId: string, parentId: string): void;
	/** Replaces the current bucket selection with exactly the new node's id (E5). */
	selectOnly(nodeId: string): void;
}

function fail(reason: string, extra = ""): void {
	new Notice(`Atlas: couldn't add a block here: ${reason}${extra}`, ERROR_NOTICE_MS);
}

/** PR-3.F1 (G1/E3/E4/E5/E6/F6): takes the same per-parent lock every add-under kind shares
 * (`viewId:parentId`), checks the parent still exists before creating anything on disk (E4 —
 * `placeUnit`'s own silent fallback to the view root must never be reachable from here) and again
 * immediately before nesting, then expands the parent, selects the new row and opens it in the
 * editor with the cursor on the empty first line. A misconfigured pool (E3) or any other create
 * failure rolls back whatever `createOnDisk` made and shows the one Notice it already reports a
 * reason for ("the pool folder setting is empty or the vault root" for E3) — the "Block" entry
 * itself stays visible and enabled regardless (`canAddUnder` never looks at the pool setting).
 * Resolves to the new node on success, or `null` on a held lock or any failure — the lock is
 * released on every path, and the selection is left untouched by every failing path. */
export async function startAddUnderBlock(deps: AddUnderBlockDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	const release = acquireParentLock(viewId, parentId, true);
	if (!release) return null;
	try {
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		// No name dialog (G1): Block is always created empty, so `createOnDisk` is called with an
		// empty name and an explicit empty content override — never `buildBlockContent("")`, which
		// would write a bare heading instead of a genuinely empty file.
		const made = await createOnDisk(deps, "block", "", "");
		if (!made.ok) {
			fail(made.reason, made.leftover);
			return null;
		}

		// The parent may have gone while the disk step ran (a data sync): don't leave an orphan
		// block behind, and never let `placeUnit` silently fall back to the view root.
		if (!parentExists(deps, viewId, parentId)) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover);
			return null;
		}
		// `deps.placeUnit` is `ViewsManager.placeUnit` in production — synchronous and never throws —
		// but a test double (or a future caller) could; treating a thrown error the same as a null
		// return keeps the rollback/release path the one thing every failure after create goes
		// through, so the new file is never left behind unplaced.
		let node: ViewNode | null;
		try {
			node = deps.placeUnit(viewId, made.ref, parentId);
		} catch {
			node = null;
		}
		if (!node) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover);
			return null;
		}
		// The unit stays held through the nest and is released right after it, so any redraw (the
		// release tells the index's listeners) sees the new node and the unit together, never the
		// unit while it's still unplaced (E7 — the new note must never flash into the Inbox).
		made.release();
		deps.expandParent(viewId, parentId);
		deps.selectOnly(node.id);

		const file = deps.app.vault.getAbstractFileByPath(made.path);
		if (file instanceof TFile) {
			// The block is already created, nested and selected, so a failure to open it in the
			// editor is reported and the add still counts: rejecting here would skip the caller's
			// hidden-row Notice and explicit render for a node that is, in fact, in the tree.
			try {
				await deps.app.workspace.getLeaf(false).openFile(file);
				deps.app.workspace.getActiveViewOfType(MarkdownView)?.editor.setCursor({ line: 0, ch: 0 });
			} catch (error) {
				new Notice(`Atlas: the block was added, but opening it failed: ${describe(error)}`, ERROR_NOTICE_MS);
			}
		}
		return node;
	} finally {
		release();
	}
}
