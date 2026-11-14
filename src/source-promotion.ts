import { owningSourceName } from "./inbox-sections";
import { sourceLinkPath } from "./sources-path";
import { Unit } from "./types";

/** One resolved link, embed or frontmatter link, as the unit index reads it from Obsidian's metadata cache. */
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
	/** The listed Tephra source names; a link only counts inside one of these. */
	sourceNames: readonly string[];
	/** A path Atlas keeps out of promotion (an ignored folder's exclude entry covers it). */
	isExcluded: (path: string) => boolean;
	/** For a destination that is a module's interface note, the folder it speaks for (`Foo/Foo.md` -> `Foo`). */
	interfaceFolderFor: (path: string) => string | null;
}

/** `Sources/<name>/<top>/…` -> `top`; a file directly in the source root has no module, so null. */
function topLevelFolderInSource(path: string, name: string): string | null {
	const rest = path.slice(sourceLinkPath(name).length + 1);
	const slash = rest.indexOf("/");
	return slash === -1 ? null : rest.slice(0, slash);
}

/**
 * G1, the pop-out rule inside one source: a deeper file that a file elsewhere in the same source links to
 * (per Obsidian's resolved links) appears in that source's Inbox with the "promoted" pill. The module
 * boundary is the source's top-level folder, not `Sources`: a link from inside the same top-level folder
 * promotes nothing, a link from another folder of the source promotes the target. A subpath link promotes
 * only that block, never the file. A self-link promotes nothing; neither does a link to a top-level file,
 * which is already a row.
 *
 * PR-8 SEAM: links whose origin is a vault note, another source, or a code, PDF or Office file are not read
 * here. `originSourceName` below is the one place that decides which links count; PR-8 widens it.
 *
 * Pure: it is handed resolved links and answers with units. It does not read the vault.
 */
export function computeSourcePromotions(links: readonly ResolvedLink[], options: SourcePromotionOptions): SourcePromotions {
	const units = new Map<string, Unit>();
	for (const link of links) {
		const source = originSourceName(link, options.sourceNames);
		if (source === null) continue;
		if (link.to === link.from) continue;
		if (options.isExcluded(link.from) || options.isExcluded(link.to)) continue;

		const fromTop = topLevelFolderInSource(link.from, source);
		const toTop = topLevelFolderInSource(link.to, source);
		if (toTop !== null && toTop === fromTop) continue; // only a genuine same-module match is "not outside"

		if (link.subpath) {
			// Unlike a plain link, a block needs no module of its own: a block of a top-level file promotes too.
			units.set(`block:${link.to}#${link.subpath}`, { type: "promoted-block", path: link.to, subpath: link.subpath });
			continue;
		}
		if (toTop === null) continue; // a top-level file is already listed; nothing to pop out
		const moduleFolder = `${sourceLinkPath(source)}/${toTop}`;
		const interfaceFolder = options.interfaceFolderFor(link.to);
		if (interfaceFolder !== null) {
			if (interfaceFolder !== moduleFolder) {
				units.set(`folder:${interfaceFolder}`, { type: "promoted-folder", path: interfaceFolder, topLevelFolder: moduleFolder });
			}
		} else {
			units.set(`file:${link.to}`, { type: "promoted-file", path: link.to, topLevelFolder: moduleFolder });
		}
	}
	return { units };
}

/** The source a link counts in: both ends live in the same listed source. Anything else (PR-8) is null. */
function originSourceName(link: ResolvedLink, sourceNames: readonly string[]): string | null {
	const from = owningSourceName(link.from, sourceNames);
	if (from === null) return null;
	return owningSourceName(link.to, sourceNames) === from ? from : null;
}
