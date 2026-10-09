import { App, TFile, TFolder } from "obsidian";
import type { AtlasSettings } from "./settings";
import { Unit } from "./types";
import { getFreeBlockDisplayText, getPromotedBlockDisplayText } from "./display-text";
import type { FreeBlockTextCache } from "./block-link-display";

export interface ResolvedUnit {
	unit: Unit;
	text: string;
	secondary?: string;
	icon: string;
	promoted: boolean;
	/** PR-3 (G3): true for a unit manually added via the inbox "+" modal — renders an "added" badge
	 * instead of (never alongside) the "promoted" badge. PR-1 (polish): both badges are inbox-only;
	 * a bucket row never shows either, even when this flag is true. */
	added: boolean;
	/** ctime of the underlying file/folder, for the inbox's "newest first" default sort. */
	ctime: number;
}

function iconFor(unit: Unit): string {
	switch (unit.type) {
		case "folder-unit":
		case "promoted-folder":
		case "added-folder":
			return "folder";
		case "free-block":
			return "message-square";
		case "promoted-block":
			return "quote";
		default:
			return "file";
	}
}

/** Resolves everything the explorer needs to render one row for a unit. Reads files where the
 * display text is derived from content (free blocks, promoted blocks) — done once per render pass
 * rather than per keystroke. F11: free-block text is served from `freeBlockCache` (already kept
 * current by vault events for F7's needs) when available, instead of re-reading the file fresh on
 * every render pass — at a couple thousand free blocks, a fresh read per render per block is real,
 * avoidable I/O. Promoted-block text has no equivalent cache yet (a smaller, bounded-impact gap —
 * promoted blocks are explicit `#^id` links from elsewhere, typically far fewer than free blocks in
 * a real vault — logged as a follow-up in decisions.md rather than built speculatively here). */
export async function resolveUnit(
	app: App,
	settings: AtlasSettings,
	unit: Unit,
	freeBlockCache?: FreeBlockTextCache
): Promise<ResolvedUnit | null> {
	const file = app.vault.getAbstractFileByPath(unit.path);
	if (!file) return null;
	const promoted = unit.type === "promoted-file" || unit.type === "promoted-folder" || unit.type === "promoted-block";
	const added = unit.type === "added-file" || unit.type === "added-folder";

	switch (unit.type) {
		case "root-file":
		case "promoted-file":
		case "added-file":
			if (!(file instanceof TFile)) return null;
			return { unit, text: file.basename, icon: iconFor(unit), promoted, added, ctime: file.stat.ctime };
		case "folder-unit":
		case "promoted-folder":
		case "added-folder":
			// PR-1.S1 (G2): an added folder's row text is its folder name, never its path, and follows renames.
			if (!(file instanceof TFolder)) return null;
			return { unit, text: file.name, icon: iconFor(unit), promoted, added, ctime: 0 };
		case "free-block": {
			if (!(file instanceof TFile)) return null;
			const cached = freeBlockCache?.get(unit.path);
			const text = cached ?? (await getFreeBlockDisplayText(app, file, settings.blockDisplayLength));
			return { unit, text, icon: iconFor(unit), promoted, added, ctime: file.stat.ctime };
		}
		case "promoted-block": {
			if (!(file instanceof TFile)) return null;
			const text = await getPromotedBlockDisplayText(app, file, unit.subpath, settings.blockDisplayLength);
			return { unit, text, secondary: `in ${file.name}`, icon: iconFor(unit), promoted, added, ctime: file.stat.ctime };
		}
	}
}

export async function resolveUnits(
	app: App,
	settings: AtlasSettings,
	units: Unit[],
	freeBlockCache?: FreeBlockTextCache
): Promise<ResolvedUnit[]> {
	const resolved = await Promise.all(units.map((unit) => resolveUnit(app, settings, unit, freeBlockCache)));
	return resolved.filter((r): r is ResolvedUnit => r !== null);
}
