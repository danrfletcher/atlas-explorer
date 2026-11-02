import { App, Notice } from "obsidian";
import { TextPromptModal } from "./modals";
import { ParentExistsDeps, acquireParentLock, parentExists } from "./create-and-nest";
import { ViewNode } from "./types";

const ERROR_NOTICE_MS = 8000;

/** PR-2.F2 (G4): the one add-under kind that writes nothing to disk — a meta node, appended as the
 * clicked row's last child. `addMetaFolder`, `expandParent` and `selectOnly` are the view's own data
 * and selection calls, lifted to plain functions so this flow needs neither `ViewsManager` nor any
 * Obsidian render state directly — a test can drive it against a real `ViewsManager` with plain spies
 * for the other two. */
export interface AddUnderFolderDeps extends ParentExistsDeps {
	app: Pick<App, "workspace"> | App;
	/** `ViewsManager.addMetaFolder` — null only if the view itself is gone (not expected mid-flow,
	 * but handled the same way as a vanished parent: a Notice, no node). */
	addMetaFolder(viewId: string, parentId: string, label: string): ViewNode | null;
	/** Expands the clicked row so the new child is visible without a further click (G4). */
	expandParent(viewId: string, parentId: string): void;
	/** Replaces the current bucket selection with exactly the new node's id (E5). */
	selectOnly(nodeId: string): void;
	/** Registers the open label prompt with the view, so closing the view can close it (a modal
	 * belongs to the app, not the leaf). Closing it resolves the flow as a cancel. The returned
	 * function un-registers it once the prompt has settled. */
	trackPrompt(prompt: { close(): void }): () => void;
}

function fail(reason: string): void {
	new Notice(`Atlas: couldn't add a folder here: ${reason}`, ERROR_NOTICE_MS);
}

/** Opens the same label prompt the toolbar's "Add folder" uses, resolving to the typed value on
 * submit (whatever it is, even "" or whitespace-only — `addMetaFolder` owns the "New folder"
 * fallback) or `null` on cancel (Esc, the close button, Cancel, or the view closing underneath it). */
function promptForLabel(app: App, trackPrompt: AddUnderFolderDeps["trackPrompt"]): Promise<string | null> {
	return new Promise((resolve) => {
		let untrack: () => void = () => {};
		const prompt = new TextPromptModal(
			app,
			"New folder",
			"New folder",
			(label) => {
				untrack();
				resolve(label);
			},
			"",
			() => {
				untrack();
				resolve(null);
			}
		);
		untrack = trackPrompt(prompt);
		prompt.open();
	});
}

/** PR-2.F2 (G4/E1/E4/E5/E6): "Add under… > Folder" on the clicked row. Takes the same per-parent
 * lock Create and every other add-under kind share (`viewId:parentId`), checks the parent still
 * exists before the prompt opens and again immediately before nesting (E4 — `addMetaFolder`'s own
 * silent fallback to the view root must never be reachable from here), then expands the parent and
 * selects the new row on success. Resolves to the new node on success, or `null` on a held lock,
 * cancel, or any failure — the lock is released on every path. */
export async function startAddUnderFolder(deps: AddUnderFolderDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	const release = acquireParentLock(viewId, parentId, true);
	if (!release) return null;
	try {
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		const label = await promptForLabel(deps.app as App, deps.trackPrompt);
		if (label === null) return null;
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		const node = deps.addMetaFolder(viewId, parentId, label);
		if (!node) {
			fail("the parent no longer exists");
			return null;
		}
		deps.expandParent(viewId, parentId);
		deps.selectOnly(node.id);
		return node;
	} finally {
		release();
	}
}
