import type { MetadataCache, TAbstractFile, Vault } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { McpTool } from "./mcp-protocol";
import { resolveViewForWrite, vaultIdentity, viewIdentity } from "./mcp-status-tools";
import { UnitIndex } from "./unit-index";
import { UnitRef, View, ViewNode, nodeHoldsLiveDataSource, unitRefsEqual, unitToRef } from "./types";
import { ViewsManager } from "./views";

/**
 * PR-3.F1: the five arranging MCP tools — `add_node`, `move_node`, `remove_node`, `create_folder`,
 * `rename_folder`. Every one of these is a thin wrapper around an existing `ViewsManager` method
 * (`placeUnit`, `moveNode`, `unplaceNode`, `addMetaFolder`, `renameMetaFolder`) — the same methods
 * the explorer's own drag-and-drop and context menus already call — plus the vault-path and
 * meta/real-folder validation the spec's fence (F2/F3) requires before any of them run. None of
 * these tools ever calls `app.vault.create`/`rename`/`createFolder`/`delete`, or edits file
 * content: `resolveVaultPathToRef` below only ever *reads* via `Vault.getAbstractFileByPath`, and
 * every `ViewsManager` method called from here only ever mutates the in-memory view tree and saves
 * through its own normal `save()` path (`persist()` + `notifyChange()`).
 *
 * Every handler here is a plain, synchronous function (no internal `await`) — exactly like
 * `set_node_status`'s own handler already is. That is what makes two concurrent arranging calls
 * serialize rather than interleave (the E8/E8-follow-on rule) and what makes a reply that lands in
 * the same instant as an unrelated vault rename see the rename's effect rather than a stale one
 * (GP7): Node's single-threaded event loop can never pause a synchronous handler partway through
 * to run `ViewsManager.onVaultRename` (also fully synchronous, registered as a plain `vault.on`
 * callback) — whichever of the two was scheduled first always finishes first.
 */

export interface McpArrangeToolsContext {
	getViewsManager: () => ViewsManager;
	/** Q5: every reply names the vault this server is attached to, matching the read/status tools. */
	getVaultName: () => string;
	getVaultPath: () => string;
	/** G4: the one piece of real vault knowledge `add_node` needs — read-only, never a write method. */
	getVault: () => Pick<Vault, "getAbstractFileByPath">;
	/** R4 review: `add_node` must validate a resolved path against the plugin's own unit
	 * classification, not just "exists on disk" (`resolveVaultPathToRef` only ever checks the
	 * latter). `isExcludedPath`/`isInterfaceNoteFile` are the same rules `UnitIndex` itself applies
	 * when deciding what counts as a unit at all. */
	getUnitIndex: () => Pick<UnitIndex, "getUnits" | "isExcludedPath" | "isInterfaceNoteFile">;
	/** R4 review: validates a block reference's subpath against the file's own heading/block cache,
	 * so a `#subpath` that doesn't actually exist in the file is refused rather than placed as a
	 * row that only ever renders "(missing)". */
	getMetadataCache: () => Pick<MetadataCache, "getFileCache">;
	/** R4 review: promotes a module-internal file/folder/block that merely hasn't been promoted yet
	 * — the exact same thing the UI's own "Promote and place in view…" does (`addManualPromotion` +
	 * persist), never touching disk. */
	promoteUnit: (ref: UnitRef) => void;
	/** R3 review: clears a removed node's device-local source state (its `ApiHeadersStore` headers
	 * and/or `FolderSourcePathStore` Outside-Vault path) — the same thing the explorer's own
	 * "Remove from view" does for a sourced row, so a token or Outside path never lingers under a
	 * dead node id. */
	forgetDeviceLocalSourceState: (nodeId: string) => void;
}

/** E3/E9-style: a node id argument (parent or target) that doesn't resolve in the named view. */
export class McpArrangeNodeNotFoundError extends Error {}
/** E9: a vault path `add_node` was given that doesn't resolve to any file or folder at all. */
export class McpUnitNotFoundError extends Error {}
/** G4: a vault path that does exist, but not as the kind the caller said (or implied) it was. */
export class McpWrongUnitKindError extends Error {}
/** R5 review: an Outside-Vault-managed row named as a target or parent — the UI's own drag-and-drop
 * never drags one of these rows and never accepts a drop onto one, and neither can these tools. */
export class McpOutsideManagedError extends Error {}

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${toolName} requires a "${key}" argument (a non-empty string).`);
	}
	return value;
}

function requireNonBlankString(args: Record<string, unknown>, key: string, toolName: string): string {
	const value = requireString(args, key, toolName);
	if (value.trim().length === 0) {
		throw new Error(`${toolName} requires a non-empty, non-whitespace "${key}" argument.`);
	}
	return value;
}

/** `null`/omitted both mean "the view root" throughout this file — a present-but-wrong-typed value
 * is a schema error (wrong type), never silently coerced. */
function optionalNodeId(args: Record<string, unknown>, key: string, toolName: string): string | null {
	const value = args[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${toolName}: "${key}" must be a string node id, or null/omitted for the view root.`);
	}
	return value;
}

function optionalIndex(args: Record<string, unknown>, toolName: string): number {
	const value = args.index;
	// No "index" argument means "append at the end" — `ViewsManager.moveNode`'s own clamp
	// (`Math.max(0, Math.min(index, targetChildren.length))`) turns this into exactly that.
	if (value === undefined) return Number.MAX_SAFE_INTEGER;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${toolName}: "index" must be a finite number when given.`);
	}
	return value;
}

function optionalKindHint(args: Record<string, unknown>, toolName: string): "file" | "folder" | "block" | undefined {
	const value = args.kind;
	if (value === undefined) return undefined;
	if (value === "file" || value === "folder" || value === "block") return value;
	throw new Error(`${toolName}: "kind" must be one of "file", "folder" or "block" when given.`);
}

/** G4: fails outright (E3-style, distinct from `McpUnitNotFoundError`/`McpWrongUnitKindError`) for
 * a `parentNodeId`/`newParentId` that doesn't resolve in `view` — `ViewsManager.placeUnit`/
 * `addMetaFolder` would otherwise silently fall back to the view root for exactly this case
 * (`parentId ? this.findNode(...) : null` — a *found* `null` and a *not-found* lookup both take the
 * "no parent" branch), which is the specific silent-misplacement bug this check exists to prevent.
 *
 * R5 review: also refuses a parent that *does* exist but is an Outside-Vault-managed row — the
 * explorer's own drag-and-drop never accepts a drop onto one of these, and neither can add_node,
 * move_node or create_folder. */
function requireParentExists(viewsManager: ViewsManager, view: { id: string; name: string }, parentNodeId: string | null, toolName: string, argName: string): void {
	if (parentNodeId === null) return;
	if (!viewsManager.getNode(view.id, parentNodeId)) {
		throw new McpArrangeNodeNotFoundError(`${toolName}: no node with id "${parentNodeId}" (the "${argName}" argument) was found in view "${view.name}".`);
	}
	if (viewsManager.isOutsideManagedNode(view.id, parentNodeId)) {
		throw new McpOutsideManagedError(
			`${toolName}: node "${parentNodeId}" (the "${argName}" argument) is an Outside-Vault-managed row in view "${view.name}" — the UI never nests anything onto one of these, and neither can ${toolName}.`
		);
	}
}

function splitBlockPath(path: string): { base: string; subpath: string } | null {
	const hash = path.indexOf("#");
	if (hash < 0) return null;
	return { base: path.slice(0, hash), subpath: path.slice(hash + 1) };
}

/**
 * G4: resolves a vault path string to a `UnitRef`, the way `add_node` must before ever calling
 * `ViewsManager.placeUnit` — via `Vault.getAbstractFileByPath` (or, for a `path#subpath` block
 * reference, the same lookup against the base path). Throws `McpUnitNotFoundError` (E9) for a path
 * that resolves to nothing at all, or `McpWrongUnitKindError` for a path that does resolve but not
 * as `kindHint` says (when given) — e.g. `kind: "file"` against a path that is actually a folder,
 * or a `path#subpath` block reference whose base path is a folder rather than a file.
 *
 * Deliberately stops at "does this exist on disk" — it never decides whether the result is an
 * actual *Atlas unit* (a vault-root folder, a promoted/linked file, folder or block). That decision
 * is `ensurePlaceableUnit`'s job (R4 review), run separately so this function's own existing tests
 * and contract (a bare `UnitRef`, nothing else) stay unchanged.
 */
export function resolveVaultPathToRef(vault: Pick<Vault, "getAbstractFileByPath">, path: string, kindHint?: "file" | "folder" | "block"): UnitRef {
	const split = splitBlockPath(path);
	const basePath = split ? split.base : path;
	const file = vault.getAbstractFileByPath(basePath);
	if (!file) {
		throw new McpUnitNotFoundError(`No vault unit exists at path "${path}". Create it with the Obsidian CLI first, then retry add_node.`);
	}
	if (split) {
		if (!(file instanceof TFile)) {
			throw new McpWrongUnitKindError(`Path "${path}" names a folder, not a file — a block reference needs a file as its base path.`);
		}
		if (kindHint !== undefined && kindHint !== "block") {
			throw new McpWrongUnitKindError(`Path "${path}" names a block (it has a "#" subpath), not a "${kindHint}" as given.`);
		}
		return { kind: "block", path: basePath, subpath: split.subpath };
	}
	const actualKind: "file" | "folder" = file instanceof TFolder ? "folder" : "file";
	if (kindHint !== undefined && kindHint !== actualKind) {
		throw new McpWrongUnitKindError(`Path "${path}" is a ${actualKind}, not a "${kindHint}" as given.`);
	}
	return actualKind === "folder" ? { kind: "folder", path: basePath } : { kind: "file", path: basePath };
}

function isKnownUnit(unitIndex: Pick<UnitIndex, "getUnits">, ref: UnitRef): boolean {
	return unitIndex.getUnits().some((unit) => unitRefsEqual(unitToRef(unit), ref));
}

/** R4 review: a block reference's subpath actually has to resolve against the file's own cached
 * headings/blocks — unlike a resolved link (which Atlas already trusts without re-checking the
 * subpath, see `UnitIndex.computePromotions`), an agent-typed `#subpath` has no link behind it to
 * have already been resolved once. `^id` block references are matched the same lower-cased way
 * `display-text.ts` matches them; a heading reference is matched by trimmed, case-insensitive text,
 * the same tolerance Obsidian's own heading-link resolution applies. */
function blockSubpathExists(metadataCache: Pick<MetadataCache, "getFileCache">, file: TFile, subpath: string): boolean {
	const cache = metadataCache.getFileCache(file);
	if (!cache) return false;
	if (subpath.startsWith("^")) {
		return Boolean(cache.blocks?.[subpath.slice(1).toLowerCase()]);
	}
	const needle = subpath.trim().toLowerCase();
	return Boolean(cache.headings?.some((heading) => heading.heading.trim().toLowerCase() === needle));
}

/**
 * R4 review: decides whether a path `add_node` just resolved to `ref` (via `resolveVaultPathToRef`)
 * is actually placeable — "exists on disk" is not the same thing as "is an Atlas unit". A file or
 * folder that exists but is not a unit still renders as a normal row (`ExplorerView.resolveRef` goes by
 * presence), but a block ref that is not a unit renders a permanently-greyed "(missing)" row, and this
 * tool promotes eagerly rather than leave a non-unit ref placed. Returns whether `ref` still needs promoting (the caller
 * promotes it itself, see the R10 note below) — it never promotes anything by itself. Three
 * outcomes:
 *   - `ref` is already a recognised Atlas unit (`UnitIndex.getUnits()`) — returns `false`, nothing
 *     more to do.
 *   - `ref` names a module-internal file/folder that merely hasn't been promoted yet, or a block
 *     reference whose subpath genuinely resolves to a heading/block in its file — returns `true`;
 *     eligible for the same manual promotion "Promote and place in view…" performs
 *     (`UnitIndex.addManualPromotion` + persist, never touching disk), but not yet applied.
 *   - `ref` is one of the cases the UI's own "Promote and place" can never reach in the first
 *     place — the vault root, a folder's own interface note (AGENTS.md: not a unit ref), a path
 *     inside an excluded folder, or a block reference whose subpath doesn't exist — refused
 *     outright (throws).
 *
 * R9 review: the vault-root/interface-note/excluded-folder refusals used to run only on the
 * non-block path, below an early `return` for `ref.kind === "block"` — a block reference inside an
 * excluded folder (or whose base file is an interface note) skipped all three checks entirely and
 * fell straight through to promotion. Excluded folders never promote (AGENTS.md), for any unit
 * kind, so these checks now run first, before the kind split, and apply to a block ref's base path
 * exactly as they do to a file or folder path.
 *
 * R10 review: this function itself must never call `ctx.promoteUnit` — a promotion
 * (`addManualPromotion` + persist) is permanent, but `placeUnit` can still refuse afterward (the R1
 * cycle guard), and an agent whose add_node call errors out must never see data.json changed anyway.
 * The caller only calls `ctx.promoteUnit` once `placeUnit` has actually returned a node.
 */
function ensurePlaceableUnit(ctx: McpArrangeToolsContext, file: TAbstractFile, ref: UnitRef): boolean {
	const unitIndex = ctx.getUnitIndex();
	if (isKnownUnit(unitIndex, ref)) return false;

	if (file instanceof TFolder && file.isRoot()) {
		throw new McpWrongUnitKindError(`add_node: the vault root is not a vault unit.`);
	}
	if (file instanceof TFile && unitIndex.isInterfaceNoteFile(file)) {
		throw new McpWrongUnitKindError(
			`add_node: "${ref.path}" is its folder's interface note, not a unit of its own — add_node the containing module (folder) instead.`
		);
	}
	if (unitIndex.isExcludedPath(ref.path)) {
		throw new McpWrongUnitKindError(`add_node: "${ref.path}" is inside an excluded folder and is never a vault unit.`);
	}

	if (ref.kind === "block") {
		if (!(file instanceof TFile) || !blockSubpathExists(ctx.getMetadataCache(), file, ref.subpath)) {
			throw new McpUnitNotFoundError(
				`add_node: "${ref.path}#${ref.subpath}" does not resolve to an existing heading or block in that file.`
			);
		}
	}

	// Not yet a recognised unit, but eligible: the same manual promotion the UI's own "Promote and
	// place in view…" (Module Contents modal) performs for exactly this case — never touches disk.
	// Left to the caller to actually apply, once placement itself is confirmed to succeed (R10).
	return true;
}

/** The live children array a node currently sits in — `view.root` for the view root, or the live
 * `ViewNode.children` array of whichever node `parentId` names. Used only to read back a node's
 * *actual* post-move position (R7 review), never to mutate. */
function childrenOf(viewsManager: ViewsManager, view: View, parentId: string | null): ViewNode[] {
	if (parentId === null) return view.root;
	return viewsManager.getNode(view.id, parentId)?.children ?? view.root;
}

const PARENT_NODE_ID_SCHEMA = { type: ["string", "null"] } as const;

/** G4/GP1/GP3/E9: places an existing vault unit (file, block or module/folder) under a parent node
 * (or the view root) in a named view. Never creates anything — a path absent from the vault, or a
 * `parentNodeId` absent from the view, is refused outright (E9 and its follow-on). R4 review:
 * additionally refused if the path exists on disk but isn't an Atlas unit and isn't eligible for
 * promotion (`ensurePlaceableUnit`). R1 review: refused if placing would create a cycle — `ref` is
 * already placed as some node X and `parentNodeId` names X itself or one of X's descendants, which
 * would otherwise splice X out of the tree and lose it. R2 review: the returned `nodeId` is the
 * node `placeUnit` itself just moved or created, never a second, possibly-wrong `findUnitNode`
 * walk over a view that may hold more than one placement of the same ref (PR 13).
 *
 * R10 review: `ensurePlaceableUnit` only decides and validates whether `ref` is eligible for manual
 * promotion — it no longer calls `ctx.promoteUnit` itself. The actual promotion only happens below,
 * after `placeUnit` has returned an actual node, so a call refused by the R1 cycle guard (or any
 * other `placeUnit` refusal) never leaves behind a permanent manual promotion the agent was never
 * told about. */
export function createAddNodeTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "add_node",
		description:
			'Places an existing vault unit (file, block or module/folder) under a parent node (or the view root when "parentNodeId" is omitted/null) in a named view. ' +
			'"path" must already exist in the vault as an actual Atlas unit (or be eligible for automatic promotion, like a module-internal file) — create it with the Obsidian CLI ' +
			'first; add_node never creates, renames or moves a real file. "kind" ("file"/"folder"/"block") is an optional hint that is checked against the path\'s actual kind, never trusted blindly.',
		inputSchema: {
			type: "object",
			properties: {
				view: { type: "string" },
				path: { type: "string" },
				kind: { type: "string", enum: ["file", "folder", "block"] },
				parentNodeId: PARENT_NODE_ID_SCHEMA,
			},
			required: ["view", "path"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "add_node");
			const path = requireString(args, "path", "add_node");
			const kindHint = optionalKindHint(args, "add_node");
			const parentNodeId = optionalNodeId(args, "parentNodeId", "add_node");
			requireParentExists(viewsManager, view, parentNodeId, "add_node", "parentNodeId");

			const ref = resolveVaultPathToRef(ctx.getVault(), path, kindHint);
			const file = ctx.getVault().getAbstractFileByPath(ref.path);
			if (!file) {
				// Unreachable in practice — resolveVaultPathToRef above just resolved this same path.
				throw new McpUnitNotFoundError(`add_node: "${ref.path}" could not be re-resolved — please report this.`);
			}
			const needsPromotion = ensurePlaceableUnit(ctx, file, ref);

			const node = viewsManager.placeUnit(view.id, ref, parentNodeId);
			if (!node) {
				throw new Error(
					`add_node: "${path}" is already placed in view "${view.name}" at or above "${parentNodeId}" — placing it there would nest it inside itself.`
				);
			}
			// R10 review: promote only now that placement is confirmed to have actually happened —
			// never before, so a refusal above never leaves a stray permanent manual promotion behind.
			if (needsPromotion) ctx.promoteUnit(ref);

			return { vault: vaultIdentity(ctx), view: viewIdentity(view), nodeId: node.id, ref, parentNodeId };
		},
	};
}

/** G5/F3: reparents or reorders an existing node (unit or meta) within one view via
 * `ViewsManager.moveNode` — arrangement only, never the drag-onto-module-icon disk move the
 * Obsidian UI offers elsewhere. An unknown `nodeId`/`newParentId` is refused as "not found" before
 * `moveNode` is even called (so the two cases get distinct messages); once both are confirmed to
 * exist, a `false` return from `moveNode` can only mean its own self-or-descendant guard fired.
 * R5 review: `nodeId` itself is refused up front if it names an Outside-Vault-managed row — the
 * explorer's own drag-and-drop never drags one of these. R7 review: the reply's `index` is the
 * node's actual position in its new parent after the move, not the (possibly out-of-range or
 * sentinel `Number.MAX_SAFE_INTEGER`) value the caller asked for. */
export function createMoveNodeTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "move_node",
		description:
			'Reparents or reorders an existing node (unit or meta/Atlas-only folder) within one view. "newParentId" (optional, null/omitted = view root) and "index" ' +
			'(optional, omitted = append at the end) match ViewsManager.moveNode\'s own semantics, including its out-of-range index clamp. Refuses moving a node into itself ' +
			"or its own descendant, and refuses an Outside-Vault-managed row as either the node or its new parent. Never touches the filesystem.",
		inputSchema: {
			type: "object",
			properties: {
				view: { type: "string" },
				nodeId: { type: "string" },
				newParentId: PARENT_NODE_ID_SCHEMA,
				index: { type: "number" },
			},
			required: ["view", "nodeId"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "move_node");
			const nodeId = requireString(args, "nodeId", "move_node");
			const newParentId = optionalNodeId(args, "newParentId", "move_node");
			const index = optionalIndex(args, "move_node");

			if (!viewsManager.getNode(view.id, nodeId)) {
				throw new McpArrangeNodeNotFoundError(`move_node: no node with id "${nodeId}" was found in view "${view.name}".`);
			}
			if (viewsManager.isOutsideManagedNode(view.id, nodeId)) {
				throw new McpOutsideManagedError(
					`move_node: node "${nodeId}" in view "${view.name}" is an Outside-Vault-managed row — the UI never drags one of these, and neither can move_node.`
				);
			}
			requireParentExists(viewsManager, view, newParentId, "move_node", "newParentId");

			const moved = viewsManager.moveNode(view.id, nodeId, newParentId, index);
			if (!moved) {
				throw new Error(`move_node: node "${nodeId}" cannot be moved into itself or its own descendant.`);
			}

			const node = viewsManager.getNode(view.id, nodeId)!;
			const actualIndex = childrenOf(viewsManager, view, newParentId).indexOf(node);
			return {
				vault: vaultIdentity(ctx),
				view: viewIdentity(view),
				nodeId,
				type: node.type,
				ref: node.ref ?? null,
				label: node.label ?? null,
				parentNodeId: newParentId,
				index: actualIndex,
			};
		},
	};
}

/** G5: removes exactly one node instance by id via `ViewsManager.unplaceNode` — its children lift
 * up one level into its old slot (the UI's own "Remove from view" behaviour), including
 * `unplaceNode`'s own `promotableChildren` filter for a Folder-source-owner's managed children. The
 * reply's `liftedChildIds` is only the subset of the removed node's own direct children that are
 * still findable in the view immediately afterward — a managed child `promotableChildren` dropped
 * along with its Outside-Vault owner is correctly absent from it, never misreported as "lifted".
 *
 * R3 review: also matches the UI's "Remove from view" in clearing a sourced node's device-local
 * state (its `ApiHeadersStore` headers and/or `FolderSourcePathStore` Outside-Vault path) before
 * unplacing it — otherwise a removed API/CSV/table/Folder-sourced node's bearer token or Outside
 * path would linger on the device under a dead node id. The reply's `sourceRemoved` says whether
 * this happened, standing in for the UI's own confirmation dialog for a sourced node. */
export function createRemoveNodeTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "remove_node",
		description:
			'Removes exactly one node instance by id from a view. Its children lift up one level into its old slot — matching "Remove from view" in the UI — never discarded ' +
			'silently. If the node holds a live data source (API, CSV, Markdown-table or Folder), its device-local headers and/or Outside-Vault path are cleared too, same as ' +
			'the UI\'s own "Remove from view" — the reply\'s "sourceRemoved" says whether this happened. Never touches the filesystem.',
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, nodeId: { type: "string" } },
			required: ["view", "nodeId"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "remove_node");
			const nodeId = requireString(args, "nodeId", "remove_node");

			const node = viewsManager.getNode(view.id, nodeId);
			if (!node) {
				throw new McpArrangeNodeNotFoundError(`remove_node: no node with id "${nodeId}" was found in view "${view.name}".`);
			}
			const directChildIds = node.children.map((c) => c.id);
			const sourceRemoved = nodeHoldsLiveDataSource(node);
			if (sourceRemoved) ctx.forgetDeviceLocalSourceState(nodeId);

			viewsManager.unplaceNode(view.id, nodeId);

			const liftedChildIds = directChildIds.filter((id) => viewsManager.getNode(view.id, id) !== null);
			return { vault: vaultIdentity(ctx), view: viewIdentity(view), removedNodeId: nodeId, liftedChildIds, sourceRemoved };
		},
	};
}

/** G6: creates an Atlas-only meta node (`ViewNode.type === "meta"`, no `ref`) via
 * `ViewsManager.addMetaFolder` under a named parent (or the view root). Never creates anything on
 * disk — a meta folder is a label, not a real folder. An empty/whitespace-only label is refused
 * before `addMetaFolder` is even called, rather than silently saved as its own "New folder"
 * fallback (which exists for a different caller — the UI's own "+ folder" button, which has no
 * label yet to validate against). R5 review: `parentNodeId` is refused the same way `add_node`'s
 * is if it names an Outside-Vault-managed row. */
export function createCreateFolderTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "create_folder",
		description:
			'Creates an Atlas-only meta folder (not a real folder on disk) under a named parent node (or the view root when "parentNodeId" is omitted/null), and returns its ' +
			"new node id. The label must be non-empty after trimming. Refuses an Outside-Vault-managed row as the parent.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, label: { type: "string" }, parentNodeId: PARENT_NODE_ID_SCHEMA },
			required: ["view", "label"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "create_folder");
			const label = requireNonBlankString(args, "label", "create_folder");
			const parentNodeId = optionalNodeId(args, "parentNodeId", "create_folder");
			requireParentExists(viewsManager, view, parentNodeId, "create_folder", "parentNodeId");

			const node = viewsManager.addMetaFolder(view.id, parentNodeId, label);
			if (!node) {
				throw new Error(`create_folder: view "${view.name}" could not be found when creating the folder — please report this.`);
			}

			return { vault: vaultIdentity(ctx), view: viewIdentity(view), nodeId: node.id, label: node.label };
		},
	};
}

/** G6: renames an existing meta node's label via `ViewsManager.renameMetaFolder`. Distinguishes
 * "node id not found in this view" from "node exists but is not a meta folder" — `renameMetaFolder`
 * itself returns `false` for both, so this tool looks the node up itself first to tell the two
 * apart. A `type: "unit"` target (a real file, block or module) is refused with a message pointing
 * at the Obsidian CLI, never silently coerced into a label edit — Atlas never renames a real file
 * or module folder on disk. */
export function createRenameFolderTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "rename_folder",
		description:
			'Renames an existing Atlas-only meta folder\'s label. Refused — pointing at the Obsidian CLI instead — if "nodeId" names a real file, block or module ' +
			"(type: \"unit\"); Atlas never renames anything on disk. The label must be non-empty after trimming.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, nodeId: { type: "string" }, label: { type: "string" } },
			required: ["view", "nodeId", "label"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "rename_folder");
			const nodeId = requireString(args, "nodeId", "rename_folder");
			const label = requireNonBlankString(args, "label", "rename_folder");

			const node = viewsManager.getNode(view.id, nodeId);
			if (!node) {
				throw new McpArrangeNodeNotFoundError(`rename_folder: no node with id "${nodeId}" was found in view "${view.name}".`);
			}
			if (node.type !== "meta") {
				throw new McpWrongUnitKindError(
					`rename_folder: node "${nodeId}" in view "${view.name}" is a unit (a real file, block or module), not an Atlas-only meta folder — rename it with the Obsidian CLI instead, not rename_folder.`
				);
			}

			const renamed = viewsManager.renameMetaFolder(view.id, nodeId, label);
			if (!renamed) {
				throw new Error(`rename_folder: node "${nodeId}" in view "${view.name}" could not be renamed — please report this.`);
			}

			return { vault: vaultIdentity(ctx), view: viewIdentity(view), nodeId, label: label.trim() };
		},
	};
}
