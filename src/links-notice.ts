import { App, Notice } from "obsidian";

export const LINKS_NOT_UPDATED_MESSAGE =
	"Links to this note weren't updated (Obsidian's 'Automatically update internal links' is off)";

const NOTICE_DURATION_MS = 8000;

export type LinksConfigReader = (app: App) => unknown;

/** Reads `alwaysUpdateLinks` from the vault config (`Vault.getConfig` isn't in the public typings,
 * hence the cast). */
export const readAlwaysUpdateLinks: LinksConfigReader = (app) =>
	(app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("alwaysUpdateLinks");

/** Fails quiet: a reader that throws, or a value that isn't a boolean (key absent), counts as on. */
export function isAutoUpdateLinksOn(app: App, read: LinksConfigReader = readAlwaysUpdateLinks): boolean {
	try {
		const value = read(app);
		return typeof value === "boolean" ? value : true;
	} catch {
		return true;
	}
}

/** Call after a move/rename Atlas triggered: one notice when Obsidian won't have rewritten links in
 * notes. Atlas's own views and refs are rewritten regardless. Returns whether a notice was shown.
 * `suppressed` (R3-6): true while the Tephra toggle is on. Then Atlas has switched Obsidian's setting off
 * on purpose and Tephra rewrites the links, so the notice would be false and is never shown. */
export function noticeIfLinksNotUpdated(app: App, read: LinksConfigReader = readAlwaysUpdateLinks, suppressed?: () => boolean): boolean {
	if (suppressed?.() === true) return false;
	if (isAutoUpdateLinksOn(app, read)) return false;
	new Notice(LINKS_NOT_UPDATED_MESSAGE, NOTICE_DURATION_MS);
	return true;
}
