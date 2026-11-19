import { isUsableSourceName, type TephraSource } from "./tephra-client";
import { normalizeRoot, selectTopLevelSources, VAULT_SOURCE_NAME } from "./sources-links";
import { sourceLinkPath } from "./sources-path";

/**
 * PR-12 (G6): where each listed Tephra source sits in the vault's path space.
 *
 * A top-level source is the target of one `Sources/<name>` folder link. A PROMOTED source (a folder made its own
 * source) gets no link of its own: it is a label for a folder inside its parent, at the parent's own path
 * (`Sources/tephra/crates/tephrad`, or `Projects/Atlas` for a vault folder). So its vault path is derived from
 * Tephra's absolute paths: the parent's vault path plus the folder's path relative to the parent's root.
 *
 * Tephra's `source.list` says nothing about "promoted"; Atlas reads it from the roots. Tephra refuses to register
 * a source nested in another, so a root inside another source's root (or the vault's) only ever comes from a
 * promote. Held in memory (F1: never in the views' data); the plugin also keeps the last list in `settings.tephraPromotedRoots` so a start with Tephra down still knows them.
 */
export interface SourceRootInfo {
	name: string;
	/** Tephra's absolute root for the source, trailing slashes dropped. */
	absRoot: string;
	/** The source's root as a vault path: `Sources/<name>` for a top-level source, the parent's folder for a promoted one. */
	vaultPath: string;
	/** The name of the source this one was promoted out of (`notes` for the vault), or null for a top-level source. */
	parent: string | null;
	status: TephraSource["status"];
}

/** A promoted source's root: the part the resolver and the Inbox need. */
export interface PromotedRoot {
	name: string;
	vaultPath: string;
	/** Tephra's absolute root for the folder: what a delete under it is probed against (R3-4, E5). */
	absRoot: string;
}

function isInsideOrSame(path: string, root: string): boolean {
	return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** `path` relative to `root` (both normalized, `path` strictly inside `root`). */
function relativeTo(path: string, root: string): string {
	return root === "/" ? path.slice(1) : path.slice(root.length + 1);
}

/**
 * Every listed source (the vault's `notes` aside) with its vault-path root. Pure. A source that can't be placed
 * is left out: an unusable name, a relative path, a root that holds the vault, or a second source on a root an
 * earlier name already has (the same tie rule as the `Sources/` links).
 *
 * `vaultPath` is the vault's absolute path ('' / null when unknown: a vault folder can't be recognised as
 * promoted then, and only sources nested in another listed source are).
 */
export function computeSourceRoots(sources: readonly TephraSource[], vaultPath: string | null): SourceRootInfo[] {
	const vaultRoot = vaultPath === null || vaultPath === "" ? null : normalizeRoot(vaultPath);
	const top = selectTopLevelSources([...sources], vaultRoot);
	const result: SourceRootInfo[] = [];
	const byName = new Map<string, SourceRootInfo>();
	const statusOf = new Map(sources.map((s) => [s.name, s.status] as const));
	for (const linked of top.linked) {
		const info: SourceRootInfo = { name: linked.name, absRoot: linked.root, vaultPath: sourceLinkPath(linked.name), parent: null, status: statusOf.get(linked.name) ?? "offline" };
		result.push(info);
		byName.set(info.name, info);
	}

	// The rest, shallowest root first so a parent is placed before its child. A same-root twin of a placed source
	// (or a source the top-level pass skipped for a reason other than nesting) never gets an entry.
	const placed = new Set(top.linked.map((s) => s.name));
	const skipped = new Set(top.skipped.map((s) => s.name));
	const placedRoots = new Set(top.linked.map((s) => s.root));
	const candidates = [...sources]
		.filter((s) => s.name !== VAULT_SOURCE_NAME && !placed.has(s.name) && !skipped.has(s.name) && isUsableSourceName(s.name))
		.map((s) => ({ source: s, root: normalizeRoot(s.path) }))
		.filter((c): c is { source: TephraSource; root: string } => c.root !== null)
		.filter((c) => !placedRoots.has(c.root))
		.sort((a, b) => a.root.split("/").length - b.root.split("/").length || (a.source.name < b.source.name ? -1 : a.source.name > b.source.name ? 1 : 0));
	const notes = sources.find((s) => s.name === VAULT_SOURCE_NAME);
	const vaultRoots = [notes ? normalizeRoot(notes.path) : null, vaultRoot].filter((root): root is string => root !== null);
	const takenRoots = new Set(placedRoots);
	for (const { source, root } of candidates) {
		if (takenRoots.has(root)) continue; // a same-root twin: the first name keeps it
		// The longest root that holds this one, among the placed sources and the vault.
		let parent: SourceRootInfo | null = null;
		for (const other of byName.values()) {
			if (other.absRoot !== root && isInsideOrSame(root, other.absRoot) && (parent === null || other.absRoot.length > parent.absRoot.length)) parent = other;
		}
		const vaultHolder = vaultRoots.filter((v) => v !== root && isInsideOrSame(root, v)).sort((a, b) => b.length - a.length)[0] ?? null;
		let info: SourceRootInfo | null = null;
		if (parent !== null && (vaultHolder === null || parent.absRoot.length >= vaultHolder.length)) {
			info = { name: source.name, absRoot: root, vaultPath: `${parent.vaultPath}/${relativeTo(root, parent.absRoot)}`, parent: parent.name, status: source.status };
		} else if (vaultHolder !== null) {
			info = { name: source.name, absRoot: root, vaultPath: relativeTo(root, vaultHolder), parent: VAULT_SOURCE_NAME, status: source.status };
		}
		if (info === null) continue; // nested in something Atlas couldn't place: no vault path to give it
		takenRoots.add(root);
		byName.set(info.name, info);
		result.push(info);
	}
	return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The promoted sources among `roots`, in the shape the resolver takes. */
export function promotedRootsOf(roots: readonly SourceRootInfo[]): PromotedRoot[] {
	return roots.filter((r) => r.parent !== null).map((r) => ({ name: r.name, vaultPath: r.vaultPath, absRoot: r.absRoot }));
}

/**
 * The deepest root (a source, promoted or top-level) holding `path` — the "own source = longest matching root"
 * rule — or null when no listed source does (the vault). Whole path segments only: `crates/tephrad2` is not
 * inside `crates/tephrad`.
 */
export function owningRoot(path: string, roots: readonly SourceRootInfo[]): SourceRootInfo | null {
	let best: SourceRootInfo | null = null;
	for (const root of roots) {
		if (path !== root.vaultPath && !path.startsWith(`${root.vaultPath}/`)) continue;
		if (best === null || root.vaultPath.length > best.vaultPath.length) best = root;
	}
	return best;
}

/** The vault path of a path inside a promoted-or-not source, as the folder's absolute path on disk: the owning
 * source's absolute root plus the rest. Null when no listed source owns `path`, or `path` is the vault's own. */
export function absolutePathOf(path: string, roots: readonly SourceRootInfo[]): string | null {
	const owner = owningRoot(path, roots);
	if (owner === null) return null;
	if (path === owner.vaultPath) return owner.absRoot;
	return `${owner.absRoot === "/" ? "" : owner.absRoot}/${path.slice(owner.vaultPath.length + 1)}`;
}

/** Whether `a` is the folder `b` or inside it, by whole segments. */
export function isInsideFolder(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`);
}

/** The promoted roots among `roots` whose folder is exactly `path`'s own top: used to hide a promoted folder in
 * its parent. True when `path` is a promoted source's root. */
export function isPromotedRootPath(path: string, roots: readonly SourceRootInfo[]): SourceRootInfo | null {
	return roots.find((r) => r.parent !== null && r.vaultPath === path) ?? null;
}
