import { TFile, TFolder } from "obsidian";
import type { Vault } from "obsidian";
import type { UnitRef } from "./types";

/** The vault entry a placed ref points at, or null when its target is not there. The one rule for
 * "does a placed ref's target still exist?". Independent of whether the target is an Atlas unit: a
 * note moved into a module folder with no backlink is no longer a unit but is still there, so its row
 * must stay a normal row. Only a target that is really gone is missing.
 *
 * - `kind: "file"`: a `TFile` at the path (any extension). A folder at that path is not present.
 * - `kind: "folder"`: a non-root `TFolder` at the path. A file at that path is not present.
 * - `kind: "block"`: never present here. A block renders only as a unit, so a non-unit block ref is
 *   missing; callers that already hold the block's unit judge it from the unit.
 *
 * Pure: reads the vault index only; never creates, promotes or persists anything. */
export function presentRefEntry(vault: Pick<Vault, "getAbstractFileByPath">, ref: UnitRef): TFile | TFolder | null {
	if (ref.kind === "block" || !ref.path) return null;
	const entry = vault.getAbstractFileByPath(ref.path);
	if (ref.kind === "folder") return entry instanceof TFolder && !entry.isRoot() ? entry : null;
	return entry instanceof TFile ? entry : null;
}

/** True when `presentRefEntry` finds the ref's target. */
export function isRefPresent(vault: Pick<Vault, "getAbstractFileByPath">, ref: UnitRef): boolean {
	return presentRefEntry(vault, ref) !== null;
}

/** Row text for a present target: a file's name without its extension, a folder's name. */
export function presentEntryLabel(entry: TFile | TFolder): string {
	if (entry instanceof TFolder) return entry.name;
	const ext = entry.extension ? `.${entry.extension}` : "";
	return ext && entry.name.endsWith(ext) ? entry.name.slice(0, -ext.length) : entry.name;
}
