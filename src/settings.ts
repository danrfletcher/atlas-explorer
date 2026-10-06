import { App, Menu, PluginSettingTab, Setting } from "obsidian";
import type AtlasPlugin from "./main";
import { rewritePathString } from "./types";
import { normalizeHexColor } from "./statuses";
import { closeActivePopup, openColorPickerPopup } from "./status-popup";

export interface AtlasSettings {
	poolFolder: string;
	excludedFolders: string[];
	/** Folders whose files are never auto-promoted into the inbox by a link or embed. Files there
	 * still show in the explorer and can still be added by hand with "+". Read through
	 * `normalizeNoAutoPromoteFolders`, never directly, so a hand-edited `data.json` is covered too. */
	noAutoPromoteFolders: string[];
	interfaceNoteAcceptAltNames: boolean;
	replaceNativeExplorerOnStartup: boolean;
	blockDisplayLength: number;
	defaultViewId: string;
	/** F8 follow-up (Dan's live drag-and-drop testing feedback): folders/modules are first-class
	 * citizens whose internal organization Atlas doesn't otherwise touch, so filing a file/block
	 * into one via drag is a deliberate exception — gated by a confirm dialog when this is on. */
	confirmAddToModule: boolean;
	/** PR 14: status-dot glow effect, ported from the reference plugin's own toggle. Lives under
	 * the "Status" settings tab even though it's stored alongside the rest of settings, same as
	 * every other simple on/off toggle in this file. */
	glowEnabled: boolean;
	/** PR 15: when a status dot replaces a row's normal icon, keep that icon visible shrunk down
	 * inside the dot instead of hiding it outright. */
	retainIcons: boolean;
	/** PR 15 (Dan-found follow-up): which color a retained icon uses — `true` matches the app
	 * background (a "cut out of the dot" look), `false` matches normal text color. Only meaningful
	 * when `retainIcons` is on. */
	retainIconMatchBackground: boolean;
}

export const DEFAULT_TO_DELETE_FOLDER = "_to_delete";
export const DEFAULT_POOL_FOLDER = "_pool";

export const DEFAULT_SETTINGS: AtlasSettings = {
	poolFolder: DEFAULT_POOL_FOLDER,
	excludedFolders: [],
	noAutoPromoteFolders: [],
	interfaceNoteAcceptAltNames: false,
	replaceNativeExplorerOnStartup: true,
	blockDisplayLength: 80,
	defaultViewId: "default",
	confirmAddToModule: true,
	glowEnabled: false,
	retainIcons: false,
	retainIconMatchBackground: false,
};

/** Turns a raw `noAutoPromoteFolders` value (a textarea's lines, or whatever `data.json` holds) into
 * clean vault-relative folder paths: trims, strips leading/trailing `/`, drops blanks, and drops the
 * pool folder (free blocks are never auto-promoted anyway, so it can't be listed). Anything that
 * isn't an array of strings yields `[]`. Always returns a new array. */
export function normalizeNoAutoPromoteFolders(raw: unknown, poolFolder: string): string[] {
	if (!Array.isArray(raw)) return [];
	const pool = normalizeFolderPath(poolFolder);
	const result: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const folder = normalizeFolderPath(entry);
		if (folder === "" || folder === pool || result.includes(folder)) continue;
		result.push(folder);
	}
	return result;
}

/** Rewrites listed folders for a vault rename or move (exact path or `old/` prefix, the same rule
 * `rewritePathString` applies to refs). Returns the new list only when something changed, so the
 * caller can skip a save. Callers assign and persist the result before any index rebuild runs. */
export function rewriteNoAutoPromoteFolders(folders: readonly string[], oldPath: string, newPath: string): string[] | null {
	const rewritten = folders.map((folder) => rewritePathString(folder, oldPath, newPath));
	return rewritten.some((folder, i) => folder !== folders[i]) ? rewritten : null;
}

function normalizeFolderPath(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

/** True when `path` is a listed folder or sits under one. Case-sensitive, like `isExcluded`. */
export function isCoveredByNoAutoPromote(path: string, folders: readonly string[]): boolean {
	return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/** Dot-folders + the pool folder + `_to_delete`, computed once against the live vault root. */
export function computeDefaultExcludedFolders(app: App, poolFolder: string): string[] {
	const rootFolders = app.vault
		.getRoot()
		.children.filter((child) => "children" in child)
		.map((child) => child.path);
	const dotFolders = rootFolders.filter((path) => path.startsWith("."));
	return Array.from(new Set([...dotFolders, poolFolder, DEFAULT_TO_DELETE_FOLDER]));
}

type SettingsTabId = "basic" | "status";

export class AtlasSettingTab extends PluginSettingTab {
	/** Not persisted — resets to "Basic" each time the settings panel is reopened, same as any
	 * other Obsidian settings tab's in-session UI state. */
	private activeTab: SettingsTabId = "basic";

	constructor(app: App, private plugin: AtlasPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const tabBar = containerEl.createDiv({ cls: "atlas-settings-tabs" });
		this.renderTabButton(tabBar, "basic", "Basic");
		this.renderTabButton(tabBar, "status", "Status");

		const body = containerEl.createDiv({ cls: "atlas-settings-body" });
		if (this.activeTab === "basic") this.renderBasicTab(body);
		else this.renderStatusTab(body);
	}

	private renderTabButton(tabBar: HTMLElement, id: SettingsTabId, label: string): void {
		const btn = tabBar.createEl("button", { text: label, cls: "atlas-settings-tab" });
		if (this.activeTab === id) btn.addClass("is-active");
		btn.addEventListener("click", () => {
			if (this.activeTab === id) return;
			this.activeTab = id;
			this.display();
		});
	}

	// ---------- Basic tab (everything that existed before PR 14) ----------

	private renderBasicTab(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Pool folder")
			.setDesc("Where free blocks live. Created on demand the first time you add a block.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_POOL_FOLDER)
					.setValue(this.plugin.settings.poolFolder)
					.onChange(async (value) => {
						const oldPoolFolder = this.plugin.settings.poolFolder;
						const newPoolFolder = value.trim() || DEFAULT_POOL_FOLDER;
						this.plugin.settings.poolFolder = newPoolFolder;
						await this.plugin.saveSettings();
						await this.plugin.handlePoolFolderChanged(oldPoolFolder, newPoolFolder);
					})
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"One per line. These never appear in the explorer, and their files never appear in any inbox — except files in the pool folder, which still show as free blocks."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(".obsidian\n.git\n.trash")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.plugin.saveSettings();
						this.plugin.unitIndex.rebuild();
					})
			);

		new Setting(containerEl)
			.setName("Never auto-promote from these folders")
			.setDesc(
				"One per line. Files here still show in the explorer and can be added with +, but links and embeds never promote them into the inbox. The pool folder can't be listed."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("Attachments")
					.setValue(this.plugin.settings.noAutoPromoteFolders.join("\n"))
					.onChange(async (value) => {
						// Always a fresh array: the shared DEFAULT_SETTINGS entry must never change.
						this.plugin.settings.noAutoPromoteFolders = normalizeNoAutoPromoteFolders(
							value.split("\n"),
							this.plugin.settings.poolFolder
						);
						await this.plugin.saveSettings();
						this.plugin.unitIndex.rebuild();
					})
			);

		new Setting(containerEl)
			.setName("Interface note convention")
			.setDesc("A folder's interface note is always <Folder>/<Folder>.md. Also accept index.md / README.md as a fallback.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.interfaceNoteAcceptAltNames).onChange(async (value) => {
					this.plugin.settings.interfaceNoteAcceptAltNames = value;
					await this.plugin.saveSettings();
					this.plugin.unitIndex.rebuild();
				})
			);

		new Setting(containerEl)
			.setName("Replace native explorer on startup")
			.setDesc("Make Atlas the active view in the left sidebar on launch. The native explorer stays available as a tab.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.replaceNativeExplorerOnStartup).onChange(async (value) => {
					this.plugin.settings.replaceNativeExplorerOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Block display length")
			.setDesc("How many characters of a free block's first line to show in the explorer.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.blockDisplayLength)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						this.plugin.settings.blockDisplayLength = parsed;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Confirm before adding a unit to a module")
			.setDesc(
				"Dragging a file or block onto a module files it into that module on disk — a deliberate exception to Atlas never otherwise touching a module's internal organization. When on, asks first. When off, it happens immediately."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmAddToModule).onChange(async (value) => {
					this.plugin.settings.confirmAddToModule = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Default view on launch")
			// Only "Default" exists until F9 (views) ships — the dropdown is wired up now so it needs
			// no rework later, it just has one option today.
			.setDesc("Which view Atlas opens to when the vault loads.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("default", "Default")
					.setValue(this.plugin.settings.defaultViewId)
					.onChange(async (value) => {
						this.plugin.settings.defaultViewId = value;
						await this.plugin.saveSettings();
					})
			);
	}

	// ---------- Status tab (PR 14: data model + settings only, no tree rendering/assignment yet) ----------

	private renderStatusTab(containerEl: HTMLElement): void {
		containerEl.createEl("p", {
			text: "Define named status sets here. Assigning a status set to an item happens from its right-click menu in the explorer (coming in a later PR) — this tab only manages the sets themselves.",
			cls: "setting-item-description",
		});

		this.renderStatusSets(containerEl);
		this.renderColorPalette(containerEl);
		this.renderDesign(containerEl);
	}

	private renderStatusSets(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Status sets").setHeading();

		const statusesManager = this.plugin.statusesManager;
		for (const set of statusesManager.getStatusSets()) {
			const wrapper = containerEl.createDiv({ cls: "atlas-status-set-card" });

			new Setting(wrapper)
				.setName("Status set name")
				.addText((text) =>
					text.setValue(set.name).onChange((value) => {
						statusesManager.renameStatusSet(set.id, value);
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete status set")
						.onClick(() => {
							statusesManager.deleteStatusSet(set.id);
							this.display();
						})
				);

			const list = wrapper.createDiv({ cls: "atlas-status-list" });
			set.statuses.forEach((status, idx) => {
				const isDefault = status.id === set.defaultStatusId;
				const row = new Setting(list).setClass("atlas-status-row");

				// PR 14 fix (Dan-found while testing PR 16): this used to be a bare native
				// `<input type="color">`, which only ever offers the OS color picker — the shared
				// Color Palette below was never actually reachable from here despite the section's
				// own description claiming it's "offered by every status-color picker." Now a
				// clickable swatch that opens the real palette-grid-plus-custom popup, matching the
				// reference plugin's own equivalent.
				const swatch = row.controlEl.createDiv({ cls: "atlas-status-swatch" });
				swatch.setCssStyles({ backgroundColor: normalizeHexColor(status.color) });
				swatch.setAttribute("role", "button");
				swatch.setAttribute("aria-label", "Change color");
				swatch.addEventListener("click", () => {
					openColorPickerPopup({
						anchor: swatch,
						palette: statusesManager.getColorPalette(),
						currentColor: normalizeHexColor(status.color),
						onPick: (hex) => {
							statusesManager.updateStatus(set.id, status.id, { color: hex });
							swatch.setCssStyles({ backgroundColor: hex });
						},
						onSaveToPalette: (hex) => {
							// Reviewer-caught (A22): matching the existing dedicated "Add color to
							// palette" button's own behavior a few sections down, which already calls
							// this.display() after the same addPaletteColor call — without it, the
							// separate always-visible Color Palette section below wouldn't show the
							// new swatch until something unrelated triggered a re-render. Closing the
							// popup first (rather than leaving it open, matching the reference
							// plugin's own behavior) avoids a worse problem `display()` would
							// otherwise introduce here: it rebuilds this exact row's swatch element,
							// so a still-open popup's `onPick` would go on updating a now-detached
							// node instead of the fresh one — full re-render and an anchored popup
							// staying open don't mix safely in this settings panel's architecture.
							closeActivePopup();
							statusesManager.addPaletteColor(hex);
							this.display();
						},
					});
				});

				row.addText((text) =>
					text.setValue(status.label).onChange((value) => {
						statusesManager.updateStatus(set.id, status.id, { label: value });
					})
				);

				const badges = row.controlEl.createDiv({ cls: "atlas-status-badges" });
				if (isDefault) badges.createSpan({ cls: "atlas-status-badge", text: "Default" });
				if (status.isCompleted) badges.createSpan({ cls: "atlas-status-badge", text: "Completed" });
				if (status.isCancelled) badges.createSpan({ cls: "atlas-status-badge", text: "Cancelled" });

				// Completed/cancelled + reorder + default all fold into one "more actions" menu
				// instead of a row of toggles — a full toggle-plus-label pair per flag didn't fit in
				// the settings panel's actual width (measured live: ~645px of controls in a ~300px
				// row), the same space-budget problem the reference plugin's own "more actions" popup
				// solves for the identical set of actions. Reusing Atlas's own `Menu` import (already
				// used elsewhere, e.g. the explorer's row context menus) rather than adding a new
				// popup utility just for this.
				row.addExtraButton((btn) => {
					btn.setIcon("more-vertical").setTooltip("More actions");
					btn.onClick(() => {
						const menu = new Menu();
						const rect = btn.extraSettingsEl.getBoundingClientRect();
						if (!isDefault) {
							menu.addItem((item) =>
								item
									.setTitle("Make default")
									.setIcon("star")
									.onClick(() => {
										statusesManager.setDefaultStatus(set.id, status.id);
										this.display();
									})
							);
						}
						menu.addItem((item) =>
							item
								.setTitle(status.isCompleted ? "Unmark as completed" : "Mark as completed")
								.setIcon("check-circle")
								.onClick(() => {
									statusesManager.setStatusCompleted(set.id, status.id, !status.isCompleted);
									this.display();
								})
						);
						menu.addItem((item) =>
							item
								.setTitle(status.isCancelled ? "Unmark as cancelled" : "Mark as cancelled")
								.setIcon("x-circle")
								.onClick(() => {
									statusesManager.setStatusCancelled(set.id, status.id, !status.isCancelled);
									this.display();
								})
						);
						menu.addSeparator();
						menu.addItem((item) =>
							item
								.setTitle("Move up")
								.setIcon("arrow-up")
								.setDisabled(idx === 0)
								.onClick(() => {
									const order = set.statuses.map((s) => s.id);
									[order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
									statusesManager.reorderStatuses(set.id, order);
									this.display();
								})
						);
						menu.addItem((item) =>
							item
								.setTitle("Move down")
								.setIcon("arrow-down")
								.setDisabled(idx === set.statuses.length - 1)
								.onClick(() => {
									const order = set.statuses.map((s) => s.id);
									[order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
									statusesManager.reorderStatuses(set.id, order);
									this.display();
								})
						);
						menu.addSeparator();
						menu.addItem((item) =>
							item
								.setTitle("Remove status")
								.setIcon("trash")
								.onClick(() => {
									statusesManager.removeStatus(set.id, status.id);
									this.display();
								})
						);
						menu.showAtPosition({ x: rect.left, y: rect.bottom });
					});
				});
			});

			new Setting(wrapper).addButton((btn) =>
				btn.setButtonText("Add status").onClick(() => {
					statusesManager.addStatus(set.id, "New status", "#888888");
					this.display();
				})
			);
		}

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("New status set")
				.setCta()
				.onClick(() => {
					statusesManager.createStatusSet("New status set");
					this.display();
				})
		);
	}

	private renderColorPalette(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Color palette").setHeading();
		containerEl.createEl("p", {
			text: "Shared swatches offered by every status-color picker above, in addition to a fully custom color.",
			cls: "setting-item-description",
		});

		const statusesManager = this.plugin.statusesManager;
		const grid = containerEl.createDiv({ cls: "atlas-palette-grid" });
		for (const hex of statusesManager.getColorPalette()) {
			const item = grid.createDiv({ cls: "atlas-palette-item" });
			const swatch = item.createDiv({ cls: "atlas-palette-swatch" });
			swatch.setCssStyles({ backgroundColor: hex });
			swatch.setAttribute("title", hex);
			const removeBtn = item.createSpan({ cls: "atlas-palette-remove", text: "×" });
			removeBtn.setAttribute("role", "button");
			removeBtn.setAttribute("aria-label", `Remove ${hex} from palette`);
			removeBtn.addEventListener("click", () => {
				statusesManager.removePaletteColor(hex);
				this.display();
			});
		}

		const addWrapper = containerEl.createDiv({ cls: "atlas-palette-add" });
		const colorInput = addWrapper.createEl("input", { type: "color" });
		colorInput.value = "#888888";
		const addBtn = addWrapper.createEl("button", { text: "Add color to palette" });
		addBtn.addEventListener("click", () => {
			statusesManager.addPaletteColor(colorInput.value);
			this.display();
		});
	}

	private renderDesign(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Design").setHeading();

		new Setting(containerEl)
			.setName("Glow")
			.setDesc("Adds a soft glow around status dots.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.glowEnabled).onChange(async (value) => {
					this.plugin.settings.glowEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.refreshExplorerViews();
				})
			);

		new Setting(containerEl)
			.setName("Retain icons")
			.setDesc("When a status is assigned, keep the item's normal icon visible, shrunk down inside the status dot, instead of replacing it outright.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.retainIcons).onChange(async (value) => {
					this.plugin.settings.retainIcons = value;
					await this.plugin.saveSettings();
					this.plugin.refreshExplorerViews();
				})
			);

		new Setting(containerEl)
			.setName("Retained icon color")
			.setDesc("Only matters when \"Retain icons\" is on. Match the icon to normal text color, or to the app's background color.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("text", "Match text color")
					.addOption("background", "Match background color")
					.setValue(this.plugin.settings.retainIconMatchBackground ? "background" : "text")
					.onChange(async (value) => {
						this.plugin.settings.retainIconMatchBackground = value === "background";
						await this.plugin.saveSettings();
						this.plugin.refreshExplorerViews();
					})
			);
	}
}
