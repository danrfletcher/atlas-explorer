import { Notice } from "obsidian";
import type AtlasPlugin from "./main";
import { UnitRef } from "./types";
import { flattenMetaFolders } from "./views";
import { ViewSuggestModal, MetaFolderSuggestModal } from "./explorer-view";
import { TextPromptModal } from "./modals";
import { registerRenderLogCommand } from "./render-log-command";

/** F10 — the finalized command list. `Add block` is registered separately (F4 owns it). */
export function registerF10Commands(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "open-explorer",
		name: "Open explorer",
		callback: () => void plugin.activateExplorerView(),
	});

	plugin.addCommand({
		id: "switch-view",
		name: "Switch view…",
		callback: () => {
			new ViewSuggestModal(plugin.app, plugin.viewsManager.getViews(), (view) => {
				plugin.viewsManager.setActiveViewId(view.id);
			}).open();
		},
	});

	plugin.addCommand({
		id: "place-active-file-in-view",
		name: "Place active file in view…",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) return false;
			if (checking) return true;
			const ref: UnitRef = { kind: "file", path: file.path };
			new ViewSuggestModal(plugin.app, plugin.viewsManager.getViews(), (view) => {
				const targets = [{ id: null, label: "(bucket root)" }, ...flattenMetaFolders(view.root)];
				new MetaFolderSuggestModal(plugin.app, targets, (target) => {
					plugin.viewsManager.placeUnit(view.id, ref, target.id);
					new Notice(`Atlas: placed "${file.basename}" in "${view.name}".`);
				}).open();
			}).open();
			return true;
		},
	});

	plugin.addCommand({
		id: "reveal-active-file",
		name: "Reveal active file in Atlas",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) return false;
			if (checking) return true;
			void plugin.activateExplorerView();
			const ref: UnitRef = { kind: "file", path: file.path };
			if (!plugin.viewsManager.isPlacedAnywhere(ref)) {
				new Notice(`Atlas: "${file.basename}" isn't placed in any view yet.`);
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "new-view",
		name: "New view",
		callback: () => {
			new TextPromptModal(plugin.app, "New view", "", (name) => {
				if (!name.trim()) return;
				const created = plugin.viewsManager.createView(name);
				if (!created) return new Notice(`Atlas: a view named "${name}" already exists.`);
				plugin.viewsManager.setActiveViewId(created.id);
			}).open();
		},
	});

	plugin.addCommand({
		id: "rebuild-index",
		name: "Rebuild index",
		callback: () => {
			plugin.unitIndex.rebuild();
			new Notice(`Atlas: index rebuilt (${plugin.unitIndex.getUnits().length} units) — see console for timings.`);
		},
	});

	registerRenderLogCommand(plugin);
}
