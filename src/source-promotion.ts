import { owningSourceName } from "./inbox-sections";
import { isInSourcesFolder, sourceLinkPath } from "./sources-path";
import { Unit } from "./types";

/** One resolved link, embed or frontmatter link, as the unit index reads it from Obsidian's metadata cache, or
 * (for a file Obsidian doesn't index) from one of Tephra's edges. */
export interface ResolvedLink {
	/** Vault path of the file the link is written in. */
	from: string;
	/** Vault path of the file it resolves to. */
	to: string;
	/** What follows `#` (a `^id` or a heading); empty for a plain link. */
	subpath: string;
}

export interface SourcePromotions {
	/** Keyed by `unitKey`. */
	units: Map<string, Unit>;
}

export interface SourcePromotionOptions {
	/** The listed Tephra source names; a link only counts when its target is inside one of these. */
	sourceNames: readonly string[];
	/** A path Atlas keeps out of promotion (an ignored folder's exclude entry covers it). */
	isExcluded: (path: string) => boolean;
	/** For a destination that is a module's interface note, the folder it speaks for (`Foo/Foo.md` -> `Foo`). */
	interfaceFolderFor: (path: string) => string | null;
}

/**
 * The module a path belongs to, as a vault path: `Sources/<name>/<top>/…` -> `Sources/<name>/<top>`, where
 * `<name>` is the longest listed source root (the settled "own source" rule, so `Sources/whoopx/a/b.md` is in
 * `whoopx`, never in `whoop`). A file directly in a source's root has no module, like a vault-root file; neither
 * has a path under no listed source (and a vault path, which `UnitIndex` classifies itself). Pure.
 */
export function sourceModuleOf(path: string, sourceNames: readonly string[]): string | null {
	const name = owningSourceName(path, sourceNames);
	return name === null ? null : moduleWithin(path, name);
}

/** `sourceModuleOf` once the owning source `name` is known. */
function moduleWithin(path: string, name: string): string | null {
	const root = sourceLinkPath(name);
	if (path.length <= root.length) return null;
	const rest = path.slice(root.length + 1);
	const slash = rest.indexOf("/");
	return slash === -1 ? null : `${root}/${rest.slice(0, slash)}`;
}

/**
 * G12, the pop-out rule per source: a deeper file in a source appears in that source's Inbox with the
 * "promoted" pill when a link reaches it from outside its own module. A module is the source's top-level folder
 * (`Sources/<name>/<top>`), not `Sources`. A link from a vault file or from another source always counts as from
 * outside; a link from the same module never promotes; a link from a top-level file of the same source counts as
 * from outside (that file has no module). A subpath link promotes only that block, never the file. A self-link
 * promotes nothing; neither does a link to a top-level file, which is already a row.
 *
 * Only the TARGET has to be in a listed source. The origin is any of: a vault file (its own vault-side rules,
 * such as Atlas-excluded folders, are applied by the caller before the link is handed in), another source's
 * file, or a file Obsidian doesn't index (a code, PDF or Office file, read from Tephra's edges). An origin under
 * `Sources/` that no listed source owns is skipped. A link into the vault from a source promotes nothing here:
 * the vault section is the vault-side rules' alone (R3-1).
 *
 * Pure: it is handed resolved links and answers with units. It does not read the vault.
 */
export function computeSourcePromotions(links: readonly ResolvedLink[], options: SourcePromotionOptions): SourcePromotions {
	const units = new Map<string, Unit>();
	// The same few paths recur across thousands of links (R2): each path's owner is worked out once per call.
	const owners = new Map<string, string | null>();
	const ownerOf = (path: string): string | null => {
		let owner = owners.get(path);
		if (owner === undefined) {
			owner = owningSourceName(path, options.sourceNames);
			owners.set(path, owner);
		}
		return owner;
	};
	const excludedPaths = new Map<string, boolean>();
	const excluded = (path: string): boolean => {
		let verdict = excludedPaths.get(path);
		if (verdict === undefined) {
			verdict = options.isExcluded(path);
			excludedPaths.set(path, verdict);
		}
		return verdict;
	};
	for (const link of links) {
		const toSource = ownerOf(link.to);
		if (toSource === null) continue; // the target is not in a listed source: not this rule's business
		const fromSource = ownerOf(link.from);
		if (fromSource === null && isInSourcesFolder(link.from)) continue; // unknown or removed source
		if (link.to === link.from) continue;
		if (excluded(link.from) || excluded(link.to)) continue;

		const toModule = moduleWithin(link.to, toSource);
		if (toModule !== null && fromSource !== null && toModule === moduleWithin(link.from, fromSource)) continue; // only a genuine same-module match is "not outside"

		if (link.subpath) {
			// Unlike a plain link, a block needs no module of its own: a block of a top-level file promotes too.
			units.set(`block:${link.to}#${link.subpath}`, { type: "promoted-block", path: link.to, subpath: link.subpath });
			continue;
		}
		if (toModule === null) continue; // a top-level file is already listed; nothing to pop out
		const interfaceFolder = options.interfaceFolderFor(link.to);
		if (interfaceFolder !== null) {
			if (interfaceFolder !== toModule) {
				units.set(`folder:${interfaceFolder}`, { type: "promoted-folder", path: interfaceFolder, topLevelFolder: toModule });
			}
		} else {
			units.set(`file:${link.to}`, { type: "promoted-file", path: link.to, topLevelFolder: toModule });
		}
	}
	return { units };
}
