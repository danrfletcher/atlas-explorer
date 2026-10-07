import { Debouncer, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS, computeDefaultExcludedFolders } from "./settings";
import { UnitIndex } from "./unit-index";
import { AddedItem, UnitRef, View } from "./types";
import { registerAddBlockCommand } from "./commands";
import { AtlasLinkSuggest } from "./link-suggest";
import { applySuggesterPrecedence, removeSuggesterPrecedence } from "./suggester-precedence";
import { FreeBlockTextCache, freeBlockLivePreviewPlugin, registerBlockLinkDisplayPostProcessor } from "./block-link-display";
import { ViewsManager } from "./views";
import { FolderLiveRefresh } from "./folder-live-refresh";
import { parentFolderPath } from "./folder-source";
import { ATLAS_VIEW_TYPE, AtlasExplorerView } from "./explorer-view";
import { registerF10Commands } from "./f10-commands";
import { closeNameDialog, openNameDialog } from "./name-dialog";
import { GraduationController } from "./graduation";
import { noticeIfLinksNotUpdated } from "./links-notice";
import { registerTestHarness } from "./test-harness";
import { DEFAULT_COLOR_PALETTE, StatusSet, StatusesManager } from "./statuses";
import { ApiHeadersStore } from "./api-headers-store";
import { FolderSourcePathStore } from "./folder-source-path-store";
import { ApiSourceController } from "./api-source-controller";
import { CsvSourceController } from "./csv-source-controller";
import { MarkdownTableSourceController } from "./markdown-table-source-controller";

interface AtlasData {
	settings: AtlasSettings;
	manualPromotions: UnitRef[];
	views: View[];
	activeViewId: string;
	/** PR 10: vault paths of module-internal subfolders currently expanded in a Module Contents
	 * modal — a flat set is enough since folder paths are already unique/absolute across the vault,
	 * no need to key by module. Absence = collapsed (the default for a folder never opened before). */
	expandedModuleFolders: string[];
	/** PR 14: named status sets, ported from the reference plugin's own model. */
	statusSets: StatusSet[];
	/** PR 14: shared/global palette offered by every status-color picker. */
	colorPalette: string[];
	/** PR-2: per-view dismiss state (view id -> dismissed refs) plus one separate global-scope set —
	 * a global dismiss is a single entry here, never enumerated into every view's own map. */
	dismissedByView: Record<string, UnitRef[]>;
	dismissedGlobal: UnitRef[];
	/** PR-2: units manually added to the inbox via "+", distinct from `manualPromotions`. */
	addedItems: AddedItem[];
}

export default class AtlasPlugin extends Plugin {
	declare settings: AtlasSettings;
	manualPromotions: UnitRef[];
	/** PR-2: staged at load time, then handed to `UnitIndex`, which becomes authoritative — same
	 * lifecycle as `manualPromotions` above. */
	private dismissedByView: Record<string, UnitRef[]>;
	private dismissedGlobal: UnitRef[];
	private addedItems: AddedItem[];
	/** PR 10: runtime form of `AtlasData.expandedModuleFolders` — a `Set` for O(1) membership checks
	 * from the modal, which re-checks every visible subfolder's expanded state on each open. */
	private expandedModuleFolders: Set<string>;
	unitIndex: UnitIndex;
	viewsManager: ViewsManager;
	statusesManager: StatusesManager;
	/** G13: device-local (never-synced) storage for API data-source request headers. */
	apiHeadersStore: ApiHeadersStore;
	/** PR-5 (G6/F6): device-local (never-synced) storage for Outside-Vault Folder source absolute
	 * paths — its own store, separate from `apiHeadersStore`, so the two never interact. */
	folderSourcePathStore: FolderSourcePathStore;
	/** G1/G6/G11: the fetch → map → merge → persist pipeline for API-backed Folders. */
	apiSourceController: ApiSourceController;
	/** PR-7 (G17-G19/G21-G23): the read → parse → map → merge → persist pipeline for CSV-backed
	 * Folders — a vault file read stands in for `apiSourceController`'s HTTP fetch. */
	csvSourceController: CsvSourceController;
	/** PR-8 (G17-G20/G22-G24): the read → parse → map → merge → persist pipeline for Markdown-Table-
	 * backed Folders — same shape as `csvSourceController`, with a parsed table's rows standing in for
	 * CSV's own parsed rows. */
	markdownTableSourceController: MarkdownTableSourceController;
	/** Public so the explorer (F8/F11) can reuse it instead of re-reading free-block files on every render. */
	freeBlockTextCache: FreeBlockTextCache;
	private linkSuggest: AtlasLinkSuggest;
	graduation: GraduationController;
	private persistDebounced: Debouncer<[], void>;
	/** PR-1 (G5): debounced live refresh for Inside-Vault Folder sources. Plugin-wide, not per leaf, so
	 * two open Atlas leaves never mean two refreshes of the same source. */
	private folderLiveRefresh = new FolderLiveRefresh((nodeId) => this.refreshInsideFolderSource(nodeId));

	async onload() {
		const data = (await this.loadData()) as AtlasData | null;
		this.loadFromData(data);

		this.persistDebounced = debounce(() => void this.persistNow(), 500, true);

		this.unitIndex = new UnitIndex(
			this.app,
			this.settings,
			this.manualPromotions,
			this.dismissedByView,
			this.dismissedGlobal,
			this.addedItems
		);
		this.viewsManager = new ViewsManager(
			this.app,
			data?.views ?? [],
			data?.activeViewId ?? "",
			() => this.persistDebounced()
		);
		// PR-4 (T1): keeps `UnitIndex` in sync with every Folder source's currently-managed refs, so
		// those children resolve as real units (G3) instead of the generic missing-ref fallback. Runs
		// once now for whatever's already in `data.json` from a prior session, then again on every
		// `ViewsManager` change (refresh, save, rename-rewrite) — not gated on either refresh toggle,
		// since already-placed managed children need to resolve on load even if neither is on.
		const syncFolderSourceUnits = () => this.unitIndex.setFolderSourceRefs(this.viewsManager.getFolderSourceManagedRefs());
		this.viewsManager.onChange(syncFolderSourceUnits);
		syncFolderSourceUnits();
		this.statusesManager = new StatusesManager(
			data?.statusSets ?? [],
			data?.colorPalette ?? [...DEFAULT_COLOR_PALETTE],
			() => this.persistDebounced()
		);
		this.graduation = new GraduationController({
			vault: this.app.vault,
			fileManager: this.app.fileManager,
			scheduler: { setTimeout: (cb, ms) => window.setTimeout(cb, ms), clearTimeout: (handle) => window.clearTimeout(handle as number) },
			getPoolFolder: () => this.settings.poolFolder,
			getExcludedFolders: () => this.settings.excludedFolders,
			notify: (message, durationMs) => void new Notice(message, durationMs),
			afterMove: () => void noticeIfLinksNotUpdated(this.app),
			onHiddenMove: (oldPath, newPath) => {
				// Obsidian sends no rename event for a file it has hidden, so replay the placement hooks.
				const manualChanged = this.unitIndex.rewriteManualPromotions(oldPath, newPath);
				const dismissedChanged = this.unitIndex.rewriteDismissedAndAddedPaths(oldPath, newPath);
				if (manualChanged || dismissedChanged) this.persistDebounced();
				this.viewsManager.onVaultRename(oldPath, newPath);
			},
			openDialog: (options) => openNameDialog(this.app, options),
		});
		this.apiHeadersStore = new ApiHeadersStore(this.app);
		this.folderSourcePathStore = new FolderSourcePathStore(this.app);
		this.apiSourceController = new ApiSourceController();
		this.csvSourceController = new CsvSourceController();
		this.markdownTableSourceController = new MarkdownTableSourceController();
		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.linkSuggest = new AtlasLinkSuggest(this);
		this.registerEditorSuggest(this.linkSuggest);

		this.freeBlockTextCache = new FreeBlockTextCache(this);
		this.freeBlockTextCache.register();
		registerBlockLinkDisplayPostProcessor(this);
		this.registerEditorExtension([freeBlockLivePreviewPlugin(this, this.freeBlockTextCache)]);

		this.registerView(ATLAS_VIEW_TYPE, (leaf) => new AtlasExplorerView(leaf, this));

		this.app.workspace.onLayoutReady(() => {
			this.unitIndex.rebuild();
			void this.freeBlockTextCache.populateAll();
			// Deferred until layout is ready so the native `[[` suggester is already registered —
			// see docs/decisions.md for why this reorder is needed and how it degrades safely.
			applySuggesterPrecedence(this.app, this.linkSuggest);
			if (this.settings.replaceNativeExplorerOnStartup) {
				void this.activateExplorerView();
			}
		});

		this.registerEvent(this.app.vault.on("create", (file) => this.onVaultCreateEvent(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDeleteEvent(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRenameEvent(file, oldPath)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultModifyEvent(file)));
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				this.unitIndex.onMetadataResolved();
				this.graduation.handleResolved();
			})
		);

		registerAddBlockCommand(this);
		registerF10Commands(this);

		if (__ATLAS_TEST__) this.register(registerTestHarness(this));
	}

	/** A vault `modify` event. PR-1 (G5): deliberately never queues a folder refresh — a child's content
	 * edit changes no row, so only create, delete and rename reach `scheduleInsideFolderRefresh`. */
	onVaultModifyEvent(file: TAbstractFile): void {
		this.graduation.handleModify();
		// G21: a saved `.csv` file re-triggers every CSV-sourced node pointed at it, same as the
		// view-load/every-N-minutes triggers already do for API sources. PR-8: a saved `.md` file
		// does the same for every Markdown-Table-sourced node pointed at it.
		for (const leaf of this.app.workspace.getLeavesOfType(ATLAS_VIEW_TYPE)) {
			if (leaf.view instanceof AtlasExplorerView) {
				leaf.view.notifyCsvFileModified(file.path);
				leaf.view.notifyMarkdownTableFileModified(file.path);
			}
		}
	}

	/** PR-1 (G5): a vault `create` event — the index picks the new file up, and any Inside-Vault Folder
	 * source it is a direct child of refreshes live. */
	onVaultCreateEvent(file: TAbstractFile): void {
		this.unitIndex.onVaultCreate(file);
		this.scheduleInsideFolderRefresh([file.path]);
	}

	/** PR-1 (G5): a vault `delete` event. The live refresh is queued after the view's own delete handling,
	 * so the placeholder/mode reconciliation has already run by the time the folder re-reads. */
	onVaultDeleteEvent(file: TAbstractFile): void {
		this.unitIndex.onVaultDelete(file.path);
		this.graduation.handleDelete(file);
		// G27: clears any placeholder row's noteRef pointing at the deleted file — additive
		// alongside the two existing calls above, which this leaves untouched.
		this.viewsManager.onVaultDelete(file.path);
		this.scheduleInsideFolderRefresh([file.path]);
	}

	/** PR-1 (G5): a vault `rename` event. The live refresh is queued only after `viewsManager.onVaultRename`
	 * has run (rewrites refs, detaches a move-out) — it's a debounced timer, so it can never fire inline. */
	onVaultRenameEvent(file: TAbstractFile, oldPath: string): void {
		const promotionsChanged = this.unitIndex.onVaultRename(file, oldPath);
		this.viewsManager.onVaultRename(oldPath, file.path); // saves itself if anything changed
		this.scheduleInsideFolderRefresh([oldPath, file.path]);
		if (this.onModuleFolderRename(oldPath, file.path)) this.persistDebounced();
		if (promotionsChanged) this.persistDebounced();
		this.graduation.handleRename(file, oldPath); // last: only records the file and schedules the move for a later tick
	}

	/** PR-1 (G5): queues a live refresh for every Inside-Vault Folder source in the active view whose
	 * folder is the direct parent of one of `paths` — exact, case-sensitive match. A child's content
	 * edit never reaches here (only create/delete/rename do), and a grandchild's events never match. */
	private scheduleInsideFolderRefresh(paths: string[]): void {
		const parents = new Set(paths.map(parentFolderPath));
		const view = this.viewsManager.getActiveView();
		for (const nodeId of this.viewsManager.getInsideFolderSourceNodeIds(view.id, parents)) {
			this.folderLiveRefresh.schedule(nodeId);
		}
	}

	/** PR-1 (G5): the debounced refresh itself — always the active view, same as every other source trigger. */
	private refreshInsideFolderSource(nodeId: string): void {
		const view = this.viewsManager.getActiveView();
		this.viewsManager.refreshFolderSource(view.id, nodeId);
	}

	onunload() {
		this.folderLiveRefresh.cancelAll(); // PR-1 (G5): nothing fires after the plugin is gone
		this.graduation?.dispose(); // before closing the dialog, so a dismissed one doesn't revert or move anything
		closeNameDialog();
		removeSuggesterPrecedence(this.app, this.linkSuggest);
		this.persistDebounced?.run(); // flush any pending save rather than losing up to 500ms of drags
		console.debug("[Atlas] unloading");
	}

	/** PR 15 fix: re-renders every open Atlas explorer leaf — used by the settings tab right after a
	 * display-only toggle (Glow, Retain icons, Retained icon color) that nothing else would trigger
	 * a re-render for. More than one leaf is possible if the view is split. */
	refreshExplorerViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(ATLAS_VIEW_TYPE)) {
			if (leaf.view instanceof AtlasExplorerView) leaf.view.refresh();
		}
	}

	/** Opens the Atlas explorer in the left sidebar, reusing an existing leaf if one's already open. */
	async activateExplorerView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(ATLAS_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			await leaf?.setViewState({ type: ATLAS_VIEW_TYPE, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	private loadFromData(data: AtlasData | null): void {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		this.manualPromotions = data?.manualPromotions ?? [];
		this.dismissedByView = data?.dismissedByView ?? {};
		this.dismissedGlobal = data?.dismissedGlobal ?? [];
		this.addedItems = data?.addedItems ?? [];
		this.expandedModuleFolders = new Set(data?.expandedModuleFolders ?? []);
		if (!data) {
			this.settings.excludedFolders = computeDefaultExcludedFolders(this.app, this.settings.poolFolder);
		}
	}

	/** Saves right away and drops any pending debounced save: for changes that must survive an immediate reload. */
	async flushSave(): Promise<void> {
		this.persistDebounced.cancel();
		await this.persistNow();
	}

	private async persistNow(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			manualPromotions: this.unitIndex.getManualPromotions(),
			views: this.viewsManager.getViews(),
			activeViewId: this.viewsManager.getActiveViewId(),
			expandedModuleFolders: Array.from(this.expandedModuleFolders),
			statusSets: this.statusesManager.getStatusSets(),
			colorPalette: this.statusesManager.getColorPalette(),
			dismissedByView: this.unitIndex.getDismissedByView(),
			dismissedGlobal: this.unitIndex.getDismissedGlobal(),
			addedItems: this.unitIndex.getAddedItems(),
		} satisfies AtlasData);
	}

	/** PR 10: whether a module-internal subfolder should render expanded in a Module Contents modal.
	 * Defaults to collapsed (`false`) for any path never toggled before — matches "fully collapsed
	 * the first time a module is ever opened". */
	isModuleFolderExpanded(path: string): boolean {
		return this.expandedModuleFolders.has(path);
	}

	/** PR 10: persists a subfolder's fold state (debounced, same as drag/placement state) — no
	 * re-render side effect to worry about here, unlike the main tree's meta-folder collapse, since
	 * nothing else in the plugin reacts to this. */
	setModuleFolderExpanded(path: string, expanded: boolean): void {
		if (expanded) this.expandedModuleFolders.add(path);
		else this.expandedModuleFolders.delete(path);
		this.persistDebounced();
	}

	/** PR 10 review follow-up: rewrites (exact match or `oldPath/...` prefix, same rule
	 * `rewriteRefPath` applies to `UnitRef`s elsewhere) any tracked fold-state path affected by a
	 * vault rename, so a renamed subfolder keeps its remembered state instead of silently losing it
	 * at the new path while the old path leaks forever in `data.json`. Returns whether anything
	 * changed, so the caller only persists when needed. */
	private onModuleFolderRename(oldPath: string, newPath: string): boolean {
		let changed = false;
		for (const path of Array.from(this.expandedModuleFolders)) {
			let rewritten: string | null = null;
			if (path === oldPath) rewritten = newPath;
			else if (path.startsWith(`${oldPath}/`)) rewritten = `${newPath}${path.slice(oldPath.length)}`;
			if (rewritten !== null) {
				this.expandedModuleFolders.delete(path);
				this.expandedModuleFolders.add(rewritten);
				changed = true;
			}
		}
		return changed;
	}

	/** Settings changes are deliberate, infrequent user actions — save immediately rather than
	 * through the drag-oriented debounce views/promotions use. */
	async saveSettings(): Promise<void> {
		await this.persistNow();
	}

	async saveManualPromotions(): Promise<void> {
		await this.persistNow();
	}

	/** F1 AC: changing the pool folder re-indexes; free blocks left behind in the old folder are
	 * flagged with a warning instead of silently disappearing or being deleted. */
	async handlePoolFolderChanged(oldPoolFolder: string, newPoolFolder: string): Promise<void> {
		const excluded = new Set(this.settings.excludedFolders);
		excluded.delete(oldPoolFolder);
		excluded.add(newPoolFolder);
		this.settings.excludedFolders = Array.from(excluded);
		await this.saveSettings();
		this.unitIndex.rebuild();

		const oldFolder = this.app.vault.getAbstractFileByPath(oldPoolFolder);
		if (oldFolder instanceof TFolder) {
			const remaining = oldFolder.children.filter((child) => child instanceof TFile && child.extension === "md");
			if (remaining.length > 0) {
				new Notice(
					`Atlas: ${remaining.length} block(s) left behind in the old pool folder "${oldPoolFolder}" — move them into "${newPoolFolder}" to keep them as free blocks.`,
					10000
				);
			}
		}
	}
}
