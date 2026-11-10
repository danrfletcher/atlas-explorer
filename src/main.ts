import { Debouncer, FileSystemAdapter, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import {
	AtlasSettingTab,
	AtlasSettings,
	DEFAULT_SETTINGS,
	computeDefaultExcludedFolders,
	normalizeAutoPromotion,
	normalizeHighlightOpenNote,
	normalizeNoAutoPromoteFolders,
	rewriteNoAutoPromoteFolders,
} from "./settings";
import { UnitIndex, sanitizeHiddenModuleItems } from "./unit-index";
import { AddedItem, UnitRef, View } from "./types";
import { registerAddBlockCommand } from "./commands";
import { AtlasLinkSuggest } from "./link-suggest";
import { applySuggesterPrecedence, removeSuggesterPrecedence } from "./suggester-precedence";
import { FreeBlockTextCache, freeBlockLivePreviewPlugin, registerBlockLinkDisplayPostProcessor } from "./block-link-display";
import { ViewsManager } from "./views";
import { FolderLiveRefresh } from "./folder-live-refresh";
import { parentFolderPath } from "./folder-source";
import { ATLAS_VIEW_TYPE, AtlasExplorerView } from "./explorer-view";
import { registerSortIcons } from "./sort";
import { registerF10Commands } from "./f10-commands";
import { closeNameDialog, openNameDialog } from "./name-dialog";
import { GraduationController } from "./graduation";
import { noticeIfLinksNotUpdated } from "./links-notice";
import { registerTestHarness } from "./test-harness";
import { DEFAULT_COLOR_PALETTE, StatusSet, StatusesManager } from "./statuses";
import { ApiHeadersStore } from "./api-headers-store";
import { FolderSourcePathStore } from "./folder-source-path-store";
import { resolveOutsidePath } from "./folder-source-outside";
import { FolderSourceOutsideWatchers } from "./folder-source-outside-watcher";
import { ApiSourceController } from "./api-source-controller";
import { CsvSourceController } from "./csv-source-controller";
import { MarkdownTableSourceController } from "./markdown-table-source-controller";
import { ExternalMoveDetector } from "./external-move";
import { McpTokenStore } from "./mcp-token-store";
import { McpServer, shouldAutoStartMcpServer } from "./mcp-server";
import { createAtlasStatusTool } from "./mcp-tools";
import { McpTool } from "./mcp-protocol";
import { createGetNodeStatusTool, createListNodesTool, createListStatusSetsTool, createListViewsTool, createSetNodeStatusTool } from "./mcp-status-tools";
import { createAddNodeTool, createCreateFolderTool, createMoveNodeTool, createRemoveNodeTool, createRenameFolderTool } from "./mcp-arrange-tools";
import { RENDER_LOG_FILE, RenderLog, withRenderCause } from "./render-log";

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
	/** PR-2 (G2): module path -> vault paths of items hidden inside that module's Module Contents
	 * modal. Absent in a `data.json` written before this existed (read as nothing hidden). */
	hiddenModuleItems: Record<string, string[]>;
}

export default class AtlasPlugin extends Plugin {
	declare settings: AtlasSettings;
	manualPromotions: UnitRef[];
	/** PR-2: staged at load time, then handed to `UnitIndex`, which becomes authoritative — same
	 * lifecycle as `manualPromotions` above. */
	private dismissedByView: Record<string, UnitRef[]>;
	private dismissedGlobal: UnitRef[];
	private addedItems: AddedItem[];
	private hiddenModuleItems: Record<string, string[]>;
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
	/** PR-2 (G6/G9): live watchers on the active view's Outside-Vault Folder sources, one per folder. */
	outsideFolderWatchers: FolderSourceOutsideWatchers;
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
	/** PR-1.S1 (T1): pairs a `delete` with a later `create` of the same name/kind as an external move
	 * (e.g. a shell `mv`), which Obsidian reports as delete+create rather than `rename`. */
	private externalMoveDetector = new ExternalMoveDetector();
	/** PR-1.S1 (Q1/G1/F6): device-local storage for the embedded MCP server's port and bearer
	 * token — never synced, same pattern as `apiHeadersStore`/`folderSourcePathStore`. */
	mcpTokenStore: McpTokenStore;
	/** PR-1.S1 (F5): only ever constructed on desktop — `null` on mobile, where there is no
	 * listener, port or token work at all. */
	mcpServer: McpServer | null = null;
	/** PR-1 (render log): plugin-wide, so two open Atlas leaves share one log. Backed by
	 * `<plugin dir>/render-log.json` — never `data.json`. */
	renderLog: RenderLog;

	async onload() {
		const data = (await this.loadData()) as AtlasData | null;
		this.loadFromData(data);
		this.renderLog = new RenderLog(this.app.vault.adapter, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/${RENDER_LOG_FILE}`);
		await this.renderLog.load();

		this.persistDebounced = debounce(() => void this.persistNow(), 500, true);

		this.unitIndex = new UnitIndex(
			this.app,
			this.settings,
			this.manualPromotions,
			this.dismissedByView,
			this.dismissedGlobal,
			this.addedItems,
			this.hiddenModuleItems
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
			onHiddenMove: (oldPath, newPath) => this.handleHiddenMove(oldPath, newPath),
			openDialog: (options) => openNameDialog(this.app, options),
		});
		this.apiHeadersStore = new ApiHeadersStore(this.app);
		this.folderSourcePathStore = new FolderSourcePathStore(this.app);
		this.outsideFolderWatchers = new FolderSourceOutsideWatchers({
			isResolved: (path) => resolveOutsidePath(path),
			onRescan: (nodeId) => this.refreshOutsideFolderSource(nodeId),
		});
		// Rebuilt on every views change: a new or re-pointed source, and a view switch, all reach here through `onChange`.
		this.viewsManager.onChange(() => this.syncOutsideFolderWatchers());
		this.syncOutsideFolderWatchers();
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

		// PR-2 (T12): must run before registerView() below registers the view factory, so the
		// G13 indicator and the "Sort children…" menu item resolve a real icon the very first
		// time any view renders — see ATLAS_SORT_AZ_ICON_ID's doc comment in sort.ts.
		registerSortIcons();

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
				this.viewsManager.onMetadataResolved();
				this.unitIndex.onMetadataResolved();
				this.graduation.handleResolved();
			})
		);

		registerAddBlockCommand(this);
		registerF10Commands(this);

		// PR-1.S1 (F5): the MCP server (its listener, port and token work) is constructed only on
		// desktop — `mcpServer` stays `null` on mobile, so nothing in this block ever runs there.
		void this.initMcpServer();

		if (__ATLAS_TEST__) this.register(registerTestHarness(this));
	}

	/** PR-1.S1 (F5/G1/R4): constructs the device-local token store and, on desktop only, the MCP
	 * server itself, then auto-starts it when `mcpServerEnabled` is on — the single place this
	 * gating runs, so a test can drive exactly this method instead of re-implementing the
	 * `if (!Platform.isMobile) {...}` check inline (and so it actually proves what `onload` does). */
	private async initMcpServer(): Promise<void> {
		this.mcpTokenStore = new McpTokenStore(this.app);
		if (Platform.isMobile) return; // F5: no listener, port or token work at all on mobile
		this.mcpServer = this.createMcpServer();
		if (shouldAutoStartMcpServer(this.settings.mcpServerEnabled, Platform.isMobile)) {
			await this.mcpServer.start();
		}
	}

	/** PR-1.S1 (G8): builds the server with the one tool this PR ships — `atlas_status`. Later PRs
	 * (PR-2.F1/PR-3.F1) register their own tools on this same map, not a new server instance. */
	private createMcpServer(): McpServer {
		const tools = new Map<string, McpTool>();
		tools.set(
			"atlas_status",
			createAtlasStatusTool({
				getVaultName: () => this.app.vault.getName(),
				getVaultPath: () => this.getVaultBasePath(),
				getPluginVersion: () => this.manifest.version,
				getToolNames: () => Array.from(tools.keys()),
			})
		);
		// PR-2.F1 (G2/G3/G7): the read and status-write tools, registered on this same map — they
		// inherit the bearer-token check and JSON-RPC transport `atlas_status` already has for free,
		// since both go through the one `McpServer.handleRequest` path.
		const statusToolsContext = {
			getViewsManager: () => this.viewsManager,
			getStatusesManager: () => this.statusesManager,
			getVaultName: () => this.app.vault.getName(),
			getVaultPath: () => this.getVaultBasePath(),
			getFolderSourcePath: (nodeId: string) => this.folderSourcePathStore.get(nodeId),
		};
		tools.set("list_views", createListViewsTool(statusToolsContext));
		tools.set("list_nodes", createListNodesTool(statusToolsContext));
		tools.set("list_status_sets", createListStatusSetsTool(statusToolsContext));
		tools.set("get_node_status", createGetNodeStatusTool(statusToolsContext));
		tools.set("set_node_status", createSetNodeStatusTool(statusToolsContext));
		// PR-3.F1 (G4/G5/G6): the five arranging tools, registered on this same map — they share
		// the status tools' own vault identity and never touch the filesystem (F2/F3).
		const arrangeToolsContext = {
			getViewsManager: () => this.viewsManager,
			getVaultName: () => this.app.vault.getName(),
			getVaultPath: () => this.getVaultBasePath(),
			getVault: () => this.app.vault,
			getUnitIndex: () => this.unitIndex,
			getMetadataCache: () => this.app.metadataCache,
			promoteUnit: (ref: UnitRef) => {
				this.unitIndex.addManualPromotion(ref);
				void this.saveManualPromotions();
			},
			forgetDeviceLocalSourceState: (nodeId: string) => this.forgetDeviceLocalSourceState(nodeId),
		};
		tools.set("add_node", createAddNodeTool(arrangeToolsContext));
		tools.set("move_node", createMoveNodeTool(arrangeToolsContext));
		tools.set("remove_node", createRemoveNodeTool(arrangeToolsContext));
		tools.set("create_folder", createCreateFolderTool(arrangeToolsContext));
		tools.set("rename_folder", createRenameFolderTool(arrangeToolsContext));
		return new McpServer({
			getToken: () => this.mcpTokenStore.get().token,
			getPort: () => this.mcpTokenStore.get().port,
			tools,
			getServerInfo: () => ({ name: this.manifest.id, version: this.manifest.version }),
			notify: (message) => void new Notice(message),
			logError: (message, err) => console.error(message, err),
		});
	}

	/** The vault's absolute filesystem path (desktop only — mobile's adapter isn't a
	 * `FileSystemAdapter`, and the MCP server never runs there anyway). */
	private getVaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	}

	/** A vault `modify` event. PR-1 (G5): deliberately never queues a folder refresh — a child's content
	 * edit changes no row, so only create, delete and rename reach `scheduleInsideFolderRefresh`. */
	onVaultModifyEvent(file: TAbstractFile): void {
		this.graduation.handleModify();
		// G21: a saved `.csv` file re-triggers every CSV-sourced node pointed at it, same as the
		// view-load/every-N-minutes triggers already do for API sources. PR-8: a saved `.md` file
		// does the same for every Markdown-Table-sourced node pointed at it.
		this.notifyCsvOrMarkdownTableFileChanged(file.path);
	}

	/** PR-7 (R4 fix)/PR-8: shared by `onVaultModifyEvent` and `onVaultDeleteEvent` — re-triggers every
	 * CSV-/Markdown-Table-sourced node pointed at `path` in every open explorer view. Gated by
	 * extension before walking any view tree at all — every other vault event (images, canvases, an
	 * ordinary note with no table, anything non-`.csv`/`.md`) used to pay that walk for nothing.
	 * `notifyCsvFileModified` can only ever match a `.csv` source; `notifyMarkdownTableFileModified`
	 * can only ever match a `.md` one — neither source type is ever configured with any other
	 * extension. A deleted file's own controller sees it the same way a dead API URL would (its
	 * `getAbstractFileByPath` lookup simply fails), so reusing this on delete needs no separate
	 * "missing" handling — it's the same refresh path, just triggered one event earlier than the next
	 * view-load/timer/manual refresh would have caught it (PR-7 R6). */
	private notifyCsvOrMarkdownTableFileChanged(path: string): void {
		const isCsv = path.endsWith(".csv");
		const isMd = path.endsWith(".md");
		if (!isCsv && !isMd) return;
		for (const leaf of this.app.workspace.getLeavesOfType(ATLAS_VIEW_TYPE)) {
			if (leaf.view instanceof AtlasExplorerView) {
				if (isCsv) leaf.view.notifyCsvFileModified(path);
				if (isMd) leaf.view.notifyMarkdownTableFileModified(path);
			}
		}
	}

	/** PR-1 (G5): a vault `create` event — the index picks the new file up, and any Inside-Vault Folder
	 * source it is a direct child of refreshes live. PR-1.S1 (T1): also checks whether this pairs with
	 * a recent `delete` of the same name and kind at a different path — an external move Obsidian
	 * reports as delete+create instead of `rename` — and if so, replays the same reconciliation
	 * `onVaultRenameEvent` runs for an in-app rename. */
	onVaultCreateEvent(file: TAbstractFile): void {
		this.unitIndex.onVaultCreate(file);
		this.scheduleInsideFolderRefresh([file.path]);
		const oldPath = this.externalMoveDetector.matchCreate(file);
		if (oldPath !== null) this.onVaultRenameEvent(file, oldPath);
	}

	/** PR-1 (G5): a vault `delete` event. The live refresh is queued after the view's own delete handling,
	 * so the placeholder/mode reconciliation has already run by the time the folder re-reads. */
	onVaultDeleteEvent(file: TAbstractFile): void {
		this.unitIndex.onVaultDelete(file.path);
		if (this.unitIndex.pruneHiddenModuleItems(file.path)) this.persistDebounced(); // PR-2: no orphaned hidden entries
		this.graduation.handleDelete(file);
		// G27: clears any placeholder row's noteRef pointing at the deleted file — additive
		// alongside the two existing calls above, which this leaves untouched.
		this.viewsManager.onVaultDelete(file.path);
		this.scheduleInsideFolderRefresh([file.path]);
		// PR-7 (R6 fix): deleting a CSV/Markdown Table source's own backing file used to leave its red
		// "missing" dot showing only at the next view-load, timer tick or manual refresh. Same trigger
		// `onVaultModifyEvent` already uses for a save — see its own doc comment for why this needs no
		// separate "missing" handling.
		this.notifyCsvOrMarkdownTableFileChanged(file.path);
		this.externalMoveDetector.onDelete(file);
	}

	/** PR-1 (G5): a vault `rename` event. The live refresh is queued only after `viewsManager.onVaultRename`
	 * has run (rewrites refs, detaches a move-out) — it's a debounced timer, so it can never fire inline. */
	onVaultRenameEvent(file: TAbstractFile, oldPath: string): void {
		this.rewriteNoAutoPromoteOnRename(oldPath, file.path); // before onVaultRename: its folder branch rebuilds the index
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
		withRenderCause("folder-source-refresh", () => this.viewsManager.refreshFolderSource(view.id, nodeId));
	}

	/** PR-2 (G9): keeps the watcher registry in step with the active view's Outside-Vault sources. Mobile
	 * never watches (G7: outside sources don't run on mobile, and there is no fallback). */
	private syncOutsideFolderWatchers(): void {
		const sources = new Map<string, string>();
		if (!Platform.isMobile) {
			const view = this.viewsManager.getActiveView();
			for (const nodeId of this.viewsManager.getOutsideFolderSourceNodeIds(view.id)) {
				sources.set(nodeId, this.folderSourcePathStore.get(nodeId));
			}
		}
		this.outsideFolderWatchers.sync(sources);
	}

	/** PR-2 (G6): a watcher event's rescan for one source — the same refresh window focus runs, for one node. */
	private refreshOutsideFolderSource(nodeId: string): void {
		const view = this.viewsManager.getActiveView();
		withRenderCause("folder-source-refresh", () => this.viewsManager.refreshFolderSource(view.id, nodeId, this.folderSourcePathStore.get(nodeId)));
	}

	onunload() {
		this.folderLiveRefresh.cancelAll(); // PR-1 (G5): nothing fires after the plugin is gone
		this.externalMoveDetector?.cancelAll(); // PR-1.S1 (T1): same — no stray pairing after unload
		void this.mcpServer?.stop(); // PR-1.S1 (G1): stops the listener; any in-flight response still completes
		this.outsideFolderWatchers?.closeAll(); // PR-2 (G9): every watcher closes with the plugin
		this.graduation?.dispose(); // before closing the dialog, so a dismissed one doesn't revert or move anything
		closeNameDialog();
		removeSuggesterPrecedence(this.app, this.linkSuggest);
		this.persistDebounced?.run(); // flush any pending save rather than losing up to 500ms of drags
		void this.renderLog?.dispose(); // render log: write what's pending; a rejected write is swallowed inside
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
		// Always a fresh, normalised array: `Object.assign` above would otherwise share DEFAULT_SETTINGS' array.
		this.settings.noAutoPromoteFolders = normalizeNoAutoPromoteFolders(data?.settings?.noAutoPromoteFolders, this.settings.poolFolder);
		// PR-1.F2: a hand-edited non-boolean value must not throw and falls back to the default (on),
		// rather than being carried through by the plain `Object.assign` above.
		this.settings.highlightOpenNote = normalizeHighlightOpenNote(this.settings.highlightOpenNote);
		// PR-1 (G1): a missing or non-boolean value (an upgrade from a data.json without the key) is off.
		this.settings.autoPromotion = normalizeAutoPromotion(this.settings.autoPromotion);
		this.manualPromotions = data?.manualPromotions ?? [];
		this.dismissedByView = data?.dismissedByView ?? {};
		this.dismissedGlobal = data?.dismissedGlobal ?? [];
		this.addedItems = data?.addedItems ?? [];
		this.hiddenModuleItems = sanitizeHiddenModuleItems(data?.hiddenModuleItems);
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
			hiddenModuleItems: this.unitIndex.getHiddenModuleItems(),
		} satisfies AtlasData);
	}

	/** PR-2 (G2): hides or unhides one item of a module's contents. Plugin data only; saved through the
	 * debounced persist, so a run of quick clicks on the eye button writes once. A hide is recorded under
	 * the module being viewed; an unhide clears the item from every module's list, so the eye never reads
	 * "visible" while the item is still hidden through another module (`UnitIndex.isModuleItemHidden`). */
	setModuleItemHidden(modulePath: string, itemPath: string, hidden: boolean): void {
		const changed = hidden
			? this.unitIndex.setModuleItemHidden(modulePath, itemPath, true)
			: this.unitIndex.unhideItemEverywhere(itemPath);
		if (changed) this.persistDebounced();
	}

	/** PR-2 (G2): whether `itemPath` itself is hidden, in whichever module it was hidden from. The eye
	 * button reads this, so it agrees with what the inbox does with the item. */
	isModuleItemHidden(itemPath: string): boolean {
		return this.unitIndex.isItemHiddenInAnyModule(itemPath);
	}

	/** The hidden-list entry that hides `path` (itself or a folder above it), or null. Lets a module
	 * opened directly show that it is hidden as a whole, as the inbox treats it. */
	moduleHiddenBy(path: string): string | null {
		return this.unitIndex.findHiddenCover(path);
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

	/** Obsidian sends no rename event for a file it has hidden, so this replays the placement hooks. */
	handleHiddenMove(oldPath: string, newPath: string): void {
		this.rewriteNoAutoPromoteOnRename(oldPath, newPath); // same order as onVaultRenameEvent: save before anything else
		const manualChanged = this.unitIndex.rewriteManualPromotions(oldPath, newPath);
		const dismissedChanged = this.unitIndex.rewriteDismissedAndAddedPaths(oldPath, newPath);
		if (manualChanged || dismissedChanged) this.persistDebounced();
		this.viewsManager.onVaultRename(oldPath, newPath);
	}

	/** Keeps `noAutoPromoteFolders` pointing at a renamed or moved folder (E4). Assigns and saves right
	 * away, so the entry is on disk before the caller's index rebuild runs. No-op when nothing matches. */
	private rewriteNoAutoPromoteOnRename(oldPath: string, newPath: string): void {
		const rewritten = rewriteNoAutoPromoteFolders(this.settings.noAutoPromoteFolders, oldPath, newPath);
		if (!rewritten) return;
		this.settings.noAutoPromoteFolders = rewritten;
		void this.saveSettings();
	}

	/** Settings changes are deliberate, infrequent user actions — save immediately rather than
	 * through the drag-oriented debounce views/promotions use. */
	async saveSettings(): Promise<void> {
		await this.persistNow();
	}

	async saveManualPromotions(): Promise<void> {
		await this.persistNow();
	}

	/** PR-1 (G15e), shared by the explorer's own "Remove from view" and PR-3.F1's `remove_node` MCP
	 * tool: drops a node's device-local source state — its headers (`ApiHeadersStore`) and its
	 * Outside-Vault path (`FolderSourcePathStore`). Both are keyed by node id and never synced. One
	 * place, so no caller that deletes a sourced node can forget one of the two. */
	forgetDeviceLocalSourceState(nodeId: string): void {
		this.apiHeadersStore.delete(nodeId);
		this.folderSourcePathStore.delete(nodeId);
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
