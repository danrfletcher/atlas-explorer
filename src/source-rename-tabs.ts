import { isSameOrUnder, SOURCES_FOLDER } from "./sources-path";
import { rewritePathString } from "./types";

/** The part of an Obsidian leaf this needs. */
export interface RenameTabLeaf {
	view?: { save?: () => Promise<void> } | null;
	getViewState(): { type: string; state?: Record<string, unknown> | undefined; [key: string]: unknown };
	setViewState(state: { type: string; state?: Record<string, unknown> | undefined; [key: string]: unknown }): Promise<void>;
}

export interface RenameTabsDeps {
	iterateLeaves: (visit: (leaf: RenameTabLeaf) => void) => void;
	/** Whether the vault's index holds this path yet. */
	isIndexed: (path: string) => boolean;
	/** Resolves once `paths` are all indexed, or after `timeoutMs`, whichever is first. Event-driven (the vault's
	 * `create` events), never a fixed wait. */
	whenIndexed: (paths: string[], timeoutMs: number) => Promise<void>;
	/** A new tab, for a file whose own tab Obsidian closed when the file vanished. */
	openLeaf: () => RenameTabLeaf;
}

/** How long to wait for Obsidian to index `Sources/<new>/…` before reopening what it can. */
export const REOPEN_TIMEOUT_MS = 10_000;

interface CapturedTab {
	leaf: RenameTabLeaf;
	state: ReturnType<RenameTabLeaf["getViewState"]>;
	oldPath: string;
	newPath: string;
}

/**
 * PR-11 (G4): the tabs open on `Sources/<old>/…` when a source is renamed. Before the link swap every such tab's
 * view is told to save (so a pending editor write reaches the file while it still has its old path), and each
 * tab's state is remembered. After the swap, once Obsidian has indexed the new paths, each tab is pointed at the
 * same file under `Sources/<new>/…`: in place when its leaf survived the delete, in a new tab when Obsidian closed
 * it. Nothing here writes file content itself, and a tab whose new file never appears is left alone.
 */
export async function captureRenameTabs(deps: RenameTabsDeps, oldName: string, newName: string): Promise<() => void> {
	const oldPrefix = `${SOURCES_FOLDER}/${oldName}`;
	const newPrefix = `${SOURCES_FOLDER}/${newName}`;
	const tabs: CapturedTab[] = [];
	const saves: Array<Promise<void>> = [];
	deps.iterateLeaves((leaf) => {
		const state = leaf.getViewState();
		const file = state.state?.file;
		if (typeof file !== "string" || !isSameOrUnder(file, oldPrefix)) return;
		tabs.push({ leaf, state, oldPath: file, newPath: rewritePathString(file, oldPrefix, newPrefix) });
		const save = leaf.view?.save;
		if (typeof save === "function") saves.push(save.call(leaf.view).catch((error: unknown) => console.error("[Atlas] couldn't save a tab before the source was renamed", error)));
	});
	await Promise.all(saves);
	if (tabs.length === 0) return () => undefined;
	return () => {
		void reopen(deps, tabs);
	};
}

async function reopen(deps: RenameTabsDeps, tabs: CapturedTab[]): Promise<void> {
	await deps.whenIndexed(
		tabs.map((tab) => tab.newPath),
		REOPEN_TIMEOUT_MS
	);
	const alive = new Set<RenameTabLeaf>();
	deps.iterateLeaves((leaf) => alive.add(leaf));
	for (const tab of tabs) {
		if (!deps.isIndexed(tab.newPath)) continue;
		try {
			const leaf = alive.has(tab.leaf) ? tab.leaf : deps.openLeaf();
			await leaf.setViewState({ ...tab.state, state: { ...tab.state.state, file: tab.newPath } });
		} catch (error) {
			console.error(`[Atlas] couldn't reopen ${tab.oldPath} at ${tab.newPath}`, error);
		}
	}
}
