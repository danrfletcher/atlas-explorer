import { getPromotedRoots, setPromotedRoots, type PromotedRootLike } from "./source-links";
import { computeSourceRoots, promotedRootsOf } from "./source-roots";
import type { TephraSource } from "./tephra-client";
import type { TephraSnapshot } from "./tephra-connection";

/**
 * PR-12 (G6): sets the promoted roots the resolver, the `[[` popup, the link text, Backlinks and the Inbox sections
 * read, from a source list. Returns true when they changed. The roots live in memory; the caller keeps the last ones in `settings.tephraPromotedRoots` (outside the views) for a start with Tephra down (R5).
 */
export function applyPromotedRoots(sources: readonly TephraSource[], vaultPath: string | null): boolean {
	const next = promotedRootsOf(computeSourceRoots([...sources], vaultPath));
	const before = getPromotedRoots();
	if (before.length === next.length && before.every((root, i) => root.name === next[i].name && root.vaultPath === next[i].vaultPath && root.absRoot === next[i].absRoot)) return false;
	setPromotedRoots(next);
	return true;
}

/** The connection a roots sync listens to. */
export interface PromotedRootsConnection {
	onChange(listener: (snapshot: TephraSnapshot) => void): () => void;
	onCheck(listener: (snapshot: TephraSnapshot) => void): () => void;
}

/**
 * Reads the promoted roots from every source list Tephra answers: after each finished check, changed or not, and on
 * each snapshot change (a `graph:changed` push, a promote or return made with `tephractl`, Tephra coming back).
 * Registered before anything that draws from them, so what is drawn already sees the new roots. A check that
 * found Tephra offline keeps the last roots: the sections stay as they were (PR-9). Returns the unsubscribe.
 */
export function bindPromotedRoots(connection: PromotedRootsConnection, options: { getVaultPath: () => string | null; onChanged: (roots: readonly PromotedRootLike[]) => void }): () => void {
	const sync = (snapshot: TephraSnapshot) => {
		if (snapshot.state === "online" && applyPromotedRoots(snapshot.sources, options.getVaultPath())) options.onChanged(getPromotedRoots());
	};
	const offChange = connection.onChange(sync);
	const offCheck = connection.onCheck(sync);
	return () => {
		offChange();
		offCheck();
	};
}
