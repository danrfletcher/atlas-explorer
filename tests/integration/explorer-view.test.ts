import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { Menu, Notice } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { ApiItemState, FolderSourceConfig, PLACEHOLDER_ROW_KIND, UnitRef, View, ViewNode, unitRefKey, unitToRef } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";
import { AtlasSettingTab, DEFAULT_SETTINGS, AtlasSettings } from "../../src/settings";
import { ATLAS_VIEW_TYPE, AtlasExplorerView, candidateFilesForAdd } from "../../src/explorer-view";
import AtlasPlugin from "../../src/main";
import { UnitIndex } from "../../src/unit-index";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { bucketRows, drawBucketRows, openExplorer, pointer, PressEnv, PressInternals } from "../unit/explorer-view-press-helpers";
import { callRenderApiItemRow, callRenderNodeList, makeFakeExplorer, makeStatusesManager, proto } from "../unit/explorer-view-sort-truncate-helpers";

// R1 (PR-1.F2 review): Obsidian's `Setting` is replaced with a recorder so the "Highlight the open
// note" toggle's *real* settings-tab `onChange` (settings.ts:253-257) can be captured and invoked
// directly — the same technique `tests/unit/no-auto-promote.test.ts` already uses for the toggle
// right beside it. Every other export (App, Vault, TFile...) is kept exactly as the shared mock.
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();

	interface ToggleState {
		value?: boolean;
		onChange?: (value: boolean) => unknown;
	}
	const makeToggleComponent = (state: ToggleState): unknown => {
		const proxy: unknown = new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (prop === "setValue") return (v: boolean) => ((state.value = v), proxy);
					if (prop === "onChange") return (fn: (value: boolean) => unknown) => ((state.onChange = fn), proxy);
					return () => proxy;
				},
			}
		);
		return proxy;
	};

	class FakeSetting {
		static rows: { name: string; toggles: ToggleState[] }[] = [];
		constructor(public containerEl: HTMLElement) {
			const row = { name: "", toggles: [] as ToggleState[] };
			FakeSetting.rows.push(row);
			return new Proxy(this, {
				get(target, prop, receiver) {
					if (prop === "setName") return (name: string) => ((row.name = name), receiver);
					if (prop === "addToggle")
						return (cb: (c: unknown) => void) => {
							const state: ToggleState = {};
							cb(makeToggleComponent(state));
							row.toggles.push(state);
							return receiver;
						};
					if (prop in target) return Reflect.get(target, prop, receiver);
					// Every other Setting-builder call (setDesc, addText, addTextArea, addDropdown...)
					// is a harmless no-op — renderBasicTab only needs its toggle rows read back, and
					// none of those other builders' callbacks need to run at all for that.
					return (..._args: unknown[]) => receiver;
				},
			});
		}
	}

	return { ...actual, Setting: FakeSetting };
});

/** PR-1.F2 integration: the filter box and selection against a Folder source's hidden and "filtered out"
 * rows. The real `ViewsManager` answers the render state, and the real `renderNode` builds the rows, so the
 * search and Remove checks run against the same DOM the explorer builds. */

const RULES: YamlFilterRule[] = [{ key: "status", value: "active" }];

function source(mode: FolderSourceConfig["mode"], rules?: YamlFilterRule[]): FolderSourceConfig {
	return {
		type: "folder",
		location: "inside",
		path: "Jobs",
		showFiles: true,
		showFolders: false,
		refreshOnViewLoad: false,
		mode,
		...(rules ? { filters: { files: { yaml: { rules } } } } : {}),
	};
}

interface Harness {
	vm: ViewsManager;
	viewId: string;
	folderId: string;
	fake: ReturnType<typeof makeFakeExplorer>;
	cache: Map<string, { frontmatter?: Record<string, unknown> } | null>;
}

/** A merge Folder source on `Jobs/` with the YAML rule saved. `beta` is hidden at save. `acme` matches,
 * unless `acmeDone` is set, which makes it a live "filtered out" row after the metadata resolves. */
function setup({ acmeDone = false }: { acmeDone?: boolean } = {}): Harness {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	const cache = new Map<string, { frontmatter?: Record<string, unknown> } | null>([
		["Jobs/acme.md", { frontmatter: { status: "active" } }],
		["Jobs/beta.md", { frontmatter: { status: "done" } }],
	]);
	for (const path of cache.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => cache.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;

	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const viewId = vm.getViews()[0].id;
	const folder = vm.addMetaFolder(viewId, null, "Job search")!;
	vm.setFolderSource(viewId, folder.id, source("merge"));
	vm.refreshFolderSource(viewId, folder.id);
	vm.onMetadataResolved();
	vm.setFolderSource(viewId, folder.id, source("merge", RULES));
	vm.onMetadataResolved();
	if (acmeDone) {
		cache.set("Jobs/acme.md", { frontmatter: { status: "done" } });
		vm.onMetadataResolved();
	}

	const sm = makeStatusesManager();
	const fake = makeFakeExplorer(sm, {
		plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: vm } as never,
		renderNode: proto.renderNode,
		removeUnitsFromView: proto.removeUnitsFromView,
		holdsLiveDataSource: proto.holdsLiveDataSource,
		forgetDeviceLocalSourceState: proto.forgetDeviceLocalSourceState,
		resolveRef: vi.fn(async (ref: { path: string }) => ({ text: ref.path.replace(/^.*\//, "").replace(/\.md$/, ""), missing: false, promoted: false, added: false })),
		isOutsideManagedUnit: vi.fn(() => false),
		renderRowIcon: vi.fn(),
		setPlacementTooltip: vi.fn(),
		wireModuleRow: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		openRef: vi.fn(),
		makeDropZone: vi.fn(),
		handleRowKeydown: vi.fn(),
		buildNodeDragPayload: vi.fn(),
	});
	Object.assign(fake, { selectedBucketNodeIds: new Set<string>() });
	return { vm, viewId, folderId: folder.id, fake, cache };
}

const folderOf = (h: Harness): ViewNode => h.vm.getNode(h.viewId, h.folderId)!;
const rowFor = (h: Harness, path: string): ViewNode => folderOf(h).children.find((c) => c.ref?.path === path)!;

/** Renders the folder's rows through the real explorer pass, with the current filter text. */
async function render(h: Harness, filterText = ""): Promise<HTMLElement> {
	h.fake.filterText = filterText;
	const container = document.createElement("div");
	await callRenderNodeList(h.fake, folderOf(h).children, container, h.vm.getViews()[0], 1, [folderOf(h)], undefined);
	return container;
}

const rowElFor = (container: HTMLElement, id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-select-key="${id}"]`);

describe("G12 — filter-box search: hidden rows never show, and filtered-out rows are found and removable", () => {
	it("a hidden row is not shown, even when the search matches it exactly", async () => {
		const h = setup();
		const beta = rowFor(h, "Jobs/beta.md");
		expect(h.vm.managedRowFilterState(h.viewId, beta)).toBe("hidden");

		const container = await render(h, "beta");
		expect(rowElFor(container, beta.id)).toBeNull();
		expect(container.textContent).not.toContain("beta");
	});

	it("a filtered-out row is found by search, and its Remove button removes it", async () => {
		const h = setup({ acmeDone: true });
		const acme = rowFor(h, "Jobs/acme.md");
		expect(h.vm.managedRowFilterState(h.viewId, acme)).toBe("filteredOut");

		const container = await render(h, "acme");
		const row = rowElFor(container, acme.id)!;
		expect(row).not.toBeNull();
		expect(row.classList.contains("atlas-filtered-out")).toBe(true);
		expect(row.textContent).toContain("filtered out");

		const removeBtn = row.querySelector<HTMLElement>(".atlas-row-action")!;
		expect(removeBtn).not.toBeNull();
		removeBtn.click();
		expect(rowFor(h, "Jobs/acme.md")).toBeUndefined();
		expect(folderOf(h).folderSource?.removedRefs ?? []).toEqual([]);
	});
});

describe("E9 — selection is pruned of hidden rows, and a filtered-out row stays selectable", () => {
	it("a selected row that becomes hidden is deselected, and the rest of the selection is kept", async () => {
		const h = setup();
		const acme = rowFor(h, "Jobs/acme.md");
		const beta = rowFor(h, "Jobs/beta.md");
		(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([acme.id, beta.id]);

		await render(h);
		expect([...(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds]).toEqual([acme.id]);
	});

	it("a filtered-out row stays in the selection and shows as selected", async () => {
		const h = setup({ acmeDone: true });
		const acme = rowFor(h, "Jobs/acme.md");
		(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([acme.id]);

		const container = await render(h);
		expect((h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds.has(acme.id)).toBe(true);
		expect(rowElFor(container, acme.id)!.classList.contains("is-selected")).toBe(true);
	});
});

/** PR-1.F1 integration: `updateActiveHighlight` against the real `renderNode`/`renderNodeList`/
 * `renderApiItemRow`, so the matching rule is exercised through the exact rows the explorer builds —
 * a module, nested file rows (one of them a duplicate placed again at root), a Table/API Item row
 * (its `noteRef` attachment), and two block rows. `renderFoldableChildren` is the one stub here (the
 * real one also drives the fold-chevron chrome, which these tests don't need); it still recurses
 * through the real `renderNodeList`/`renderNode`, and renders nothing for a collapsed node, matching
 * the real one's "folded away is simply not shown" behaviour (GP4). */
interface HighlightHarness {
	app: InstanceType<typeof MockApp>;
	fake: ReturnType<typeof makeFakeExplorer>;
	content: HTMLElement;
	setActiveFile: (file: TFile | null) => void;
	setNodeCollapsed: ReturnType<typeof vi.fn>;
	projectsNode: ViewNode;
	quarryNested: ViewNode;
	quarryDuplicate: ViewNode;
	notesNode: ViewNode;
	block1: ViewNode;
	block2: ViewNode;
	/** R4: a block row whose own file path contains '#'. */
	block3: ViewNode;
	/** R5: a block row whose *subpath* itself contains '#' (a nested-heading link, [[Ideas#H1#H2]]). */
	block4: ViewNode;
	/** R3/G7: a row an `.atlas-missing` class must keep unhighlighted even when its ref matches. */
	missingNode: ViewNode;
	/** R3/G7: a row an `.atlas-filtered-out` class must keep unhighlighted even when its ref matches. */
	filteredNode: ViewNode;
	/** R3/F6: an Outside-Vault Folder source whose managed child (`outsideRow`) must never highlight. */
	outsideOwnerNode: ViewNode;
	outsideRow: ViewNode;
	groupMeta: ViewNode;
	v: View;
	/** R2(a): fires whatever the real `onOpen` (via `callOnOpen`) registered on the mock
	 * workspace — lets a test prove the `file-open`/`active-leaf-change` subscriptions themselves
	 * still drive `updateActiveHighlight`, instead of only ever calling it directly. */
	triggerWorkspace: (name: string, ...args: unknown[]) => void;
	/** R2(a): the real (unstubbed) `onOpen`, run against this harness's `fake`. `fake.render` is a
	 * no-op stub — `onOpen`'s own final `await this.render()` is irrelevant to this test, which only
	 * needs the two workspace subscriptions it wires before that call. */
	callOnOpen: () => Promise<void>;
	/** PR-1.F2: the plugin's own settings object passed into (or created by) `setupHighlightHarness` —
	 * a test can flip `settings.highlightOpenNote` directly and call `callUpdateActiveHighlight` again. */
	settings: AtlasSettings;
}

function setupHighlightHarness(settings: AtlasSettings = { ...DEFAULT_SETTINGS }): HighlightHarness {
	const app = new MockApp();
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/Projects.md");
	app.vault.seedFile("Quarry drones.md");
	app.vault.seedFile("Notes.md");
	app.vault.seedFile("Ideas.md");
	app.vault.seedFile("Attached.md");
	app.vault.seedFile("Draft #1.md");

	const sm = makeStatusesManager();
	const setNodeCollapsed = vi.fn();

	// R3/F6: the Outside-Vault source `outsideRow` (below) belongs to — looked up by id via
	// `viewsManager.getNode`, the same way the real `isOutsideManagedUnit` looks up any owner.
	const outsideOwnerNode: ViewNode = {
		id: "outside-owner",
		type: "meta",
		label: "External",
		children: [],
		folderSource: { type: "folder", location: "outside", path: "Ext", showFiles: true, showFolders: false, mode: "merge" },
	};

	// R2(a): a minimal real event bus on the mock workspace. `onOpen` (called for real by
	// `callOnOpen`, never reimplemented here) registers its `file-open`/`active-leaf-change`
	// handlers against this the same way it would against the real Obsidian workspace; `on` itself
	// is the actual subscription (Obsidian's `registerEvent` is only cleanup bookkeeping on top of
	// it), so stubbing `registerEvent` to a no-op below still leaves the real handlers reachable.
	const workspaceListeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const workspace = (app as unknown as { workspace: Record<string, unknown> }).workspace;
	workspace.on = (name: string, cb: (...args: unknown[]) => void) => {
		const arr = workspaceListeners.get(name) ?? [];
		arr.push(cb);
		workspaceListeners.set(name, arr);
		return { name, cb };
	};
	const triggerWorkspace = (name: string, ...args: unknown[]): void => {
		for (const cb of workspaceListeners.get(name) ?? []) cb(...args);
	};

	const plugin = {
		statusesManager: sm,
		settings,
		app: app as unknown as App,
		unitIndex: { onChange: vi.fn(() => () => {}) },
		viewsManager: {
			setApiItemStatus: vi.fn(),
			// R3/G7: only the one row tagged "filtered-node" reports filteredOut — every other row's
			// match keeps working exactly as before.
			managedRowFilterState: vi.fn((_viewId: string, node: ViewNode) => (node.id === "filtered-node" ? "filteredOut" : "shown")),
			setNodeCollapsed,
			onChange: vi.fn(() => () => {}),
			getNode: vi.fn((_viewId: string, nodeId: string) => (nodeId === "outside-owner" ? outsideOwnerNode : undefined)),
		},
	};

	let activeFile: TFile | null = null;
	(app as unknown as { workspace: { getActiveFile: () => TFile | null } }).workspace.getActiveFile = () => activeFile;

	const quarryNested: ViewNode = { id: "quarry-nested", type: "unit", ref: { kind: "file", path: "Quarry drones.md" }, children: [] };
	const projectsNode: ViewNode = { id: "projects", type: "unit", ref: { kind: "folder", path: "Projects" }, children: [quarryNested] };
	const quarryDuplicate: ViewNode = { id: "quarry-dup", type: "unit", ref: { kind: "file", path: "Quarry drones.md" }, children: [] };
	const notesNode: ViewNode = { id: "notes", type: "unit", ref: { kind: "file", path: "Notes.md" }, children: [] };
	const block1: ViewNode = { id: "block-1", type: "unit", ref: { kind: "block", path: "Ideas.md", subpath: "^b1" }, children: [] };
	const block2: ViewNode = { id: "block-2", type: "unit", ref: { kind: "block", path: "Ideas.md", subpath: "^b2" }, children: [] };
	// R4: a block row whose file path itself contains '#' — `parseUnitRefKey`'s pre-fix first-'#'
	// split misread `block:Draft #1.md#^b3` as path "Draft " + subpath "1.md#^b3", so this never
	// highlighted before the fix even though its file is open.
	const block3: ViewNode = { id: "block-3", type: "unit", ref: { kind: "block", path: "Draft #1.md", subpath: "^b3" }, children: [] };
	// R5: a block row promoted from a nested-heading link ([[Ideas#H1#H2]]) — the subpath itself
	// contains '#', so `block:Ideas.md#H1#H2` is ambiguous between this ref and
	// `{ path: "Ideas.md#H1", subpath: "H2" }`. Opening "Ideas.md" must still highlight this row.
	const block4: ViewNode = { id: "block-4", type: "unit", ref: { kind: "block", path: "Ideas.md", subpath: "H1#H2" }, children: [] };
	const missingNode: ViewNode = { id: "missing-node", type: "unit", ref: { kind: "file", path: "Missing.md" }, children: [] };
	const filteredNode: ViewNode = { id: "filtered-node", type: "unit", ref: { kind: "file", path: "Filtered.md" }, children: [] };
	// F6: ref.path deliberately reads the same as the real vault note "Quarry drones.md" above.
	const outsideRow: ViewNode = {
		id: "outside-row",
		type: "unit",
		ref: { kind: "file", path: "Quarry drones.md" },
		folderSourceManaged: true,
		folderSourceOwnerId: "outside-owner",
		children: [],
	};
	const groupMeta: ViewNode = { id: "group", type: "meta", label: "Group", children: [] };

	const v: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

	const fake = makeFakeExplorer(sm, {
		plugin: plugin as never,
		renderNode: proto.renderNode,
		renderNodeList: proto.renderNodeList,
		renderApiItemRow: proto.renderApiItemRow,
		// PR-3: `renderNode` now calls the real `computeEffectiveCollapsed` directly (to decide a
		// row's `hasBottomZone` for its drop zone) before ever reaching the stubbed
		// `renderFoldableChildren` below — `filterText` stays "" (unset) everywhere in this file, so
		// this never touches `subtreeHasMatch`/`apiItemsMatchFilter`, just `node.collapsed`.
		computeEffectiveCollapsed: proto.computeEffectiveCollapsed,
		renderFoldableChildren: vi.fn(async (node: unknown, _chevron: unknown, container: HTMLElement, view: unknown, depth: number, ancestors: unknown[]) => {
			const n = node as ViewNode;
			if (n.collapsed) return;
			const wrap = container.createDiv({ cls: "atlas-meta-children" });
			await (proto.renderNodeList as unknown as (nodes: ViewNode[], c: HTMLElement, v2: unknown, d: number, a: unknown[], o?: ViewNode) => Promise<void>).call(
				fake,
				n.children,
				wrap,
				view,
				depth + 1,
				[n, ...ancestors],
				undefined
			);
		}),
		resolveRef: vi.fn(async (ref: UnitRef) => ({
			text: ref.kind === "block" ? ref.subpath : (ref.path.split("/").pop() ?? ref.path).replace(/\.md$/, ""),
			icon: ref.kind === "folder" ? "folder" : "file",
			// R3/G7: only `missingNode`'s own path reports missing — every other row's match keeps
			// working exactly as before.
			missing: ref.kind !== "block" && ref.path === "Missing.md",
			promoted: false,
			added: false,
		})),
		// R3/F6: the real `isOutsideManagedUnit`, not a stub that always answers false. It still
		// answers false for every row here except `outsideRow` — none of the others ever set
		// `folderSourceManaged`/`folderSourceOwnerId`, so this is a no-op for every existing test.
		isOutsideManagedUnit: proto.isOutsideManagedUnit,
		resolveOutsideManagedRowInfo: proto.resolveOutsideManagedRowInfo,
		setPlacementTooltip: vi.fn(),
		wireModuleRow: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		openRef: vi.fn(),
		makeDropZone: vi.fn(),
		handleRowKeydown: vi.fn(),
		buildNodeDragPayload: vi.fn(),
		// R2(a): the real `updateActiveHighlight`, so the handlers wired by the real `onOpen` (which
		// call `this.updateActiveHighlight()` directly, not through any test helper) actually run it.
		updateActiveHighlight: proto.updateActiveHighlight,
		// R2(a): the rest of `onOpen`'s own dependencies — exercised only by the test that calls
		// `callOnOpen`, harmless no-ops for every other test here, which never calls it.
		unsubscribers: [] as (() => void)[],
		registerEvent: vi.fn(),
		registerDomEvent: vi.fn(),
		leaf: {},
		viewLoadTrigger: { activate: vi.fn(() => false), deactivate: vi.fn() },
		refreshApiSourcesOnViewLoad: vi.fn(),
		render: vi.fn(async () => {}),
		dragPayload: null,
		inboxDragRowEl: null,
		cancelActiveDwell: null,
		queueRender: vi.fn(),
	});
	Object.assign(fake, { selectedBucketNodeIds: new Set<string>() });

	const header = document.createElement("div");
	const content = document.createElement("div");
	const containerEl = document.createElement("div");
	containerEl.appendChild(header);
	containerEl.appendChild(content);
	Object.assign(fake, { containerEl });

	return {
		app,
		fake,
		content,
		setActiveFile: (file) => (activeFile = file),
		setNodeCollapsed,
		projectsNode,
		quarryNested,
		quarryDuplicate,
		notesNode,
		block1,
		block2,
		block3,
		block4,
		missingNode,
		filteredNode,
		outsideOwnerNode,
		outsideRow,
		groupMeta,
		v,
		triggerWorkspace,
		callOnOpen: () => (proto.onOpen as unknown as (this: unknown) => Promise<void>).call(fake),
		settings,
	};
}

/** Renders the harness's root nodes plus one API Item row (a Table/API source placeholder with a
 * `noteRef` attachment) into `h.content`, real pass throughout. */
async function renderHighlightTree(h: HighlightHarness): Promise<void> {
	h.content.replaceChildren();
	const roots = [h.groupMeta, h.projectsNode, h.quarryDuplicate, h.notesNode, h.block1, h.block2, h.block3, h.block4, h.missingNode, h.filteredNode, h.outsideRow];
	await callRenderNodeList(h.fake, roots, h.content, h.v, 0, [h.v], undefined);

	const apiItem: ApiItemState = { id: "api-1", label: "Attached item", kind: PLACEHOLDER_ROW_KIND, noteRef: { kind: "file", path: "Attached.md" } };
	const apiOwner: ViewNode = { id: "api-folder", type: "unit", children: [] };
	callRenderApiItemRow(h.fake, apiItem, h.content, h.v, apiOwner, 0, [h.v]);
}

function callUpdateActiveHighlight(h: HighlightHarness): void {
	(proto.updateActiveHighlight as unknown as () => void).call(h.fake);
}

function activeRefKeys(h: HighlightHarness): string[] {
	return Array.from(h.content.querySelectorAll<HTMLElement>(".atlas-row.is-active")).map((el) => el.dataset.refKey ?? "");
}

describe("PR-1.F1 — active highlight: file, module, block and Item rows via the real render pass", () => {
	it("GP1: opening a file visible, nested under an expanded module, highlights that row (and its duplicate, G1)", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(activeRefKeys(h).sort()).toEqual(["file:Quarry drones.md", "file:Quarry drones.md"].sort());
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("GP3: opening a different file clears the previous highlight and highlights the new row", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		h.setActiveFile({ path: "Notes.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.notesNode.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("GP5: opening a module's interface note highlights the module row, never the module's own path", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Projects/Projects.md" } as TFile);
		callUpdateActiveHighlight(h);

		const moduleRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.projectsNode.id}"]`)!;
		expect(moduleRow.classList.contains("is-active")).toBe(true);
		expect(moduleRow.dataset.refKey).toBe("folder:Projects");
		// G6: the module row highlights through its interface note only — its nested child (a
		// different file entirely) never highlights alongside it.
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(false);
	});

	it("GP6: opening the file two promoted blocks live in highlights both block rows like a file row", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Ideas.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(h.content.querySelector(`[data-select-key="${h.block1.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.block2.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("G3: a Table/API Item row's noteRef attachment highlights the same way once that note is open", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Attached.md" } as TFile);
		callUpdateActiveHighlight(h);

		const itemRow = h.content.querySelector<HTMLElement>(".atlas-row-api-item")!;
		expect(itemRow.classList.contains("is-active")).toBe(true);
	});

	it("G6: a meta (Folder) row never highlights — it carries no data-ref-key at all", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		const metaRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.groupMeta.id}"]`)!;
		expect(metaRow.dataset.refKey).toBeUndefined();
		expect(metaRow.classList.contains("is-active")).toBe(false);
	});

	it("E2: no file open clears every highlight; re-running with the same active file is idempotent", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(2);

		callUpdateActiveHighlight(h); // same active file again — idempotent, nothing flips
		expect(activeRefKeys(h)).toHaveLength(2);

		h.setActiveFile(null);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(0);
	});

	it("E4: deleting the open note clears the highlight, with no stale is-active left", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const quarry = h.app.vault.getAbstractFileByPath("Quarry drones.md") as TFile;
		h.setActiveFile(quarry);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(2);

		await h.app.vault.delete(quarry);
		// Obsidian reports no active file once the open note is gone.
		h.setActiveFile(null);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(0);
	});

	it("E5: two Atlas panes each highlight only their own rows, independent of the other's fold state", async () => {
		const h1 = setupHighlightHarness();
		await renderHighlightTree(h1);
		const h2 = setupHighlightHarness();
		h2.projectsNode.collapsed = true; // pane 2's own fold state — must not affect pane 1 at all
		await renderHighlightTree(h2);

		h1.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h1);
		h2.setActiveFile({ path: "Notes.md" } as TFile);
		callUpdateActiveHighlight(h2);

		expect(activeRefKeys(h1).sort()).toEqual(["file:Quarry drones.md", "file:Quarry drones.md"].sort());
		expect(activeRefKeys(h2)).toEqual(["file:Notes.md"]);
		// Pane 2's collapsed module never even rendered its nested child — confirms the two panes'
		// fold states are fully independent, not just their highlight state.
		expect(h2.content.querySelector(`[data-select-key="${h1.quarryNested.id}"]`)).toBeNull();
	});

	it("E3: after a vault rename of the open note, the highlight follows the row once it reflects the new ref", async () => {
		// The rewrite of a view's own node ref on rename is a separate, pre-existing mechanism
		// (F9 rename integrity, not part of this PR) — this proves only that `updateActiveHighlight`
		// itself follows once that rewrite (and the re-render it triggers) has happened.
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const quarry = h.app.vault.getAbstractFileByPath("Quarry drones.md") as TFile;
		h.setActiveFile(quarry);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(2);

		await h.app.vault.rename(quarry, "Renamed drones.md");
		h.quarryNested.ref = { kind: "file", path: "Renamed drones.md" };
		h.quarryDuplicate.ref = { kind: "file", path: "Renamed drones.md" };
		await renderHighlightTree(h);
		callUpdateActiveHighlight(h);

		expect(activeRefKeys(h)).toEqual(["file:Renamed drones.md", "file:Renamed drones.md"]);
	});

	it("GP4/F1: collapsing a module shows nothing for its hidden child, and no scroll/collapse call comes from highlighting; expanding brings it back", async () => {
		const h = setupHighlightHarness();
		h.projectsNode.collapsed = true;
		await renderHighlightTree(h);
		h.content.scrollTop = 42;
		Notice.reset();

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);
		// Only the root-level duplicate is in the DOM at all while collapsed — nothing "shows" for
		// the hidden nested row, matching "folded away is simply not shown" (not merely un-highlighted).
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)).toBeNull();
		expect(activeRefKeys(h)).toHaveLength(1);
		expect(h.content.scrollTop).toBe(42);
		expect(h.setNodeCollapsed).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(0);

		h.projectsNode.collapsed = false;
		await renderHighlightTree(h);
		callUpdateActiveHighlight(h);
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(activeRefKeys(h)).toHaveLength(2);
		expect(h.content.scrollTop).toBe(42);
		expect(h.setNodeCollapsed).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(0);
	});

	it("R4: a block row whose own file path contains '#' highlights once that file is open, exactly like any other block row", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Draft #1.md" } as TFile);
		callUpdateActiveHighlight(h);

		const row = h.content.querySelector<HTMLElement>(`[data-select-key="${h.block3.id}"]`)!;
		expect(row.dataset.refKey).toBe("block:Draft #1.md#^b3");
		expect(row.classList.contains("is-active")).toBe(true);
	});

	it("R5: a block row whose own subpath contains '#' (a nested-heading link, [[Ideas#H1#H2]]) highlights once its file is open — parseUnitRefKey's last-'#' split alone would misread this row's path as 'Ideas.md#H1' and never match 'Ideas.md'", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Ideas.md" } as TFile);
		callUpdateActiveHighlight(h);

		const row = h.content.querySelector<HTMLElement>(`[data-select-key="${h.block4.id}"]`)!;
		expect(row.dataset.refKey).toBe("block:Ideas.md#H1#H2");
		expect(row.classList.contains("is-active")).toBe(true);
	});

	it("R3/F6: an Outside-Vault-managed row whose ref.path equals the open vault note's path never highlights, even while the real vault rows for that same path do", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const outsideRowEl = h.content.querySelector<HTMLElement>(`[data-select-key="${h.outsideRow.id}"]`)!;
		expect(outsideRowEl.dataset.outsideManaged).toBe("true");

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(outsideRowEl.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("R3/G7: a missing row and a filtered-out row stay unhighlighted even though their own ref matches the open file's path", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const missingRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.missingNode.id}"]`)!;
		const filteredRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.filteredNode.id}"]`)!;
		expect(missingRow.classList.contains("atlas-missing")).toBe(true);
		expect(filteredRow.classList.contains("atlas-filtered-out")).toBe(true);

		h.setActiveFile({ path: "Missing.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(missingRow.classList.contains("is-active")).toBe(false);

		h.setActiveFile({ path: "Filtered.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(filteredRow.classList.contains("is-active")).toBe(false);
	});

	it("G8: a row that is both selected and the open note carries is-selected and is-active together", async () => {
		const h = setupHighlightHarness();
		(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([h.quarryNested.id]);
		await renderHighlightTree(h);

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		const row = h.content.querySelector<HTMLElement>(`[data-select-key="${h.quarryNested.id}"]`)!;
		expect(row.classList.contains("is-selected")).toBe(true);
		expect(row.classList.contains("is-active")).toBe(true);
	});

	it("R2(a): the real file-open and active-leaf-change subscriptions wired in onOpen drive the highlight, not just a direct call to updateActiveHighlight", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		await h.callOnOpen();

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		h.triggerWorkspace("file-open");
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(true);

		h.setActiveFile({ path: "Notes.md" } as TFile);
		h.triggerWorkspace("active-leaf-change", {});
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.notesNode.id}"]`)!.classList.contains("is-active")).toBe(true);
	});
});

/** PR-1.F2: the global "Highlight the open note" setting. `updateActiveHighlight` itself must read
 * `plugin.settings.highlightOpenNote` fresh on every call (not a cached copy), so these exercise the
 * real method directly against the setting flipped on the same (per-harness) settings object — no
 * stub of the matching rule anywhere here, same as the PR-1.F1 suite above. */
describe("PR-1.F2 — the 'Highlight the open note' setting (G9, GP7, E9)", () => {
	it("G9: with the setting off, no row anywhere carries is-active even though the open file has matching rows", async () => {
		const h = setupHighlightHarness({ ...DEFAULT_SETTINGS, highlightOpenNote: false });
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(activeRefKeys(h)).toEqual([]);
	});

	it("GP7: turning the setting off clears every highlight at once, and turning it back on restores it with no reload and no scrolling", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h).length).toBeGreaterThan(0);

		// Off: every highlight disappears at once, straight from this one call — no re-render.
		h.settings.highlightOpenNote = false;
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toEqual([]);

		// GP7 continued: opening another note while off adds none.
		h.setActiveFile({ path: "Notes.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toEqual([]);

		// Back on: the currently open note's visible rows are highlighted again at once, with no
		// reload and no scrolling — just the next call to the same method.
		h.settings.highlightOpenNote = true;
		callUpdateActiveHighlight(h);
		expect(h.content.querySelector(`[data-select-key="${h.notesNode.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("E9: flipping the setting re-applies/clears on two separate Atlas leaves sharing the same settings object, both changing together", async () => {
		const sharedSettings: AtlasSettings = { ...DEFAULT_SETTINGS };
		const leafA = setupHighlightHarness(sharedSettings);
		const leafB = setupHighlightHarness(sharedSettings);
		await renderHighlightTree(leafA);
		await renderHighlightTree(leafB);
		leafA.setActiveFile({ path: "Quarry drones.md" } as TFile);
		leafB.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(leafA);
		callUpdateActiveHighlight(leafB);
		expect(activeRefKeys(leafA).length).toBeGreaterThan(0);
		expect(activeRefKeys(leafB).length).toBeGreaterThan(0);

		// A real settings-tab toggle mutates the one shared settings object then calls
		// refreshExplorerViews(), which re-runs the highlight on every leaf — modelled here by
		// mutating the shared object once and re-invoking updateActiveHighlight on each leaf, the
		// same single pass a real refreshExplorerViews() loop would drive.
		sharedSettings.highlightOpenNote = false;
		callUpdateActiveHighlight(leafA);
		callUpdateActiveHighlight(leafB);
		expect(activeRefKeys(leafA)).toEqual([]);
		expect(activeRefKeys(leafB)).toEqual([]);

		sharedSettings.highlightOpenNote = true;
		callUpdateActiveHighlight(leafA);
		callUpdateActiveHighlight(leafB);
		expect(activeRefKeys(leafA).length).toBeGreaterThan(0);
		expect(activeRefKeys(leafB).length).toBeGreaterThan(0);
	});
});

/** PR-1.F2 R1: the test above (E9) calls `updateActiveHighlight` by hand on two independent
 * harnesses and never touches `onChange`/`refreshExplorerViews` at all, so it would still pass if
 * the toggle's `onChange` dropped the `refreshExplorerViews()` call, called it before
 * `saveSettings`, or if `refreshExplorerViews` skipped a leaf. This exercises the real chain
 * instead: the settings tab's actual `onChange` (settings.ts:253-257, captured via the `Setting`
 * recorder above) mutates the one shared settings object, awaits the real `saveSettings` (->
 * `persistNow` -> `saveData`), then calls the real `AtlasPlugin.refreshExplorerViews`, which looks
 * up two stubbed Atlas leaves via `getLeavesOfType` and calls the real `refresh`/`queueRender` on
 * each (never reimplemented here) — so a dropped or reordered call in any of those real methods
 * would fail this test. Each leaf's own `render` override is the only stand-in, rebuilding the
 * same real tree `renderHighlightTree` builds and then calling the real `updateActiveHighlight`,
 * exactly mirroring what the real (private) `render` does at its own end. */
describe("PR-1.F2 — R1: the real settings-tab onChange drives refreshExplorerViews over real Atlas leaves", () => {
	it("saves before either leaf's queued render runs, and that queued render clears/restores the highlight on both", async () => {
		const { Setting: FakeSettingCtor } = (await import("obsidian")) as unknown as {
			Setting: { rows: { name: string; toggles: { value?: boolean; onChange?: (v: boolean) => unknown }[] }[] };
		};
		FakeSettingCtor.rows.length = 0;

		const sharedSettings: AtlasSettings = { ...DEFAULT_SETTINGS };
		const leafA = setupHighlightHarness(sharedSettings);
		const leafB = setupHighlightHarness(sharedSettings);
		// Grafting the real prototype on (while every already-assigned own property above keeps
		// taking priority over it) makes `leaf.view instanceof AtlasExplorerView` true. `queueRender`
		// is deleted off each fake (setupHighlightHarness stubs it as a no-op for the tests above,
		// which never need a queued render) so it and `refresh` fall through to the real,
		// un-stubbed prototype methods — the whole point of this test.
		for (const h of [leafA, leafB]) {
			Object.setPrototypeOf(h.fake, AtlasExplorerView.prototype);
			delete (h.fake as unknown as { queueRender?: unknown }).queueRender;
		}

		const order: string[] = [];
		for (const [label, h] of [["A", leafA], ["B", leafB]] as const) {
			Object.assign(h.fake, {
				render: vi.fn(async () => {
					order.push(`render:${label}`);
					await renderHighlightTree(h);
					(h.fake as unknown as { updateActiveHighlight(): void }).updateActiveHighlight();
				}),
			});
		}

		await renderHighlightTree(leafA);
		await renderHighlightTree(leafB);
		leafA.setActiveFile({ path: "Quarry drones.md" } as TFile);
		leafB.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(leafA);
		callUpdateActiveHighlight(leafB);
		expect(activeRefKeys(leafA).length).toBeGreaterThan(0);
		expect(activeRefKeys(leafB).length).toBeGreaterThan(0);

		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		Object.assign(plugin, {
			app: {
				workspace: {
					getLeavesOfType: vi.fn((type: string) => {
						// The first synchronous thing `refreshExplorerViews` itself does — recorded so the
						// order check below can tell a same-tick reorder (refresh dispatched before save)
						// from the correct one, since the *actual* re-render it triggers is always deferred
						// to a macrotask either way and so can't by itself prove which came first.
						order.push("refresh-dispatch");
						return type === ATLAS_VIEW_TYPE ? [{ view: leafA.fake }, { view: leafB.fake }] : [];
					}),
				},
			},
			settings: sharedSettings,
			unitIndex: { getManualPromotions: () => [], getDismissedByView: () => ({}), getDismissedGlobal: () => [], getAddedItems: () => [] },
			viewsManager: { getViews: () => [], getActiveViewId: () => "default" },
			statusesManager: { getStatusSets: () => [], getColorPalette: () => [] },
			expandedModuleFolders: new Set<string>(),
			saveData: vi.fn(async (_data: unknown) => {
				order.push("saveData");
			}),
		});

		const tab = new AtlasSettingTab(new MockApp() as unknown as App, plugin);
		(tab as unknown as { renderBasicTab(el: HTMLElement): void }).renderBasicTab(document.createElement("div"));
		const row = FakeSettingCtor.rows.find((r) => r.name === "Highlight the open note");
		expect(row).toBeTruthy();
		const toggle = row!.toggles[0];
		expect(toggle.value).toBe(true); // reflects the shared settings object's current (default-on) value

		const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

		// Off: the real onChange runs end to end. `saveData` must land before `refreshExplorerViews`
		// is even dispatched; the render itself is also deferred (queueRender's setTimeout 0), so
		// nothing renders yet.
		await toggle.onChange!(false);
		expect(order).toEqual(["saveData", "refresh-dispatch"]);
		await flush();
		expect(order).toEqual(["saveData", "refresh-dispatch", "render:A", "render:B"]);
		expect(activeRefKeys(leafA)).toEqual([]);
		expect(activeRefKeys(leafB)).toEqual([]);

		// Back on: same real chain, same ordering, both leaves' highlight restored together.
		order.length = 0;
		await toggle.onChange!(true);
		expect(order).toEqual(["saveData", "refresh-dispatch"]);
		await flush();
		expect(order).toEqual(["saveData", "refresh-dispatch", "render:A", "render:B"]);
		expect(activeRefKeys(leafA).length).toBeGreaterThan(0);
		expect(activeRefKeys(leafB).length).toBeGreaterThan(0);
	});
});

describe("PR-1 (deferred-findings R3) — a bucket row's own dragstart tracks its source element", () => {
	it("sets bucketDragRowEl alongside dragPayload, so render() can detect a mid-drag teardown", async () => {
		const h = setup();
		const acme = rowFor(h, "Jobs/acme.md");
		(h.fake as unknown as { buildNodeDragPayload: ReturnType<typeof vi.fn> }).buildNodeDragPayload = vi.fn(() => ({
			kind: "node",
			nodeId: acme.id,
			viewId: h.viewId,
		}));

		const container = await render(h);
		const row = rowElFor(container, acme.id)!;
		row.dispatchEvent(new Event("dragstart"));

		const fake = h.fake as unknown as { dragPayload: unknown; bucketDragRowEl: HTMLElement | null };
		expect(fake.dragPayload).not.toBeNull();
		expect(fake.bucketDragRowEl).toBe(row);
	});
});

// --- Atlas #13 PR-1: a placed file/folder that exists renders normally even when it is not a unit ----
//
// Dan's case: `Responsibilities.md` is placed under Areas > Career > Tracks > Short Term > FDE Play in
// the Actionable view, then moved into the `FDE Play` folder. It has no backlink, so after the move it
// is no longer an Atlas unit. These tests run the REAL `ViewsManager` rename rewrite, the REAL
// `UnitIndex`, the REAL `resolveRef` and the REAL `renderNode`; only the chrome helpers a row calls
// (drag zones, tooltips, selection) are stubbed.
describe("Atlas #13 PR-1 — a moved note that is no longer a unit stays a normal row", () => {
	const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0));
	const PRESENCE_REAL = ["renderNode", "renderConnectionDots", "resolveRef", "resolveOutsideManagedRowInfo", "isOutsideManagedUnit", "wireModuleRow", "matchesFilter", "removeUnitsFromView", "holdsLiveDataSource", "forgetDeviceLocalSourceState", "trackModuleModal"] as const;
	const MOVED = "FDE Play/Responsibilities.md";

	function unitNode(id: string, ref: UnitRef, children: ViewNode[] = []): ViewNode {
		return { id, type: "unit", ref, children };
	}
	function metaNode(id: string, label: string, children: ViewNode[] = []): ViewNode {
		return { id, type: "meta", label, children };
	}

	/** The Actionable view: Areas > Career > Tracks > Short Term > FDE Play > [children]. */
	function actionableView(leaf: ViewNode[]): View {
		return {
			id: "actionable",
			name: "Actionable",
			inboxMode: "view",
			root: [metaNode("areas", "Areas", [metaNode("career", "Career", [metaNode("tracks", "Tracks", [metaNode("short", "Short Term", [metaNode("fde", "FDE Play", leaf)])])])])],
		};
	}

	function build(opts: { files: string[]; folders: string[]; view: View; excludedFolders?: string[]; persist?: () => void }) {
		const app = new MockApp();
		for (const f of opts.folders) app.vault.seedFolder(f);
		for (const f of opts.files) app.vault.seedFile(f);
		const settings = { ...DEFAULT_SETTINGS, excludedFolders: opts.excludedFolders ?? [] };
		const unitIndex = new UnitIndex(app as unknown as App, settings, [], {}, [], []);
		unitIndex.rebuild();
		const persist = opts.persist ?? vi.fn();
		const views = new ViewsManager(app as unknown as App, [opts.view], opts.view.id, persist);
		// Mirrors `AtlasPlugin.onVaultRenameEvent`: the unit index first, then the views rewrite.
		app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
			unitIndex.onVaultRename(file, oldPath);
			views.onVaultRename(oldPath, file.path);
		});
		app.vault.on("delete", (file: TAbstractFile) => {
			unitIndex.onVaultDelete(file.path);
			views.onVaultDelete(file.path);
		});
		app.vault.on("create", (file: TAbstractFile) => unitIndex.onVaultCreate(file));
		return { app, settings, unitIndex, views, persist: persist as ReturnType<typeof vi.fn> };
	}
	type Built = ReturnType<typeof build>;

	function explorerFor(b: Built) {
		const explorer = {
			plugin: {
				app: b.app,
				settings: b.settings,
				unitIndex: b.unitIndex,
				viewsManager: b.views,
				freeBlockTextCache: undefined,
				isModuleFolderExpanded: vi.fn(() => false),
				setModuleFolderExpanded: vi.fn(),
				folderSourcePathStore: { get: () => undefined },
			},
			filterText: "",
			dragPayload: null,
			selectedBucketNodeIds: new Set<string>(),
			selectedInboxRefKeys: new Set<string>(),
			unitsByRefKey: new Map(),
			renderRowIcon: vi.fn(),
			makeDropZone: vi.fn(),
			setPlacementTooltip: vi.fn(),
			handleSelectionClick: vi.fn(() => false),
			bucketVisibleOrder: vi.fn(() => []),
			buildNodeDragPayload: vi.fn(),
			handleRowKeydown: vi.fn(),
			showUnitMenu: vi.fn(),
			openModuleContentsModal: vi.fn(),
			openRef: vi.fn(),
			renderFoldableChildren: vi.fn(async () => {}),
			computeEffectiveCollapsed: vi.fn(async () => false),
			renderSortIndicator: vi.fn(),
		} as unknown as Record<string, unknown>;
		for (const name of PRESENCE_REAL) explorer[name] = (proto as unknown as Record<string, (...a: unknown[]) => unknown>)[name].bind(explorer);
		return explorer;
	}

	/** Mirrors `AtlasExplorerView.render`'s unit lookup, then renders `node` with the real `renderNode`. */
	async function renderNode(b: Built, node: ViewNode, opts: { explorer?: Record<string, unknown>; ancestors?: ViewNode[] } = {}): Promise<HTMLElement> {
		const explorer = opts.explorer ?? explorerFor(b);
		explorer.unitsByRefKey = new Map(b.unitIndex.getUnits().map((u) => [unitRefKey(unitToRef(u)), u]));
		const container = document.createElement("div");
		// A Folder row is only a header here (its children are the foldable list); render the leaf
		// unit rows it holds, which is what the user sees under "FDE Play".
		const leaves = node.type === "meta" ? node.children : [node];
		for (const leaf of leaves) {
			await (explorer.renderNode as (n: ViewNode, c: HTMLElement, v: View, d: number, a: unknown[]) => Promise<void>)(leaf, container, b.views.getViews()[0], 0, opts.ancestors ?? []);
		}
		return container;
	}

	const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>(".atlas-row-unit"));
	const textOf = (row: HTMLElement) => row.querySelector(".atlas-row-text")?.textContent;
	const nodeAt = (b: Built, id: string) => b.views.getNode("actionable", id)!;

	/** The Dan scenario up to the move: a root-level unit placed under FDE Play, then renamed into `FDE Play/`. */
	async function danScenario() {
		const b = build({ files: ["Responsibilities.md", "Other.md"], folders: ["FDE Play"], view: actionableView([unitNode("resp", { kind: "file", path: "Responsibilities.md" })]) });
		return b;
	}
	const moveIntoFolder = async (b: Built) => b.app.vault.rename(b.app.vault.getAbstractFileByPath("Responsibilities.md")!, MOVED);
	const REFS = (b: Built) => b.unitIndex.getUnits().map((u) => unitRefKey(unitToRef(u)));

	it("GP1/GP2: the move rewrites the ref and the node keeps its id and position; GP3: the row is a normal file row", async () => {
		const b = await danScenario();
		expect(REFS(b)).toContain("file:Responsibilities.md");
		const before = nodeAt(b, "resp");
		const parent = nodeAt(b, "fde");
		await moveIntoFolder(b);

		expect(REFS(b)).not.toContain(`file:${MOVED}`); // no backlink: no longer a unit
		const after = nodeAt(b, "resp");
		expect(after).toBe(before);
		expect(after.ref).toEqual({ kind: "file", path: MOVED });
		expect(parent.children.map((n) => n.id)).toEqual(["resp"]);

		const row = rowsOf(await renderNode(b, parent))[0];
		expect(textOf(row)).toBe("Responsibilities");
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(row.textContent).not.toContain("(missing)");
		expect(row.querySelector(".atlas-row-action")).toBeNull();
		expect(row.querySelector(".atlas-badge")).toBeNull(); // no promoted/added pill on a bucket row
		expect(row.getAttribute("draggable")).toBe("true");
	});

	it("GP5: re-rendering from the persisted tree (a plugin reload) gives the same row", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		const first = await renderNode(b, nodeAt(b, "fde"));

		const persisted = JSON.parse(JSON.stringify(b.views.getViews())) as View[];
		const reloaded = new ViewsManager(b.app as unknown as App, persisted, "actionable", vi.fn());
		const index2 = new UnitIndex(b.app as unknown as App, b.settings, [], {}, [], []);
		index2.rebuild(); // "Atlas: Rebuild index"
		const b2: Built = { ...b, views: reloaded, unitIndex: index2 };
		const second = await renderNode(b2, reloaded.getNode("actionable", "fde")!);

		expect(second.innerHTML).toBe(first.innerHTML);
		expect(textOf(rowsOf(second)[0])).toBe("Responsibilities");
	});

	it("F1/F2/F5: rendering writes nothing, creates no promotion, and the file is not in the inbox", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		b.persist.mockClear();
		const dataBefore = JSON.stringify(b.views.getViews());
		const unitsBefore = JSON.stringify(b.unitIndex.getUnits());
		const callsBefore = [...b.app.vault.calls];
		const changes = vi.fn();
		b.views.onChange(changes);

		await renderNode(b, nodeAt(b, "fde"));
		await renderNode(b, nodeAt(b, "fde"));

		expect(b.persist).not.toHaveBeenCalled();
		expect(changes).not.toHaveBeenCalled();
		expect(JSON.stringify(b.views.getViews())).toBe(dataBefore);
		expect(JSON.stringify(b.unitIndex.getUnits())).toBe(unitsBefore);
		expect(b.app.vault.calls).toEqual(callsBefore);
		const inbox = b.views.getInboxUnits(b.unitIndex.getUnits(), "actionable", "view", b.unitIndex);
		expect(inbox.map((u) => u.path)).not.toContain(MOVED);
		expect(b.views.getInboxUnits(b.unitIndex.getUnits(), "actionable", "global", b.unitIndex).map((u) => u.path)).not.toContain(MOVED);
	});

	it("GP7/F3: after the note is deleted the row is greyed '(missing)' with Remove, and the node is never auto-removed", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		await b.app.vault.delete(b.app.vault.getAbstractFileByPath(MOVED)!);

		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(true);
		expect(row.querySelector(".atlas-row-secondary")?.textContent).toBe("(missing)");
		expect(row.querySelector(".atlas-row-action")).not.toBeNull();
		expect(nodeAt(b, "resp")).toBeDefined();
		expect(nodeAt(b, "fde").children.map((n) => n.id)).toEqual(["resp"]);
	});

	it("E4: delete then recreate at the same path flips the row missing -> normal", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		await b.app.vault.delete(b.app.vault.getAbstractFileByPath(MOVED)!);
		expect(rowsOf(await renderNode(b, nodeAt(b, "fde")))[0].classList.contains("atlas-missing")).toBe(true);
		await b.app.vault.create(MOVED, "");
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(row)).toBe("Responsibilities");
	});

	it("E3: a placed unit that loses its last backlink stays a normal row (no flicker to missing)", async () => {
		const b = build({ files: ["Alpha/Doc.md", "Alpha/Alpha.md"], folders: ["Alpha"], view: actionableView([unitNode("doc", { kind: "file", path: "Alpha/Doc.md" })]) });
		b.unitIndex.addManualPromotion({ kind: "file", path: "Alpha/Doc.md" });
		b.unitIndex.rebuild();
		expect(REFS(b)).toContain("file:Alpha/Doc.md");
		expect(rowsOf(await renderNode(b, nodeAt(b, "fde")))[0].classList.contains("atlas-missing")).toBe(false);
		// The promotion (standing in for a live backlink) goes away: no longer a unit, still there.
		(b.unitIndex as unknown as { manualPromotions: UnitRef[] }).manualPromotions = [];
		b.unitIndex.rebuild();
		expect(REFS(b)).not.toContain("file:Alpha/Doc.md");
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(row)).toBe("Doc");
	});

	it("E5: the same file placed twice in one view renders both rows normally", async () => {
		const ref: UnitRef = { kind: "file", path: MOVED };
		const b = build({
			files: [MOVED],
			folders: ["FDE Play"],
			view: actionableView([unitNode("a", ref), unitNode("b", ref)]),
		});
		const rows = rowsOf(await renderNode(b, nodeAt(b, "fde")));
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.classList.contains("atlas-missing")).toBe(false);
			expect(textOf(row)).toBe("Responsibilities");
		}
	});

	it("E6: a file inside an excluded folder: existence alone decides", async () => {
		const b = build({
			files: [MOVED, "Gone-excl/Real.md"],
			folders: ["FDE Play", "Gone-excl"],
			excludedFolders: ["FDE Play"],
			view: actionableView([unitNode("a", { kind: "file", path: MOVED }), unitNode("b", { kind: "file", path: "FDE Play/Deleted.md" })]),
		});
		const rows = rowsOf(await renderNode(b, nodeAt(b, "fde")));
		expect(rows[0].classList.contains("atlas-missing")).toBe(false);
		expect(rows[1].classList.contains("atlas-missing")).toBe(true);
	});

	it("E2: a placed folder that exists and is no longer promoted is a normal module row (folder icon, folder name)", async () => {
		const b = build({
			files: ["Areas/Deep/Deep.md", "Areas/Deep/x.md"],
			folders: ["Areas", "Areas/Deep"],
			view: actionableView([unitNode("deep", { kind: "folder", path: "Areas/Deep" })]),
		});
		expect(REFS(b)).not.toContain("folder:Areas/Deep");
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(row)).toBe("Deep");
		expect(row.querySelector(".atlas-row-action")).toBeNull();
		const wire = vi.spyOn(proto as unknown as Record<string, () => void>, "wireModuleRow");
		await renderNode(b, nodeAt(b, "fde"));
		expect(wire).toHaveBeenCalledTimes(1);
		wire.mockRestore();
	});

	it("E9: a file ref that is a folder, and a folder ref that is a file, render greyed missing", async () => {
		const b = build({
			files: ["Notes/a.md"],
			folders: ["Notes"],
			view: actionableView([unitNode("f", { kind: "file", path: "Notes" }), unitNode("d", { kind: "folder", path: "Notes/a.md" })]),
		});
		const rows = rowsOf(await renderNode(b, nodeAt(b, "fde")));
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.classList.contains("atlas-missing")).toBe(true);
	});

	it("E11: a non-markdown file that is not a unit is a present row", async () => {
		const b = build({ files: ["FDE Play/scan.pdf"], folders: ["FDE Play"], view: actionableView([unitNode("p", { kind: "file", path: "FDE Play/scan.pdf" })]) });
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(row)).toBe("scan");
	});

	it("a non-unit block ref and an empty path still render missing", async () => {
		const b = build({
			files: [MOVED],
			folders: ["FDE Play"],
			view: actionableView([unitNode("blk", { kind: "block", path: MOVED, subpath: "^abc" }), unitNode("empty", { kind: "file", path: "" })]),
		});
		const rows = rowsOf(await renderNode(b, nodeAt(b, "fde")));
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.classList.contains("atlas-missing")).toBe(true);
	});

	it("a path that later becomes a unit switches to unit rendering with its promoted flag", async () => {
		const b = build({ files: [MOVED], folders: ["FDE Play"], view: actionableView([unitNode("r", { kind: "file", path: MOVED })]) });
		const plain = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(plain.querySelector(".atlas-badge")).toBeNull();
		b.unitIndex.addManualPromotion({ kind: "file", path: MOVED });
		b.unitIndex.rebuild();
		const unitRow = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(unitRow.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(unitRow)).toBe("Responsibilities");
	});

	it("E7: Remove from view takes the node away only; the file is not in the inbox; the inbox '+' and Place in view… both accept it again", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		const explorer = explorerFor(b);
		const node = nodeAt(b, "resp");

		await (explorer.removeUnitsFromView as (viewId: string, nodes: ViewNode[]) => Promise<void>)("actionable", [node]);
		await flushPromises();
		expect(nodeAt(b, "fde").children).toEqual([]);
		expect(b.app.vault.getAbstractFileByPath(MOVED)).not.toBeNull(); // nothing on disk changed
		expect(b.app.vault.calls.filter((c) => c !== "rename")).toEqual([]);
		const inboxPaths = () => b.views.getInboxUnits(b.unitIndex.getUnits(), "actionable", "view", b.unitIndex).map((u) => u.path);
		expect(inboxPaths()).not.toContain(MOVED);

		// The inbox "+" offers it (it is no longer placed anywhere) and picking it adds it to the inbox.
		const placed = b.views.placedRefKeys();
		const offered = candidateFilesForAdd(b.app.vault.getFiles() as never, b.unitIndex.getUnits(), (ref) => placed.has(unitRefKey(ref))).map((f) => f.path);
		expect(offered).toContain(MOVED);
		b.unitIndex.markAdded({ kind: "file", path: MOVED });
		expect(inboxPaths()).toContain(MOVED);
		b.unitIndex.removeAdded({ kind: "file", path: MOVED });

		// "Place in view…" ends in placeUnit with the bare ref, which has no unit check.
		const replaced = b.views.placeUnit("actionable", { kind: "file", path: MOVED }, "fde");
		expect(replaced).not.toBeNull();
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(row)).toBe("Responsibilities");
	});

	/** An explorer whose row icon, open and status handling are the real methods (not stubs), so the
	 * status dot, click-to-open and middle-click-to-open run the same code a user's click does. The
	 * workspace records which file each leaf opened and in which tab mode. */
	function liveExplorerFor(b: Built) {
		const opened: { path: string; newTab: boolean }[] = [];
		(b.app as unknown as { workspace: unknown }).workspace = {
			getLeaf: (newTab: boolean) => ({ openFile: async (f: { path: string }) => void opened.push({ path: f.path, newTab: !!newTab }) }),
			onLayoutReady: (cb: () => void) => cb(),
			getLeavesOfType: () => [],
		};
		const explorer = explorerFor(b);
		(explorer.plugin as Record<string, unknown>).statusesManager = makeStatusesManager();
		for (const name of ["renderRowIcon", "openRef"] as const) explorer[name] = (proto as unknown as Record<string, (...a: unknown[]) => unknown>)[name].bind(explorer);
		return { explorer, opened };
	}

	/** Make the "FDE Play" Folder a status governor so rows under it get a status dot. */
	function governFde(b: Built): ViewNode {
		const fde = nodeAt(b, "fde");
		fde.statusEnabled = true;
		fde.statusSetId = "S";
		return fde;
	}

	it("GP4/T1/T6: click and middle-click open the moved note; the status dot changes; nesting works", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		const fde = governFde(b);
		const { explorer, opened } = liveExplorerFor(b);
		const container = await renderNode(b, fde, { explorer, ancestors: [fde] });
		const row = rowsOf(container)[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);

		// Plain click opens FDE Play/Responsibilities.md in the current tab.
		row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();
		expect(opened).toEqual([{ path: MOVED, newTab: false }]);

		// Middle-click opens it in a new tab.
		row.querySelector(".atlas-row-text")!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
		await flushPromises();
		expect(opened).toEqual([{ path: MOVED, newTab: false }, { path: MOVED, newTab: true }]);

		// The status dot shows the set default (Todo, #888888); picking Doing changes the explicit status.
		const dot = row.querySelector<HTMLElement>(".atlas-status-dot-circle")!;
		expect(dot).not.toBeNull();
		expect(dot.style.backgroundColor).toBe("rgb(136, 136, 136)");
		dot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		const doing = Array.from(document.body.querySelectorAll<HTMLElement>(".atlas-choice-popup-item")).find((e) => e.textContent === "Doing")!;
		expect(doing).toBeDefined();
		doing.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(nodeAt(b, "resp").explicitStatusId).toBe("doing");
		expect(opened).toHaveLength(2); // the dot click did not also open the note
		const after = rowsOf(await renderNode(b, fde, { explorer: liveExplorerFor(b).explorer, ancestors: [fde] }))[0];
		expect(after.querySelector<HTMLElement>(".atlas-status-dot-circle")!.style.backgroundColor).toBe("rgb(0, 136, 255)");

		// Nesting: another unit can be placed under the moved row.
		expect(b.views.placeUnit("actionable", { kind: "file", path: "Other.md" }, "resp")).not.toBeNull();
		expect(nodeAt(b, "resp").children.map((n) => n.ref)).toEqual([{ kind: "file", path: "Other.md" }]);
	});

	it("GP7/T2: deleting the moved note turns the row greyed '(missing)' with a Remove button that removes only the node", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		expect(rowsOf(await renderNode(b, nodeAt(b, "fde")))[0].classList.contains("atlas-missing")).toBe(false);
		await b.app.vault.delete(b.app.vault.getAbstractFileByPath(MOVED)!);

		const row = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(row.classList.contains("atlas-missing")).toBe(true);
		expect(row.querySelector(".atlas-row-secondary")?.textContent).toBe("(missing)");
		const remove = row.querySelector<HTMLElement>(".atlas-row-action")!;
		expect(remove).not.toBeNull();
		remove.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();
		expect(nodeAt(b, "fde").children).toEqual([]);
	});

	it("E3/T3: a placed file promoted by a real backlink stays a normal row after the backlink is removed", async () => {
		const b = build({
			files: ["Linker.md", "Alpha/Doc.md", "Alpha/Alpha.md"],
			folders: ["Alpha"],
			view: actionableView([unitNode("doc", { kind: "file", path: "Alpha/Doc.md" })]),
		});
		// Linker.md (vault root) links [[Doc]]; Doc.md lives in the Alpha module, so it is promoted by link.
		let linked = true;
		const cache = b.app.metadataCache as unknown as { getFileCache: (f: { path: string }) => unknown; getFirstLinkpathDest: (l: string) => unknown };
		cache.getFileCache = (f) => (f.path === "Linker.md" && linked ? { links: [{ link: "Doc", original: "[[Doc]]" }] } : null);
		cache.getFirstLinkpathDest = (l) => (l === "Doc" ? b.app.vault.getAbstractFileByPath("Alpha/Doc.md") : null);
		b.unitIndex.rebuild();
		expect(b.unitIndex.getUnits().map((u) => `${u.type}:${u.path}`)).toContain("promoted-file:Alpha/Doc.md");
		const before = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(before.classList.contains("atlas-missing")).toBe(false);

		// The last backlink goes away: Doc.md is no longer a unit, but is still in the vault.
		linked = false;
		b.unitIndex.rebuild();
		expect(b.unitIndex.getUnits().map((u) => u.path)).not.toContain("Alpha/Doc.md");
		const after = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(after.classList.contains("atlas-missing")).toBe(false);
		expect(after.querySelector(".atlas-row-action")).toBeNull();
		expect(textOf(after)).toBe("Doc");
	});

	it("E7/T4: a present file removed from view leaves the inbox alone, and can be re-placed or added again", async () => {
		const b = await danScenario();
		await moveIntoFolder(b);
		const { explorer } = liveExplorerFor(b);
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde"), { explorer }))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		b.app.vault.calls.length = 0;

		await (explorer.removeUnitsFromView as (viewId: string, nodes: ViewNode[]) => Promise<void>)("actionable", [nodeAt(b, "resp")]);
		await flushPromises();
		expect(nodeAt(b, "fde").children).toEqual([]);
		expect(b.app.vault.getAbstractFileByPath(MOVED)).not.toBeNull();
		expect(b.app.vault.calls).toEqual([]);
		const inboxPaths = () => b.views.getInboxUnits(b.unitIndex.getUnits(), "actionable", "view", b.unitIndex).map((u) => u.path);
		expect(inboxPaths()).not.toContain(MOVED);

		const placed = b.views.placedRefKeys();
		expect(candidateFilesForAdd(b.app.vault.getFiles() as never, b.unitIndex.getUnits(), (ref) => placed.has(unitRefKey(ref))).map((f) => f.path)).toContain(MOVED);
		expect(b.views.placeUnit("actionable", { kind: "file", path: MOVED }, "fde")).not.toBeNull();
		const replaced = rowsOf(await renderNode(b, nodeAt(b, "fde")))[0];
		expect(replaced.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(replaced)).toBe("Responsibilities");
	});

	it("F9/T5: with a real UnitIndex, Create Module is offered on a placed root-level .md unit and not on a nested non-unit file", () => {
		const b = build({
			files: ["Root.md", MOVED],
			folders: ["FDE Play"],
			view: actionableView([unitNode("root", { kind: "file", path: "Root.md" }), unitNode("nested", { kind: "file", path: MOVED })]),
		});
		expect(b.unitIndex.getUnits().map((u) => u.path)).toEqual(expect.arrayContaining(["Root.md"]));
		expect(b.unitIndex.getUnits().map((u) => u.path)).not.toContain(MOVED);
		const titlesFor = (id: string): string[] => {
			const node = nodeAt(b, id);
			const explorer = explorerFor(b);
			explorer.startCreateModule = vi.fn();
			explorer.placeInViewFlow = vi.fn();
			let built: Menu | undefined;
			const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
				built = this;
			});
			(proto as unknown as Record<string, (...a: unknown[]) => void>).showUnitMenu.call(explorer, new MouseEvent("contextmenu"), node.ref, b.views.getViews()[0], node);
			show.mockRestore();
			return (built as unknown as { titles: () => string[] }).titles();
		};
		expect(titlesFor("root")).toContain("Create Module");
		expect(titlesFor("nested")).not.toContain("Create Module");
		expect(titlesFor("nested")).toEqual(expect.arrayContaining(["Add under…", "Remove from view", "Place in view…"]));
	});

	it("E2/E7/T7: a placed non-unit folder is a module row; Remove from view takes the node away, the vault is untouched and the inbox gains no entry", async () => {
		const b = build({
			files: ["Areas/Deep/Deep.md", "Areas/Deep/x.md"],
			folders: ["Areas", "Areas/Deep"],
			view: actionableView([unitNode("deep", { kind: "folder", path: "Areas/Deep" })]),
		});
		const inboxPaths = () => b.views.getInboxUnits(b.unitIndex.getUnits(), "actionable", "view", b.unitIndex).map((u) => u.path);
		const inboxBefore = inboxPaths();
		const { explorer } = liveExplorerFor(b);
		const row = rowsOf(await renderNode(b, nodeAt(b, "fde"), { explorer }))[0];
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(textOf(row)).toBe("Deep");
		expect(row.querySelector(".atlas-row-action")).toBeNull();
		b.app.vault.calls.length = 0;

		await (explorer.removeUnitsFromView as (viewId: string, nodes: ViewNode[]) => Promise<void>)("actionable", [nodeAt(b, "deep")]);
		await flushPromises();
		expect(nodeAt(b, "fde").children).toEqual([]);
		expect(b.app.vault.getAbstractFileByPath("Areas/Deep")).not.toBeNull();
		expect(b.app.vault.calls).toEqual([]);
		expect(inboxPaths()).toEqual(inboxBefore);
		expect(inboxPaths()).not.toContain("Areas/Deep");
	});

	it("F8: an Outside-Vault-managed row resolves through resolveOutsideManagedRowInfo and never asks the vault about its absolute path", async () => {
		const abs = "/Users/someone/Jobs/acme.md";
		const b = build({ files: [], folders: [], view: actionableView([{ ...unitNode("o", { kind: "file", path: abs }), folderSourceManaged: true, folderSourceOwnerId: "fde" }]) });
		const lookup = vi.spyOn(b.app.vault, "getAbstractFileByPath");
		const explorer = explorerFor(b);
		explorer.isOutsideManagedUnit = vi.fn(() => true);
		const resolveRef = vi.spyOn(explorer as { resolveRef: () => unknown }, "resolveRef");
		const container = document.createElement("div");
		await (explorer.renderNode as (n: ViewNode, c: HTMLElement, v: View, d: number, a: unknown[]) => Promise<void>)(nodeAt(b, "o"), container, b.views.getViews()[0], 0, []);
		const row = rowsOf(container)[0];
		expect(textOf(row)).toBe("acme.md");
		expect(row.classList.contains("atlas-missing")).toBe(false);
		expect(resolveRef).not.toHaveBeenCalled();
		expect(lookup.mock.calls.map((c) => c[0])).not.toContain(abs);
	});
});

/** Atlas #16 (E9): with two Atlas leaves open, each view has its own `onOpen` listeners (the hidden
 * one included). The real `refreshExplorerViews` finds both through `getLeavesOfType`; a press inside
 * either pane holds both views' renders, and ending it releases both. */
describe("Atlas #16 — E9: a press in either of two Atlas leaves holds both views", () => {
	let h: SectionHarness;
	let first: PressEnv;
	let second: PressInternals;
	let secondRenderNow: ReturnType<typeof vi.fn>;
	let removeSecond: (() => void)[];
	let secondHost: HTMLElement;

	beforeEach(async () => {
		vi.useFakeTimers();
		h = makeSectionHarness({ bucketRows: 1, inboxRows: 1 });
		first = await openExplorer(h);
		drawBucketRows(first.ex, () => 1);

		// The second (hidden) leaf's view: same plugin, its own container, the same stubbed row content.
		const firstEx = first.ex as unknown as Record<string, unknown>;
		const view = new AtlasExplorerView({} as WorkspaceLeaf, firstEx.plugin as never);
		secondHost = document.body.appendChild(document.createElement("div"));
		secondHost.appendChild(document.createElement("div"));
		secondHost.appendChild(document.createElement("div"));
		(view as unknown as { containerEl: HTMLElement }).containerEl = secondHost;
		for (const key of ["renderToolbar", "renderNodeList", "resolveRef", "matchesFilter", "setPlacementTooltip", "updateActiveHighlight", "syncRefreshTimers", "refreshApiSourcesOnViewLoad"]) {
			(view as unknown as Record<string, unknown>)[key] = firstEx[key];
		}
		second = view as unknown as PressInternals;
		removeSecond = [];
		second.leaf = {} as WorkspaceLeaf;
		second.registerEvent = vi.fn();
		second.registerDomEvent = (el, type, cb, opts) => {
			el.addEventListener(type, cb, opts);
			removeSecond.push(() => el.removeEventListener(type, cb, opts));
		};
		await second.onOpen();
		secondRenderNow = vi.spyOn(second, "renderNow") as unknown as ReturnType<typeof vi.fn>;
		first.renderNow.mockClear();
		secondRenderNow.mockClear();
	});

	afterEach(() => {
		first.teardown();
		removeSecond.forEach((remove) => remove());
		h.teardown();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** The plugin's real `refreshExplorerViews`, looking both views up through `getLeavesOfType`. */
	function refreshBoth(): void {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		Object.assign(plugin, {
			app: {
				workspace: {
					getLeavesOfType: (type: string) =>
						type === ATLAS_VIEW_TYPE ? [{ view: first.ex }, { view: second }] : [],
				},
			},
		});
		// `instanceof AtlasExplorerView` holds: both are real instances.
		plugin.refreshExplorerViews();
	}

	const presses: [string, () => HTMLElement][] = [
		["the visible leaf", () => bucketRows()[0]],
		["the other leaf", () => secondHost.children[1] as HTMLElement],
	];
	for (const [name, target] of presses) {
		it(`a press in ${name} holds both views, and releasing it renders each once`, async () => {
			const node = target();
			pointer("pointerdown", node, { buttons: 1 });
			refreshBoth();
			await vi.advanceTimersByTimeAsync(50);
			expect(first.renderNow).not.toHaveBeenCalled();
			expect(secondRenderNow).not.toHaveBeenCalled();

			pointer("pointerup", node);
			await vi.advanceTimersByTimeAsync(50);
			expect(first.renderNow).toHaveBeenCalledTimes(1);
			expect(secondRenderNow).toHaveBeenCalledTimes(1);
		});
	}

	it("without a press both views render as before", async () => {
		refreshBoth();
		await vi.advanceTimersByTimeAsync(50);
		expect(first.renderNow).toHaveBeenCalledTimes(1);
		expect(secondRenderNow).toHaveBeenCalledTimes(1);
	});
});
