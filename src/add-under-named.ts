import { App, Notice } from "obsidian";
import { CreateOnDiskDeps, ParentExistsDeps, acquireParentLock, createOnDisk, describe, parentExists } from "./create-and-nest";
import { openNameDialog } from "./name-dialog";
import { UnitRef, ViewNode } from "./types";

const ERROR_NOTICE_MS = 8000;
const CONFIRM_LABEL = "Add";

/** The two add-under kinds that ask for a name and create it on disk: File (`<name>.md` at the vault
 * root) and Module (`<name>/<name>.md`). PR-3.F2 (File) and PR-3.F3 (Module) were line-for-line
 * copies of each other; they share this one flow so a fix lands in both at once. Block (no name
 * dialog) and Folder (no disk write) stay in their own files. */
export type AddUnderNamedKind = "file" | "module";

/** What differs between the two kinds; everything else in `startAddUnderNamed` is shared. */
interface NamedKindSpec {
	/** The dialog's title prefix: "Add file under <parent>". */
	dialogTitle: string;
	/** The failure Notice's subject. File's is fixed; Module names the module once the dialog has
	 * resolved a name (G9, R2), and falls back to the generic wording before one exists. */
	failSubject(name: string | null): string;
	/** Module flushes `data.json` after the add (R1) and says so if that write fails; File doesn't. */
	savedNotice: ((name: string, error: unknown) => string) | null;
}

const SPECS: Record<AddUnderNamedKind, NamedKindSpec> = {
	file: {
		dialogTitle: "Add file under",
		failSubject: () => "a file here",
		savedNotice: null,
	},
	module: {
		dialogTitle: "Add module under",
		failSubject: (name) => (name ? `module "${name}" here` : "a module here"),
		savedNotice: (name, error) => `Atlas: the module "${name}" was created, but saving the views failed: ${describe(error)}`,
	},
};

/** The deps for File and Module add-under. Reuses PR-1.S1's shared create-and-hold foundation
 * (`createOnDisk`, `acquireParentLock`, `parentExists` — all from `create-and-nest.ts`) and
 * Create's own name dialog (`openNameDialog`), but never copies `createFromMeta`'s replace-in-place
 * step: the clicked row stays exactly where it is, and the new item becomes its child instead. */
export interface AddUnderNamedDeps extends CreateOnDiskDeps, ParentExistsDeps {
	app: App;
	getExcludedFolders(): string[];
	/** The clicked row's own displayed label, right now — a Folder's `label`, or the same resolved
	 * text its row currently shows (basename, or a free block's title/first line). Used verbatim in
	 * the dialog's title ("Add file under <parent>"); computed fresh rather than cached, so a
	 * rename that happened since the row last rendered is still reflected. */
	getParentLabel(viewId: string, parentId: string): Promise<string>;
	/** `ViewsManager.placeNewUnit` — nests `ref` as a brand-new node, always the clicked row's last
	 * child, and returns it, or `null` only if the view itself is gone (not expected mid-flow, but
	 * handled the same way as a vanished parent: a Notice, no node). Deliberately not `placeUnit`:
	 * that moves an *existing* node sharing the same ref instead of creating a new one, which for a
	 * freshly created item could silently relocate an unrelated node elsewhere in the view —
	 * including a greyed missing row whose file is gone but whose node lingers (missing refs are never
	 * auto-removed), or an ancestor of the clicked row, which would splice that ancestor into its own
	 * descendant's children and create a cycle. */
	placeNewUnit(viewId: string, ref: UnitRef, parentId: string): ViewNode | null;
	/** Expands the clicked row so the new child is visible without a further click. */
	expandParent(viewId: string, parentId: string): void;
	/** Replaces the current bucket selection with exactly the new node's id (E5). */
	selectOnly(nodeId: string): void;
	/** Module only: writes data.json now, so a reload right after the add can't lose the new node
	 * (R1). A rejection is caught and shown as its own Notice — the module and its node are never
	 * rolled back for a save failure; only the write to disk failed, not the add itself. File never
	 * calls it. */
	save?(): Promise<void>;
}

/** G2/G3/E1/E2/E4/E5/E6/F5: takes the same per-parent lock every add-under kind shares
 * (`viewId:parentId`), checks the parent still exists before the name dialog opens and again
 * immediately before creating anything on disk and before nesting (E4 — `placeNewUnit`'s own silent
 * fallback to the view root must never be reachable from here), then — once the dialog resolves a
 * name (Cancel/Escape/close resolve `null`, G8/E1) — creates the item via the shared `createOnDisk`
 * (`<name>.md`, or `<name>/<name>.md` for a module; body `# <name>` either way), nests it as the
 * clicked row's last child, expands the parent and selects the new row. Never opens the new item
 * and never replaces or moves the clicked row (F5). The dialog opens empty with an explicit `full`
 * validation mode and reads "Add" instead of "Create".
 *
 * Resolves to the new node on success, or `null` on a held lock, cancel, or any failure — the lock
 * is released on every path (including a thrown error), the inbox hold is released on every path
 * after the disk create, and the selection is left untouched by every failing path. */
export async function startAddUnderNamed(kind: AddUnderNamedKind, deps: AddUnderNamedDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	const spec = SPECS[kind];
	const fail = (reason: string, extra = "", name: string | null = null): void => {
		new Notice(`Atlas: couldn't add ${spec.failSubject(name)}: ${reason}${extra}`, ERROR_NOTICE_MS);
	};

	const release = acquireParentLock(viewId, parentId, true);
	if (!release) return null;
	try {
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		const parentLabel = await deps.getParentLabel(viewId, parentId);
		const name = await openNameDialog(deps.app, {
			title: `${spec.dialogTitle} ${parentLabel}`,
			confirmLabel: CONFIRM_LABEL,
			initialValue: "",
			mode: "full",
			poolFolder: deps.getPoolFolder(),
			excludedFolders: deps.getExcludedFolders(),
		});
		if (name === null) return null;

		// The parent may have gone while the dialog was open.
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists", "", name);
			return null;
		}
		const made = await createOnDisk(deps, kind, name);
		if (!made.ok) {
			fail(made.reason, made.leftover, name);
			return null;
		}

		// The parent may have gone while the disk step ran (a data sync): don't leave an orphan
		// behind, and never let `placeNewUnit` silently fall back to the view root.
		if (!parentExists(deps, viewId, parentId)) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover, name);
			return null;
		}
		// `deps.placeNewUnit` is `ViewsManager.placeNewUnit` in production — synchronous and never
		// throws — but a test double (or a future caller) could; treating a thrown error the same
		// as a null return keeps the rollback/release path the one thing every failure after
		// create goes through, so the new item is never left behind unplaced.
		let node: ViewNode | null;
		try {
			node = deps.placeNewUnit(viewId, made.ref, parentId);
		} catch {
			node = null;
		}
		if (!node) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover, name);
			return null;
		}
		// The unit stays held through the nest and is released right after it, so any redraw (the
		// release tells the index's listeners) sees the new node and the unit together, never the
		// unit while it's still unplaced (E7 — the new item must never flash into the Inbox).
		made.release();
		deps.expandParent(viewId, parentId);
		deps.selectOnly(node.id);
		// The add itself has already succeeded — the item is on disk and nested — so a save failure
		// here is reported, not rolled back.
		if (spec.savedNotice && deps.save) {
			try {
				await deps.save();
			} catch (error) {
				new Notice(spec.savedNotice(name, error), ERROR_NOTICE_MS);
			}
		}
		return node;
	} finally {
		release();
	}
}
