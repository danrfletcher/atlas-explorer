import type { UnitRef } from "./types";
import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { findInterfaceNote } from "./interface-notes";
import { presentRefEntry } from "./ref-presence";
import type { AtlasSettings } from "./settings";

/** Middle-click on a bucket or inbox unit row = "Open in new tab". This module holds the one rule set
 * deciding whether a given `auxclick` should open anything; `explorer-view.ts` only gathers the row's
 * state and passes it in. Pure DOM + data, so every rule is unit-testable without an explorer. */

/** Controls inside a row. A middle-click that lands on (or inside) one of these does nothing, so the
 * row's note only opens from its label area (or a module's row body). `.atlas-status-dot` covers the
 * dot form of a row icon, `.atlas-truncation-row` the "N Done" group rows (which are rows themselves). */
export const MIDDLE_CLICK_CONTROL_SELECTOR = [
	".atlas-chevron",
	".atlas-status-dot",
	".atlas-row-action",
	".atlas-badge",
	".atlas-api-connection-dot",
	".atlas-sort-indicator",
	".atlas-truncation-row",
].join(", ");

/** Reserved for later: a module's icon (plain or status-dot form) does nothing on middle-click. */
const MODULE_ICON_SELECTOR = ".atlas-icon";

export interface MiddleClickRowState {
	ref: UnitRef;
	/** The row is rendered as missing (`RowInfo.missing`). Covers a non-added missing inbox row too. */
	missing: boolean;
	/** An Outside-Vault Folder-source child: its `ref.path` is not a vault path. */
	outsideManaged: boolean;
	/** Checked live at click time: a file/block ref's file exists, or a module's interface note exists.
	 * Guards a row whose target vanished since it was rendered, so a block for a deleted file can never
	 * reach `openLinkText` (which would create a note). */
	targetExists: boolean;
}

/** Live check that the ref has something to open: a file ref's file is in the vault (unit or not,
 * via the shared `presentRefEntry` rule), a block ref's file is in the vault, or a module's folder is
 * present and has an interface note. Never creates anything. */
export function refTargetExists(app: App, settings: AtlasSettings, ref: UnitRef): boolean {
	// A block is not covered by the presence rule (it renders only as a unit); it opens its file.
	if (ref.kind === "block") return app.vault.getAbstractFileByPath(ref.path) instanceof TFile;
	const entry = presentRefEntry(app.vault, ref);
	if (ref.kind === "folder") return entry instanceof TFolder && findInterfaceNote(app, entry, settings) !== null;
	return entry !== null;
}

/** `mousedown` guard: button 1 would start the browser's middle-button autoscroll. Buttons 0 and 2
 * are left alone so the row still takes focus and the context menu still works. */
export function suppressMiddleButtonAutoscroll(evt: MouseEvent): void {
	if (evt.button === 1) evt.preventDefault();
}

/** True when `evt` hit a control inside `rowEl` (or, for a module row, its icon). */
function hitsControl(evt: MouseEvent, rowEl: HTMLElement, ref: UnitRef): boolean {
	const target = evt.target;
	if (!(target instanceof Element)) return false;
	const selector = ref.kind === "folder" ? `${MIDDLE_CLICK_CONTROL_SELECTOR}, ${MODULE_ICON_SELECTOR}` : MIDDLE_CLICK_CONTROL_SELECTOR;
	const hit = target.closest(selector);
	return hit !== null && rowEl.contains(hit);
}

/** Every rule for whether a middle-click opens the row's note. */
export function shouldOpenOnMiddleClick(evt: MouseEvent, rowEl: HTMLElement, state: MiddleClickRowState): boolean {
	if (evt.button !== 1) return false;
	if (evt.shiftKey || evt.metaKey || evt.ctrlKey || evt.altKey) return false;
	if (state.missing || state.outsideManaged || !state.targetExists) return false;
	return !hitsControl(evt, rowEl, state.ref);
}

/** Wires both listeners on a bucket/inbox unit row: the `mousedown` autoscroll guard and the
 * `auxclick` open. `targetExists` is called at click time, not render time, so a row whose file was
 * deleted after the last render still does nothing. */
export function wireMiddleClickOpen(
	rowEl: HTMLElement,
	row: Omit<MiddleClickRowState, "targetExists">,
	targetExists: () => boolean,
	openRef: (ref: UnitRef, newTab: boolean) => unknown
): void {
	rowEl.addEventListener("mousedown", suppressMiddleButtonAutoscroll);
	rowEl.addEventListener("auxclick", (evt) => {
		// Cheap rules first so the vault lookup only runs for a click that could actually open.
		if (!shouldOpenOnMiddleClick(evt, rowEl, { ...row, targetExists: true })) return;
		// The rules above already passed (with targetExists assumed true), so only the live check is left.
		if (!targetExists()) return;
		void openRef(row.ref, true);
	});
}

/** Runs the rules and, if they pass, opens the ref in a new tab through `openRef(ref, true)`. No
 * debounce: each qualifying click opens its own tab. Returns whether it opened. */
export function openOnMiddleClick(
	evt: MouseEvent,
	rowEl: HTMLElement,
	state: MiddleClickRowState,
	openRef: (ref: UnitRef, newTab: boolean) => unknown
): boolean {
	if (!shouldOpenOnMiddleClick(evt, rowEl, state)) return false;
	void openRef(state.ref, true);
	return true;
}
