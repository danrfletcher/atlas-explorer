import { App, FuzzyMatch, FuzzySuggestModal, ItemView, MarkdownView, Menu, Modal, Notice, Platform, TAbstractFile, TFile, TFolder, WorkspaceLeaf, renderResults, setIcon, setTooltip } from "obsidian";
import type AtlasPlugin from "./main";
import type { AtlasSettings } from "./settings";
import { ApiItemState, PLACEHOLDER_ROW_KIND, StatusGovernance, TruncatedStatusConfig, Unit, UnitRef, View, ViewNode, unitRefKey, unitToRef } from "./types";
import {
	ApiSourceIdPair,
	MetaTarget,
	collectApiSourceNodeIdPairs,
	collectOutsideFolderSourceNodeIdPairs,
	flattenMetaFolders,
	nodeHasApiRows,
} from "./views";
import { resolveOutsidePath } from "./folder-source-outside";
import { resolveUnit } from "./unit-display";
import { TextPromptModal, ConfirmModal, ConfirmDeleteRowsModal, StatusesModal } from "./modals";
import { StatusDefinition, pluralizeStatusLabel } from "./statuses";
import { openStatusPickerPopup } from "./status-popup";
import { createInterfaceNote, findInterfaceNote } from "./interface-notes";
import { addBlock } from "./commands";
import { addCreateModuleItem, startCreateModule, unitForRef } from "./create-module";
import { CreateKind, addCreateItem, startCreateFromMeta } from "./create-from-meta";
import { noticeIfLinksNotUpdated } from "./links-notice";
import { generateBlockId } from "./display-text";
import { ApiSourceModal } from "./api-source-modal";
import { ViewLoadTrigger, dotStateFor, dotTooltip } from "./api-source-controller";
import { obsidianRequestImpl } from "./api-request-obsidian";
import { apiItemMatchesFilter, formatLocalDateFromIso } from "./api-mapping";
import { MIN_REFRESH_MINUTES, RefreshEveryTimers } from "./api-refresh-timer";
import { executeApiCommand } from "./api-command-runner";
import { resolveArgv, tokenizeCommand } from "./command-argv";

export const ATLAS_VIEW_TYPE = "atlas-explorer";

/** F11: fixed row height assumed for inbox virtualization (all inbox rows are single-line,
 * `white-space: nowrap` per `.atlas-row` in styles.css, so this holds across Obsidian's own font
 * settings closely enough — a few px of slack either way just means a bit of overscan, not overlap). */
const INBOX_ROW_HEIGHT = 28;
/** Extra rows rendered above/below the visible window, so a fast scroll doesn't show blank gaps
 * before the next frame's window recomputes. */
const INBOX_OVERSCAN = 8;
/** Must match `.atlas-meta-children`'s and `.atlas-filter-wrap`'s `transition-duration` in
 * styles.css — every state-persisting toggle that triggers a full re-render (meta-folder collapse,
 * the bucket/inbox section headers, the filter-reveal toggle) delays that re-render by this long so
 * the CSS collapse/expand transition finishes playing before the DOM gets rebuilt out from under
 * it. PR 11: originally only the meta-folder chevron used this trick (hence the old name); the
 * bucket/inbox/filter toggles shipped in PR 9 without it, which is why none of them actually
 * animated despite having the CSS for it — same fix, applied to the rest of the collapse toggles. */
const COLLAPSE_TRANSITION_MS = 160;
/** PR 9 (issue 2, point 5): how long a drag has to hover a module (without dropping) before its
 * Contents modal opens automatically, mirroring the "hover a folder while dragging to expand it"
 * pattern most native file managers use. */
const MODULE_HOVER_DWELL_MS = 650;

/** PR 20: both variants now carry an array — a plain single-item drag is just the length-1 case,
 * so every existing drop-handling call site only needed to start iterating instead of gaining a
 * second, parallel "batch" code path next to the original single-item one. */
type DragPayload = { kind: "node"; nodeIds: string[]; viewId: string } | { kind: "inbox"; refs: UnitRef[] };

/** R14: an API item's label is arbitrary upstream data, not a filename Atlas chose — strip path
 * separators and other characters the vault/filesystem reject or reinterpret before using it as
 * one, so attaching a note/block/module to an item never throws or nests into an unrelated path. */
function sanitizeFileName(name: string): string {
	return name.replace(/[/\\:*?"<>|]/g, "-").trim();
}

/** PR-1.F2 (G3): one inbox row as the sort sees it. */
export interface InboxSortRow {
	unit: Unit;
	/** The row's displayed text (`RowInfo.text`), used for name order. */
	text: string;
}

/** PR-1.F2 (G3): the inbox sort, extracted as a pure comparator so it is unit-testable. Alphabetical
 * mode orders every row by name, files and modules interleaved. Newest-first (any other mode) puts
 * files first by ctime, newest first, then every module (folder-kind unit: folder-unit, promoted-folder,
 * added-folder) ordered by name. Ties on name or ctime fall back to path, so a re-render never reorders
 * rows that compare equal. `lookup` is the vault's `getAbstractFileByPath`, read only for a file's ctime. */
export function compareInboxRows(
	a: InboxSortRow,
	b: InboxSortRow,
	alphabetical: boolean,
	lookup: (path: string) => TAbstractFile | null
): number {
	const byName = (): number => a.text.localeCompare(b.text) || a.unit.path.localeCompare(b.unit.path);
	if (alphabetical) return byName();
	const aIsModule = unitToRef(a.unit).kind === "folder";
	const bIsModule = unitToRef(b.unit).kind === "folder";
	if (aIsModule !== bIsModule) return aIsModule ? 1 : -1;
	if (aIsModule) return byName();
	const fileA = lookup(a.unit.path);
	const fileB = lookup(b.unit.path);
	const ctimeA = fileA instanceof TFile ? fileA.stat.ctime : 0;
	const ctimeB = fileB instanceof TFile ? fileB.stat.ctime : 0;
	return ctimeB - ctimeA || byName();
}

interface RowInfo {
	text: string;
	secondary?: string;
	icon: string;
	promoted: boolean;
	/** PR-3 (G3): renders an "added" badge in place of "promoted" — the two are mutually exclusive. */
	added: boolean;
	missing: boolean;
}

export class ViewSuggestModal extends FuzzySuggestModal<View> {
	constructor(app: AtlasPlugin["app"], private views: View[], private onChoose: (view: View) => void) {
		super(app);
	}
	getItems(): View[] {
		return this.views;
	}
	getItemText(view: View): string {
		return view.name;
	}
	onChooseItem(view: View): void {
		this.onChoose(view);
	}
}

export class MetaFolderSuggestModal extends FuzzySuggestModal<MetaTarget> {
	constructor(app: AtlasPlugin["app"], private targets: MetaTarget[], private onChoose: (target: MetaTarget) => void) {
		super(app);
	}
	getItems(): MetaTarget[] {
		return this.targets;
	}
	getItemText(target: MetaTarget): string {
		return target.label;
	}
	onChooseItem(target: MetaTarget): void {
		this.onChoose(target);
	}
}

/** PR-3 (G2): the "+" inbox-add modal. Deliberately broader than auto-promotion eligibility — its
 * list source is every vault file, not the "references outside the module" rule (F3) — narrowed only
 * by the candidate builders' already-a-unit-somewhere exclusion. PR-1.F1: one mixed list of files
 * and sub-folders; a folder row shows as `path/` with a folder icon, a file row as `path` with a file icon. */
export class AddFileSuggestModal extends FuzzySuggestModal<TFile | TFolder> {
	constructor(app: AtlasPlugin["app"], private items: (TFile | TFolder)[], private onChoose: (item: TFile | TFolder) => void) {
		super(app);
	}
	getItems(): (TFile | TFolder)[] {
		return this.items;
	}
	getItemText(item: TFile | TFolder): string {
		return item instanceof TFolder ? `${item.path}/` : item.path;
	}
	onChooseItem(item: TFile | TFolder): void {
		this.onChoose(item);
	}
	renderSuggestion(match: FuzzyMatch<TFile | TFolder>, el: HTMLElement): void {
		el.addClass("atlas-add-suggest-item");
		const iconEl = el.createSpan({ cls: "atlas-add-suggest-icon" });
		setIcon(iconEl, match.item instanceof TFolder ? "folder" : "file");
		const textEl = el.createSpan({ cls: "atlas-add-suggest-text" });
		renderResults(textEl, this.getItemText(match.item), match.match);
	}
}

/** PR-3 (G2, E4): every vault file minus any file already a unit somewhere (auto-promoted, manually
 * promoted, already added) or already placed/nested as a node in any view — so picking one from the
 * modal can never produce a duplicate inbox row. List-level exclusion only: no runtime dedupe is
 * exercised once a file is chosen. PR-1.F1 (G12): an added folder's interface note (`<Folder>/<Folder>.md`)
 * is excluded too, until that folder is dismissed for good (`isGloballyDismissed`); a promoted folder's
 * note is still offered. */
export function candidateFilesForAdd(
	allFiles: TFile[],
	units: Unit[],
	isPlacedAnywhere: (ref: UnitRef) => boolean,
	isGloballyDismissed: (ref: UnitRef) => boolean = () => false
): TFile[] {
	// R2: only a *file-kind* ref counts as "the file already present as a unit" (G2) — a promoted-block
	// unit's `.path` is its containing file's path even though it's kind "block" (per `unitToRef`), so
	// comparing bare paths wrongly excluded a file whose only unit is a promoted block from this list.
	const fileRefKeys = new Set(
		units.filter((unit) => unitToRef(unit).kind === "file").map((unit) => unitRefKey(unitToRef(unit)))
	);
	for (const unit of units) {
		if (unit.type !== "added-folder") continue;
		if (isGloballyDismissed({ kind: "folder", path: unit.path })) continue;
		const folderName = unit.path.slice(unit.path.lastIndexOf("/") + 1);
		fileRefKeys.add(unitRefKey({ kind: "file", path: `${unit.path}/${folderName}.md` }));
	}
	return allFiles.filter(
		(file) => !fileRefKeys.has(unitRefKey({ kind: "file", path: file.path })) && !isPlacedAnywhere({ kind: "file", path: file.path })
	);
}

/** PR-1.F1 (G1, F2, E9): every sub-folder the "+" picker may offer. Lists the folders itself from
 * `allLoaded` (`vault.getAllLoadedFiles()`). A folder is offered only when it is not a vault-root
 * folder, not already a unit (folder-units, promoted, Folder-source-managed or added folders), not
 * placed in any view (bucket or inbox), not the pool folder or inside it, and not inside an excluded
 * folder. Unit and placed lookups are Sets built once per call, so the cost is linear in the vault. */
export function candidateFoldersForAdd(
	allLoaded: TAbstractFile[],
	units: Unit[],
	placedRefKeys: Set<string>,
	settings: Pick<AtlasSettings, "poolFolder" | "excludedFolders">
): TFolder[] {
	const unitFolderKeys = new Set(
		units.filter((unit) => unitToRef(unit).kind === "folder").map((unit) => unitRefKey(unitToRef(unit)))
	);
	const { poolFolder, excludedFolders } = settings;
	const isWithin = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}/`);
	return allLoaded.filter((entry): entry is TFolder => entry instanceof TFolder).filter((folder) => {
		const key = unitRefKey({ kind: "folder", path: folder.path });
		if (folder.isRoot() || !folder.path.includes("/")) return false;
		if (unitFolderKeys.has(key) || placedRefKeys.has(key)) return false;
		if (isWithin(folder.path, poolFolder)) return false;
		return !excludedFolders.some((excluded) => isWithin(folder.path, excluded));
	});
}

/** PR 9 (issue 2): replaces inline fold/unfold for modules with a browsable read-only tree of the
 * module's physical internals — modules are opaque, first-class units whose internal organization
 * Atlas doesn't otherwise rearrange, so this is look-don't-touch by default (clicking a file opens
 * it and closes the modal; right-click still offers "Reveal in native explorer", same as before).
 * In `dropTarget` mode (only ever passed when opened via the hover-during-drag gesture, issue 2
 * point 5) every folder shown — including the module's own root — becomes a live drop target for
 * whatever's still being dragged, skipping the usual confirm dialog entirely, since choosing an
 * exact destination inside this modal already *is* the confirmation. */
export interface ModuleContentsModalCallbacks {
	onOpenFile: (file: TFile) => void;
	onRevealInNative: (path: string) => void;
	onPromoteAndPlace: (path: string, isFolder: boolean) => void;
	/** Set only when opened via the hover-during-drag gesture — every folder shown becomes a live
	 * drop target for the drag still in progress, and dropping skips the usual confirm dialog. */
	dropTarget?: { onDrop: (targetFolderPath: string) => void };
	onCloseCallback?: () => void;
	/** PR 10: whether a subfolder (by vault path) should render expanded — backed by
	 * `AtlasPlugin.isModuleFolderExpanded`, persisted across modal close/reopen and Obsidian
	 * restarts. Defaults to collapsed for any path never toggled before. */
	isFolderExpanded: (path: string) => boolean;
	/** PR 10: called when the user clicks a subfolder's chevron, so the explorer view can persist
	 * the new state via `AtlasPlugin.setModuleFolderExpanded`. */
	onToggleFolder: (path: string, expanded: boolean) => void;
}

export class ModuleContentsModal extends Modal {
	private filterText = "";
	private rows: { el: HTMLElement; name: string }[] = [];

	constructor(app: App, private folder: TFolder, private callbacks: ModuleContentsModalCallbacks) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.folder.name);
		this.contentEl.addClass("atlas-module-modal-content");
		const treeEl = this.contentEl.createDiv({ cls: "atlas-module-modal-tree" });

		if (this.callbacks.dropTarget) {
			const rootRow = treeEl.createDiv({ cls: "atlas-row atlas-row-internal atlas-module-modal-root" });
			rootRow.createSpan({ cls: "atlas-row-text", text: `${this.folder.name} (module root)` });
			this.wireDropZone(rootRow, this.folder.path);
			this.rows.push({ el: rootRow, name: this.folder.name });
		}

		this.renderTree(this.folder, treeEl, 0);
		if (this.filterText) this.setFilterText(this.filterText);
	}

	onClose(): void {
		this.contentEl.empty();
		this.callbacks.onCloseCallback?.();
	}

	/** Re-applies match highlighting against a (possibly changed) filter without closing/reopening —
	 * called live by the explorer view while this modal is open and the filter text changes. */
	setFilterText(text: string): void {
		this.filterText = text;
		const needle = text.trim().toLowerCase();
		for (const { el, name } of this.rows) {
			el.toggleClass("atlas-row-filter-match", needle.length > 0 && name.toLowerCase().includes(needle));
		}
	}

	/** PR 10: a folder child gets its own chevron and a dedicated children-wrapper (the same
	 * `.atlas-meta-children`/`-inner` grid-collapse technique used everywhere else in the plugin),
	 * so fold/unfold animates and each subfolder's state is independent. Toggling here has no
	 * re-render side effect to worry about (unlike the main tree's meta-folder collapse, whose
	 * persist call triggers a full external re-render) — it's just a class toggle plus a debounced
	 * write, so no delayed-persist trick is needed. */
	private renderTree(folder: TFolder, container: HTMLElement, depth: number): void {
		for (const child of folder.children) {
			const row = container.createDiv({ cls: "atlas-row atlas-row-internal" });
			row.style.paddingLeft = `${depth * 16 + 16}px`;
			// Always reserve the chevron's slot, even for a file (which never gets one) — otherwise
			// a file's icon sits flush against the row's edge while a folder's icon is pushed right
			// by its chevron, so icons at the same depth don't line up (found in Dan's own testing
			// of this PR). An empty same-width spacer keeps every icon at a depth aligned regardless
			// of which rows happen to be folders.
			const chevron = row.createDiv({ cls: "atlas-chevron" });
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			setIcon(iconEl, child instanceof TFolder ? "folder" : "file");
			row.createSpan({ cls: "atlas-row-text", text: child.name });
			this.rows.push({ el: row, name: child.name });

			if (child instanceof TFile) {
				row.addEventListener("click", () => {
					this.callbacks.onOpenFile(child);
					this.close();
				});
			} else if (this.callbacks.dropTarget) {
				this.wireDropZone(row, child.path);
			}
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle("Reveal in native explorer")
						.setIcon("folder-open")
						.onClick(() => this.callbacks.onRevealInNative(child.path))
				);
				menu.addItem((item) =>
					item
						.setTitle("Promote and place in view…")
						.setIcon("arrow-right-left")
						.onClick(() => {
							this.callbacks.onPromoteAndPlace(child.path, child instanceof TFolder);
							this.close();
						})
				);
				menu.showAtMouseEvent(evt);
			});

			if (child instanceof TFolder) {
				let expanded = this.callbacks.isFolderExpanded(child.path);
				setIcon(chevron, expanded ? "chevron-down" : "chevron-right");

				const childrenWrap = container.createDiv({ cls: "atlas-meta-children" });
				childrenWrap.toggleClass("is-collapsed", !expanded);
				const childrenInner = childrenWrap.createDiv({ cls: "atlas-meta-children-inner" });
				this.renderTree(child, childrenInner, depth + 1);

				chevron.addEventListener("click", (evt) => {
					evt.stopPropagation();
					expanded = !expanded;
					setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
					childrenWrap.toggleClass("is-collapsed", !expanded);
					this.callbacks.onToggleFolder(child.path, expanded);
				});
			}
		}
	}

	private wireDropZone(row: HTMLElement, folderPath: string): void {
		row.addEventListener("dragover", (evt) => {
			evt.preventDefault();
			row.addClass("atlas-drop-target");
		});
		row.addEventListener("dragleave", () => row.removeClass("atlas-drop-target"));
		row.addEventListener("drop", (evt) => {
			evt.preventDefault();
			row.removeClass("atlas-drop-target");
			this.callbacks.dropTarget?.onDrop(folderPath);
			this.close();
		});
	}
}

/**
 * F8 — the explorer view. A flat unit index (F2) arranged into a bucket tree per view (F9). This
 * view never moves anything on disk — the only filesystem writes anywhere in it are `vault.create`
 * (Add block/file/folder) and `createInterfaceNote`, both already on Part 7's allowed list. Every
 * drag/promote/placement path below is plugin-data only.
 */
export class AtlasExplorerView extends ItemView {
	private filterText = "";
	private sortMode: "manual" | "alphabetical" = "manual";
	private bucketCollapsed = false;
	private inboxCollapsed = true;
	/** PR-5 (G7/G8): whether dismissed inbox rows render inline, tagged "hidden". Mirrors
	 * `inboxCollapsed` — a single instance field rather than per-view, matching this view's existing
	 * convention that transient section-header UI state is shared across view switches within the
	 * same explorer instance, not stored per `View`. Off by default on fresh load, same as collapse. */
	private showDismissed = false;
	/** PR 9: filter input is hidden behind a reveal toggle now instead of always shown. */
	private filterRevealed = false;
	/** One-shot: set when the reveal toggle is clicked open, consumed by the very next
	 * `renderToolbar` call so the newly-created input is auto-focused exactly once, not on every
	 * render while revealed (which would fight the existing focus-preservation logic in `render()`). */
	private focusFilterOnNextRender = false;
	/** PR 9: a folder's collapsed state as it was *before* the current filter run started
	 * auto-revealing folders that contain a match — restored verbatim once the filter clears, so
	 * filtering never permanently changes what the user had manually folded/unfolded. `undefined`
	 * (rather than absent from the map) is a valid stored value, so presence-checking uses `has`. */
	private preFilterCollapsedState: Map<string, boolean | undefined> | null = null;
	/** PR 9 (issue 6): tracked so the filter input's handler can push a live update into an
	 * already-open Module Contents modal, rather than the modal only ever seeing the filter text
	 * that was active at the moment it was opened. */
	private openModuleModal: ModuleContentsModal | null = null;
	/** PR 19: which truncated-status groups are currently expanded back to their individual member
	 * rows, keyed by `${governor kind}:${governor id}:${statusId}` (see `renderNodeList`'s `keyOf`).
	 * Ephemeral UI state, not persisted — matches every other fold-state field on this view, and a
	 * collapsed-by-default group is the expected state on next load, same as a freshly-opened bucket. */
	private expandedTruncationGroups = new Set<string>();
	/** PR 20: multi-select (F8's own spec — "shift/cmd-click; drag moves the whole selection").
	 * Bucket and inbox each get their own selection, mutually exclusive: selecting in one always
	 * clears the other, same as most apps treat two independent list panes rather than trying to
	 * support a single drag gesture that mixes a placed node and an unplaced ref (genuinely different
	 * operations at drop time — `moveNode` vs `placeUnit`). Keyed by node id (bucket) / ref key
	 * (inbox) rather than storing node/ref objects directly, so a stale reference from a prior render
	 * can never leak in — every read goes back through `ViewsManager`/`unitRefKey` at use time. */
	private selectedBucketNodeIds = new Set<string>();
	private selectedInboxRefKeys = new Set<string>();
	/** PR 20: which view's ids the current bucket selection belongs to — see `render()`'s own use of
	 * this (clears the bucket selection on a view switch; inbox selection is unaffected). */
	private lastRenderedViewId: string | null = null;
	/** The last row clicked (in either scope) — where a following shift-click's range starts from.
	 * Cleared implicitly by scope: a shift-click only extends a range if the anchor's own scope
	 * matches the row just clicked, so a stray shift-click in the *other* list can't try to build a
	 * range across two unrelated lists. */
	private selectionAnchor: string | null = null;
	private selectionAnchorScope: "bucket" | "inbox" | null = null;
	/** PR 20: the bucket's own node-list container from the most recent render — queried live at
	 * shift-click time (`getBoundingClientRect().height > 0`) to build the visible row order a range
	 * selects across, so a collapsed folder's hidden contents and a filtered-out row are both
	 * correctly excluded from the range without a second, parallel bookkeeping structure to keep in
	 * sync with the DOM. */
	private bucketListEl: HTMLElement | null = null;
	/** PR 20: the inbox's own stable sort order from the most recent render, captured once right
	 * after it's computed (`renderInboxSection`) rather than queried from the DOM like the bucket's
	 * — F11's virtualization means most inbox rows genuinely aren't in the DOM at any given moment,
	 * so a DOM query would silently miss whatever's currently scrolled out of view. */
	private inboxSelectOrder: string[] = [];
	private inboxRefByKey = new Map<string, UnitRef>();
	private dragPayload: DragPayload | null = null;
	/** Review follow-up (retroactive PR 9 finding): cancels whichever module row's dwell timer is
	 * currently pending, if any — invoked from the window-level `dragend` backstop below. At most
	 * one dwell timer is ever pending at a time in practice (only one row can be mid-hover during a
	 * single drag), so a single reference is enough; each `wireModuleRow` call points this at its
	 * own `cancelDwell` while its timer is live and clears it again once the timer fires or cancels
	 * normally via `dragleave`/`drop`. */
	private cancelActiveDwell: (() => void) | null = null;
	/** G5a: fires refresh-on-view-load exactly once per open/return of this leaf, not on every
	 * unrelated re-render. */
	private viewLoadTrigger = new ViewLoadTrigger();
	/** G5b/F3: one interval per API Folder with "Refresh every X minutes" on, scoped to the *active*
	 * named View only — same scoping G5a's own view-load refresh already uses, so switching to a
	 * different View stops timers for Folders that aren't currently showing, and returning to this one
	 * schedules them fresh (with at most one immediate catch-up refresh if it's overdue, never a burst).
	 * Alive only for as long as this Atlas leaf itself is open — `onClose()` stops every one of them. */
	private refreshEveryTimers = new RefreshEveryTimers();
	private unsubscribers: (() => void)[] = [];
	/** R1: a `ConfirmDeleteRowsModal` opened from `refreshApiSource` belongs to the app, not this leaf —
	 * Obsidian never closes it just because the leaf that opened it did. Tracked here so `onClose` can
	 * close every still-open one itself, resolving it as "dismissed" (the edge case: "confirmation modal
	 * dismissed by ... view close counts as unanswered on an automatic refresh"). */
	private openConfirmDeleteModals: ConfirmDeleteRowsModal[] = [];
	private renderQueued = false;
	/** F11: rebuilt once per render from the flat unit list, so resolving a ref is O(1) instead of
	 * an O(n) `find` per row — at thousands of units the naive scan-per-row was O(n^2) per render. */
	private unitsByRefKey = new Map<string, Unit>();
	/** Tracked so `render()` can restore focus/caret after rebuilding the toolbar — see the comment
	 * in `render()` for why this is necessary at all. */
	private filterInputEl: HTMLInputElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AtlasPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ATLAS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Atlas";
	}

	getIcon(): string {
		return "map";
	}

	async onOpen(): Promise<void> {
		this.unsubscribers.push(this.plugin.unitIndex.onChange(() => this.queueRender()));
		this.unsubscribers.push(this.plugin.viewsManager.onChange(() => this.queueRender()));
		this.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
				this.updateActiveHighlight();
				if (leaf === this.leaf) {
					if (this.viewLoadTrigger.activate()) this.refreshApiSourcesOnViewLoad();
				} else {
					this.viewLoadTrigger.deactivate();
				}
			})
		);
		if (this.viewLoadTrigger.activate()) this.refreshApiSourcesOnViewLoad();
		this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.updateActiveHighlight()));
		// G11/F10: Outside-Vault connection/children recheck on focus-regain — fires only from this
		// real browser event, never a self-scheduling timer/interval/poll (F10's own fence).
		this.registerDomEvent(window, "focus", () => this.refreshOutsideFolderSourcesOnFocus());
		// Review follow-up (retroactive PR 9 finding): `dragPayload` was only ever cleared by a
		// specific row's own `drop` handler or a Module Contents modal closing — never by a drag
		// ending abnormally (dropped outside the window, over an uninstrumented area, cancelled via
		// Escape). A stale `dragPayload` was harmless before PR 9 (nothing read it outside an active
		// drop), but PR 9's dwell timer treats its mere presence as proof a drag is live, so a later,
		// unrelated drag hovering a module row within the dwell window could pop the Contents modal
		// using stale drag data. This window-level backstop clears it (and cancels any pending dwell
		// timer) whenever a drag ends, regardless of how.
		this.registerDomEvent(window, "dragend", () => {
			this.dragPayload = null;
			this.cancelActiveDwell?.();
			// PR 20 follow-up (reviewer-caught, A27): a successful drop already repaints via
			// `handleDrop`, but an *abandoned* drag (dropped outside any registered zone, or
			// cancelled with Escape) never reaches that — same "state correct, paint stale" bug
			// family as the two Dan just found, just the one remaining branch.
			//
			// Reviewer follow-up, same review round: the first version of this fix used `queueRender`
			// here specifically to *claim* it would coalesce with a same-tick `handleDrop` render —
			// but `handleDrop` called `void this.render()` directly (like a dozen+ other call sites in
			// this file), which never touches `queueRender`'s own dedup flag, so the two never
			// actually coalesced; a successful drop was silently doing two render passes, harmless but
			// not what the comment claimed. Fixed for real this time, not just re-worded: `handleDrop`
			// now calls `queueRender()` too (both of its own call sites), so the flag this relies on is
			// actually shared and a successful drop really is one render, not two.
			this.queueRender();
		});
		await this.render();
	}

	async onClose(): Promise<void> {
		for (const unsub of this.unsubscribers) unsub();
		this.refreshEveryTimers.stopAll();
		// R1: closing each modal fires its own onClose, which reports "dismissed" and (via the callback
		// wired in refreshApiSource) removes itself from this array — iterate a copy so that in-loop
		// mutation of the live array never skips an entry.
		for (const modal of [...this.openConfirmDeleteModals]) modal.close();
	}

	/** Collapses bursts of index/view change events (a drag can fire several) into one render. */
	private queueRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.setTimeout(() => {
			this.renderQueued = false;
			void this.render();
		}, 0);
	}

	/** PR 15 fix (Dan-found): Glow/Retain icons/Retained icon color are read fresh on every render,
	 * but nothing was triggering a render when they changed in Settings — `unitIndex`/`viewsManager`
	 * changes already auto-refresh via `queueRender` (wired in `onOpen`), these plain settings don't
	 * go through either, so toggling one silently had no visible effect until something else
	 * happened to re-render. Called by the settings tab right after `saveSettings()` for exactly
	 * these toggles. */
	refresh(): void {
		this.queueRender();
	}

	/** PR-7 (G21): called from `main.ts`'s vault `"modify"` listener on every file save — refreshes
	 * every CSV-sourced node in the active view whose `csvSource.path` matches the modified file.
	 * Scoped to the active view only, mirroring `refreshApiSourcesOnViewLoad`/`syncRefreshTimers`'s own
	 * scoping (a Folder in a non-active view has no live timer either). */
	notifyCsvFileModified(path: string): void {
		const view = this.plugin.viewsManager.getActiveView();
		for (const node of this.collectCsvSourceNodes(view.root)) {
			if (node.csvSource?.path === path) this.refreshCsvSource(view, node, "automatic");
		}
	}

	/** PR-8 (G21): same role as `notifyCsvFileModified` above, for Markdown Table sources — called
	 * from `main.ts`'s vault `"modify"` listener on every file save, reusing the exact same
	 * refresh-toggle plumbing (no new refresh UI). */
	notifyMarkdownTableFileModified(path: string): void {
		const view = this.plugin.viewsManager.getActiveView();
		for (const node of this.collectMarkdownTableSourceNodes(view.root)) {
			if (node.markdownTableSource?.path === path) this.refreshMarkdownTableSource(view, node, "automatic");
		}
	}

	// --- G1/G5/G6/G11: API-backed Folders ---------------------------------------------------------

	/** G5a/PR-4 (G10): refreshes every Folder in the active view that has "refresh when Atlas view
	 * loads" on — both API and (Inside-Vault) Folder sources, reusing this same trigger/toggle. */
	private refreshApiSourcesOnViewLoad(): void {
		const view = this.plugin.viewsManager.getActiveView();
		for (const node of this.collectApiSourceNodes(view.root)) {
			if (node.apiSource?.refreshOnViewLoad) this.refreshApiSource(view, node, "automatic");
		}
		for (const node of this.collectFolderSourceNodes(view.root)) {
			// G11: Outside-Vault's connection/children check on load is mandatory, independent of the
			// optional "refresh on view load" toggle (G10) — Inside-Vault keeps the toggle-gated
			// behavior unchanged, exactly as before this PR.
			if (node.folderSource?.refreshOnViewLoad || node.folderSource?.location === "outside") {
				this.refreshFolderSource(view, node);
			}
		}
		for (const node of this.collectCsvSourceNodes(view.root)) {
			if (node.csvSource?.refreshOnViewLoad) this.refreshCsvSource(view, node, "automatic");
		}
		for (const node of this.collectMarkdownTableSourceNodes(view.root)) {
			if (node.markdownTableSource?.refreshOnViewLoad) this.refreshMarkdownTableSource(view, node, "automatic");
		}
	}

	/** G11/F10: re-checks every Outside-Vault Folder source in the active view on focus-regain —
	 * recomputes its children (via `refreshFolderSource`, which looks the current device-local path up
	 * fresh) so a since-resolved or since-unresolved path's managed children reappear/clear
	 * automatically; the indicator dot itself needs no separate refresh call since it already
	 * recomputes `resolveOutsidePath` live on every render. */
	private refreshOutsideFolderSourcesOnFocus(): void {
		const view = this.plugin.viewsManager.getActiveView();
		for (const node of this.collectFolderSourceNodes(view.root)) {
			if (node.folderSource?.location === "outside") this.refreshFolderSource(view, node);
		}
	}

	private collectApiSourceNodes(nodes: ViewNode[]): ViewNode[] {
		const out: ViewNode[] = [];
		for (const node of nodes) {
			if (node.type === "meta") {
				if (node.apiSource) out.push(node);
				out.push(...this.collectApiSourceNodes(node.children));
			}
		}
		return out;
	}

	/** PR-4 (G10): same walk as `collectApiSourceNodes`, for Folder sources — kept as its own
	 * function rather than merged into one, since the two are gated/dispatched on different fields
	 * (`apiSource` vs `folderSource`) at every call site anyway. */
	private collectFolderSourceNodes(nodes: ViewNode[]): ViewNode[] {
		const out: ViewNode[] = [];
		for (const node of nodes) {
			if (node.type === "meta") {
				if (node.folderSource) out.push(node);
				out.push(...this.collectFolderSourceNodes(node.children));
			}
		}
		return out;
	}

	/** PR-7 (G21): same walk as `collectApiSourceNodes`/`collectFolderSourceNodes`, for CSV sources —
	 * kept as its own function for the same reason the other two are: each is gated/dispatched on its
	 * own field at every call site anyway. */
	private collectCsvSourceNodes(nodes: ViewNode[]): ViewNode[] {
		const out: ViewNode[] = [];
		for (const node of nodes) {
			if (node.type === "meta") {
				if (node.csvSource) out.push(node);
				out.push(...this.collectCsvSourceNodes(node.children));
			}
		}
		return out;
	}

	/** PR-8 (G21): same walk as `collectCsvSourceNodes`, for Markdown Table sources. */
	private collectMarkdownTableSourceNodes(nodes: ViewNode[]): ViewNode[] {
		const out: ViewNode[] = [];
		for (const node of nodes) {
			if (node.type === "meta") {
				if (node.markdownTableSource) out.push(node);
				out.push(...this.collectMarkdownTableSourceNodes(node.children));
			}
		}
		return out;
	}

	/** G5b/F3/PR-4 (G10): (re)schedules this Atlas view's "Refresh every X minutes" timers against
	 * the active View's current set of eligible Folders — both API and Folder sources feed the same
	 * scheduler (`RefreshEveryTimers` is already source-type-agnostic), so no new scheduler is
	 * introduced for Folder sources. Called after every render, so a saved config change (interval
	 * edited, toggle flipped, source removed) reschedules cleanly on the very next render rather than
	 * needing a dedicated call site of its own for each way that can happen. */
	private syncRefreshTimers(view: View): void {
		const apiNodes = this.collectApiSourceNodes(view.root)
			.filter((node) => node.apiSource?.refreshEveryMinutesEnabled)
			.map((node) => ({
				id: node.id,
				enabled: true,
				minutes: node.apiSource?.refreshEveryMinutes ?? MIN_REFRESH_MINUTES,
				lastFetchedAt: node.apiCache?.fetchedAt ?? null,
			}));
		const folderNodes = this.collectFolderSourceNodes(view.root)
			.filter((node) => node.folderSource?.refreshEveryMinutesEnabled)
			.map((node) => ({
				id: node.id,
				enabled: true,
				minutes: node.folderSource?.refreshEveryMinutes ?? MIN_REFRESH_MINUTES,
				// PR-4: a Folder source has no fetch-timestamp cache of its own (its "cache" is just the
				// real children it manages) — always `null`, so a never-refreshed Folder fires one
				// immediate catch-up refresh the same way a never-fetched API source does.
				lastFetchedAt: null,
			}));
		// PR-7: a CSV source shares `apiCache` with API sources (same shape, same `fetchedAt`), so its
		// timer entry is built exactly like `apiNodes` above.
		const csvNodes = this.collectCsvSourceNodes(view.root)
			.filter((node) => node.csvSource?.refreshEveryMinutesEnabled)
			.map((node) => ({
				id: node.id,
				enabled: true,
				minutes: node.csvSource?.refreshEveryMinutes ?? MIN_REFRESH_MINUTES,
				lastFetchedAt: node.apiCache?.fetchedAt ?? null,
			}));
		// PR-8: a Markdown Table source shares `apiCache` with API/CSV sources, so its timer entry is
		// built exactly like `csvNodes` above.
		const mdTableNodes = this.collectMarkdownTableSourceNodes(view.root)
			.filter((node) => node.markdownTableSource?.refreshEveryMinutesEnabled)
			.map((node) => ({
				id: node.id,
				enabled: true,
				minutes: node.markdownTableSource?.refreshEveryMinutes ?? MIN_REFRESH_MINUTES,
				lastFetchedAt: node.apiCache?.fetchedAt ?? null,
			}));
		this.refreshEveryTimers.sync([...apiNodes, ...folderNodes, ...csvNodes, ...mdTableNodes], (nodeId) => {
			const activeView = this.plugin.viewsManager.getActiveView();
			const apiTarget = this.collectApiSourceNodes(activeView.root).find((n) => n.id === nodeId);
			if (apiTarget) {
				this.refreshApiSource(activeView, apiTarget, "automatic");
				return;
			}
			const folderTarget = this.collectFolderSourceNodes(activeView.root).find((n) => n.id === nodeId);
			if (folderTarget) {
				this.refreshFolderSource(activeView, folderTarget);
				return;
			}
			const csvTarget = this.collectCsvSourceNodes(activeView.root).find((n) => n.id === nodeId);
			if (csvTarget) {
				this.refreshCsvSource(activeView, csvTarget, "automatic");
				return;
			}
			const mdTableTarget = this.collectMarkdownTableSourceNodes(activeView.root).find((n) => n.id === nodeId);
			if (mdTableTarget) this.refreshMarkdownTableSource(activeView, mdTableTarget, "automatic");
		});
	}

	/** R8/G13: the one choke point every refresh trigger in this file goes through (view-load, the
	 * every-X-minutes timer, "Refresh now", post-save) — mobile shows cached rows only and can never
	 * trigger a live request. `trigger` (G5/G6b) distinguishes "Refresh now" (always asks again when a
	 * delete needs confirming) from the two automatic triggers (ask at most once per Folder). */
	private refreshApiSource(view: View, node: ViewNode, trigger: "manual" | "automatic" = "manual"): void {
		if (!node.apiSource || Platform.isMobile) return;
		const headers = this.plugin.apiHeadersStore.get(node.id);
		void this.plugin.apiSourceController.refresh(node, node.apiSource, headers, () => this.plugin.viewsManager.notifyExternalMutation(), {
			requestImpl: obsidianRequestImpl,
			trigger,
			confirmDelete: (count) =>
				new Promise((resolve) => {
					const modal = new ConfirmDeleteRowsModal(this.plugin.app, count, (answer) => {
						this.openConfirmDeleteModals = this.openConfirmDeleteModals.filter((m) => m !== modal);
						resolve(answer);
					});
					this.openConfirmDeleteModals.push(modal);
					modal.open();
				}),
		});
	}

	/** PR-4 (G3/G10/F5): resolves and reconciles an Inside-Vault Folder source's children against its
	 * target folder. Purely a data-layer operation (`ViewsManager.refreshFolderSource` only reads the
	 * vault, never writes it) — the resulting real unit children render for free through the normal
	 * tree, with no Folder-source-specific rendering path. */
	private refreshFolderSource(view: View, node: ViewNode): void {
		// PR-5: Outside-Vault reconciliation needs the device-local path, which `ViewsManager` itself
		// never holds (same reason `apiHeadersStore` lookups live here, not in `ViewsManager`, for API
		// sources) — looked up fresh on every call so a since-changed path is always current.
		const outsidePath = node.folderSource?.location === "outside" ? this.plugin.folderSourcePathStore.get(node.id) : undefined;
		this.plugin.viewsManager.refreshFolderSource(view.id, node.id, outsidePath);
	}

	/** PR-7 (G17-G19/G21-G23): the CSV equivalent of `refreshApiSource` — a vault file read stands in
	 * for the HTTP fetch, so (unlike `refreshApiSource`) this deliberately has no `Platform.isMobile`
	 * guard: reading a file already in the vault works offline/on mobile exactly as well as it does on
	 * desktop, there's no live request to skip. */
	private refreshCsvSource(view: View, node: ViewNode, trigger: "manual" | "automatic" = "manual"): void {
		if (!node.csvSource) return;
		void this.plugin.csvSourceController.refresh(node, node.csvSource, () => this.plugin.viewsManager.notifyExternalMutation(), {
			vault: this.plugin.app.vault,
			trigger,
			confirmDelete: (count) =>
				new Promise((resolve) => {
					const modal = new ConfirmDeleteRowsModal(this.plugin.app, count, (answer) => {
						this.openConfirmDeleteModals = this.openConfirmDeleteModals.filter((m) => m !== modal);
						resolve(answer);
					});
					this.openConfirmDeleteModals.push(modal);
					modal.open();
				}),
		});
	}

	/** PR-8 (G17-G20/G22-G24): the Markdown Table equivalent of `refreshCsvSource` — same no-mobile-
	 * guard reasoning (a vault file read, not a live request). */
	private refreshMarkdownTableSource(view: View, node: ViewNode, trigger: "manual" | "automatic" = "manual"): void {
		if (!node.markdownTableSource) return;
		void this.plugin.markdownTableSourceController.refresh(node, node.markdownTableSource, () => this.plugin.viewsManager.notifyExternalMutation(), {
			vault: this.plugin.app.vault,
			trigger,
			confirmDelete: (count) =>
				new Promise((resolve) => {
					const modal = new ConfirmDeleteRowsModal(this.plugin.app, count, (answer) => {
						this.openConfirmDeleteModals = this.openConfirmDeleteModals.filter((m) => m !== modal);
						resolve(answer);
					});
					this.openConfirmDeleteModals.push(modal);
					modal.open();
				}),
		});
	}

	private openApiSourceModal(view: View, node: ViewNode): void {
		const headers = this.plugin.apiHeadersStore.get(node.id);
		const outsidePath = this.plugin.folderSourcePathStore.get(node.id);
		new ApiSourceModal(
			this.plugin.app,
			node.apiSource ?? null,
			headers,
			(result) => {
				if (result.type === "folder") {
					this.plugin.viewsManager.setFolderSource(view.id, node.id, result.source);
					// G6/acceptance: Inside<->Outside toggling (or clearing the field outright) clears
					// the previously stored path rather than leaving a stale device-local entry behind.
					if (result.source.location === "outside" && result.outsidePath) {
						this.plugin.folderSourcePathStore.set(node.id, result.outsidePath);
					} else {
						this.plugin.folderSourcePathStore.delete(node.id);
					}
					this.refreshFolderSource(view, node);
					return;
				}
				if (result.type === "csv") {
					// R8/G4: switching API->CSV drops the API source (R1's mutual-exclusion fix), so it
					// must also drop that source's device-local headers (possibly a bearer token) —
					// otherwise they linger in ApiHeadersStore and silently pre-fill the next time the
					// user switches back to API, same as "Remove data source" already does for them.
					const hadApiSource = node.apiSource !== undefined;
					this.plugin.viewsManager.setCsvSource(view.id, node.id, result.source);
					if (hadApiSource) this.plugin.apiHeadersStore.delete(node.id);
					this.refreshCsvSource(view, node, "manual");
					return;
				}
				if (result.type === "markdown-table") {
					// PR-8: same device-local-headers cleanup as the CSV branch above, for switching away
					// from API into Markdown Table.
					const hadApiSource = node.apiSource !== undefined;
					this.plugin.viewsManager.setMarkdownTableSource(view.id, node.id, result.source);
					if (hadApiSource) this.plugin.apiHeadersStore.delete(node.id);
					this.refreshMarkdownTableSource(view, node, "manual");
					return;
				}
				this.plugin.apiHeadersStore.set(node.id, result.headers);
				this.plugin.viewsManager.setApiSource(view.id, node.id, result.source);
				this.refreshApiSource(view, node, "manual");
			},
			node.folderSource ?? null,
			outsidePath,
			node.csvSource ?? null,
			node.markdownTableSource ?? null
		).open();
	}

	/** R3/G7: `duplicateNode` deep-copies `apiSource` itself, but the device-local headers for it (and
	 * for any nested sourced Folder in the duplicated subtree) live outside the synced view tree in
	 * `ApiHeadersStore` — copied across separately here using the original/clone id pairs, or the copy's
	 * first refresh of a token-authed API would fail 401 despite its modal showing the same settings. */
	private duplicateFolder(view: View, node: ViewNode): void {
		const clone = this.plugin.viewsManager.duplicateNode(view.id, node.id);
		if (!clone) return;
		const pairs: ApiSourceIdPair[] = collectApiSourceNodeIdPairs(node, clone);
		for (const pair of pairs) {
			const headers = this.plugin.apiHeadersStore.get(pair.originalId);
			if (headers.length > 0) this.plugin.apiHeadersStore.set(pair.cloneId, headers);
		}
		// PR-5 (G6/F6 mirror of the headers copy above): an Outside-Vault Folder source's device-local
		// path has the same "lives outside the synced tree" problem `duplicateNode` can't solve on its
		// own — copied across the same way, scoped to Outside-Vault sourced nodes in the subtree.
		const outsidePairs = collectOutsideFolderSourceNodeIdPairs(node, clone);
		for (const pair of outsidePairs) {
			const path = this.plugin.folderSourcePathStore.get(pair.originalId);
			if (path) this.plugin.folderSourcePathStore.set(pair.cloneId, path);
		}
	}

	/** G9: opens an API item's already-attached note/block/module. Only ever called once `item.noteRef`
	 * is set (R7: a click on an unattached item is a no-op — attaching is a deliberate, menu-driven
	 * action, not an accidental side effect of the default click). */
	private async openApiItemAttachment(item: ApiItemState): Promise<void> {
		if (!item.noteRef) return;
		await this.openRef(item.noteRef);
	}

	/** G9: creates a new note (file), block, or module (folder) and attaches it to this API item as
	 * its one attachment, replacing whatever was attached before. Mirrors the existing "Add
	 * note"/"Add block"/"Add module" creation shapes elsewhere in this file (`addFile`, `addBlock`,
	 * `addFolder`) rather than inventing a fourth. */
	private async attachApiItem(view: View, folderNode: ViewNode, item: ApiItemState, kind: "file" | "block" | "folder"): Promise<void> {
		const { vault } = this.plugin.app;
		// R14: the API label is arbitrary upstream data — '/' or '\\' would otherwise be read as
		// path separators (nesting into/creating folders vault.create/createFolder don't expect)
		// and ':' throws on some platforms; sanitising keeps the created file/folder name a sibling
		// in the current location, matching every other "Add …" action in this file.
		const label = sanitizeFileName(item.label.trim()) || "Untitled";
		let ref: UnitRef;
		let openable: TFile | null = null;
		if (kind === "file") {
			const file = await vault.create(await this.uniquePath(label, "md"), "");
			ref = { kind: "file", path: file.path };
			openable = file;
		} else if (kind === "folder") {
			const folder = await vault.createFolder(await this.uniquePath(label, null));
			ref = { kind: "folder", path: folder.path };
			// R14: "Add module" created a plain folder with nothing else linked to it, so openRef's
			// folder branch (which only ever opens a *found* interface note) had nothing to open —
			// a click on the row silently did nothing. Give it the same interface note the existing
			// module flow creates (`createInterfaceNote`, used from the bucket unit's own menu).
			openable = await createInterfaceNote(this.plugin.app, folder);
		} else {
			const poolFolder = this.plugin.settings.poolFolder;
			if (!(vault.getAbstractFileByPath(poolFolder) instanceof TFolder)) await vault.createFolder(poolFolder);
			let path: string;
			do {
				path = `${poolFolder}/${generateBlockId(new Date())}.md`;
			} while (vault.getAbstractFileByPath(path));
			const file = await vault.create(path, `# ${item.label}\n`);
			ref = { kind: "block", path: file.path, subpath: file.basename };
			openable = file;
		}
		this.plugin.viewsManager.setApiItemNoteRef(view.id, folderNode.id, item.id, ref);
		if (openable) {
			const leaf = this.plugin.app.workspace.getLeaf(false);
			await leaf.openFile(openable);
			if (kind === "block") this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.editor.setCursor({ line: 1, ch: 0 });
		}
	}

	/** G9/G26/G28: "Add note / block / module" plus (G29: gated on the item's shared placeholder tag,
	 * never an API-specific check) "Remove attachment" whenever `noteRef` is set, and "Remove"
	 * whenever the row is `notFound` — the only context-menu actions for a placeholder item besides
	 * status (G10: no drag, nest, reorder, rename, or duplicate, all of which require a real
	 * `ViewNode`, which items never get). With action = run command, the attachment stays reachable
	 * from this menu. Status itself is set via the dot click (R5), not this menu. Remove/Remove
	 * attachment are additive — "Open attachment"/"Add note"/"Add block"/"Add module" keep their
	 * existing conditions and ordering. */
	private showApiItemMenu(evt: MouseEvent, view: View, folderNode: ViewNode, item: ApiItemState): void {
		const menu = new Menu();
		const isPlaceholder = item.kind === PLACEHOLDER_ROW_KIND;
		if (item.noteRef) {
			menu.addItem((mi) => mi.setTitle("Open attachment").setIcon("file-text").onClick(() => void this.openApiItemAttachment(item)));
			menu.addSeparator();
		}
		menu.addItem((mi) => mi.setTitle("Add note").setIcon("file-plus").onClick(() => void this.attachApiItem(view, folderNode, item, "file")));
		menu.addItem((mi) => mi.setTitle("Add block").setIcon("square-plus").onClick(() => void this.attachApiItem(view, folderNode, item, "block")));
		menu.addItem((mi) => mi.setTitle("Add module").setIcon("folder-plus").onClick(() => void this.attachApiItem(view, folderNode, item, "folder")));
		if (isPlaceholder && (item.noteRef || item.notFound)) menu.addSeparator();
		// G28: a manual backstop, available for any reason noteRef went stale — not conditioned on
		// G27's auto-clear having run or being able to.
		if (isPlaceholder && item.noteRef) {
			menu.addItem((mi) =>
				mi.setTitle("Remove attachment").setIcon("unlink").onClick(() => this.plugin.viewsManager.clearApiItemNoteRef(view.id, folderNode.id, item.id))
			);
		}
		// G26: no bulk remove (F3), no undo (F4) — deletes the apiItemState entry outright, immediately.
		if (isPlaceholder && item.notFound) {
			menu.addItem((mi) =>
				mi.setTitle("Remove").setIcon("trash-2").onClick(() => this.plugin.viewsManager.removeApiItem(view.id, folderNode.id, item.id))
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** G9/G9b: handles click on an API item row according to the folder's configured click action. */
	private async handleApiItemClick(folderNode: ViewNode, item: ApiItemState): Promise<void> {
		const action = folderNode.apiSource?.action ?? folderNode.apiSource?.clickAction ?? "open-attachment";
		if (action === "none") return;
		if (action === "open-attachment") {
			if (item.noteRef) await this.openApiItemAttachment(item);
			return;
		}
		if (action === "run-command") {
			// G13: Click-action commands are not available on mobile
			if (Platform.isMobile) return;
			const command = folderNode.apiSource?.command;
			if (!command || !command.trim()) return;

			const tokenResult = tokenizeCommand(command);
			if (!tokenResult.ok) {
				new Notice(`Atlas: command error — ${tokenResult.error}`);
				return;
			}

			// Read extra fields from the cached mapped row
			const cachedRow = folderNode.apiCache?.rows.find((r) => r.id === item.id);
			const extra = cachedRow?.extra;

			const resolved = resolveArgv(tokenResult.tokens, extra);
			if (!resolved.ok) {
				new Notice(`Atlas: ${resolved.error}`);
				return;
			}

			await executeApiCommand(resolved.argv);
		}
	}

	/** G8: a throwaway pseudo-`ViewNode` so an API item can go through the same status-resolution
	 * machinery as a real node, without ever being inserted into `children[]` (G10 — API items are
	 * never draggable/nestable/reorderable/removable/renamable/duplicatable, which would otherwise
	 * need special-casing throughout the drag/drop and context-menu code if they lived there). */
	private pseudoNodeForApiItem(item: ApiItemState): ViewNode {
		return { id: item.id, type: "unit", children: [], explicitStatusId: item.explicitStatusId };
	}

	private renderApiItemRow(item: ApiItemState, container: HTMLElement, view: View, folderNode: ViewNode, depth: number, ancestors: StatusGovernance[]): void {
		const pseudo = this.pseudoNodeForApiItem(item);
		const row = container.createDiv({ cls: "atlas-row atlas-row-unit atlas-row-api-item" });
		row.style.paddingLeft = `${depth * 16}px`;
		row.toggleClass("atlas-not-found", !!item.notFound);
		row.createDiv({ cls: "atlas-chevron" }); // empty spacer — keeps icons aligned at this depth, same as any childless row
		const iconEl = row.createDiv({ cls: "atlas-icon" });
		// R5: routes the dot click to the API item's own status setter — `pseudo` has no real `ViewNode`
		// counterpart `setExplicitStatus` (the default) could resolve.
		this.renderRowIcon(iconEl, view, pseudo, ancestors, "plug", (statusId) =>
			this.plugin.viewsManager.setApiItemStatus(view.id, folderNode.id, item.id, statusId)
		);
		row.createSpan({ cls: "atlas-row-text", text: item.label });
		if (item.secondary) row.createSpan({ cls: "atlas-row-secondary", text: item.secondary });
		if (item.notFound) {
			// R4: previously rendered "not found" with no date — G6 requires the last-seen date too.
			// R13: format as ISO-date (2026-09-25), matching the spec's example, rather than
			// `toLocaleDateString`'s locale-dependent format (25/09/2026 in en-GB).
			// R19: format the *local* calendar date — `lastSeenAt` is a UTC ISO string, and slicing it
			// directly reports the UTC date, which can be a day behind the local one near midnight.
			const text = item.lastSeenAt ? `not found, last seen ${formatLocalDateFromIso(item.lastSeenAt)}` : "not found";
			row.createSpan({ cls: "atlas-row-secondary", text });
		}

		// G9/G9b: click opens attachment or runs terminal command per source clickAction config
		row.addEventListener("click", () => {
			void this.handleApiItemClick(folderNode, item);
		});

		// G9/R7: "Add note / block / module" — status is set via the dot click instead (R5).
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showApiItemMenu(evt, view, folderNode, item);
		});
	}

	/** R18: does this Folder's own API rows (not its real `children`) contain a filter match? Used
	 * alongside `subtreeHasMatch` everywhere a collapsed Folder needs to be force-revealed, or bypass
	 * truncation grouping, for a matching descendant — API rows are a Folder's rows too, just not
	 * `ViewNode`s (G10), so they need the same "never hide a match behind a stale fold" treatment. */
	private apiItemsMatchFilter(node: ViewNode): boolean {
		if (!node.apiItemOrder) return false;
		return node.apiItemOrder.some((itemId) => {
			const item = node.apiItemState?.[itemId];
			return item ? apiItemMatchesFilter(this.filterText, item.label, item.secondary) : false;
		});
	}

	// --- ref resolution (shared by bucket + inbox rendering) -------------------------------------

	private async resolveRef(ref: UnitRef): Promise<RowInfo> {
		const unit = this.unitsByRefKey.get(unitRefKey(ref));
		if (unit) {
			const resolved = await resolveUnit(this.plugin.app, this.plugin.settings, unit, this.plugin.freeBlockTextCache);
			if (resolved)
				return {
					text: resolved.text,
					secondary: resolved.secondary,
					icon: resolved.icon,
					promoted: resolved.promoted,
					added: resolved.added,
					missing: false,
				};
		}
		// F9: refs are never deleted automatically — render greyed as missing rather than crash.
		const fallbackText = ref.kind === "block" ? ref.subpath : (ref.path.split("/").pop() ?? ref.path);
		return {
			text: fallbackText,
			icon: ref.kind === "folder" ? "folder" : ref.kind === "block" ? "quote" : "file",
			promoted: false,
			added: false,
			missing: true,
		};
	}

	/** PR-5 (G8): an Outside-Vault-managed child's `ref.path` is an absolute filesystem path, never
	 * indexed by `UnitIndex` (which only ever knows about vault paths) — `resolveRef`'s normal
	 * `unitsByRefKey` lookup can never find it, and its generic missing-ref fallback would otherwise
	 * wrongly show a "(missing)" badge/remove button for a child whose source currently resolves fine.
	 * Bypasses `resolveRef` entirely for exactly these rows: basename-derived text/icon, never
	 * `missing` — `renderNodeList`'s `isOutsideManagedAndUnresolved` check is what actually keeps an
	 * Outside-Vault child out of view while its source doesn't resolve (R1/R2 fix: the node itself stays
	 * in the persisted tree throughout), so a rendered row here is always one its source currently
	 * vouches for. */
	private resolveOutsideManagedRowInfo(ref: UnitRef): RowInfo {
		const text = ref.kind === "block" ? ref.subpath : (ref.path.split("/").pop() ?? ref.path);
		return { text, icon: ref.kind === "folder" ? "folder" : "file", promoted: false, added: false, missing: false };
	}

	/** PR-5 (G8/F7): true only for a `type: "unit"` node that a specifically Outside-Vault Folder
	 * source manages — the one distinction `renderNode` needs to gate drag/nest/rename off for exactly
	 * these rows while leaving Inside-Vault-managed (and any hand-placed) rows completely unaffected. */
	private isOutsideManagedUnit(view: View, node: ViewNode): boolean {
		if (!node.folderSourceManaged || !node.folderSourceOwnerId) return false;
		const owner = this.plugin.viewsManager.getNode(view.id, node.folderSourceOwnerId);
		return owner?.folderSource?.location === "outside";
	}

	/** PR-5 (R1/R2 fix): true for an Outside-Vault-managed child whose owning source does not
	 * currently resolve on this device. `buildFolderSourceChildren` (`folder-source.ts`) now leaves
	 * these rows exactly as they are in the persisted tree while unresolved — restoring the right
	 * explicit status/collapsed state/manually-nested children once the path resolves again, instead
	 * of deleting and recreating them (R1), and never writing a wiped tree to a synced `data.json`
	 * (R2) — so this is the one place that actually keeps them out of view while unresolved, per the
	 * spec's "render empty... reappear on recovery" (never a deletion). */
	private isOutsideManagedAndUnresolved(view: View, node: ViewNode): boolean {
		if (!node.folderSourceManaged || !node.folderSourceOwnerId) return false;
		const owner = this.plugin.viewsManager.getNode(view.id, node.folderSourceOwnerId);
		if (owner?.folderSource?.location !== "outside") return false;
		return !resolveOutsidePath(this.plugin.folderSourcePathStore.get(owner.id));
	}

	/** PR-5 (R3 fix): true for any node (not just the one the caller already has in hand) that an
	 * Outside-Vault Folder source manages — looked up by id so `buildNodeDragPayload` can filter the
	 * rest of a multi-select by id without needing each `ViewNode` object already in scope. */
	private isOutsideManagedNodeId(viewId: string, nodeId: string): boolean {
		const node = this.plugin.viewsManager.getNode(viewId, nodeId);
		if (!node || !node.folderSourceManaged || !node.folderSourceOwnerId) return false;
		const owner = this.plugin.viewsManager.getNode(viewId, node.folderSourceOwnerId);
		return owner?.folderSource?.location === "outside";
	}

	// --- top-level render --------------------------------------------------------------------------

	private async render(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		const scrollTop = container.scrollTop;
		// Dan-found: `container.scrollTop` only covers the *outer* sidebar scroll (which section is
		// in view) — the inbox's own virtualized viewport (F11, `.atlas-inbox-viewport`) is a
		// separate `overflow-y: auto` element with its own independent scroll position, rebuilt from
		// scratch by `container.empty()` below like everything else, with nothing capturing or
		// restoring *its* scrollTop before now. Any click-driven re-render (this PR's own multi-select
		// highlighting made that far more frequent for the inbox specifically — a plain click on an
		// inbox row never used to trigger a re-render at all before PR 20) snapped a scrolled-down
		// inbox straight back to its top. Captured here, restored in `renderVirtualizedInboxRows`
		// itself (has to happen before that view's own first `drawWindow()`, not after, since that
		// read is what decides which rows are even in the initial DOM).
		const inboxViewportScrollTop = container.querySelector(".atlas-inbox-viewport")?.scrollTop ?? 0;
		// The filter input lives inside `container` and gets torn down by `container.empty()` below
		// like everything else — every keystroke re-renders the whole view (index/view-change events
		// and typing both go through this same `render()`). Capture focus/caret here and restore it
		// on the freshly-created input after rebuilding, or every keystroke past the first would be
		// silently lost as focus falls off the removed element.
		const activeEl = document.activeElement;
		const filterHadFocus = activeEl instanceof HTMLInputElement && activeEl.classList.contains("atlas-filter");
		const filterSelectionStart = filterHadFocus ? activeEl.selectionStart : null;
		const filterSelectionEnd = filterHadFocus ? activeEl.selectionEnd : null;
		// Dan-found: Escape/Delete (`handleRowKeydown`) never reached a real keyboard press, even
		// though the exact same keys worked fine dispatched synthetically straight at a queried row
		// element in this PR's own CDP testing. Root cause is the same class of gap as the drag-abort
		// bug earlier in this PR: a real click on a focusable (`tabIndex=0`) row focuses it natively
		// (a browser's own default `mousedown` handling, before our `click` listener even runs) — but
		// `handleSelectionClick` then calls `render()` in response to that same click, which
		// `container.empty()`s the row right back out from under that just-assigned focus. The new
		// row rebuilt in its place is a different DOM node and was never itself focused, so a
		// following *real* keydown has nowhere relevant to land — while `dispatchEvent` in a test
		// fires straight at whichever element you queried, focus state or not, so this was invisible
		// to every synthetic test this PR ran. Same fix shape as the filter input's own focus restore
		// just above/below: capture before `container.empty()`, restore after rebuild.
		const activeRowKey = activeEl instanceof HTMLElement && activeEl.dataset.selectKey ? activeEl.dataset.selectKey : null;

		container.empty();
		container.addClass("atlas-explorer");

		const view = this.plugin.viewsManager.getActiveView();
		const allUnits = this.plugin.unitIndex.getUnits();
		this.unitsByRefKey = new Map(allUnits.map((u) => [unitRefKey(unitToRef(u)), u]));

		// PR 20: bucket node ids are only meaningful within the view that minted them — switching to
		// a different view and keeping the old selection around would (extremely unlikely id
		// collision aside) just be a stale, meaningless-looking highlight on whatever nodes happen to
		// render next. Inbox selection is unaffected — a ref key means the same thing across views.
		if (view.id !== this.lastRenderedViewId) {
			// R9: G5a is "opening or returning to an Atlas view", not just "Obsidian leaf activation" —
			// switching the *internal* Atlas view (the view switcher, `setActiveViewId`) is exactly that,
			// and previously fired no refresh at all since it never touches `active-leaf-change`. Guarded
			// on `lastRenderedViewId !== null` so this is a genuine switch, not the view's very first
			// render (which `onOpen`'s own `activate()` call already covers).
			if (this.lastRenderedViewId !== null) this.refreshApiSourcesOnViewLoad();
			this.lastRenderedViewId = view.id;
			this.selectedBucketNodeIds.clear();
			if (this.selectionAnchorScope === "bucket") {
				this.selectionAnchor = null;
				this.selectionAnchorScope = null;
			}
		}

		this.renderToolbar(container, view);
		if (filterHadFocus && this.filterInputEl) {
			this.filterInputEl.focus();
			this.filterInputEl.setSelectionRange(filterSelectionStart, filterSelectionEnd);
		}

		const bucketEl = container.createDiv({ cls: "atlas-section atlas-bucket" });
		await this.renderBucketSection(bucketEl, view);

		const inboxUnits = this.plugin.viewsManager.getInboxUnits(allUnits, view.id, view.inboxMode, this.plugin.unitIndex);
		// PR-5 (G8): only resolved while the toggle is active — otherwise dismissed rows never enter
		// the merged/sorted list at all, matching G8's "renders inline in the existing list" via an
		// extra input set rather than a post-filter that would still momentarily touch every dismissed row.
		const dismissedUnits = this.showDismissed
			? this.plugin.viewsManager.getDismissedInboxUnits(allUnits, view.id, view.inboxMode, this.plugin.unitIndex)
			: [];
		const inboxEl = container.createDiv({ cls: "atlas-section atlas-inbox" });
		await this.renderInboxSection(inboxEl, view, inboxUnits, dismissedUnits, inboxViewportScrollTop);

		if (activeRowKey) {
			const restored = container.querySelector<HTMLElement>(`[data-select-key="${CSS.escape(activeRowKey)}"]`);
			// `preventScroll` — this row's own visible position (and the scroll position that shows
			// it) was already restored above/in `renderVirtualizedInboxRows`; a plain `.focus()` here
			// would otherwise fight that by scrolling to whatever the browser's own default
			// focus-into-view behavior decides, undoing the fix just above it.
			restored?.focus({ preventScroll: true });
		}

		container.scrollTop = scrollTop;
		this.updateActiveHighlight();
		this.syncRefreshTimers(view);
	}

	// --- toolbar -------------------------------------------------------------------------------

	/** PR 9: one dense row, three sections (view identity | create | view controls) — replaces the
	 * previous always-visible New/Rename/Delete-view icon trio (moved to the view-name button's
	 * right-click menu) and the always-visible filter input (now behind a reveal toggle), per Dan's
	 * live-testing feedback that the old toolbar was too cluttered to fit one line comfortably. */
	private renderToolbar(container: HTMLElement, view: View): void {
		const toolbar = container.createDiv({ cls: "atlas-toolbar" });

		// --- section 1: view identity ---------------------------------------------------------
		const viewName = toolbar.createDiv({ cls: "atlas-view-name" });
		viewName.setText(view.name);
		setTooltip(viewName, "Click to switch views, right-click for more");
		viewName.addEventListener("click", () => {
			new ViewSuggestModal(this.plugin.app, this.plugin.viewsManager.getViews(), (v) => {
				this.plugin.viewsManager.setActiveViewId(v.id);
			}).open();
		});
		viewName.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("New view").setIcon("plus").onClick(() => {
					new TextPromptModal(this.plugin.app, "New view", "", (name) => {
						if (!name.trim()) return;
						const created = this.plugin.viewsManager.createView(name);
						if (!created) return new Notice(`Atlas: a view named "${name}" already exists.`);
						this.plugin.viewsManager.setActiveViewId(created.id);
					}).open();
				})
			);
			menu.addItem((item) =>
				item.setTitle("Rename view").setIcon("pencil").onClick(() => {
					new TextPromptModal(this.plugin.app, "Rename view", view.name, (name) => {
						if (!this.plugin.viewsManager.renameView(view.id, name)) {
							new Notice(`Atlas: a view named "${name}" already exists.`);
						}
					}).open();
				})
			);
			menu.addItem((item) =>
				item.setTitle("Delete view").setIcon("trash-2").onClick(() => {
					new ConfirmModal(
						this.plugin.app,
						`Delete the view "${view.name}"? Units placed only in this view move to the global inbox — nothing on disk changes.`,
						"Delete",
						() => this.plugin.viewsManager.deleteView(view.id)
					).open();
				})
			);
			// PR 17: root-level assignment — same "Statuses" modal as any other item, just governing
			// the view's own top-level items instead of one specific node's children. Same no-nothing-
			// to-apply-to gate as any other item (PR 15): an empty bucket has nothing underneath it.
			if (view.root.length > 0) {
				menu.addSeparator();
				menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(view, null)));
			}
			menu.showAtMouseEvent(evt);
		});

		toolbar.createDiv({ cls: "atlas-toolbar-sep" });

		// --- section 2: create ------------------------------------------------------------------
		this.toolbarButton(toolbar, "square-plus", "Add block", () => void addBlock(this.plugin));
		this.toolbarButton(toolbar, "file-plus", "Add file", () => void this.addFile());
		this.toolbarButton(toolbar, "folder-plus", "Add module", () => void this.addFolder());
		this.toolbarButton(toolbar, "layers", "Add folder", () => this.addMetaFolder(view, null));

		toolbar.createDiv({ cls: "atlas-toolbar-sep" });

		// --- section 3: view controls ------------------------------------------------------------
		this.toolbarButton(toolbar, this.sortMode === "manual" ? "arrow-up-down" : "arrow-down-a-z", "Sort: manual / A–Z", () => {
			this.sortMode = this.sortMode === "manual" ? "alphabetical" : "manual";
			void this.render();
		});
		this.toolbarButton(toolbar, "chevrons-down-up", "Collapse all", () => this.plugin.viewsManager.collapseAll(view.id));
		// PR 11: same fix as the bucket/inbox sections — toggling `filterRevealed` used to call
		// `render()` immediately, which tears down and rebuilds the whole toolbar (including the
		// filter row) already in its new state within the same tick, so the CSS transition never had
		// a persisting element to animate from/to. `filterRow` is declared further down (still fine —
		// this closure only reads it at click time, long after the `const` has run), and the actual
		// state change + re-render is delayed the same way.
		//
		// Review follow-up (A14): the first version of this fix read `!this.filterRevealed` directly
		// inside the click handler — but that field only actually updates once the delayed block
		// below runs, so a second click inside the 160ms window read the same stale value as the
		// first and re-applied the same direction instead of toggling back. Exactly the race
		// A11/A12 already fixed once for the meta-folder chevron; `localRevealed` here is that same
		// fix — seeded once, flipped from its own prior value on every click, never re-read from
		// `this.filterRevealed` until the eventual `render()` replaces this whole closure anyway.
		let localRevealed = this.filterRevealed;
		let filterRevealTimer: number | undefined;
		this.toolbarButton(toolbar, "search", "Filter", () => {
			localRevealed = !localRevealed;
			const nowRevealed = localRevealed;
			filterRow.toggleClass("is-collapsed", !nowRevealed);
			if (filterRevealTimer !== undefined) window.clearTimeout(filterRevealTimer);
			filterRevealTimer = window.setTimeout(() => {
				filterRevealTimer = undefined;
				this.filterRevealed = nowRevealed;
				if (nowRevealed) {
					this.focusFilterOnNextRender = true;
				} else if (this.filterText) {
					// Closing the reveal always returns to the unfiltered view — a hidden input still
					// silently filtering the list would be confusing, with no visible query to explain it.
					this.filterText = "";
					this.restoreFoldStateAfterFilterClear();
				}
				void this.render();
			}, COLLAPSE_TRANSITION_MS);
		});

		// A separate block-level row below the toolbar's icon row, not an inline-growing box within
		// it — the icon row has `flex-wrap: wrap` for its own overflow handling, and a horizontally
		// growing filter box inline with those icons would (and did, per Dan's testing) eventually
		// force a line-wrap mid-animation: an instant, un-animatable reflow that jumped the
		// bucket/inbox sections below down abruptly instead of moving them smoothly. Revealing is a
		// height transition on its own row instead (`.atlas-meta-children`, same technique as
		// everywhere else in the plugin), which the icon row's wrapping can't interfere with.
		const filterRow = container.createDiv({ cls: "atlas-meta-children atlas-filter-row" });
		filterRow.toggleClass("is-collapsed", !this.filterRevealed);
		const filterRowInner = filterRow.createDiv({ cls: "atlas-meta-children-inner" });
		const filterInput = filterRowInner.createEl("input", { cls: "atlas-filter", attr: { type: "text", placeholder: "Filter…" } });
		filterInput.value = this.filterText;
		this.filterInputEl = filterInput;
		filterInput.addEventListener("input", () => {
			const wasActive = !!this.filterText.trim();
			this.filterText = filterInput.value;
			if (wasActive && !this.filterText.trim()) this.restoreFoldStateAfterFilterClear();
			this.openModuleModal?.setFilterText(this.filterText);
			void this.render();
		});
		if (this.focusFilterOnNextRender) {
			this.focusFilterOnNextRender = false;
			window.setTimeout(() => filterInput.focus(), 0);
		}
	}

	private toolbarButton(toolbar: HTMLElement, icon: string, tooltip: string, onClick: () => void): void {
		const btn = toolbar.createDiv({ cls: "atlas-toolbar-btn" });
		setIcon(btn, icon);
		setTooltip(btn, tooltip);
		btn.addEventListener("click", onClick);
	}

	private async addFile(): Promise<void> {
		const file = await this.plugin.app.vault.create(await this.uniquePath("Untitled", "md"), "");
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	private async addFolder(): Promise<void> {
		await this.plugin.app.vault.createFolder(await this.uniquePath("New module", null));
	}

	private async uniquePath(base: string, ext: string | null, folder = ""): Promise<string> {
		const suffix = ext ? `.${ext}` : "";
		const prefix = folder ? `${folder}/` : "";
		let candidate = `${prefix}${base}${suffix}`;
		let i = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${prefix}${base} ${++i}${suffix}`;
		}
		return candidate;
	}

	private addMetaFolder(view: View, parentId: string | null): void {
		new TextPromptModal(this.plugin.app, "New folder", "New folder", (label) => {
			if (label.trim()) this.plugin.viewsManager.addMetaFolder(view.id, parentId, label);
		}).open();
	}

	// --- bucket ----------------------------------------------------------------------------------

	private async renderBucketSection(container: HTMLElement, view: View): Promise<void> {
		const header = container.createDiv({ cls: "atlas-section-header" });
		const chevron = header.createDiv({ cls: "atlas-chevron" });
		setIcon(chevron, this.bucketCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: "Bucket" });

		// PR 11: the whole section's content used to only render at all when expanded (`if
		// (this.bucketCollapsed) return`), and the header click handler triggered an immediate full
		// re-render — so there was never a persisting DOM node for the CSS transition to animate
		// from/to, just a hard snap between "rendered" and "not rendered". Same fix as the
		// meta-folder chevron: content always renders into a dedicated wrapper, the collapse is a
		// CSS transition on that wrapper, and the state-persisting re-render is delayed until the
		// transition has had time to play.
		const sectionWrap = container.createDiv({ cls: "atlas-meta-children" });
		sectionWrap.toggleClass("is-collapsed", this.bucketCollapsed);
		const sectionInner = sectionWrap.createDiv({ cls: "atlas-meta-children-inner" });

		// The whole section (not just the list of existing rows) is the bucket-root drop target —
		// registering it on `listEl` alone left almost no reliable empty area to hit once a few
		// rows existed (the div's own height hugs its content in normal block flow, so dropping
		// just below the last row landed on `container`, which had no drop handler at all). Any
		// specific row still wins first via its own drop handler's `stopPropagation`. Safe to keep
		// registered while visually collapsed — the wrapper's `overflow: hidden` + zero-height grid
		// track means collapsed content has no interactable area regardless.
		this.makeDropZone(sectionInner, { kind: "bucket-root", viewId: view.id });

		const listEl = sectionInner.createDiv({ cls: "atlas-node-list" });
		this.bucketListEl = listEl; // PR 20: queried live for shift-click range selection
		// PR 17: the view itself is the root governor — top-level items resolve their status against
		// it exactly the same way any other item resolves against its parent node, no special-casing.
		await this.renderNodeList(view.root, listEl, view, 0, [view]);

		let localCollapsed = this.bucketCollapsed;
		let pendingPersist: number | undefined;
		header.addEventListener("click", () => {
			localCollapsed = !localCollapsed;
			setIcon(chevron, localCollapsed ? "chevron-right" : "chevron-down");
			sectionWrap.toggleClass("is-collapsed", localCollapsed);
			if (pendingPersist !== undefined) window.clearTimeout(pendingPersist);
			pendingPersist = window.setTimeout(() => {
				pendingPersist = undefined;
				this.bucketCollapsed = localCollapsed;
				void this.render();
			}, COLLAPSE_TRANSITION_MS);
		});
	}

	/** PR 19: wires PR 17's hide-completed/hide-cancelled/truncate-statuses settings (captured but
	 * inert until now) into actual rendering. A node's governor and resolved status are looked up
	 * once per node here — hidden/truncated status is a property of *this* rendering pass against
	 * *these* ancestors, not the node itself, so it can't be decided any earlier (e.g. in `moveNode`,
	 * PR 18's own finding) or cached across renders.
	 *
	 * Precedence, per TASKS.md's own edge case: hide wins outright — a hidden item is excluded from
	 * rendering *and* from a truncated group's count, never appearing even as a tally. Among what's
	 * left, a status truncation-enabled on its governor only actually collapses once at least two
	 * siblings share it (a "group" of one is just the item itself — matches the reference plugin's
	 * own `>= 2` threshold, ported directly rather than reinvented, since collapsing a lone item into
	 * a summary of itself has no purpose).
	 *
	 * Filter interaction (flagged in TASKS.md as "not yet grilled, resolve if obvious during build"):
	 * a node that itself matches the active filter, or contains a descendant that does, always
	 * renders individually — same "never let a filter match hide behind something else" principle
	 * `renderFoldableChildren` already applies to collapsed folders (PR 9 issue 6), extended to cover
	 * hide/truncate the same way. */
	private async renderNodeList(nodes: ViewNode[], container: HTMLElement, view: View, depth: number, ancestors: StatusGovernance[], apiOwner?: ViewNode): Promise<void> {
		const sm = this.plugin.statusesManager;
		const filterActive = !!this.filterText.trim();

		interface Resolved {
			node: ViewNode;
			status: StatusDefinition | null;
			governor: StatusGovernance | null;
			bypass: boolean;
			apiItem?: ApiItemState;
		}
		const resolved: Resolved[] = [];
		for (const node of nodes) {
			// R1/R2 fix: an Outside-Vault-managed child whose source doesn't currently resolve on this
			// device renders as if it doesn't exist — the persisted tree keeps it intact (see
			// `isOutsideManagedAndUnresolved`'s own doc comment) so it reappears exactly as it was the
			// moment the path resolves again, with no separate "missing" row or hole in this list.
			if (this.isOutsideManagedAndUnresolved(view, node)) continue;
			const governor = sm.findGoverningAncestor(ancestors, node);
			const status = governor ? sm.resolveNodeStatus(ancestors, node) : null;
			let bypass = false;
			if (filterActive) {
				if (node.type === "unit" && node.ref) {
					const info = await this.resolveRef(node.ref);
					if (this.matchesFilter(info.text)) bypass = true;
				}
				if (!bypass && node.type === "meta" && this.apiItemsMatchFilter(node)) bypass = true;
				if (!bypass && node.children.length > 0 && (await this.subtreeHasMatch(node.children))) bypass = true;
			}
			resolved.push({ node, status, governor, bypass });
		}

		// G25: a Folder's own API item rows (`apiItemOrder`/`apiItemState`) are folded into this same
		// `resolved` list, right behind its real children in build order — so the one sort-by-status
		// pass and one hide/truncate/count pass below apply identically to both row kinds, instead of
		// `renderApiItems` walking `apiItemOrder` on its own with no sort/truncate logic at all (the
		// bug this closes). A stale/unmatched id in `apiItemOrder` (source renamed/removed from under
		// it) is simply skipped here, same graceful degrade `renderApiItems` already did. Filter
		// exclusion mirrors a real unit's own (`renderNode`'s `matchesFilter` early-return): a
		// non-matching item is skipped entirely, before it can ever be sorted, counted, or truncated —
		// a surviving match instead bypasses hide/truncate outright, same "a filter match is never
		// folded away" rule real nodes already get.
		if (apiOwner?.apiItemOrder) {
			// R3 fix: a Folder-source-demoted row (`item.folderSourceDeleted`, carrying the real index
			// its `ViewNode` occupied among `apiOwner`'s children at the moment it was deleted) is
			// spliced back in among those real children at (approximately) that same position, instead
			// of always landing after every one of them the way a genuine API/Table row still does —
			// "append-mode row retains all other row data (title, metadata, position)". Collected
			// separately and inserted after the real-children loop above so `realCount` reflects only
			// those real children, never any already-inserted positioned row.
			const realCount = resolved.length;
			const positioned: { entry: Resolved; position: number }[] = [];
			const trailing: Resolved[] = [];
			for (const itemId of apiOwner.apiItemOrder) {
				const item = apiOwner.apiItemState?.[itemId];
				if (!item) continue;
				if (filterActive && !apiItemMatchesFilter(this.filterText, item.label, item.secondary)) continue;
				const pseudo = this.pseudoNodeForApiItem(item);
				const governor = sm.findGoverningAncestor(ancestors, pseudo);
				const status = governor ? sm.resolveNodeStatus(ancestors, pseudo) : null;
				const entry: Resolved = { node: pseudo, status, governor, bypass: filterActive, apiItem: item };
				if (item.folderSourceDeleted && typeof item.position === "number") {
					positioned.push({ entry, position: Math.min(Math.max(item.position, 0), realCount) });
				} else {
					trailing.push(entry);
				}
			}
			// Insert highest position first: splice(p, 0, x) only shifts indices >= p, so a later
			// (lower-position) insertion's target index is never disturbed by an earlier one.
			positioned.sort((a, b) => b.position - a.position);
			for (const { entry, position } of positioned) resolved.splice(position, 0, entry);
			resolved.push(...trailing);
		}

		// PR 22: sort-by-status — the nearest governor that reaches this list (same ancestor-walk
		// precedent as every other governance field, just without the per-child `applyTo` gate,
		// since this is one shared decision for the whole list rather than a per-child one — see
		// `findSortGovernor`'s own doc comment) decides both the ranking status set and direction.
		// Array.prototype.sort is stable (guaranteed since ES2019), so equal-rank children simply
		// keep their existing relative order for free — no separate tie-break needed (grilled, Q5).
		// Sorting here, before the hide/truncate/render pass below, is also what makes a truncated
		// group's placeholder land at its status's rank position once sort-by-status is on — it
		// naturally becomes "whichever grouped member is now first in iteration order," with no
		// separate positioning logic required.
		const sortGovernor = sm.findSortGovernor(ancestors);
		if (sortGovernor?.sortMode === "status" && sortGovernor.statusSetId) {
			const setId = sortGovernor.statusSetId;
			const rankOf = (r: Resolved): number => {
				if (!r.status) return Number.POSITIVE_INFINITY;
				return sm.rankOf(setId, r.status.id) ?? Number.POSITIVE_INFINITY;
			};
			resolved.sort((a, b) => (sortGovernor.sortReverse ? rankOf(b) - rankOf(a) : rankOf(a) - rankOf(b)));
		}

		const isHidden = (status: StatusDefinition, governor: StatusGovernance): boolean =>
			(!!status.isCompleted && !!governor.hideCompleted) || (!!status.isCancelled && !!governor.hideCancelled);
		const groupKeyOf = (governor: StatusGovernance, statusId: string): string =>
			(governor === view ? `view:${view.id}` : `node:${(governor as ViewNode).id}`) + `:${statusId}`;

		const counts = new Map<string, number>();
		for (const r of resolved) {
			if (r.bypass || !r.status || !r.governor) continue;
			if (isHidden(r.status, r.governor)) continue;
			if (!r.governor.truncatedStatuses?.[r.status.id]?.enabled) continue;
			const key = groupKeyOf(r.governor, r.status.id);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}

		const groupRowShown = new Set<string>();
		for (const r of resolved) {
			const { node, status, governor, bypass, apiItem } = r;
			if (!bypass && status && governor && isHidden(status, governor)) continue; // hide wins outright

			if (!bypass && status && governor) {
				const config = governor.truncatedStatuses?.[status.id];
				if (config?.enabled && (counts.get(groupKeyOf(governor, status.id)) ?? 0) >= 2) {
					const key = groupKeyOf(governor, status.id);
					const expanded = this.expandedTruncationGroups.has(key);
					if (!groupRowShown.has(key)) {
						groupRowShown.add(key);
						this.renderTruncationGroupHeader(container, view, key, status, config, counts.get(key) ?? 0, depth, expanded);
					}
					if (!expanded) continue; // folded into the placeholder above, not rendered as its own row
				}
			}

			if (apiItem) {
				// G25: same row content/icon/click wiring as before the fix — only its position within
				// the now-shared ordering/truncation pass is new (`apiOwner` is only set when this list
				// has API rows to merge, so it's always defined here).
				this.renderApiItemRow(apiItem, container, view, apiOwner as ViewNode, depth, ancestors);
			} else {
				await this.renderNode(node, container, view, depth, ancestors);
			}
		}
	}

	/** PR 19: the group placeholder ("3 Done") when collapsed, or a small "Collapse" affordance
	 * (placed once, right before the group's first member) when expanded — both toggle the same
	 * ephemeral `expandedTruncationGroups` entry and re-render. Deliberately a dedicated row rather
	 * than the reference plugin's own double-click-a-member's-dot gesture: Atlas already binds a
	 * single click on a status dot to opening the change-status popup (PR 16), so overloading a
	 * second, timing-based meaning onto the same target would collide with an already-shipped,
	 * reviewed interaction rather than cleanly extend it — an explicit, discoverable row avoids that
	 * collision entirely and costs nothing extra to build on top of the row primitives already here.
	 *
	 * PR 22 (Dan-found): this is a stand-in for real status items, not secondary content, so its dot
	 * should look exactly like a real one — dropped `atlas-row-internal` (a muted text color meant
	 * for the Module Contents modal's genuinely-secondary rows, not this) and added the glow toggle
	 * `renderRowIcon` already has. Deliberately *not* matching one thing: Retain Icons. A real dot
	 * retains one item's own type icon; a truncated group can mix types (a meta folder alongside
	 * file/block units) with no single truthful icon to retain, so the placeholder's dot always stays
	 * a plain color circle regardless of that setting (grilled directly, Q8 — Dan's own call). */
	private renderTruncationGroupHeader(
		container: HTMLElement,
		view: View,
		key: string,
		status: StatusDefinition,
		config: TruncatedStatusConfig,
		count: number,
		depth: number,
		expanded: boolean
	): void {
		const row = container.createDiv({ cls: "atlas-row atlas-truncation-row" });
		row.style.paddingLeft = `${depth * 16}px`;
		const chevron = row.createDiv({ cls: "atlas-chevron" });
		const iconEl = row.createDiv({ cls: "atlas-icon atlas-status-dot" });
		const circle = iconEl.createDiv({ cls: "atlas-status-dot-circle" });
		circle.toggleClass("atlas-status-glow", this.plugin.settings.glowEnabled);
		circle.style.backgroundColor = status.color;
		circle.style.color = status.color;
		if (expanded) {
			setIcon(chevron, "chevron-down");
			row.createSpan({ cls: "atlas-row-text", text: "Collapse" });
		} else {
			const label = config.label?.trim() || pluralizeStatusLabel(status.label);
			row.createSpan({ cls: "atlas-row-text", text: `${count} ${label}` });
		}
		row.addEventListener("click", () => {
			if (expanded) this.expandedTruncationGroups.delete(key);
			else this.expandedTruncationGroups.add(key);
			void this.render();
		});
	}

	private matchesFilter(text: string): boolean {
		if (!this.filterText.trim()) return true;
		return text.toLowerCase().includes(this.filterText.trim().toLowerCase());
	}

	/** PR 20 — F8's own spec: "Multi-select with shift/cmd-click; drag moves the whole selection."
	 * Shared between bucket rows (keyed by node id) and inbox rows (keyed by ref key) — same
	 * mechanics either way, just a different `scope`/`order`/selection `Set`. `order` is the visible
	 * row order to range-select across for a shift-click; the caller computes it fresh each time
	 * (`bucketVisibleOrder`/`inboxSelectOrder`) rather than this method owning it, since what counts
	 * as "visible" is a different question per scope (DOM measurement vs. F11's virtualization —
	 * see those two callers' own doc comments).
	 *
	 * Returns whether the click was *consumed* as a selection action: `true` for a shift-range or a
	 * cmd/ctrl-toggle (caller should skip whatever the row's own plain-click action would have been,
	 * e.g. opening a file), `false` for a plain click (selection still resets to just this one row,
	 * but the caller's normal action still runs right after — multi-select is additive on top of the
	 * existing single-click-opens behavior, not a replacement for it). */
	private handleSelectionClick(evt: MouseEvent, key: string, scope: "bucket" | "inbox", order: string[]): boolean {
		const selection = scope === "bucket" ? this.selectedBucketNodeIds : this.selectedInboxRefKeys;
		const otherSelection = scope === "bucket" ? this.selectedInboxRefKeys : this.selectedBucketNodeIds;

		if (evt.shiftKey && this.selectionAnchor !== null && this.selectionAnchorScope === scope) {
			evt.preventDefault();
			otherSelection.clear();
			const from = order.indexOf(this.selectionAnchor);
			const to = order.indexOf(key);
			if (from !== -1 && to !== -1) {
				selection.clear();
				const [lo, hi] = from <= to ? [from, to] : [to, from];
				for (let i = lo; i <= hi; i++) selection.add(order[i]);
			}
			void this.render();
			return true;
		}

		if (evt.metaKey || evt.ctrlKey) {
			evt.preventDefault();
			otherSelection.clear();
			if (selection.has(key)) selection.delete(key);
			else selection.add(key);
			this.selectionAnchor = key;
			this.selectionAnchorScope = scope;
			void this.render();
			return true;
		}

		// Plain click: always collapses back to a fresh single-item selection (and a fresh anchor
		// for the next shift-click) — but never consumed, so the row's own default action still runs.
		// Always re-renders: an earlier version skipped this when there was no *prior* selection to
		// clear away, which missed the equally real case of the *new* one-row selection needing to
		// render its own highlight for the first time — found live-testing the reviewer's own A26
		// fix, not by inspection; the underlying `Set` was always correct, only the visible ring
		// lagged a click behind until some unrelated re-render happened to catch it up.
		otherSelection.clear();
		selection.clear();
		selection.add(key);
		this.selectionAnchor = key;
		this.selectionAnchorScope = scope;
		void this.render();
		return false;
	}

	/** PR 20: the bucket's currently *visible* row order, for a shift-click range — queried live
	 * from the DOM (not tracked during render) so a collapsed folder's hidden contents and a
	 * filtered-out row are both naturally excluded without a second structure to keep in sync.
	 * `getBoundingClientRect().height > 0` is the actual "is this painted with real height right
	 * now" check — a row inside a collapsed `.atlas-meta-children` wrapper reports (near) zero here
	 * once its ancestor's `grid-template-rows` has settled to `0fr`, even though it's still present
	 * in the DOM (by design — see `renderFoldableChildren`'s own doc comment on why children always
	 * render regardless of collapsed state). */
	private bucketVisibleOrder(): string[] {
		if (!this.bucketListEl) return [];
		return Array.from(this.bucketListEl.querySelectorAll<HTMLElement>("[data-select-key]"))
			.filter((el) => el.getBoundingClientRect().height > 0)
			.map((el) => el.dataset.selectKey as string);
	}

	/** PR 20: builds this drag's payload for an existing bucket node, folding in the rest of the
	 * active selection if the dragged row is part of it. Dragging a row that *isn't* currently
	 * selected instead collapses the selection down to just that row first — same "you're now
	 * dragging what you clicked, not some other stale selection" behavior most file managers use,
	 * and keeps the drag payload always consistent with what's visibly highlighted at drag time.
	 *
	 * Dan-found (real mouse, not CDP): this used to call `render()` right here, same as every other
	 * selection change — but this one fires from a `dragstart` handler, mid-gesture, and a real
	 * native HTML5 drag cannot survive its own source row being torn out of the document by
	 * `container.empty()` a moment after `dragstart` fires — the whole drag silently aborts, so nothing
	 * ever reaches a drop target again. CDP's synthetic `dispatchEvent(new DragEvent(...))` doesn't
	 * go through the browser's real native drag state machine, so this never surfaced during this
	 * PR's own live-CDP testing — only caught once Dan tried it with an actual mouse. No render call
	 * here now; the selection `Set`s still update correctly (silently), and the visible highlight
	 * catches up on the very next render, which `handleDrop` already triggers right after the drop
	 * completes regardless. */
	private buildNodeDragPayload(nodeId: string, viewId: string): DragPayload {
		if (!this.selectedBucketNodeIds.has(nodeId) || this.selectedBucketNodeIds.size <= 1) {
			this.selectedInboxRefKeys.clear();
			this.selectedBucketNodeIds.clear();
			this.selectedBucketNodeIds.add(nodeId);
			this.selectionAnchor = nodeId;
			this.selectionAnchorScope = "bucket";
		}
		// R3 fix: an Outside-Vault-managed child can still be part of a shift/cmd-click multi-select
		// (its own row never starts a drag — `renderNode`'s `outsideManaged` gate — but it can tag along
		// in someone else's selection), so it must never ride along in the payload an ordinary row's drag
		// actually moves. Filtered out of the payload, not the selection itself, so the highlight is
		// unaffected and only the drop/move/nest behavior changes.
		const nodeIds = [...this.selectedBucketNodeIds].filter((id) => !this.isOutsideManagedNodeId(viewId, id));
		return { kind: "node", nodeIds, viewId };
	}

	/** PR 20: same idea as `buildNodeDragPayload`, for an inbox row — see its own doc comment for why
	 * this deliberately never calls `render()` from inside a `dragstart` handler. */
	private buildInboxDragPayload(ref: UnitRef): DragPayload {
		const key = unitRefKey(ref);
		if (!this.selectedInboxRefKeys.has(key) || this.selectedInboxRefKeys.size <= 1) {
			this.selectedBucketNodeIds.clear();
			this.selectedInboxRefKeys.clear();
			this.selectedInboxRefKeys.add(key);
			this.selectionAnchor = key;
			this.selectionAnchorScope = "inbox";
		}
		const refs = [...this.selectedInboxRefKeys].map((k) => this.inboxRefByKey.get(k)).filter((r): r is UnitRef => !!r);
		return { kind: "inbox", refs: refs.length > 0 ? refs : [ref] };
	}

	/** PR 9 (issue 6): does this subtree contain a unit whose resolved text matches the active
	 * filter? Used to force-reveal a folder that would otherwise hide a match behind a stale fold. */
	private async subtreeHasMatch(nodes: ViewNode[]): Promise<boolean> {
		for (const n of nodes) {
			if (n.type === "unit" && n.ref) {
				const info = await this.resolveRef(n.ref);
				if (this.matchesFilter(info.text)) return true;
			}
			// R18: a Folder's API rows are its rows too, just not `ViewNode` children (G10) — a filter
			// match among them must force-reveal the Folder the same as a matching real descendant would.
			if (n.type === "meta" && this.apiItemsMatchFilter(n)) return true;
			if (n.children.length > 0 && (await this.subtreeHasMatch(n.children))) return true;
		}
		return false;
	}

	/** PR 9 (issue 6): restores every folder's fold state to what it was immediately before the
	 * current filter run started force-revealing matches, then forgets that snapshot. Safe to call
	 * even with nothing to restore (`preFilterCollapsedState` is null until a filter actually
	 * force-reveals something). */
	private restoreFoldStateAfterFilterClear(): void {
		if (!this.preFilterCollapsedState) return;
		const view = this.plugin.viewsManager.getActiveView();
		for (const [nodeId, collapsed] of this.preFilterCollapsedState) {
			this.plugin.viewsManager.setNodeCollapsed(view.id, nodeId, !!collapsed);
		}
		this.preFilterCollapsedState = null;
	}

	/** PR 12: shared fold/unfold wiring for any node with children — meta folders (always) and now
	 * unit nodes that have gained meta-nested children (only once they have at least one, per the
	 * grilling decision that a chevron shouldn't appear pre-emptively). Handles the filter-driven
	 * auto-reveal (PR 9 issue 6), the chevron icon, the animated children wrapper, and the same
	 * optimistic-local-state-then-delayed-persist click pattern used everywhere else fold/unfold
	 * happens in this plugin — extracted here instead of duplicated per node type so the two can't
	 * drift out of sync with each other the way duplicated logic has caused bugs before in this build. */
	private async renderFoldableChildren(node: ViewNode, chevron: HTMLElement, container: HTMLElement, view: View, depth: number, ancestors: StatusGovernance[]): Promise<void> {
		// PR 9 (issue 6): a filter-matching descendant force-reveals this node regardless of its own
		// collapsed state, so a match is never hidden behind a stale fold. The state from just before
		// the filter started touching it is remembered (once) so clearing the filter can put it back
		// exactly, rather than leaving every node the filter happened to open expanded.
		const filterActive = !!this.filterText.trim();
		let effectiveCollapsed = !!node.collapsed;
		if (filterActive) {
			if (!this.preFilterCollapsedState) this.preFilterCollapsedState = new Map();
			if (!this.preFilterCollapsedState.has(node.id)) this.preFilterCollapsedState.set(node.id, node.collapsed);
			if ((await this.subtreeHasMatch(node.children)) || this.apiItemsMatchFilter(node)) effectiveCollapsed = false;
		}
		setIcon(chevron, effectiveCollapsed ? "chevron-right" : "chevron-down");

		// Children always render (regardless of collapsed state) inside a dedicated wrapper, so
		// collapsing/expanding can be a CSS transition on that wrapper (grid-template-rows 1fr↔0fr,
		// the standard height:auto-safe collapse technique) instead of the row disappearing from
		// the DOM outright. The state-persisting call (which triggers a full re-render via
		// `onChange`) is deliberately delayed to let the transition actually play first — firing
		// it immediately would rebuild the DOM from scratch on the next tick and cut the animation
		// short with a hard snap instead of a slide.
		const childrenWrap = container.createDiv({ cls: "atlas-meta-children" });
		childrenWrap.toggleClass("is-collapsed", effectiveCollapsed);
		const childrenInner = childrenWrap.createDiv({ cls: "atlas-meta-children-inner" });
		// PR 17: `node` becomes the nearest ancestor for its own children — prepended, not replacing
		// the chain, so a grandparent's `inheritToSubfolders` can still reach past `node` if `node`
		// itself isn't a governor (or is, but doesn't itself reach — same walk either way).
		// T2/G25: `node`'s own API item rows (gated on the rows existing, not on `apiSource` surviving
		// — see `nodeHasApiRows`'s own doc comment) are passed in as `apiOwner` so they're merged into
		// this same list's sort/truncate pass, right behind the real children, instead of a second
		// `renderApiItems` pass with no sort/truncate logic of its own.
		const apiOwner = node.type === "meta" && nodeHasApiRows(node) ? node : undefined;
		await this.renderNodeList(node.children, childrenInner, view, depth + 1, [node, ...ancestors], apiOwner);

		// Local optimistic state, not `node.collapsed` — real bug caught in review: `node.collapsed`
		// only updates once the delayed `setNodeCollapsed` below actually runs, so a second click
		// inside that window previously read the same stale value as the first and re-applied the
		// same direction instead of toggling back. Also cancels/reschedules the pending persist
		// call per click, so only the last click in a rapid burst ever gets persisted.
		let localCollapsed = effectiveCollapsed;
		let pendingPersist: number | undefined;
		chevron.addEventListener("click", (evt) => {
			evt.stopPropagation();
			localCollapsed = !localCollapsed;
			setIcon(chevron, localCollapsed ? "chevron-right" : "chevron-down");
			childrenWrap.toggleClass("is-collapsed", localCollapsed);
			if (pendingPersist !== undefined) window.clearTimeout(pendingPersist);
			pendingPersist = window.setTimeout(() => {
				pendingPersist = undefined;
				this.plugin.viewsManager.setNodeCollapsed(view.id, node.id, localCollapsed);
			}, COLLAPSE_TRANSITION_MS);
		});
	}

	/** PR 15/17: renders a row's icon slot — either its normal type icon (`fallbackIconName`) or, if
	 * some ancestor governs this row (directly, or via `inheritToSubfolders` reaching past a closer
	 * non-reaching one — see `resolveNodeStatus`'s own doc comment for the full precedence rule), a
	 * colored status dot instead. Status assignment is descendant-governing, not self-governing
	 * (Dan's own spec: "the statuses apply to the first direct children under that item") — a
	 * governor's own `statusEnabled`/`statusSetId` fields describe what's *underneath* it, never its
	 * own displayed status, so this resolves against `ancestors`, never `node` itself. `ancestors[0]`
	 * is the nearest (direct parent, or the view root for a top-level item) — the chain always has
	 * at least the view in it, so root-level assignment (PR 17) falls out of the same walk with no
	 * special-casing for "nothing above this node."
	 *
	 * Dan-found sizing fix: the dot itself is a small (10px) circle centered inside the row's normal
	 * icon-slot footprint, not the whole slot — matching the reference plugin's own `.ffsi-dot`
	 * dimensions exactly (checked its live container build) rather than the icon-slot's full size,
	 * which read as oversized. Color and glow (`currentColor`-based layered box-shadow, same
	 * technique the reference plugin uses) are set on this inner circle, not the outer slot, so the
	 * glow radius is proportioned to the small dot instead of a large box.
	 *
	 * "Retain icons" (Status → Design) keeps the normal icon visible, shrunk down inside the circle,
	 * colored via "Retained icon color" (also Status → Design) — either the theme's normal text
	 * color or its background color, Dan's choice, not a fixed black/white contrast heuristic.
	 * Shared by meta and unit rows so the two can't drift out of sync with each other, the same
	 * reasoning `renderFoldableChildren`'s own extraction already used. */
	/** R5: `onSetStatus`, when given, replaces the default "resolve `node` as a real `ViewNode` via
	 * `setExplicitStatus`" behavior — a pseudo-`ViewNode` built for an API item (see
	 * `pseudoNodeForApiItem`) has no real counterpart `setExplicitStatus` could ever find by id, so
	 * without this the dot click was either a silent no-op or, worse, could collide with and corrupt
	 * an unrelated real node that happened to share the pseudo node's id. */
	private renderRowIcon(
		iconEl: HTMLElement,
		view: View,
		node: ViewNode,
		ancestors: StatusGovernance[],
		fallbackIconName: string,
		onSetStatus?: (statusId: string) => void
	): void {
		const status = this.plugin.statusesManager.resolveNodeStatus(ancestors, node);
		if (!status) {
			setIcon(iconEl, fallbackIconName);
			return;
		}
		iconEl.addClass("atlas-status-dot");
		const circle = iconEl.createDiv({ cls: "atlas-status-dot-circle" });
		circle.toggleClass("atlas-status-glow", this.plugin.settings.glowEnabled);
		circle.style.backgroundColor = status.color;
		circle.style.color = status.color; // currentColor source for the glow box-shadow layers
		if (this.plugin.settings.retainIcons) {
			const innerIcon = circle.createSpan({ cls: "atlas-status-dot-icon" });
			innerIcon.style.color = this.plugin.settings.retainIconMatchBackground ? "var(--background-primary)" : "var(--text-normal)";
			setIcon(innerIcon, fallbackIconName);
		}
		// PR 16: a plain left-click directly on the dot opens the status-picker popup — a dedicated
		// click target separate from the row's own click (open file) and right-click (full context
		// menu), which stay bound to the row itself and are unaffected. `stopPropagation` keeps this
		// click from also triggering the row's "open file" handler underneath it. Real drag gestures
		// never fire a `click` event at all (mousedown+move suppresses it), so this can never race
		// with the row/icon's own drag-based mechanics (meta-nest, module dwell/drop) — confirmed
		// during grilling, not just assumed.
		circle.addEventListener("click", (evt) => {
			evt.stopPropagation();
			// PR 17: re-finds the winning governor rather than reusing `ancestors[0]` — with
			// inheritance, the governor actually in effect for this row might be several levels up.
			const governor = this.plugin.statusesManager.findGoverningAncestor(ancestors, node);
			if (!governor?.statusSetId) return;
			const set = this.plugin.statusesManager.getStatusSet(governor.statusSetId);
			if (!set) return;
			openStatusPickerPopup({
				anchor: circle,
				statusSet: set,
				currentStatusId: status.id,
				onSelect: (picked) => (onSetStatus ? onSetStatus(picked.id) : this.plugin.viewsManager.setExplicitStatus(view.id, node.id, picked.id)),
			});
		});
	}

	private async renderNode(node: ViewNode, container: HTMLElement, view: View, depth: number, ancestors: StatusGovernance[]): Promise<void> {
		if (node.type === "meta") {
			const row = container.createDiv({ cls: "atlas-row atlas-row-meta" });
			row.dataset.selectKey = node.id;
			row.toggleClass("is-selected", this.selectedBucketNodeIds.has(node.id));
			row.style.paddingLeft = `${depth * 16}px`;
			row.setAttr("draggable", "true");
			const chevron = row.createDiv({ cls: "atlas-chevron" });
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			this.renderRowIcon(iconEl, view, node, ancestors, "layers");
			row.createSpan({ cls: "atlas-row-text", text: node.label ?? "" });
			if (node.apiSource || node.csvSource || node.markdownTableSource) {
				// G11/PR-7/PR-8: connection dot — green ok / grey never-refreshed / red last-refresh-failed
				// / amber (PR-3) waiting on an unanswered automatic delete confirmation. CSV and Markdown
				// Table both share this exact dot: their controllers write the same `apiCache`/
				// `apiAwaitingConfirmation` fields an API source does.
				const dot = row.createSpan({
					cls: `atlas-api-connection-dot atlas-api-dot-${dotStateFor(node.apiCache, node.apiAwaitingConfirmation)}`,
				});
				setTooltip(dot, dotTooltip(node.apiCache, Date.now(), node.apiAwaitingConfirmation));
			}
			if (node.folderSource?.location === "outside") {
				// PR-5 (G6/G11): recomputed fresh on every render (same "no cached connection state
				// anywhere" design as the modal's own dot) — load and focus-regain both already trigger a
				// render via `queueRender`, so this alone satisfies the recheck-on-load/focus-regain
				// requirement with no separate timer/poll (F10).
				const resolved = resolveOutsidePath(this.plugin.folderSourcePathStore.get(node.id));
				const dot = row.createSpan({ cls: `atlas-api-connection-dot atlas-api-dot-${resolved ? "green" : "red"}` });
				setTooltip(dot, resolved ? "Path resolves on this device" : "Path does not resolve on this device");
			}

			// PR 20: a meta row's plain click never did anything before this (no open target) — safe
			// to bind unconditionally, since the previous behavior ("nothing happens") is preserved
			// exactly for a plain click; only shift/cmd-click gain new meaning.
			row.addEventListener("click", (evt) => this.handleSelectionClick(evt, node.id, "bucket", this.bucketVisibleOrder()));
			row.addEventListener("dragstart", () => (this.dragPayload = this.buildNodeDragPayload(node.id, view.id)));
			this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
			row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
			row.tabIndex = 0;
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.showMetaFolderMenu(evt, node, view);
			});

			await this.renderFoldableChildren(node, chevron, container, view, depth, ancestors);
			return;
		}

		const ref = node.ref;
		if (!ref) return;
		const outsideManaged = this.isOutsideManagedUnit(view, node);
		const info = outsideManaged ? this.resolveOutsideManagedRowInfo(ref) : await this.resolveRef(ref);
		if (!this.matchesFilter(info.text)) return;

		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		if (info.missing) row.addClass("atlas-missing");
		row.dataset.refKey = unitRefKey(ref);
		row.dataset.selectKey = node.id;
		row.toggleClass("is-selected", this.selectedBucketNodeIds.has(node.id));
		row.style.paddingLeft = `${depth * 16}px`;
		// G8/F7: an Outside-Vault-managed child never drags (there is no real move/rename for it to
		// perform — Obsidian's rename/move APIs only operate on vault paths).
		row.setAttr("draggable", outsideManaged ? "false" : "true");

		// PR 12: every row now gets a chevron slot, matching meta rows and the Module Contents modal
		// (PR 10) — real content only if this unit has meta-nested children (a chevron appears only
		// once a node actually gets its first child, never pre-emptively), otherwise left empty
		// purely to keep icons aligned at the same depth regardless of type. Replaces the old fixed
		// `UNIT_ROW_CHEVRON_OFFSET` padding hack, which just simulated a chevron's width in CSS —
		// an actual (possibly empty) element is what PR 10 already found to be the reliable fix for
		// this exact alignment problem, so reusing it here instead of a second magic-number offset.
		const chevron = row.createDiv({ cls: "atlas-chevron" });
		const iconEl = row.createDiv({ cls: "atlas-icon" });
		this.renderRowIcon(iconEl, view, node, ancestors, info.icon);
		row.createSpan({ cls: "atlas-row-text", text: info.text });
		if (info.promoted) row.createSpan({ cls: "atlas-badge", text: "promoted" });
		if (info.added) row.createSpan({ cls: "atlas-badge", text: "added" });
		if (info.secondary) row.createSpan({ cls: "atlas-row-secondary", text: info.secondary });
		if (info.missing) {
			row.createSpan({ cls: "atlas-row-secondary", text: "(missing)" });
			const removeBtn = row.createDiv({ cls: "atlas-row-action" });
			setIcon(removeBtn, "x");
			setTooltip(removeBtn, "Remove from view");
			removeBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.plugin.viewsManager.unplaceNode(view.id, node.id);
			});
		}
		// PR 9 (issue 2): modules never expand inline anymore, in the bucket or the inbox — the icon
		// opens the Module Contents modal instead. `ref.kind === "folder"` covers both folder-unit and
		// promoted-folder (both are real folders on disk, per `unitToRef`). G8/F7: never wired for an
		// Outside-Vault-managed child — its icon drop target would otherwise call `renameFile` with an
		// absolute external path, which is exactly the "rename affordance" the spec requires absent.
		if (!info.missing && !outsideManaged && ref.kind === "folder") this.wireModuleRow(row, iconEl, ref.path);

		this.setPlacementTooltip(row, ref);
		row.addEventListener("click", (evt) => {
			const consumed = this.handleSelectionClick(evt, node.id, "bucket", this.bucketVisibleOrder());
			// R9(c): `ref.path` here is a bare name relative to the Outside source's root, never a vault
			// path — calling `openRef` would open (or create) a same-named vault-root file/module
			// instead of doing nothing, which is what clicking an Outside row is supposed to do.
			if (!consumed && !outsideManaged) void this.openRef(ref);
		});
		if (!outsideManaged) {
			row.addEventListener("dragstart", () => (this.dragPayload = this.buildNodeDragPayload(node.id, view.id)));
			this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
		}
		row.tabIndex = 0;
		row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showUnitMenu(evt, ref, view, node);
		});

		if (node.children.length > 0) await this.renderFoldableChildren(node, chevron, container, view, depth, ancestors);
	}

	// --- inbox -----------------------------------------------------------------------------------

	private async renderInboxSection(
		container: HTMLElement,
		view: View,
		units: Unit[],
		dismissedUnits: Unit[],
		viewportScrollTop: number
	): Promise<void> {
		const header = container.createDiv({ cls: "atlas-section-header" });
		const chevron = header.createDiv({ cls: "atlas-chevron" });
		setIcon(chevron, this.inboxCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: "Inbox" });
		// PR-5: the count badge reflects the real (undismissed) inbox size regardless of whether
		// dismissed rows are currently revealed — "Show Dismissed" is a temporary peek, not a change
		// to what's actually in the inbox, so the count shouldn't jump around as it's toggled.
		header.createSpan({ cls: "atlas-badge atlas-count-badge", text: String(units.length) });
		// PR-5 (G7): additive — the header's existing collapse `click` listener below is untouched.
		header.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showInboxHeaderMenu(evt);
		});

		const modeToggle = header.createDiv({ cls: "atlas-inbox-mode" });
		for (const mode of ["view", "global"] as const) {
			const btn = modeToggle.createSpan({ cls: "atlas-inbox-mode-btn", text: mode === "view" ? "This view" : "Global" });
			if (view.inboxMode === mode) btn.addClass("is-active");
			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.plugin.viewsManager.setInboxMode(view.id, mode);
			});
		}

		// PR-3 (G1): a sibling of `modeToggle`, not nested inside it — `.atlas-inbox-mode` already
		// carries its own `margin-left: auto` to push the toggle to the row's right edge, so this only
		// needs `.atlas-section-header`'s existing flex `gap` to sit beside it without a second
		// competing auto margin.
		const addBtn = header.createDiv({ cls: "atlas-inbox-add-btn" });
		setIcon(addBtn, "plus");
		setTooltip(addBtn, "Add file to inbox");
		addBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openAddFileModal();
		});

		// PR 11: same fix as the bucket section and the meta-folder chevron — content always renders
		// into a dedicated wrapper so the collapse is a CSS transition, not a hard snap between
		// "rendered" and "not rendered", and the state-persisting re-render is delayed to let the
		// transition play first. The inbox additionally needs to stop claiming all remaining
		// vertical space (via `container`'s own `flex: 1 1 auto`, PR 9 issue 3) once collapsed —
		// otherwise a collapsed inbox would leave a tall blank void instead of shrinking to just its
		// header, since flex-grow doesn't know or care that its content just went to zero height.
		// `.atlas-section.atlas-inbox.is-collapsed` (styles.css) overrides that back to natural
		// height; `container` is the very element that class already targets.
		container.toggleClass("is-collapsed", this.inboxCollapsed);
		const sectionWrap = container.createDiv({ cls: "atlas-meta-children" });
		sectionWrap.toggleClass("is-collapsed", this.inboxCollapsed);
		const sectionInner = sectionWrap.createDiv({ cls: "atlas-meta-children-inner" });

		const listEl = sectionInner.createDiv({ cls: "atlas-node-list" });
		this.makeDropZone(listEl, { kind: "inbox-area", viewId: view.id });

		// PR-5 (G8): dismissed rows are merged into the exact same input list the rest of this
		// function already sorts/selects/virtualizes — never a second container or render path.
		const combined = [
			...units.map((unit) => ({ unit, hidden: false })),
			...dismissedUnits.map((unit) => ({ unit, hidden: true })),
		];
		const resolved = await Promise.all(
			combined.map(async ({ unit, hidden }) => ({ unit, ref: unitToRef(unit), hidden, info: await this.resolveRef(unitToRef(unit)) }))
		);
		const filtered = resolved.filter((r) => this.matchesFilter(r.info.text));
		// PR-1.F2 (G3): every module (folder-kind unit) sorts by name in newest-first mode, not ctime 0.
		const alphabetical = this.sortMode === "alphabetical";
		const lookup = (path: string) => this.plugin.app.vault.getAbstractFileByPath(path);
		const sorted = filtered.sort((a, b) =>
			compareInboxRows({ unit: a.unit, text: a.info.text }, { unit: b.unit, text: b.info.text }, alphabetical, lookup)
		);

		// PR 20: captured here (not queried from the DOM like the bucket's) — F11's virtualization
		// below means most of these rows never actually exist in the DOM at once, so a shift-click on
		// a row currently scrolled into view still needs this to know the full order, not just
		// whatever's presently painted.
		this.inboxSelectOrder = sorted.map((r) => unitRefKey(r.ref));
		this.inboxRefByKey = new Map(sorted.map((r) => [unitRefKey(r.ref), r.ref]));

		// F11: the inbox can be thousands of rows (5,000 files + 2,000 free blocks scale target).
		// The non-virtualized fallback this used to need for expanded folder-unit internals is gone —
		// PR 9 (issue 2) replaced inline inbox expansion with the Module Contents modal, so every
		// inbox row is now fixed-height and the virtualized path always applies.
		this.renderVirtualizedInboxRows(listEl, sorted, viewportScrollTop, view);

		let localCollapsed = this.inboxCollapsed;
		let pendingPersist: number | undefined;
		header.addEventListener("click", () => {
			localCollapsed = !localCollapsed;
			setIcon(chevron, localCollapsed ? "chevron-right" : "chevron-down");
			container.toggleClass("is-collapsed", localCollapsed);
			sectionWrap.toggleClass("is-collapsed", localCollapsed);
			if (pendingPersist !== undefined) window.clearTimeout(pendingPersist);
			pendingPersist = window.setTimeout(() => {
				pendingPersist = undefined;
				this.inboxCollapsed = localCollapsed;
				void this.render();
			}, COLLAPSE_TRANSITION_MS);
		});
	}

	/** PR-3 (G2, G3): opens the "+" modal over every vault file minus whatever's already a unit or
	 * placed somewhere, and on selection marks it "added" (terminal state — see `markAdded`) and
	 * persists immediately, matching the click-driven-action convention `promoteAndPlace` uses. */
	private openAddFileModal(): void {
		const { app, settings, unitIndex, viewsManager } = this.plugin;
		const units = unitIndex.getUnits();
		// PR-1.F1: one placed-set per open, shared by the file and folder candidate lists.
		const placed = viewsManager.placedRefKeys();
		const isPlacedAnywhere = (ref: UnitRef): boolean => placed.has(unitRefKey(ref));
		const candidates: (TFile | TFolder)[] = [
			...candidateFilesForAdd(app.vault.getFiles(), units, isPlacedAnywhere, (ref) => unitIndex.isDismissed(ref, "global")),
			...candidateFoldersForAdd(app.vault.getAllLoadedFiles(), units, placed, settings),
		];
		new AddFileSuggestModal(app, candidates, (item) => {
			const ref: UnitRef = item instanceof TFolder ? { kind: "folder", path: item.path } : { kind: "file", path: item.path };
			unitIndex.markAdded(ref);
			void this.plugin.flushSave();
			void this.render();
		}).open();
	}

	private renderInboxRow(container: HTMLElement, ref: UnitRef, info: RowInfo, view: View, hidden = false): HTMLElement {
		// PR-1.F2 (G10): only an "added" item that has gone missing gets the greyed row. A missing row that
		// is not "added" (promoted, link-derived) keeps today's inbox behaviour.
		const missingAdded = info.missing && this.plugin.unitIndex.isAdded(ref);
		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		const key = unitRefKey(ref);
		if (missingAdded) row.addClass("atlas-missing");
		row.dataset.refKey = key;
		row.dataset.selectKey = key;
		row.toggleClass("is-selected", this.selectedInboxRefKeys.has(key));
		row.setAttr("draggable", missingAdded ? "false" : "true");
		const iconEl = row.createDiv({ cls: "atlas-icon" });
		setIcon(iconEl, info.icon);
		row.createSpan({ cls: "atlas-row-text", text: info.text });
		if (info.promoted) row.createSpan({ cls: "atlas-badge", text: "promoted" });
		if (info.added) row.createSpan({ cls: "atlas-badge", text: "added" });
		// PR-5 (G8): independent of the promoted/added spans above — a unit can carry both at once
		// without either clobbering the other, since each is just its own sibling span.
		if (hidden) row.createSpan({ cls: "atlas-badge", text: "hidden" });
		if (info.secondary) row.createSpan({ cls: "atlas-row-secondary", text: info.secondary });
		if (missingAdded) {
			// PR-1.F2 (G10): same greyed "(missing)" row and Remove button as the bucket; never auto-removed.
			row.createSpan({ cls: "atlas-row-secondary", text: "(missing)" });
			const removeBtn = row.createDiv({ cls: "atlas-row-action" });
			setIcon(removeBtn, "x");
			setTooltip(removeBtn, "Remove from inbox");
			removeBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.removeMissingAddedRow(ref);
			});
		}
		// PR 9 (issue 2): modules never expand inline anymore, in the inbox or the bucket — the icon
		// opens the Module Contents modal instead (see `wireModuleRow`). A missing added row is never wired.
		if (ref.kind === "folder" && !missingAdded) this.wireModuleRow(row, iconEl, ref.path);

		this.setPlacementTooltip(row, ref);
		row.addEventListener("click", (evt) => {
			const consumed = this.handleSelectionClick(evt, key, "inbox", this.inboxSelectOrder);
			if (!consumed && !missingAdded) void this.openRef(ref);
		});
		row.addEventListener("dragstart", () => (this.dragPayload = this.buildInboxDragPayload(ref)));
		row.tabIndex = 0;
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			// PR-1.F2 (G10): a missing added row offers only Remove, never Open/Create note/Place (its target is gone).
			if (missingAdded) return;
			this.showInboxUnitMenu(evt, ref, view);
		});
		return row;
	}

	/** PR-1.F2 (G10): Remove on an inbox "(missing)" row. Takes the item out of `addedItems`, drops it from
	 * the selection so no ghost row is left behind, saves immediately, and re-renders. Nothing else changes. */
	private removeMissingAddedRow(ref: UnitRef): void {
		this.plugin.unitIndex.removeAdded(ref);
		this.selectedInboxRefKeys.delete(unitRefKey(ref));
		void this.plugin.flushSave();
		void this.render();
	}

	/** F11: renders only the rows within the scrolled viewport (+ overscan) of a fixed-height,
	 * absolutely-positioned window, with a full-height spacer so the scrollbar reflects the true
	 * list length. Redraws on scroll (rAF-throttled) rather than re-running the whole view's
	 * `render()`, so scrolling thousands of rows doesn't re-resolve/re-sort/re-render the toolbar
	 * and bucket section on every frame. */
	private renderVirtualizedInboxRows(
		listEl: HTMLElement,
		sorted: { ref: UnitRef; info: RowInfo; unit: Unit; hidden: boolean }[],
		viewportScrollTop: number,
		view: View
	): void {
		const viewport = listEl.createDiv({ cls: "atlas-inbox-viewport" });
		const spacer = viewport.createDiv({ cls: "atlas-inbox-spacer" });
		spacer.style.height = `${sorted.length * INBOX_ROW_HEIGHT}px`;
		// Dan-found: restores the inbox's own scroll position across a re-render (see `render()`'s
		// own doc comment on why this is separate from the outer container's scrollTop). Has to be
		// set before the first `drawWindow()` call below, not after — that call reads
		// `viewport.scrollTop` synchronously to decide which rows even belong in the initial DOM, so
		// setting it later would draw the wrong window first and only fix itself on the next scroll.
		viewport.scrollTop = viewportScrollTop;

		let frameQueued = false;
		const drawWindow = () => {
			frameQueued = false;
			spacer.empty();
			const viewportHeight = viewport.clientHeight || 300;
			const start = Math.max(0, Math.floor(viewport.scrollTop / INBOX_ROW_HEIGHT) - INBOX_OVERSCAN);
			const count = Math.ceil(viewportHeight / INBOX_ROW_HEIGHT) + INBOX_OVERSCAN * 2;
			const end = Math.min(sorted.length, start + count);
			for (let i = start; i < end; i++) {
				const { ref, info, hidden } = sorted[i];
				const row = this.renderInboxRow(spacer, ref, info, view, hidden);
				row.addClass("atlas-row-virtual");
				row.style.top = `${i * INBOX_ROW_HEIGHT}px`;
			}
		};

		drawWindow();
		viewport.addEventListener("scroll", () => {
			if (frameQueued) return;
			frameQueued = true;
			window.requestAnimationFrame(drawWindow);
		});
	}

	/** F3: promotes and places a module's internal file/folder — called from the Module Contents
	 * modal's "Promote and place in view…" context menu item (`promoteAndPlaceFlow`). Used to also be
	 * reachable by dragging an internal out of an inline-expanded tree; PR 9 (issue 2) replaced that
	 * inline expansion with the modal, and a modal backdrop makes dragging out into the now-hidden
	 * bucket impractical, so this is click-driven only now. */
	private promoteAndPlace(path: string, isFolder: boolean, view: View, parentId: string | null): void {
		const ref: UnitRef = isFolder ? { kind: "folder", path } : { kind: "file", path };
		this.plugin.unitIndex.addManualPromotion(ref);
		void this.plugin.saveManualPromotions();
		this.plugin.viewsManager.placeUnit(view.id, ref, parentId);
	}

	// --- drag and drop -----------------------------------------------------------------------------

	private makeDropZone(
		el: HTMLElement,
		target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }
	): void {
		el.addEventListener("dragover", (evt) => {
			if (!this.dragPayload) return;
			evt.preventDefault();
			el.addClass("atlas-drop-target");
		});
		el.addEventListener("dragleave", () => el.removeClass("atlas-drop-target"));
		el.addEventListener("drop", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			el.removeClass("atlas-drop-target");
			this.handleDrop(target);
		});
	}

	/** PR 12: dropping onto a row now always means "nest as a child of this row" (meta-nesting,
	 * organizational only) — every node type can be a parent now, not just meta folders (Q3/Q11,
	 * grilled with Dan directly). The one exception, the real disk-move "add to module" gesture, no
	 * longer lives here at all — it moved to the module icon's own drop zone in `wireModuleRow`,
	 * which handles it and calls `stopPropagation()` before a drop event would ever reach this
	 * row-level handler. This *did* mean giving up "drop onto a row to insert as its sibling," which
	 * this branch used to do for unit targets — a deliberate simplification Dan chose over a
	 * right-side/rest-of-row zone split; reordering to a specific position among siblings now needs
	 * un-nesting to the bucket root or a meta folder first, not a single drag onto a neighbor.
	 *
	 * Also fixes a real, pre-existing bug found while rewriting this for PR 12: for a `payload.kind
	 * === "node"` drag (an *existing* tree node being reparented, not a fresh ref from the inbox),
	 * this used to route through `placeUnit` — which only makes sense for a unit ref and, worse,
	 * builds a *brand-new* node object with `children: []`, discarding whatever the dragged node's
	 * real children/collapsed state was. Harmless before PR 12 (units never had children to lose,
	 * and `placeUnit`'s `findUnitNode` lookup never matched a dragged *meta* folder's ref at all, so
	 * meta drags silently no-op'd instead of actually moving). PR 12 makes both halves of this live:
	 * units can now genuinely have children to lose, and meta-nesting makes "drag one row onto
	 * another" universal. `moveNode` is the correct operation for an existing node changing parent
	 * either way — it reparents the real node object in place instead of replacing it. */
	private handleDrop(target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }): void {
		const payload = this.dragPayload;
		this.dragPayload = null;
		if (!payload) return;

		if (target.kind === "inbox-area") {
			// Only a unit has a disk/ref identity to "return to the inbox" — a meta folder dropped
			// here is simply not a meaningful gesture, so it's a no-op rather than acting on a
			// fabricated ref for that one, not the whole drag.
			if (payload.kind === "node") {
				const draggedView = this.plugin.viewsManager.getView(payload.viewId);
				if (draggedView) {
					for (const nodeId of payload.nodeIds) {
						const dragged = this.findNodeAnywhere(draggedView.root, nodeId);
						// PR 13: unplaceNode removes this exact dragged instance, not every duplicate of
						// the same unit that might also be placed elsewhere in this view.
						if (dragged?.node.type === "unit") this.plugin.viewsManager.unplaceNode(payload.viewId, nodeId);
					}
				}
			}
			this.selectedBucketNodeIds.clear();
			this.queueRender();
			return;
		}

		const viewId = target.viewId;
		let parentId: string | null = null;
		if (target.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			const found = view && this.findNodeAnywhere(view.root, target.nodeId);
			if (found) parentId = found.node.id;
		}

		if (payload.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			if (!view) return;
			// PR 20: a node already nested under *another* node in this same drag batch travels along
			// with that ancestor's own move automatically — moving it again separately right after
			// would yank it back out into a sibling of its own ancestor, flattening a relationship the
			// user very likely meant to keep by dragging them together in the first place.
			const toMove = payload.nodeIds.filter((id) => {
				const found = this.findNodeAnywhere(view.root, id);
				if (!found) return false;
				return !payload.nodeIds.some((otherId) => {
					if (otherId === id) return false;
					const other = this.findNodeAnywhere(view.root, otherId);
					return !!other && this.nodeContainsDescendant(other.node, id);
				});
			});
			// An existing tree node (meta or unit) is being reparented/reordered — `moveNode` operates
			// on it directly by id, in place, so its own children/collapsed state travels with it.
			// Each move appends after the previous one, so the whole selection lands at the
			// destination in the same relative order it was dragged in.
			let index = parentId ? (this.findNodeAnywhere(view.root, parentId)?.node.children.length ?? 0) : view.root.length;
			for (const nodeId of toMove) {
				if (this.plugin.viewsManager.moveNode(viewId, nodeId, parentId, index)) index++;
			}
			this.selectedBucketNodeIds.clear();
			this.queueRender();
			return;
		}

		// payload.kind === "inbox": fresh unit refs, not yet placed anywhere in this view — placeUnit
		// always appends, so calling it in order already preserves the batch's relative order.
		for (const ref of payload.refs) this.plugin.viewsManager.placeUnit(viewId, ref, parentId);
		this.selectedInboxRefKeys.clear();
		this.queueRender();
	}

	private nodeContainsDescendant(node: ViewNode, targetId: string): boolean {
		for (const child of node.children) {
			if (child.id === targetId || this.nodeContainsDescendant(child, targetId)) return true;
		}
		return false;
	}

	/** Files/blocks are opaque internals to a folder-unit until something links to them — dropping
	 * one directly onto the module is the one deliberate way this explorer lets you physically file
	 * something into it, since Atlas otherwise never rearranges a module's internal organization.
	 * Gated by a confirm dialog (toggleable in settings) precisely because it's the one exception.
	 * Whether the moved file stays visible as its own addressable unit afterward is decided entirely
	 * by the existing link-graph promotion recompute (does it have a real backlink from outside the
	 * module?) — this never force-promotes it; a file with no backlinks simply becomes ordinary,
	 * invisible internals, matching the rest of the model. */
	private async handleAddToModule(ref: UnitRef, folderPath: string, skipConfirm = false): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(ref.path);
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(file instanceof TFile) || !(folder instanceof TFolder)) return;

		const perform = async (): Promise<void> => {
			const dotIndex = file.name.lastIndexOf(".");
			const base = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
			const ext = dotIndex > 0 ? file.name.slice(dotIndex + 1) : null;
			const newPath = await this.uniquePath(base, ext, folderPath);
			await this.plugin.app.fileManager.renameFile(file, newPath);

			const newRef: UnitRef = ref.kind === "block" ? { kind: "block", path: newPath, subpath: ref.subpath } : { kind: "file", path: newPath };
			// Promotion status only settles once Obsidian's own link graph re-resolves after the
			// move (rewritten backlink text elsewhere needs a metadataCache pass) — wait for exactly
			// that event once, then clean up any now-stale placement rather than leave a "missing"
			// ghost if it turned out to have no real backlinks and isn't a unit anymore. Cleaned up in
			// *every* view that held it (review, A11), not just the one the drag originated in — the
			// file moved on disk for the whole vault, not "within" whichever view was on screen, so
			// losing unit status is a vault-wide fact the same way `onVaultRename`'s own ref-rewriting
			// already treats path changes as cross-view, not scoped to one view's context.
			const offRef = this.plugin.app.metadataCache.on("resolved", () => {
				this.plugin.app.metadataCache.offref(offRef);
				const stillAUnit = this.plugin.unitIndex.getUnits().some((u) => unitRefKey(unitToRef(u)) === unitRefKey(newRef));
				if (!stillAUnit) {
					for (const v of this.plugin.viewsManager.getViews()) this.plugin.viewsManager.unplaceUnit(v.id, newRef);
				}
			});
		};

		// PR 9 (issue 2, point 5): dropping into a specific nested location via the Module Contents
		// modal (opened by holding a drag over the module rather than releasing it) skips the confirm
		// dialog outright, regardless of the setting — the deliberate hold-to-open gesture and picking
		// an exact destination inside the modal already *is* the confirmation. The setting only ever
		// gated the plain direct-drop path.
		if (skipConfirm) {
			await perform();
		} else if (this.plugin.settings.confirmAddToModule) {
			new ConfirmModal(
				this.plugin.app,
				`Add "${file.basename}" to "${folder.name}"? This moves the file on disk into that folder — Atlas doesn't otherwise touch a module's internal organization.`,
				"Add",
				() => void perform()
			).open();
		} else {
			await perform();
		}
	}

	private refOfNode(viewId: string, nodeId: string): UnitRef {
		const view = this.plugin.viewsManager.getView(viewId);
		const found = view && this.findNodeAnywhere(view.root, nodeId);
		return found?.node.ref ?? { kind: "file", path: "" };
	}

	/** PR 20: the module-icon drop zone (`wireModuleRow`, below) is a real disk move — deliberately
	 * restricted to a single-item drag. Dragging a multi-select onto a module icon to bulk-file
	 * several things into it at once is a materially riskier gesture (several renames at once instead
	 * of one named, confirmable one) than anything asked for here, so it's a no-op rather than an
	 * unreviewed bulk-move feature — the row-level drop zone underneath still handles a multi-item
	 * drag the normal way (organizational meta-nesting, never a disk move) once this returns `null`. */
	private singleDragRef(payload: DragPayload): UnitRef | null {
		if (payload.kind === "inbox") return payload.refs.length === 1 ? payload.refs[0] : null;
		return payload.nodeIds.length === 1 ? this.refOfNode(payload.viewId, payload.nodeIds[0]) : null;
	}

	private findNodeAnywhere(nodes: ViewNode[], nodeId: string): { node: ViewNode } | null {
		for (const node of nodes) {
			if (node.id === nodeId) return { node };
			const found = this.findNodeAnywhere(node.children, nodeId);
			if (found) return found;
		}
		return null;
	}

	// --- context menus -----------------------------------------------------------------------------

	private showUnitMenu(evt: MouseEvent, ref: UnitRef, view: View, node: ViewNode): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open").setIcon("file").onClick(() => void this.openRef(ref)));
		menu.addItem((item) => item.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.openRef(ref, true)));
		if (ref.kind === "file" || ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("Reveal in native explorer").setIcon("folder-open").onClick(() => this.revealInNativeExplorer(ref.path)));
		}
		// PR 16 (grilled): always offered for modules, not just governed ones — a governed module's
		// icon click now means "change status" (see `wireModuleRow`), so viewing contents needs a
		// path that doesn't depend on whether this module currently has a status assigned.
		if (ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("View module contents").setIcon("list-tree").onClick(() => this.openModuleContentsModal(ref.path)));
		}
		menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addSeparator();
		// PR 15 fix (Dan-found): status assignment governs this item's own *children*, not the item
		// itself — an item with no children has nothing for the option to apply to, so it's hidden
		// entirely rather than offered and doing nothing when toggled.
		if (node.children.length > 0) {
			menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(view, node.id)));
			menu.addSeparator();
		}
		// PR 13: clones this row (and its whole meta-nested subtree, if it has one) as a new sibling
		// right after it — same underlying unit, no disk duplicate, no naming scheme (two rows with
		// the same label is expected — see duplicateNode's own doc comment for why).
		menu.addItem((item) => item.setTitle("Duplicate (Meta)").setIcon("copy-plus").onClick(() => this.duplicateFolder(view, node)));
		menu.addItem((item) =>
			item
				.setTitle("Remove from view")
				.setIcon("x")
				// PR 13: unplaceNode removes this exact row, not every duplicate of the same unit
				// that might also be placed elsewhere in this view.
				.onClick(() => this.plugin.viewsManager.unplaceNode(view.id, node.id))
		);
		menu.addItem((item) => item.setTitle("Place in view…").setIcon("arrow-right-left").onClick(() => this.placeInViewFlow(ref)));
		// Create Module: only on a placed row for a root-level .md file (not inbox rows, not free
		// blocks, nested or promoted files, interface notes, or non-notes).
		addCreateModuleItem(menu, this.plugin.app.vault, unitForRef(this.plugin.unitIndex.getUnits(), ref), (file) => this.startCreateModule(file));
		menu.showAtMouseEvent(evt);
	}

	private startCreateModule(file: TFile): void {
		const { plugin } = this;
		void startCreateModule(
			{
				app: plugin.app,
				convert: (filePath, folderPath) => void plugin.viewsManager.convertFileNodesToModule(filePath, folderPath, plugin.unitIndex),
				save: () => plugin.flushSave(),
				afterMove: () => void noticeIfLinksNotUpdated(plugin.app),
				getPoolFolder: () => plugin.settings.poolFolder,
				getExcludedFolders: () => plugin.settings.excludedFolders,
			},
			file
		);
	}

	private startCreateFromMeta(kind: CreateKind, view: View, node: ViewNode): void {
		const { plugin } = this;
		void startCreateFromMeta(
			{
				app: plugin.app,
				getPoolFolder: () => plugin.settings.poolFolder,
				getExcludedFolders: () => plugin.settings.excludedFolders,
				getNode: (viewId, nodeId) => plugin.viewsManager.getNode(viewId, nodeId),
				replaceMetaNodeWithUnit: (viewId, nodeId, ref) => plugin.viewsManager.replaceMetaNodeWithUnit(viewId, nodeId, ref),
				holdUnit: (path) => plugin.unitIndex.holdUnit(path),
				save: () => plugin.flushSave(),
			},
			kind,
			view.id,
			node.id
		);
	}

	/** PR 15/17: the "Statuses" modal — opened from a bucket unit or meta folder's own context menu
	 * (`nodeId` set), or from the view-name selector for root-level assignment (`nodeId: null`,
	 * PR 17) — both read/write through `ViewsManager`'s generic `getStatusGovernance`/
	 * `updateStatusGovernance`, so this one method serves both without knowing which kind of
	 * governor it's actually editing. */
	private openStatusesModal(view: View, nodeId: string | null): void {
		const governance = this.plugin.viewsManager.getStatusGovernance(view.id, nodeId);
		if (!governance) return;
		new StatusesModal(this.plugin.app, this.plugin.statusesManager.getStatusSets(), governance, (patch) =>
			this.plugin.viewsManager.updateStatusGovernance(view.id, nodeId, patch)
		).open();
	}

	/** PR-5 (G7): the inbox section header's own right-click menu — a single toggle item, same
	 * `Menu`/`showAtMouseEvent` construction as the toolbar view-name menu and the row menus below.
	 * Toggling flips the instance-level `showDismissed` flag and re-renders; no persisted write, same
	 * as `inboxCollapsed`. */
	private showInboxHeaderMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(this.showDismissed ? "Hide Dismissed" : "Show Dismissed")
				.setIcon(this.showDismissed ? "eye-off" : "eye")
				.onClick(() => {
					this.showDismissed = !this.showDismissed;
					void this.render();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	private showInboxUnitMenu(evt: MouseEvent, ref: UnitRef, view: View): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open").setIcon("file").onClick(() => void this.openRef(ref)));
		menu.addItem((item) => item.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.openRef(ref, true)));
		if (ref.kind === "file" || ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("Reveal in native explorer").setIcon("folder-open").onClick(() => this.revealInNativeExplorer(ref.path)));
		}
		if (ref.kind === "folder") {
			const folder = this.plugin.app.vault.getAbstractFileByPath(ref.path);
			if (folder instanceof TFolder && !findInterfaceNote(this.plugin.app, folder, this.plugin.settings)) {
				menu.addItem((item) =>
					item
						.setTitle("Create interface note")
						.setIcon("file-plus-2")
						.onClick(async () => {
							const note = await createInterfaceNote(this.plugin.app, folder);
							await this.plugin.app.workspace.getLeaf(false).openFile(note);
						})
				);
			}
		}
		menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Place in view…").setIcon("arrow-right-left").onClick(() => this.placeInViewFlow(ref)));
		// PR-4 (G4-G6): the only removal mechanism for any inbox row, auto-promoted or manually-added
		// (PR-3) alike — there is no separate "remove"/"un-add" item anywhere in this menu (F1). Outside
		// Global view this only ever touches the current view's own dismiss set; invoked while the
		// explorer is showing Global view it writes the single global-scope entry instead (G5), which
		// `getInboxUnits`' dismissed-OR-check (view-scope reads global-or-own-view, global-scope reads
		// only the global set) then applies at render time for every view, including ones never opened.
		menu.addItem((item) =>
			item
				.setTitle("Dismiss")
				.setIcon("x")
				.onClick(() => {
					if (view.inboxMode === "global") {
						this.plugin.unitIndex.setDismissed(ref, "global", true);
					} else {
						this.plugin.unitIndex.setDismissed(ref, "view", true, view.id);
					}
					void this.plugin.flushSave();
					void this.render();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	private showMetaFolderMenu(evt: MouseEvent, node: ViewNode, view: View): void {
		const menu = new Menu();
		// PR 13: same clone-as-sibling action as a unit row's context menu — a meta folder has no
		// disk identity to begin with, so "duplicating" it just clones the organizational label and
		// its whole subtree, same mechanics either way (`duplicateNode` doesn't distinguish types).
		menu.addItem((item) => item.setTitle("Duplicate (Meta)").setIcon("copy-plus").onClick(() => this.duplicateFolder(view, node)));
		menu.addItem((item) =>
			item
				.setTitle("Rename folder")
				.setIcon("pencil")
				.onClick(() => {
					new TextPromptModal(this.plugin.app, "Rename folder", node.label ?? "", (label) => {
						this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
					}).open();
				})
		);
		// Create: turns this meta folder into a real block, file or module (one item on disk, the row
		// keeps its place, settings and children). Offered on every meta folder, whatever its children,
		// depth or fold state; ignores any multi-selection, so it only ever acts on this one row.
		addCreateItem(menu, evt, (kind) => this.startCreateFromMeta(kind, view, node));
		// R6: an API-only Folder has no real children yet still governs its API rows' statuses (G8) —
		// without `node.apiSource` here, such a Folder could never configure a status set at all. G4:
		// a Folder whose source was removed can still be carrying static rows from before — same reason
		// applies just as much to those.
		if (node.children.length > 0 || nodeHasApiRows(node)) {
			menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(view, node.id)));
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Data source…")
				.setIcon("plug-zap")
				.onClick(() => this.openApiSourceModal(view, node))
		);
		if (node.apiSource) {
			menu.addItem((item) =>
				item
					.setTitle("Refresh now")
					.setIcon("refresh-cw")
					.onClick(() => {
						// R8/G13: mobile shows cached rows only — say so rather than silently doing nothing.
						if (Platform.isMobile) {
							new Notice("Refreshing isn't available on mobile — showing cached rows.");
							return;
						}
						this.refreshApiSource(view, node, "manual");
					})
			);
			menu.addItem((item) =>
				item
					.setTitle("Remove data source")
					.setIcon("unplug")
					.onClick(() => {
						new ConfirmModal(
							this.plugin.app,
							`Remove the data source from "${node.label}"? Its current rows stay in place as plain rows — it just stops refreshing.`,
							"Remove",
							() => {
								this.plugin.viewsManager.setApiSource(view.id, node.id, undefined);
								// R4/G4: the source config itself includes headers (device-local, in
								// ApiHeadersStore) — Remove drops those too, same as Delete folder already
								// does, so a bearer token doesn't linger on the device or silently reappear
								// if a source is added back to this Folder later.
								this.plugin.apiHeadersStore.delete(node.id);
							}
						).open();
					})
			);
		} else if (node.folderSource) {
			// PR-4 (G10): reuses the exact same menu actions as an API source — "Refresh now" re-runs
			// the (synchronous, disk-read-only) reconciliation; "Remove data source" just stops it,
			// since the children it already placed are ordinary real units with nowhere else to go.
			menu.addItem((item) =>
				item
					.setTitle("Refresh now")
					.setIcon("refresh-cw")
					.onClick(() => this.refreshFolderSource(view, node))
			);
			menu.addItem((item) =>
				item
					.setTitle("Remove data source")
					.setIcon("unplug")
					.onClick(() => {
						new ConfirmModal(
							this.plugin.app,
							`Remove the data source from "${node.label}"? Its current children stay in place as plain units — it just stops refreshing.`,
							"Remove",
							() => this.plugin.viewsManager.setFolderSource(view.id, node.id, undefined)
						).open();
					})
			);
		} else if (node.csvSource) {
			// PR-7: reuses the exact same menu actions as an API source — "Refresh now" re-reads+parses
			// the file (no mobile guard, see `refreshCsvSource`'s own doc comment); "Remove data source"
			// just stops it, same as an API source's own Remove (rows stay in place). CSV has no
			// device-local headers store to clean up on removal.
			menu.addItem((item) =>
				item
					.setTitle("Refresh now")
					.setIcon("refresh-cw")
					.onClick(() => this.refreshCsvSource(view, node, "manual"))
			);
			menu.addItem((item) =>
				item
					.setTitle("Remove data source")
					.setIcon("unplug")
					.onClick(() => {
						new ConfirmModal(
							this.plugin.app,
							`Remove the data source from "${node.label}"? Its current rows stay in place as plain rows — it just stops refreshing.`,
							"Remove",
							() => this.plugin.viewsManager.setCsvSource(view.id, node.id, undefined)
						).open();
					})
			);
		} else if (node.markdownTableSource) {
			// PR-8: reuses the exact same menu actions as a CSV source — "Refresh now" re-reads+parses
			// the file (no mobile guard, see `refreshMarkdownTableSource`'s own doc comment); "Remove
			// data source" just stops it, same as a CSV source's own Remove (rows stay in place).
			// Markdown Table has no device-local headers store to clean up on removal.
			menu.addItem((item) =>
				item
					.setTitle("Refresh now")
					.setIcon("refresh-cw")
					.onClick(() => this.refreshMarkdownTableSource(view, node, "manual"))
			);
			menu.addItem((item) =>
				item
					.setTitle("Remove data source")
					.setIcon("unplug")
					.onClick(() => {
						new ConfirmModal(
							this.plugin.app,
							`Remove the data source from "${node.label}"? Its current rows stay in place as plain rows — it just stops refreshing.`,
							"Remove",
							() => this.plugin.viewsManager.setMarkdownTableSource(view.id, node.id, undefined)
						).open();
					})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Delete folder")
				.setIcon("trash-2")
				.onClick(() => {
					new ConfirmModal(
						this.plugin.app,
						`Delete "${node.label}"? Its contents move up one level — nothing on disk changes.`,
						"Delete",
						() => {
							// E6: the device-local headers entry has no home in the synced view data, so
							// it's cleaned up here rather than inside `deleteMetaFolder` itself.
							this.plugin.apiHeadersStore.delete(node.id);
							this.plugin.viewsManager.deleteMetaFolder(view.id, node.id);
						}
					).open();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	/** "Place in view ▸" as a two-step fuzzy flow — Obsidian's public Menu API has no submenu support. */
	private placeInViewFlow(ref: UnitRef): void {
		const views = this.plugin.viewsManager.getViews();
		new ViewSuggestModal(this.plugin.app, views, (view) => {
			const targets: MetaTarget[] = [{ id: null, label: "(bucket root)" }, ...flattenMetaFolders(view.root)];
			new MetaFolderSuggestModal(this.plugin.app, targets, (target) => {
				this.plugin.viewsManager.placeUnit(view.id, ref, target.id);
			}).open();
		}).open();
	}

	/** PR 9: click-driven equivalent of F3's "drag an internal out of the expanded tree to promote
	 * and place it" — that gesture stopped being possible once module internals moved into a modal
	 * (a modal backdrop makes dragging out into the now-hidden bucket impractical), so this preserves
	 * the same underlying capability (`promoteAndPlace`) from the Module Contents modal's own
	 * context menu instead of a drag. */
	private promoteAndPlaceFlow(path: string, isFolder: boolean): void {
		const views = this.plugin.viewsManager.getViews();
		new ViewSuggestModal(this.plugin.app, views, (view) => {
			const targets: MetaTarget[] = [{ id: null, label: "(bucket root)" }, ...flattenMetaFolders(view.root)];
			new MetaFolderSuggestModal(this.plugin.app, targets, (target) => {
				this.promoteAndPlace(path, isFolder, view, target.id);
			}).open();
		}).open();
	}

	// --- shared actions ------------------------------------------------------------------------

	private async openRef(ref: UnitRef, newTab = false): Promise<void> {
		if (ref.kind === "block") {
			this.plugin.app.workspace.openLinkText(`${ref.path}#${ref.subpath}`, "", newTab);
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(ref.path);
		if (ref.kind === "folder" && file instanceof TFolder) {
			const note = findInterfaceNote(this.plugin.app, file, this.plugin.settings);
			if (note) await this.plugin.app.workspace.getLeaf(newTab).openFile(note);
			return;
		}
		if (file instanceof TFile) await this.plugin.app.workspace.getLeaf(newTab).openFile(file);
	}

	private revealInNativeExplorer(path: string): void {
		this.plugin.app.workspace.getLeavesOfType("file-explorer")[0]?.setViewState({ type: "file-explorer" });
		const fileExplorer = this.plugin.app.workspace.getLeavesOfType("file-explorer")[0]?.view as unknown as {
			revealInFolder?: (file: TFile | TFolder) => void;
		};
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if ((file instanceof TFile || file instanceof TFolder) && fileExplorer?.revealInFolder) fileExplorer.revealInFolder(file);
	}

	// --- PR 9 (issue 2): module row icon — opens Module Contents instead of inline fold/unfold ------

	/** Wires a module row's icon (closed↔open crossfade on hover, "View module contents" tooltip,
	 * click opens the modal), its hover-during-drag dwell timer (point 5), and — PR 12 — the icon's
	 * own drop zone for the one remaining real-disk-move gesture in this row. Shared by both the
	 * inbox and bucket unit-row renderers so the two surfaces can't drift apart. `iconEl` is emptied
	 * and rebuilt with the two stacked icons the crossfade needs.
	 *
	 * PR 12: the dwell timer and the plain-drop-to-file-in confirm flow both used to be wired to the
	 * whole `row` — grilled with Dan directly (Q3/Q11) and rescoped to the icon only, since the rest
	 * of the row now means "meta-nest as a child" instead (organizational only, no disk move). The
	 * icon is the one place left where dropping a file/block still physically files it into the
	 * module; everywhere else on the row falls through to `makeDropZone`'s own row-level listener. */
	private wireModuleRow(row: HTMLElement, iconEl: HTMLElement, folderPath: string): void {
		// PR 15 fix (Dan-found, discovered while grilling the next PR): this used to unconditionally
		// wipe `iconEl` and repopulate it with the closed/open folder-icon crossfade, silently
		// overwriting a status dot `renderRowIcon` had just rendered there — meaning a governed
		// module could never actually show its dot at all, contradicting PR 15's own core promise.
		// The dot's own visual is left alone when present; the tooltip/click/drag wiring below still
		// applies to `iconEl` either way, since none of it depends on the icon's current visual
		// content. (Click's "open contents" meaning is expected to change for dotted modules once
		// the next PR's click-to-change-status lands — that's this PR's own scope, not PR 15's.)
		const hasStatusDot = iconEl.hasClass("atlas-status-dot");
		if (!hasStatusDot) {
			iconEl.empty();
			iconEl.addClass("atlas-module-icon");
			setIcon(iconEl.createSpan({ cls: "atlas-icon-closed" }), "folder");
			setIcon(iconEl.createSpan({ cls: "atlas-icon-open" }), "folder-open");
			setTooltip(iconEl, "View module contents");
			iconEl.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.openModuleContentsModal(folderPath);
			});
		}
		// PR 16 (grilled): a governed module's icon *is* its status dot, whose own click (wired in
		// `renderRowIcon`) already means "change status" — plain click can't mean two things on the
		// same element, and Dan's own original behavior list never included plain-click-opens-
		// contents as a target for a dotted module in the first place. So the click/tooltip binding
		// above is skipped entirely here; "View module contents" moves to the row's right-click menu
		// instead (added unconditionally for folder refs in `showUnitMenu`, governed or not, so the
		// path doesn't change depending on state that can flip at any time). The drag-hold-to-open
		// dwell mechanic below is unaffected either way — it was never click-based.

		let dwellTimer: number | undefined;
		const cancelDwell = () => {
			if (dwellTimer === undefined) return;
			window.clearTimeout(dwellTimer);
			dwellTimer = undefined;
			if (this.cancelActiveDwell === cancelDwell) this.cancelActiveDwell = null;
		};
		const startDwell = () => {
			if (!this.dragPayload || dwellTimer !== undefined) return;
			this.cancelActiveDwell = cancelDwell;
			dwellTimer = window.setTimeout(() => {
				dwellTimer = undefined;
				this.cancelActiveDwell = null;
				this.openModuleContentsModalForDrag(folderPath);
			}, MODULE_HOVER_DWELL_MS);
		};
		iconEl.addEventListener("dragover", (evt) => {
			if (!this.dragPayload) return;
			evt.preventDefault();
			evt.stopPropagation();
			iconEl.addClass("atlas-drop-target");
			startDwell();
		});
		iconEl.addEventListener("dragleave", () => {
			iconEl.removeClass("atlas-drop-target");
			cancelDwell();
		});
		iconEl.addEventListener("drop", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			iconEl.removeClass("atlas-drop-target");
			cancelDwell();
			const payload = this.dragPayload;
			this.dragPayload = null;
			if (!payload) return;
			const ref = this.singleDragRef(payload);
			if (ref && ref.kind !== "folder") void this.handleAddToModule(ref, folderPath);
		});
	}

	private trackModuleModal(modal: ModuleContentsModal): void {
		modal.setFilterText(this.filterText);
		this.openModuleModal = modal;
	}

	private openModuleContentsModal(folderPath: string): void {
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return;
		const modal: ModuleContentsModal = new ModuleContentsModal(this.plugin.app, folder, {
			onOpenFile: (file) => void this.openRef({ kind: "file", path: file.path }),
			onRevealInNative: (path) => this.revealInNativeExplorer(path),
			onPromoteAndPlace: (path, isFolder) => this.promoteAndPlaceFlow(path, isFolder),
			isFolderExpanded: (path) => this.plugin.isModuleFolderExpanded(path),
			onToggleFolder: (path, expanded) => this.plugin.setModuleFolderExpanded(path, expanded),
			onCloseCallback: () => {
				if (this.openModuleModal === modal) this.openModuleModal = null;
			},
		});
		this.trackModuleModal(modal);
		modal.open();
	}

	/** Opened via the hover-during-drag dwell timer only — every folder shown (including the
	 * module's own root) is a live drop target for whatever's still being dragged, and dropping
	 * anywhere in it skips the usual confirm dialog (`handleAddToModule`'s `skipConfirm`). */
	private openModuleContentsModalForDrag(folderPath: string): void {
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		const payload = this.dragPayload;
		if (!(folder instanceof TFolder) || !payload) return;
		const ref = this.singleDragRef(payload);
		if (!ref || ref.kind === "folder") return; // only files/blocks are moveable into a module (see handleDrop)
		const modal: ModuleContentsModal = new ModuleContentsModal(this.plugin.app, folder, {
			onOpenFile: (file) => void this.openRef({ kind: "file", path: file.path }),
			onRevealInNative: (path) => this.revealInNativeExplorer(path),
			onPromoteAndPlace: (path, isFolder) => this.promoteAndPlaceFlow(path, isFolder),
			isFolderExpanded: (path) => this.plugin.isModuleFolderExpanded(path),
			onToggleFolder: (path, expanded) => this.plugin.setModuleFolderExpanded(path, expanded),
			dropTarget: { onDrop: (targetFolderPath) => void this.handleAddToModule(ref, targetFolderPath, true) },
			onCloseCallback: () => {
				if (this.openModuleModal === modal) this.openModuleModal = null;
				this.dragPayload = null; // the drag gesture is considered resolved once this modal closes
			},
		});
		this.trackModuleModal(modal);
		modal.open();
	}

	private async copyLink(ref: UnitRef): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(ref.path);
		let link = "";
		if (ref.kind === "block" && file instanceof TFile) {
			link = this.plugin.app.fileManager.generateMarkdownLink(file, "", `#${ref.subpath}`);
		} else if (ref.kind === "folder" && file instanceof TFolder) {
			const note = findInterfaceNote(this.plugin.app, file, this.plugin.settings);
			if (note) link = this.plugin.app.fileManager.generateMarkdownLink(note, "");
		} else if (file instanceof TFile) {
			link = this.plugin.app.fileManager.generateMarkdownLink(file, "");
		}
		if (link) await navigator.clipboard.writeText(link);
	}

	// --- active-file tracking + keyboard ---------------------------------------------------------

	private setPlacementTooltip(row: HTMLElement, ref: UnitRef): void {
		const placements = this.plugin.viewsManager.getPlacements(ref);
		if (placements.length === 0) return;
		const text = placements.map((p) => [p.viewName, ...p.path].join(" › ")).join("\n");
		setTooltip(row, text);
	}

	private updateActiveHighlight(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const activeFile = this.plugin.app.workspace.getActiveFile();
		container.querySelectorAll(".atlas-row.is-active").forEach((el) => el.removeClass("is-active"));
		if (!activeFile) return;
		const ref: UnitRef = { kind: "file", path: activeFile.path };
		container.querySelectorAll<HTMLElement>(`[data-ref-key="${CSS.escape(unitRefKey(ref))}"]`).forEach((el) => el.addClass("is-active"));
	}

	private handleRowKeydown(evt: KeyboardEvent, node: ViewNode, view: View): void {
		// R9(c): same reasoning as the row's click handler — an Outside-Vault-managed row's `ref.path`
		// is root-relative, not a vault path, so Enter must no-op here too rather than opening (or
		// creating) a same-named vault-root file/module.
		if (evt.key === "Enter" && node.type === "unit" && node.ref && !this.isOutsideManagedUnit(view, node)) {
			evt.preventDefault();
			void this.openRef(node.ref);
		} else if (evt.key === " " && (node.type === "meta" || node.children.length > 0)) {
			// PR 12: keyboard parity for the new unit-node chevrons — same fold/unfold toggle meta
			// folders already had, now also reachable without a mouse for a unit that's gained
			// meta-nested children.
			evt.preventDefault();
			this.plugin.viewsManager.setNodeCollapsed(view.id, node.id, !node.collapsed);
		} else if (evt.key === "Delete") {
			evt.preventDefault();
			// PR 20: if the focused row is part of an active multi-selection, Delete removes every
			// *unit* currently selected (same restriction the single-row case already had — meta
			// folders delete via a distinct, different operation, `deleteMetaFolder`, that promotes
			// their children rather than a plain "remove"), not just the one row that happened to
			// have keyboard focus — same "drag moves the whole selection" spirit, applied to the one
			// other batch-shaped action this view already had.
			if (this.selectedBucketNodeIds.has(node.id) && this.selectedBucketNodeIds.size > 1) {
				for (const id of this.selectedBucketNodeIds) {
					const found = this.findNodeAnywhere(view.root, id);
					if (found?.node.type === "unit") this.plugin.viewsManager.unplaceNode(view.id, id);
				}
				this.selectedBucketNodeIds.clear();
				void this.render();
			} else if (node.type === "unit") {
				// PR 13: unplaceNode removes this exact focused row, not every duplicate of the same
				// unit that might also be placed elsewhere in this view.
				this.plugin.viewsManager.unplaceNode(view.id, node.id);
			}
		} else if (evt.key === "F2" && node.type === "meta") {
			evt.preventDefault();
			new TextPromptModal(this.plugin.app, "Rename folder", node.label ?? "", (label) => {
				this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
			}).open();
		} else if (evt.key === "Escape" && (this.selectedBucketNodeIds.size > 0 || this.selectedInboxRefKeys.size > 0)) {
			evt.preventDefault();
			this.selectedBucketNodeIds.clear();
			this.selectedInboxRefKeys.clear();
			this.selectionAnchor = null;
			this.selectionAnchorScope = null;
			void this.render();
		}
	}
}
