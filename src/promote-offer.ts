import { absolutePathOf, owningRoot, type SourceRootInfo } from "./source-roots";
import { SOURCES_FOLDER, isInSourcesFolder } from "./sources-path";
import { VAULT_SOURCE_NAME } from "./sources-links";

/**
 * PR-12 (G6, E10): where "Make its own source" and "Return to parent" are offered. Pure: the explorer asks, and
 * the menus, the drop gap and the promote action all use the same answer.
 *
 * Only a folder can be made a source: a file, a free block, a block, an API/Folder/Table/CSV data-source row and a
 * View (bucket) row never get it. A source's own top folder (a section header) can't be promoted again, nor can
 * the vault itself: neither is a folder row. A folder row is offered in an Inbox section and in Module Contents.
 */
export type PromoteRowKind = "folder" | "file" | "block" | "free-block" | "data-source" | "bucket-row" | "section-header";
export type PromoteSurface = "inbox" | "module-contents" | "view";

export interface PromoteRow {
	kind: PromoteRowKind;
	/** The row's vault path (a folder's own path). For a header, ignored. */
	path: string;
	surface: PromoteSurface;
}

export interface PromoteContext {
	/** Where each listed source sits (`computeSourceRoots`). */
	roots: readonly SourceRootInfo[];
	/** A path Atlas keeps out of its units (the pool folder, an excluded folder). */
	isExcluded?: (path: string) => boolean;
}

/**
 * Whether `row` may be made a source of its own: a folder row, in the Inbox or Module Contents, that is not a
 * source's root and lies inside a listed source or the vault proper. Whether Tephra is online is a separate
 * question (`promoteMenuState`): this one is about the row.
 */
export function canMakeOwnSource(row: PromoteRow, context: PromoteContext): boolean {
	if (row.kind !== "folder" || row.surface === "view") return false;
	const path = row.path;
	if (path === "" || path.startsWith("/") || path.endsWith("/")) return false;
	if (context.isExcluded?.(path)) return false;
	if (context.roots.some((root) => root.vaultPath === path)) return false; // a source's own top folder: already a source
	if (path === SOURCES_FOLDER) return false;
	if (isInSourcesFolder(path)) return owningRoot(path, context.roots) !== null; // `Sources/x` with no listed source owns it: nothing to promote out of
	return true; // a folder of the vault proper, or of a promoted vault folder
}

/** The source a folder would leave: its owning source's name, or the vault (`notes`). */
export function parentSourceOf(path: string, roots: readonly SourceRootInfo[]): string {
	return owningRoot(path, roots)?.name ?? VAULT_SOURCE_NAME;
}

/** The folder's absolute path on disk, for Tephra's `root`: the owning source's root plus the rest, or the vault's. */
export function promoteRootPath(path: string, roots: readonly SourceRootInfo[], vaultPath: string | null): string | null {
	const owned = absolutePathOf(path, roots);
	if (owned !== null) return owned;
	if (isInSourcesFolder(path) || vaultPath === null || vaultPath === "") return null;
	return `${vaultPath.replace(/\/+$/, "")}/${path}`;
}

/** "Return to parent" belongs to a promoted source's header only: not the vault's, not a top-level source's. */
export function canReturnToParent(sectionName: string | null, roots: readonly SourceRootInfo[]): boolean {
	if (sectionName === null || sectionName === VAULT_SOURCE_NAME) return false;
	return roots.some((root) => root.name === sectionName && root.parent !== null);
}

export interface PromoteMenuState {
	/** Shown in the menu. */
	offered: boolean;
	/** Shown but greyed out, with the "Tephra offline" tooltip (E1/G13). Never queued. */
	disabled: boolean;
}

/** The menu item's state: only an offered item is shown, and it is disabled while Tephra isn't answering. */
export function promoteMenuState(offered: boolean, tephraOnline: boolean): PromoteMenuState {
	return { offered, disabled: offered && !tephraOnline };
}

/**
 * Whether the gap between Inbox sections takes a drag: a single folder row that `canMakeOwnSource` allows, with
 * Tephra answering. A header, a file, a free block, a multi-item drag, a data-source row and a View row never
 * highlight it.
 */
export function gapTakesDrag(drag: { rows: readonly PromoteRow[] } | null, context: PromoteContext, tephraOnline: boolean): PromoteRow | null {
	if (!tephraOnline || drag === null || drag.rows.length !== 1) return null;
	const row = drag.rows[0];
	return canMakeOwnSource(row, context) ? row : null;
}
