import { TAbstractFile, TFile, TFolder } from "obsidian";
import { ApiItemState, FolderSourceConfig, PLACEHOLDER_ROW_KIND, UnitRef, ViewNode, unitRefKey } from "./types";
import { listOutsideChildren, resolveOutsidePath } from "./folder-source-outside";
import { matchesYamlRules, type YamlFilterRule } from "./folder-filter";

/** PR-1.S1: what a rule-filtered Folder source needs from the plugin to decide whether a file joins.
 * Frontmatter comes from `app.metadataCache` only, never from file content. */
export interface FolderFileFilterContext {
	/** False until `metadataCache` has resolved once (E10). Rule-filtered sources hold back new files
	 * until then, so no unfiltered rows flash at startup. */
	metadataResolved: boolean;
	frontmatterOf(file: TFile): unknown;
}

/** PR-1.F2: the rules a Folder source actually filters by. Empty-key rules are ignored, and none left
 * means the source is unfiltered. */
export function activeFolderRules(source: FolderSourceConfig): YamlFilterRule[] {
	return (source.filters?.files?.yaml?.rules ?? []).filter((rule) => rule.key.trim() !== "");
}

/** PR-1.F2 (G3): whether one vault file satisfies a source's rules. Non-notes fail any rule, since they
 * have no frontmatter. Frontmatter comes from the caller's `frontmatterOf`, which reads the metadata cache. */
export function fileMatchesFolderRules(
	file: TAbstractFile,
	rules: YamlFilterRule[],
	frontmatterOf: (file: TFile) => unknown
): boolean {
	if (!(file instanceof TFile) || file.extension !== "md") return false;
	return matchesYamlRules(frontmatterOf(file), rules);
}

/** G3/G8: the per-file predicate for a rule-filtered Folder source. `undefined` means the source is
 * unfiltered (no valid rule left), so every file passes exactly as before. */
function fileFilterFor(
	source: FolderSourceConfig,
	context: FolderFileFilterContext | undefined
): ((file: TAbstractFile) => boolean) | undefined {
	const rules = activeFolderRules(source);
	if (rules.length === 0) return undefined;
	return (file) => context?.metadataResolved === true && fileMatchesFolderRules(file, rules, context.frontmatterOf);
}

/** G3/G4: the direct children of `folder`, filtered independently by `showFiles`/`showFolders` —
 * both the simplest reading of "the target folder's children render... as real units" (direct
 * children only; a nested subfolder is its own real folder-unit, browsed via the normal module
 * pipeline rather than flattened in) and what keeps this function trivially pure/testable.
 * PR-1.S1: `fileFilter`, when given, decides which files join. Existing managed rows are not
 * affected, since `reconcileManagedChildren` keeps every one it already has. */
export function folderToRows(
	folder: TFolder,
	options: { showFiles: boolean; showFolders: boolean },
	fileFilter?: (file: TAbstractFile) => boolean
): UnitRef[] {
	const refs: UnitRef[] = [];
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			if (options.showFolders) refs.push({ kind: "folder", path: child.path });
		} else if (options.showFiles && (!fileFilter || fileFilter(child))) {
			refs.push({ kind: "file", path: child.path });
		}
	}
	return refs;
}

/** Edge case: "selecting a target folder that is an ancestor of, or identical to, the source
 * Folder's own location does not crash the explorer." Kept as a standalone pure function, not wired
 * into any live code path in this PR — a meta node (the only place `folderSource` ever lives) has no
 * disk path of its own to compare against, so there is nothing meaningful to call this with yet. */
export function isAncestorOrSelf(candidateAncestorPath: string, path: string): boolean {
	return path === candidateAncestorPath || path.startsWith(`${candidateAncestorPath}/`);
}

/** G7/G9/E2: reconciles a Folder source's current *direct* children against the folder's current
 * listing, touching only nodes this source itself manages (`folderSourceManaged`). Anything else
 * already in `existingChildren` (the user nesting something by hand alongside the managed rows) is
 * left alone and kept in place.
 *
 * - A managed child whose own kind (`file`/`folder`) is still enabled by `options` is always kept
 *   exactly where it is, whether or not its ref is still present in `desiredRefs` — reordering/
 *   nesting it by hand (G7) survives the next reconcile untouched, and refs to a since-deleted file
 *   are never auto-removed project-wide, left for `resolveRef`'s existing generic missing-ref
 *   fallback to render as a greyed row instead (G16/E1).
 * - A managed child whose kind is now toggled off is removed, lifting its own children up one level
 *   (same contract as any other removal in this codebase) — this is the one case reconcile actually
 *   drops a managed row, since it's a deliberate config change rather than a disk event.
 * - Anything in `desiredRefs` already matched by a kept managed child in `existingChildren` itself, or
 *   by `dedupe.managedElsewhere` (R1 fix — supplied by the caller from a whole-view scan, covering rows
 *   this source manages that have been dragged or nested elsewhere), or remembered as user-removed
 *   (`dedupe.removedRefs`), is skipped; everything else is appended as a new managed child. `dedupe`
 *   defaults to empty so callers that only ever deal with one flat array of direct children (e.g.
 *   existing tests) see no change in behavior. */
export function reconcileManagedChildren(
	existingChildren: ViewNode[],
	desiredRefs: UnitRef[],
	options: { showFiles: boolean; showFolders: boolean },
	makeNode: (ref: UnitRef) => ViewNode,
	dedupe: { managedElsewhere?: Set<string>; removedRefs?: Set<string> } = {}
): ViewNode[] {
	const managedElsewhere = new Set(dedupe.managedElsewhere ?? []);
	const removedRefs = dedupe.removedRefs ?? new Set<string>();
	const kept: ViewNode[] = [];
	for (const child of existingChildren) {
		if (child.folderSourceManaged && child.ref) {
			const kindEnabled = child.ref.kind === "folder" ? options.showFolders : options.showFiles;
			if (!kindEnabled) {
				kept.push(...child.children);
				continue;
			}
			managedElsewhere.add(unitRefKey(child.ref));
		}
		kept.push(child);
	}
	for (const ref of desiredRefs) {
		const key = unitRefKey(ref);
		if (managedElsewhere.has(key) || removedRefs.has(key)) continue;
		kept.push(makeNode(ref));
	}
	return kept;
}

/** R1 fix: collects the `unitRefKey` of every node anywhere in `nodes` (recursively, not just direct
 * children) that this specific Folder source (`sourceNodeId`) manages — wherever the user has since
 * moved, nested, or left it. `reconcileManagedChildren` uses this instead of only scanning its own
 * direct children, so a managed row that got dragged out of its source Folder or re-nested under
 * another child is recognized as "already placed" rather than duplicated. */
export function collectManagedRefKeys(nodes: ViewNode[], sourceNodeId: string): Set<string> {
	const keys = new Set<string>();
	const walk = (list: ViewNode[]): void => {
		for (const node of list) {
			if (node.folderSourceManaged && node.folderSourceOwnerId === sourceNodeId && node.ref) {
				keys.add(unitRefKey(node.ref));
			}
			walk(node.children);
		}
	};
	walk(nodes);
	return keys;
}

/** Minimal read-only surface this module needs from `Vault` — kept narrow so this stays pure/testable
 * without pulling in the real `obsidian` `Vault` class (which test fixtures stand in for anyway). */
export interface FolderSourceVaultLike {
	getAbstractFileByPath(path: string): unknown;
}

/** PR-5 (G6/G11/E8, R1/R2 fix): reconciles an Outside-Vault source's children against `outsidePath`
 * (the device-local absolute path — never `source.path`, which is meaningless while `location` is
 * "outside"). Same "leave stale rows alone while unresolved" contract Inside-Vault's R2 fix already
 * uses below: the spec's "render empty... reappear on recovery" is an `ExplorerView` render-time
 * concern (`isOutsideManagedAndUnresolved` skips these rows while the owning source doesn't resolve),
 * never a reason to touch the persisted tree. An unresolved path here is a no-op — it must never
 * delete a managed child (losing its `explicitStatusId`/collapsed state/manually-nested children and
 * handing the slot a brand-new id on recovery, R1) or write that deletion to a synced `data.json`
 * (R2: a missing local path on a second device must never change what device A already stored). */
function buildOutsideFolderChildren(
	outsidePath: string,
	source: FolderSourceConfig,
	existingChildren: ViewNode[],
	makeNode: (ref: UnitRef) => ViewNode,
	context: { sourceNodeId: string; viewRoot: ViewNode[] }
): ViewNode[] {
	if (!resolveOutsidePath(outsidePath)) return existingChildren;
	const desiredRefs = listOutsideChildren(outsidePath, source);
	const managedElsewhere = collectManagedRefKeys(context.viewRoot, context.sourceNodeId);
	const removedRefs = new Set(source.removedRefs ?? []);
	return reconcileManagedChildren(existingChildren, desiredRefs, source, makeNode, { managedElsewhere, removedRefs });
}

/** G16/E1: resolves `source.path` and reconciles `existingChildren` against it.
 *
 * - `location === "outside"` (PR-5): delegates to `buildOutsideFolderChildren` against the caller-
 *   supplied device-local `outsidePath` instead of `source.path` — same "leave existing managed rows
 *   alone while unresolved" contract as the Inside-Vault case below, just against a device-local path
 *   instead of a vault path; see that function's own doc comment for the R1/R2 reasoning.
 * - The target folder doesn't resolve (deleted/renamed away/never existed): if this source already
 *   has real managed rows from a previous, resolvable listing, they're left exactly as they are
 *   (R2 fix) — each one's own `ref` individually falls back to `resolveRef`'s existing generic
 *   missing-unit rendering (G16/E1), which already carries whatever explicit statuses, fold state, or
 *   hand-nested children they had, rather than being thrown away and rebuilt from nothing once the
 *   target resolves again. Only a source that has *never* resolved (no managed rows exist yet) gets a
 *   single folder-level sentinel row instead, so a brand-new unresolvable path still shows something
 *   rather than silently rendering nothing.
 * - The target folder resolves: ordinary reconciliation via `folderToRows`/`reconcileManagedChildren`,
 *   using `context` (R1 fix) to recognize a managed row that has moved anywhere else in the view, and
 *   `source.removedRefs` to never recreate one the user removed outright. */
export function buildFolderSourceChildren(
	vault: FolderSourceVaultLike,
	source: FolderSourceConfig,
	existingChildren: ViewNode[],
	makeNode: (ref: UnitRef) => ViewNode,
	context: { sourceNodeId: string; viewRoot: ViewNode[]; filter?: FolderFileFilterContext } = { sourceNodeId: "", viewRoot: existingChildren },
	outsidePath?: string
): ViewNode[] {
	if (source.location === "outside") return buildOutsideFolderChildren(outsidePath ?? "", source, existingChildren, makeNode, context);
	const target = vault.getAbstractFileByPath(source.path);
	if (!(target instanceof TFolder)) {
		if (existingChildren.some((child) => child.folderSourceManaged)) return existingChildren;
		const sentinelRef: UnitRef = { kind: "folder", path: source.path };
		return [...existingChildren, makeNode(sentinelRef)];
	}
	const desiredRefs = folderToRows(target, source, fileFilterFor(source, context.filter));
	const managedElsewhere = collectManagedRefKeys(context.viewRoot, context.sourceNodeId);
	const removedRefs = new Set(source.removedRefs ?? []);
	return reconcileManagedChildren(existingChildren, desiredRefs, source, makeNode, { managedElsewhere, removedRefs });
}

/** PR-6 (G12-G14): the one parameterized rule for how a Folder-source child's row reconciles,
 * given the source's *current* `mode` — called both at the moment the underlying file is deleted
 * (with `deletedRef` set, so the fresh entry carries a `noteRef` for PR-2's existing
 * noteRef-clearing sweep to immediately clear in append mode — genuine reuse, not a reimplemented
 * clear) and again on every later reconciliation pass over already-demoted rows (with `deletedRef`
 * omitted, so a dead link is never resurrected) — satisfying "mode is read at reconciliation time,
 * not delete time" for a mode switch that happens between the two.
 *
 * - "overwrite": no placeholder at all (G14) — `undefined` tells the caller to drop the row, or to
 *   never have created one.
 * - "merge": PR-2's exact stale-item shape (G12) — `notFound: true` plus the (frozen) `lastSeenAt`
 *   this rule was first applied with, so it renders through the identical "not found, last seen"
 *   code path as a stale API item, Remove included.
 * - "append": the row stays, with no `notFound` (G13) — `deletedRef` becomes `noteRef` only at the
 *   initial call so the existing clear-on-delete mechanism has something to clear; a later call
 *   (switched *into* append, or re-confirmed while already in it) passes none, in which case
 *   whatever `base.noteRef` already carries (e.g. manually re-attached via "Add note" since the
 *   delete) survives untouched rather than being wiped back to nothing (R1 fix).
 *
 * `base.explicitStatusId`/`secondary`/`position` (R1/R3 fixes: carried over from `ViewNode` or a
 * prior call's own result, same field name and meaning throughout) survive in both shapes
 * untouched, matching G13's "retains all other row data ... nothing else mutates." Every result
 * this rule produces is stamped `folderSourceDeleted: true` (R2 fix) so the sweep that reprocesses
 * it later can tell it apart from an unrelated, genuinely API/Table-sourced row that merely happens
 * to live in the same `apiItemState`. */
export function reconcileFolderSourceChildDelete(
	mode: "append" | "merge" | "overwrite",
	base: { id: string; label: string; lastSeenAt: string; explicitStatusId?: string; secondary?: string; noteRef?: UnitRef; position?: number },
	deletedRef?: UnitRef
): ApiItemState | undefined {
	if (mode === "overwrite") return undefined;
	if (mode === "merge") {
		return {
			id: base.id,
			label: base.label,
			kind: PLACEHOLDER_ROW_KIND,
			notFound: true,
			lastSeenAt: base.lastSeenAt,
			explicitStatusId: base.explicitStatusId,
			secondary: base.secondary,
			noteRef: base.noteRef,
			position: base.position,
			folderSourceDeleted: true,
		};
	}
	return {
		id: base.id,
		label: base.label,
		kind: PLACEHOLDER_ROW_KIND,
		noteRef: deletedRef ?? base.noteRef,
		lastSeenAt: base.lastSeenAt,
		explicitStatusId: base.explicitStatusId,
		secondary: base.secondary,
		position: base.position,
		folderSourceDeleted: true,
	};
}

/** PR-2 (R2-Q2): diffs an Outside-Vault source's managed refs against its current listing. Refs are
 * bare root-relative names, so a rename can only be recognised by what disappeared and what appeared.
 * A managed ref that is gone and a listed ref that is new, of the same kind, count as a rename only
 * when they are the sole such pair in that kind. Anything ambiguous (two renames at once, or a
 * rename alongside an unrelated add) is reported as a delete, and the add pass then creates the new
 * row, so the end state is still correct with no duplicate. `removedRefs` keeps a row the user removed
 * from coming back as an add. Callers pass only the kinds this source currently shows. */
export function diffOutsideChildren(
	managed: UnitRef[],
	listed: UnitRef[],
	removedRefs: ReadonlySet<string>
): { renamed: { from: UnitRef; to: UnitRef }[]; gone: UnitRef[] } {
	const managedKeys = new Set(managed.map(unitRefKey));
	const listedKeys = new Set(listed.map(unitRefKey));
	const gone = managed.filter((ref) => !listedKeys.has(unitRefKey(ref)));
	const added = listed.filter((ref) => {
		const key = unitRefKey(ref);
		return !managedKeys.has(key) && !removedRefs.has(key);
	});
	const renamed: { from: UnitRef; to: UnitRef }[] = [];
	const unpaired: UnitRef[] = [];
	for (const kind of ["file", "folder"] as const) {
		const goneOfKind = gone.filter((ref) => ref.kind === kind);
		const addedOfKind = added.filter((ref) => ref.kind === kind);
		if (goneOfKind.length === 1 && addedOfKind.length === 1) renamed.push({ from: goneOfKind[0], to: addedOfKind[0] });
		else unpaired.push(...goneOfKind);
	}
	return { renamed, gone: unpaired };
}

/** PR-1 (G5): the vault folder a path sits directly inside — `""` for a vault-root path. Pure string
 * work, so it answers "is this a direct child of that folder" for a path that no longer exists. */
export function parentFolderPath(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/** PR-6 (R3 fix): the display text a Folder-source child's row showed while its file still
 * existed — a file's bare basename with its extension stripped (matching how a real `unit` row
 * displays it before deletion), or the raw last path segment for a folder (nothing to strip).
 * Computed from the path string alone, since by the time this runs the file is already gone —
 * never from a live `TFile`/`TFolder`. */
export function basenameForDeletedRef(ref: UnitRef): string {
	const last = ref.path.split("/").pop() ?? ref.path;
	if (ref.kind !== "file") return last;
	const dot = last.lastIndexOf(".");
	return dot > 0 ? last.slice(0, dot) : last;
}
