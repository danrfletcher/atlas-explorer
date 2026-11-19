import { Menu, Platform, TFolder } from "obsidian";
import type AtlasPlugin from "./main";
import { attachMenuItemTooltip, TEPHRA_OFFLINE_TOOLTIP } from "./menu-item-tooltip";
import { canMakeOwnSource, promoteMenuState, type PromoteMenuState, type PromoteSurface } from "./promote-offer";
import { computeSourceRoots, type SourceRootInfo } from "./source-roots";
import { skipsSourcesFolder } from "./sources-path";

/**
 * PR-12 (G6): what the explorer's menus and drop gap read about "may this folder become a source". Free functions
 * of the plugin, not methods of the view, so every menu builder (the Inbox row's, the Module Contents row's, the
 * header's) asks the same code and none needs the view to carry it.
 */

function tephraSectionsOn(plugin: AtlasPlugin): boolean {
	const enabled = (plugin.settings as { tephraEnabled?: boolean } | undefined)?.tephraEnabled === true;
	return skipsSourcesFolder({ tephraEnabled: enabled }, Platform.isMobile);
}

/** Where each listed source sits, from the live source list; empty with the toggle off or before the first answer. */
export function sourceRootsOf(plugin: AtlasPlugin): SourceRootInfo[] {
	if (!tephraSectionsOn(plugin)) return [];
	const connection = plugin.tephraConnection;
	if (connection === undefined || connection === null) return [];
	// Offline the snapshot has no sources, but the sections stay as they were (PR-9): so does the menu, greyed out.
	const sources = connection.getSnapshot().state === "online" ? connection.getSnapshot().sources : (connection.getLastSources?.() ?? []);
	return computeSourceRoots(sources, plugin.getVaultBasePath() || null);
}

export function tephraOnlineOf(plugin: AtlasPlugin): boolean {
	return plugin.tephraConnection?.getSnapshot().state === "online";
}

/** Whether `path` is a folder Atlas keeps out of its units (the pool, an excluded folder). */
export function isPromoteExcluded(plugin: AtlasPlugin, path: string): boolean {
	const { poolFolder, excludedFolders } = plugin.settings;
	const inside = (folder: string) => folder !== "" && (path === folder || path.startsWith(`${folder}/`));
	return inside(poolFolder) || (excludedFolders ?? []).some(inside);
}

/** The one answer the menus and the gap share for "may this folder become a source": `null` when it isn't offered. */
export function promoteOffer(plugin: AtlasPlugin, path: string, surface: PromoteSurface): PromoteMenuState | null {
	if (!tephraSectionsOn(plugin)) return null;
	if (!(plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder)) return null;
	const offered = canMakeOwnSource({ kind: "folder", path, surface }, { roots: sourceRootsOf(plugin), isExcluded: (p) => isPromoteExcluded(plugin, p) });
	return offered ? promoteMenuState(true, tephraOnlineOf(plugin)) : null;
}

/** Adds "Make its own source" for a folder row: shown only for a folder that may be promoted, greyed out with
 * "Tephra offline" while Tephra isn't answering. Never queued. */
export function addMakeOwnSourceItem(menu: Menu, plugin: AtlasPlugin, folderPath: string, surface: PromoteSurface): void {
	const state = promoteOffer(plugin, folderPath, surface);
	if (state === null) return;
	menu.addItem((item) => {
		item
			.setTitle("Make its own source")
			.setIcon("folder-symlink")
			.setDisabled(state.disabled)
			.onClick(() => void plugin.sourcePromoter.makeOwnSource(folderPath));
		if (state.disabled) attachMenuItemTooltip(menu, item, TEPHRA_OFFLINE_TOOLTIP);
	});
}
