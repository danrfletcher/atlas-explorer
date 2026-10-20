import { describe, expect, it, vi } from "vitest";

/** PR-3: isolates `explorer-view.ts`'s wiring (which fields of `ApiSourceModalResult` it reads, what
 * it does with them) from the real modal's own rendering/validation, which already has full coverage
 * in `tests/unit/api-source-modal.test.ts`. */
vi.mock("../../src/api-source-modal", () => {
	class FakeApiSourceModal {
		static instances: FakeApiSourceModal[] = [];
		onSave: (result: unknown) => void;
		open = vi.fn();
		constructor(public app: unknown, public initial: unknown, public headers: unknown, onSave: (result: unknown) => void) {
			this.onSave = onSave;
			FakeApiSourceModal.instances.push(this);
		}
	}
	return { ApiSourceModal: FakeApiSourceModal };
});

/** PR-2.F2 R2: `startAddUnderFolder` itself (the prompt, the per-parent lock, the parent-exists
 * checks) already has full coverage in `tests/unit/add-under-folder.test.ts`. Mocking it here
 * isolates `runAddUnderFolder`'s own wiring — the render-then-check-visibility step — and lets the
 * test drive the real `addUnderFolderDeps()`/`render()`/`awaitRenderSettled()`/`queueRender()`
 * methods through a deliberately staged overlapping-render race. */
vi.mock("../../src/add-under-folder", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/add-under-folder")>();
	return { ...actual, startAddUnderFolder: vi.fn() };
});

import type { App } from "obsidian";
import { Menu, Notice } from "obsidian";
import { ApiSourceModal } from "../../src/api-source-modal";
import { AtlasExplorerView } from "../../src/explorer-view";
import { AddUnderFolderDeps, startAddUnderFolder } from "../../src/add-under-folder";
import { StatusesManager } from "../../src/statuses";
import { View, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import { makeStatusesManager } from "./explorer-view-sort-truncate-helpers";
import { meta } from "../integration/create-from-meta-fixtures";
import { App as MockApp } from "../mocks/obsidian";

const mockStartAddUnderFolder = startAddUnderFolder as unknown as ReturnType<typeof vi.fn>;

const FakeApiSourceModal = ApiSourceModal as unknown as {
	instances: { app: unknown; initial: unknown; headers: unknown; open: () => void; onSave: (result: unknown) => void }[];
};

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

function openApiSourceModal(node: ViewNode, plugin: Record<string, unknown>, refreshApiSource = vi.fn()) {
	(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
		{ plugin, refreshApiSource },
		view,
		node
	);
	return refreshApiSource;
}

describe("PR-3 — explorer-view.ts call sites keep working with the new ApiSourceModalResult.type field", () => {
	it("openApiSourceModal and context-menu entry point still invoke modal and handle onSave result", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");

		// The "Data source…" context-menu item still delegates to openApiSourceModal(view, node), same
		// as before this PR — unchanged by adding `type` to the result.
		const openApiSourceModalSpy = vi.fn();
		let builtMenu: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			builtMenu = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(
			{
				plugin: { statusesManager: { findSortGovernor: () => null } },
				startCreateFromMeta: vi.fn(),
				openStatusesModal: vi.fn(),
				openApiSourceModal: openApiSourceModalSpy,
			},
			new MouseEvent("contextmenu"),
			node,
			view
		);
		show.mockRestore();

		const dataSourceItem = builtMenu!.items.find((item) => item.title === "Data source…");
		expect(dataSourceItem).toBeTruthy();
		dataSourceItem!.clickHandler!();
		expect(openApiSourceModalSpy).toHaveBeenCalledWith(view, node);

		// Directly exercise the real openApiSourceModal: it builds the modal with the node's existing
		// headers/apiSource and wires onSave to persist headers + source and trigger a manual refresh.
		const headers = [{ key: "X", value: "Y" }];
		const apiHeadersStore = { get: vi.fn(() => headers), set: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshApiSource = openApiSourceModal(node, plugin);

		expect(FakeApiSourceModal.instances).toHaveLength(1);
		const modal = FakeApiSourceModal.instances[0];
		expect(modal.app).toBe(plugin.app);
		expect(modal.initial).toBeNull();
		expect(modal.headers).toBe(headers);
		expect(apiHeadersStore.get).toHaveBeenCalledWith(node.id);

		// onSave now always receives a `type` field (PR-3) alongside the unchanged `source`/`headers` —
		// explorer-view.ts must keep working without reading or requiring that field.
		const newHeaders = [{ key: "A", value: "B" }];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: newHeaders });

		expect(apiHeadersStore.set).toHaveBeenCalledWith(node.id, newHeaders);
		expect(viewsManager.setApiSource).toHaveBeenCalledWith(view.id, node.id, { url: "https://api.example.com/items" });
		expect(refreshApiSource).toHaveBeenCalledWith(view, node, "manual");
	});
});

describe("R8 — switching API->CSV drops the API source's device-local headers, same as Remove data source", () => {
	it("deletes the ApiHeadersStore entry when a node that had a live apiSource is switched to csv", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		node.apiSource = { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge" };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setCsvSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshCsvSource = vi.fn();
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshCsvSource },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const csvSource = { path: "data/items.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const };
		modal.onSave({ type: "csv", source: csvSource });

		expect(viewsManager.setCsvSource).toHaveBeenCalledWith(view.id, node.id, csvSource);
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshCsvSource).toHaveBeenCalledWith(view, node, "manual");
	});

	it("does not touch ApiHeadersStore when switching to csv from a node that never had an apiSource", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m2", "Folder");

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setCsvSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshCsvSource: vi.fn() },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const csvSource = { path: "data/items.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const };
		modal.onSave({ type: "csv", source: csvSource });

		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
	});
});

describe("PR-4 R3 — switching source types cleans up the other type's device-local state", () => {
	it("switching API->Folder drops the API source's device-local headers, same as switching to csv/markdown-table", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		node.apiSource = { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge" };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshFolderSource = vi.fn();
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshFolderSource },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const folderSource = { location: "inside" as const, path: "Projects", showFiles: true, showFolders: true };
		modal.onSave({ type: "folder", source: folderSource, outsidePath: "" });

		expect(viewsManager.setFolderSource).toHaveBeenCalledWith(view.id, node.id, folderSource);
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshFolderSource).toHaveBeenCalledWith(view, node);
	});

	it("does not touch ApiHeadersStore when switching to folder from a node that never had an apiSource", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m2", "Folder");

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshFolderSource: vi.fn() },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({ type: "folder", source: { location: "inside" as const, path: "Projects", showFiles: true, showFolders: true }, outsidePath: "" });

		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
	});

	it("switching Folder(outside)->API drops the folder source's device-local outside path", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m3", "Folder");
		node.folderSource = { location: "outside", path: "/abs/Notes", showFiles: true, showFolders: true };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => "/abs/Notes"), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshApiSource = openApiSourceModal(node, plugin);

		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: [] });

		expect(viewsManager.setApiSource).toHaveBeenCalledWith(view.id, node.id, { url: "https://api.example.com/items" });
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshApiSource).toHaveBeenCalledWith(view, node, "manual");
	});

	it("does not touch FolderSourcePathStore when switching to API from an Inside-Vault (not Outside) folder source", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m4", "Folder");
		node.folderSource = { location: "inside", path: "Projects", showFiles: true, showFolders: true };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		openApiSourceModal(node, plugin);

		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: [] });

		expect(folderSourcePathStore.delete).not.toHaveBeenCalled();
	});
});

// PR-1 (G11b/E-a): the four source walks visit every node and recurse into every node's children,
// including unit children, so a sourced folder nested under a unit still refreshes at load and on timers.
describe("PR-1 G11b/E-a — source walks reach a sourced node nested under units and meta folders", () => {
	type Walk = "collectApiSourceNodes" | "collectFolderSourceNodes" | "collectCsvSourceNodes" | "collectMarkdownTableSourceNodes";
	const proto = AtlasExplorerView.prototype as unknown as Record<Walk, (nodes: ViewNode[]) => ViewNode[]>;
	const WALKS: Array<{ walk: Walk; field: keyof ViewNode; sourced: Partial<ViewNode> }> = [
		{ walk: "collectApiSourceNodes", field: "apiSource", sourced: { apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } } },
		{ walk: "collectFolderSourceNodes", field: "folderSource", sourced: { folderSource: { location: "inside", path: "P", showFiles: true, showFolders: true, refreshOnViewLoad: false } } },
		{ walk: "collectCsvSourceNodes", field: "csvSource", sourced: { csvSource: { path: "d.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } } },
		{
			walk: "collectMarkdownTableSourceNodes",
			field: "markdownTableSource",
			sourced: { markdownTableSource: { path: "t.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } },
		},
	];

	for (const { walk, field, sourced } of WALKS) {
		it(`${walk} finds a source under unit > unit > meta and under unit > unit`, () => {
			const deep: ViewNode = { id: "deep", type: "unit", ref: { kind: "folder", path: "Deep" }, children: [], ...sourced };
			const middle: ViewNode = { id: "mid", type: "unit", ref: { kind: "file", path: "Mid.md" }, children: [deep] };
			const metaWrap: ViewNode = { id: "m", type: "meta", label: "Wrap", children: [middle] };
			const unitUnder: ViewNode = { id: "u2", type: "unit", ref: { kind: "file", path: "Top.md" }, children: [{ ...deep, id: "deep2" }] };
			const found = proto[walk].call(AtlasExplorerView.prototype, [metaWrap, unitUnder]);
			expect(found.map((n) => n.id)).toEqual(["deep", "deep2"]);
			expect(found.every((n) => n[field] !== undefined)).toBe(true);
		});

		it(`${walk} visits a sourced unit that has no children and skips unsourced nodes`, () => {
			const leaf: ViewNode = { id: "leaf", type: "unit", ref: { kind: "file", path: "L.md" }, children: [], ...sourced };
			const plain: ViewNode = { id: "plain", type: "unit", ref: { kind: "file", path: "P.md" }, children: [] };
			expect(proto[walk].call(AtlasExplorerView.prototype, [plain, leaf]).map((n) => n.id)).toEqual(["leaf"]);
		});
	}
});

// PR-2.F2 R1: addUnderFolderDeps.selectOnly only ever cleared the bucket selection, leaving a prior
// inbox selection (and a stale anchor) live — this broke "bucket and inbox selections are mutually
// exclusive" (E5) whenever Add under… > Folder ran right-clicked with inbox rows still selected.
describe("PR-2.F2 R1 — addUnderFolderDeps.selectOnly keeps bucket/inbox selection mutually exclusive", () => {
	it("clears any inbox selection, replaces the bucket selection with exactly the new node, and anchors in bucket scope", () => {
		const fakeThis = {
			plugin: { app: {}, viewsManager: { getNode: vi.fn(), addMetaFolder: vi.fn(), setNodeCollapsed: vi.fn() } },
			selectedBucketNodeIds: new Set<string>(["old-bucket-node"]),
			selectedInboxRefKeys: new Set<string>(["file:Some.md"]),
			selectionAnchor: "old-anchor" as string | null,
			selectionAnchorScope: "inbox" as "bucket" | "inbox" | null,
		};
		const deps = (AtlasExplorerView.prototype as unknown as { addUnderFolderDeps: () => AddUnderFolderDeps }).addUnderFolderDeps.call(fakeThis);

		deps.selectOnly("new-node");

		expect([...fakeThis.selectedBucketNodeIds]).toEqual(["new-node"]);
		expect([...fakeThis.selectedInboxRefKeys]).toEqual([]);
		expect(fakeThis.selectionAnchor).toBe("new-node");
		expect(fakeThis.selectionAnchorScope).toBe("bucket");
	});
});

// PR-2.F2 R2: `render()`'s own `isCurrent()` guard only tells a superseded render to bail out early
// — it says nothing about whether the render that superseded it has itself finished building the DOM
// yet. A caller that needs the truly-latest, fully-settled DOM (like `runAddUnderFolder`'s G10 check)
// must follow whichever render turns out to be the most recently *started* one, even if it only
// starts after the caller began waiting.
describe("PR-2.F2 R2 — render()/awaitRenderSettled track the truly latest render across an overlap", () => {
	it("waits for a render that starts and supersedes an in-flight one, not just the first render it saw", async () => {
		const resolvers: Array<() => void> = [];
		const fakeThis: { latestRenderPromise: Promise<void> | null; renderNow: () => Promise<void> } = {
			latestRenderPromise: null,
			renderNow: vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve))),
		};
		const render = (AtlasExplorerView.prototype as unknown as { render: () => Promise<void> }).render.bind(fakeThis);
		const awaitRenderSettled = (AtlasExplorerView.prototype as unknown as { awaitRenderSettled: () => Promise<void> }).awaitRenderSettled.bind(fakeThis);

		// Render A starts (e.g. runAddUnderFolder's own direct `render()` call) ...
		void render();
		let settled = false;
		const settledPromise = awaitRenderSettled().then(() => {
			settled = true;
		});

		// ... then, while A is still in flight, render B starts and supersedes it — exactly the
		// queued setTimeout(0) render firing mid-flight that R2 describes.
		void render();

		// A resolves (the superseded render bailing out early via its own isCurrent() check).
		resolvers[0]();
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false); // must still be waiting on B, the real latest render

		resolvers[1]();
		await settledPromise;
		expect(settled).toBe(true);
	});
});

// PR-2.F2 R2: `startAddUnderFolder` itself is mocked (see the top of this file) so this test can
// stage the exact overlapping-render race against the real `addUnderFolderDeps()`, `render()`,
// `awaitRenderSettled()` and `queueRender()` — only `ViewsManager.addMetaFolder`/`setNodeCollapsed`
// (already covered by `tests/unit/views*.test.ts`) and the DOM-building half of `render()` are
// stubbed, standing in for the parts this test doesn't need to re-prove.
describe("PR-2.F2 R2 — runAddUnderFolder waits for an overlapping queued render before checking visibility", () => {
	it("doesn't show the 'hidden by filter/sort/grouping' Notice when a save()-triggered render starts and finishes after the add's own direct render", async () => {
		Notice.reset();
		// jsdom in this test environment has no global `CSS` at all (not even without `.escape`),
		// which `runAddUnderFolder`'s own visibility check relies on, same as `render()` itself
		// already does elsewhere (src/explorer-view.ts). None of the IDs this test uses need real
		// escaping, so a minimal stand-in is enough; restored after the test either way.
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (value: string) => string } }).CSS = {
			escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
		};

		try {
			const created: ViewNode = meta("new-node", "Archive");
			const parentNode: ViewNode = meta("parent", "Projects");

			let callIndex = 0;
			let resolveD: (() => void) | null = null;
			let resolveQ: (() => void) | null = null;
			const fakeThis: Record<string, unknown> = {
				bucketListEl: document.createElement("div"),
				latestRenderPromise: null,
				renderQueued: false,
				selectedBucketNodeIds: new Set<string>(),
				selectedInboxRefKeys: new Set<string>(),
				selectionAnchor: null,
				selectionAnchorScope: null,
				filterText: "",
				expandedTruncationGroups: new Set<string>(),
				plugin: {
					app: {},
					// PR-2.F3: `addUnderHiddenSignals` reads this to resolve the new row's governance —
					// neither node here has `statusEnabled`, so a no-op stub (always "no governor") is
					// enough; this test is about the render-overlap race, not reason classification.
					statusesManager: { findGoverningAncestor: () => null, resolveNodeStatus: () => null },
					viewsManager: {
						getNode: vi.fn(() => parentNode),
						// Standing in for the real ViewsManager.addMetaFolder, which calls save() and so
						// (via this view's own ViewsManager.onChange subscription) queueRender() — the
						// trigger for the race this test stages.
						addMetaFolder: vi.fn(() => {
							(fakeThis.queueRender as () => void)();
							return created;
						}),
						setNodeCollapsed: vi.fn(() => {
							(fakeThis.queueRender as () => void)();
						}),
					},
				},
			};
			fakeThis.render = (AtlasExplorerView.prototype as unknown as { render: () => Promise<void> }).render;
			fakeThis.awaitRenderSettled = (AtlasExplorerView.prototype as unknown as { awaitRenderSettled: () => Promise<void> }).awaitRenderSettled;
			fakeThis.addUnderFolderDeps = (AtlasExplorerView.prototype as unknown as { addUnderFolderDeps: () => AddUnderFolderDeps }).addUnderFolderDeps;
			fakeThis.queueRender = (AtlasExplorerView.prototype as unknown as { queueRender: () => void }).queueRender;
			fakeThis.addUnderParentLabel = (AtlasExplorerView.prototype as unknown as { addUnderParentLabel: (...a: unknown[]) => unknown }).addUnderParentLabel;
			fakeThis.expandAddUnderParent = (AtlasExplorerView.prototype as unknown as { expandAddUnderParent: (...a: unknown[]) => unknown }).expandAddUnderParent;
			fakeThis.runAddUnderFolder = (AtlasExplorerView.prototype as unknown as { runAddUnderFolder: (view: View, node: ViewNode) => Promise<void> }).runAddUnderFolder;
			fakeThis.addUnderHiddenSignals = (AtlasExplorerView.prototype as unknown as { addUnderHiddenSignals: (...a: unknown[]) => unknown }).addUnderHiddenSignals;
			fakeThis.ancestorsForNode = (AtlasExplorerView.prototype as unknown as { ancestorsForNode: (...a: unknown[]) => unknown }).ancestorsForNode;
			fakeThis.renderNow = vi.fn(() => {
				callIndex += 1;
				if (callIndex === 1) {
					// D: runAddUnderFolder's own direct render call. Kept pending (e.g. still awaiting a
					// promoted block's disk read in a real render) until this test resolves it below.
					return new Promise<void>((resolve) => {
						resolveD = resolve;
					});
				}
				// Q: the queued render triggered above by addMetaFolder/setNodeCollapsed. Reassigns
				// bucketListEl to a fresh, still-empty list right away (mirroring renderBucketSection's
				// own `this.bucketListEl = listEl` before any row has been appended), and only appends
				// the new row once this render itself actually finishes.
				fakeThis.bucketListEl = document.createElement("div");
				return new Promise<void>((resolve) => {
					resolveQ = () => {
						const row = document.createElement("div");
						row.setAttribute("data-select-key", created.id);
						(fakeThis.bucketListEl as HTMLElement).appendChild(row);
						resolve();
					};
				});
			});

			mockStartAddUnderFolder.mockImplementation(async (deps: AddUnderFolderDeps, viewId: string, parentId: string) => {
				const node = deps.addMetaFolder(viewId, parentId, "Archive");
				if (!node) return null;
				deps.expandParent(viewId, parentId);
				deps.selectOnly(node.id);
				return node;
			});

			const runPromise = (fakeThis.runAddUnderFolder as (view: View, node: ViewNode) => Promise<void>).call(fakeThis, view, parentNode);
			let settled = false;
			void runPromise.then(() => {
				settled = true;
			});

			// Let the real setTimeout(0) scheduled by queueRender (inside addMetaFolder, above) actually
			// fire — this is render Q starting mid-flight through render D, the overlap R2 describes.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(resolveQ).not.toBeNull();
			expect(settled).toBe(false); // D hasn't resolved yet; nothing should have settled

			// D resolves (bails out early via isCurrent()) while Q is still mid-build (no row appended
			// yet). The buggy version checked `bucketListEl` right here and wrongly showed the Notice.
			resolveD!();
			await Promise.resolve();
			await Promise.resolve();
			expect(settled).toBe(false); // must still be waiting on Q, the real latest render

			// Q finishes and actually appends the new row.
			resolveQ!();
			await runPromise;

			expect(Notice.instances.some((n) => n.message.includes("hidden by the current filter"))).toBe(false);
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});
});


// PR-3 (G1/G2/G3/E1/E2/F3): the real `makeDropZone`/`handleDrop` wiring, driven with dispatched
// `dragover`/`drop`/`dragleave` events and a mocked row rectangle, against a real `ViewsManager` so
// the assertions are on genuine `moveNode`/`placeUnit` results, not a mock that was merely called.
describe("PR-3 — edge-drop row wiring (dragover/drop/dragleave against the real drag handlers)", () => {
	type DropFake = {
		plugin: { viewsManager: ViewsManager; statusesManager?: StatusesManager };
		dragPayload: unknown;
		dropIndicatorEl: HTMLElement | null;
		sortedDropOutlineEl: HTMLElement | null;
		selectedBucketNodeIds: Set<string>;
		selectedInboxRefKeys: Set<string>;
		queueRender: ReturnType<typeof vi.fn>;
		removeUnitsFromView: ReturnType<typeof vi.fn>;
		makeDropZone: (el: HTMLElement, target: unknown, hasBottomZone?: boolean) => void;
	};
	// Every other private method `makeDropZone`'s own closures reach via `this.xxx(...)`
	// (`handleDrop`, `findNodeAnywhere`, `findNodeParent`, `isCycleDrop`, `nodeContainsDescendant`,
	// `showDropIndicator`, `clearDropIndicator`, and PR-4's own `assessDrop`/`batchHasInFolderRow`/
	// `effectiveSortForParent`/`ancestorChainFor`/`isOutsideSourceFolder`/`sortedParentLabel`/
	// `showSortedDropRefusedNotice`/`showSortedDropOutline`/`clearSortedDropOutline`/`resolveRef`)
	// must be assigned onto the fake too -- a closure's captured `this` is whatever `this` was when
	// `makeDropZone` itself was *called* (`fake`, since it's invoked as `fake.makeDropZone(...)`
	// below), not just whichever one property is read here.
	const dragMethodNames = [
		"makeDropZone",
		"handleDrop",
		"findNodeAnywhere",
		"findNodeParent",
		"isCycleDrop",
		"nodeContainsDescendant",
		"showDropIndicator",
		"clearDropIndicator",
		"assessDrop",
		"batchHasInFolderRow",
		"effectiveSortForParent",
		"ancestorChainFor",
		"isOutsideSourceFolder",
		"sortedParentLabel",
		"showSortedDropRefusedNotice",
		"showSortedDropOutline",
		"clearSortedDropOutline",
		"resolveRef",
	] as const;
	const dragProto = AtlasExplorerView.prototype as unknown as Record<(typeof dragMethodNames)[number], (...a: unknown[]) => unknown>;

	function makeDropFake(viewsManager: ViewsManager, statusesManager?: StatusesManager): DropFake {
		const fake: Record<string, unknown> = {
			plugin: { viewsManager, statusesManager },
			dragPayload: null,
			dropIndicatorEl: null,
			sortedDropOutlineEl: null,
			selectedBucketNodeIds: new Set(),
			selectedInboxRefKeys: new Set(),
			queueRender: vi.fn(),
			removeUnitsFromView: vi.fn(),
			// `sortedParentLabel`'s unit branch calls the real `resolveRef`, which needs
			// `this.unitsByRefKey` -- absent here (no test in this PR-3 block exercises a sorted
			// Notice over a unit target), so it's empty rather than wired to a real index.
			unitsByRefKey: new Map(),
		};
		for (const name of dragMethodNames) fake[name] = dragProto[name];
		return fake as unknown as DropFake;
	}

	function makeRow(height = 100): HTMLElement {
		const row = document.createElement("div");
		row.getBoundingClientRect = () =>
			({ top: 0, bottom: height, height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		return row;
	}

	function dragOverAt(row: HTMLElement, clientY: number): void {
		row.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }));
	}

	/** PR-4: `handleDrop`'s refusal path fires `void this.showSortedDropRefusedNotice(...)`
	 * fire-and-forget, and that chain (`showSortedDropRefusedNotice` -> `await
	 * sortedParentLabel(...)`) defers its `new Notice(...)` call to a microtask even for a meta
	 * folder's synchronous label lookup -- any `await`, including one on an already-resolved value,
	 * always defers its continuation. Two drained ticks comfortably clears that one-`await`-deep
	 * chain before a test asserts on `Notice.instances`. */
	async function flushNoticeMicrotasks(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
	}

	function makeVm(root: ViewNode[]): ViewsManager {
		const app = new MockApp() as unknown as App;
		return new ViewsManager(app, [{ id: "v1", name: "Default", inboxMode: "view", root }], "v1", () => {});
	}

	function node(id: string, path: string, children: ViewNode[] = []): ViewNode {
		return { id, type: "unit", ref: { kind: "file", path }, children };
	}

	it("G1/E1: an edge zone (top 25%) shows exactly one indicator line positioned before the row, cleared on drop", () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const vm = makeVm([a, b]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10); // 10% of 100 -> top edge -> "before"
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(Array.from(container.children)).toEqual([fake.dropIndicatorEl, row]);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(fake.dropIndicatorEl).toBeNull();
		// "a" lands as b's sibling right before it, at the bucket root -- no nesting.
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("G1: the indicator line is cleared on dragleave, without a drop", () => {
		const vm = makeVm([node("a", "A.md"), node("b", "B.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 90); // bottom edge -> "after"
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);

		row.dispatchEvent(new Event("dragleave", { bubbles: true }));
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(fake.dropIndicatorEl).toBeNull();
	});

	it("F3/G2: the middle zone shows no line and nests as the target's child, unchanged", () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const vm = makeVm([a, b]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 50); // dead centre -> "nest"
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["b"]);
		expect(root[0].children.map((n) => n.id)).toEqual(["a"]);
	});

	it("G3/G20: a multi-select batch including a selected ancestor's own child lands together, the child travels with its ancestor and isn't placed twice", () => {
		const b = node("b", "B.md");
		const a = node("a", "A.md", [b]);
		const c = node("c", "C.md");
		const d = node("d", "D.md");
		const vm = makeVm([a, c, d]);
		const fake = makeDropFake(vm);
		// Both "a" and its own child "b" are in the drag batch -- "b" must not be moved separately.
		fake.dragPayload = { kind: "node", nodeIds: ["a", "b"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "d", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "d" -> before "d"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["c", "a", "d"]);
		expect(root.find((n) => n.id === "a")!.children.map((n) => n.id)).toEqual(["b"]);
	});

	it("R1/G3: a same-parent batch where a selected row sits above the drop point lands in drag order, not shifted by moveNode's own pre-removal index adjustment", () => {
		// [A,B,C,D,E], select A,B, drop before D -- naively incrementing `index` after each move
		// ignores that moving "a" out from above "d" closes a gap moveNode already compensated for,
		// so the stale running counter puts "b" one slot too far right (C,A,D,B,E instead of C,A,B,D,E).
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), node("d", "D.md"), node("e", "E.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a", "b"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "d", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "d" -> before "d"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["c", "a", "b", "d", "e"]);
	});

	it("R1/G3: a same-parent batch mixing a row from above and a row from below the drop point lands in drag order", () => {
		// [A,B,C,D,E], select A,E, drop before C -- "a" moves up (index decrements), "e" moves down
		// (no decrement); the naive counter also gets this pairing wrong (B,A,C,E,D instead of B,A,E,C,D).
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), node("d", "D.md"), node("e", "E.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a", "e"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "c", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "c" -> before "c"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["b", "a", "e", "c", "d"]);
	});

	it("R1/G3/E1: a same-parent batch already sitting immediately before the drop point nets out unchanged", () => {
		// [A,B,C,D], select B,C, drop before D (B,C are already exactly there, in order) -- the
		// naive counter instead produced A,B,D,C.
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), node("d", "D.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["b", "c"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "d", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "d" -> before "d"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("R1/G3: a mixed-parent batch (one row already a root sibling, one row from inside another folder) lands together in drag order", () => {
		// root [A,B,C,F(children=[X])], select A (root) and X (inside F), drop before C. "a" is a
		// same-parent move (index decrements); "x" is a cross-parent move (no decrement) -- the naive
		// counter, chained off "a"'s pre-adjustment index instead of where "a" actually landed, put
		// "x" after "c" instead of before it.
		const x = node("x", "X.md");
		const f: ViewNode = { id: "f", type: "meta", label: "F", children: [x] };
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), f]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a", "x"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "c", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "c" -> before "c"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["b", "a", "x", "c", "f"]);
		expect(root.find((n) => n.id === "f")!.children).toEqual([]);
	});

	it("E2: dropping on an edge inside the dragged node's own descendants is refused, with no indicator line", () => {
		const b = node("b", "B.md");
		const a = node("a", "A.md", [b]);
		const vm = makeVm([a]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		// "b" is "a"'s own child -- dragging "a" onto "b"'s edge is a cycle.
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true); // falls back to the plain nest highlight

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		// moveNode's own cycle guard refuses it regardless; tree is untouched either way.
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a"]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["b"]);
	});

	it("GP1/GP2: the golden path -- dragging Zebra Census to the top edge of quarry-drones", () => {
		const quarry = node("quarry", "quarry-drones.md");
		const annual = node("annual", "Annual Review.md");
		const projects: ViewNode = { id: "projects", type: "meta", label: "Projects", children: [quarry, annual] };
		const zebra = node("zebra", "Zebra Census.md");
		const vm = makeVm([zebra, projects]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["zebra"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "quarry", viewId: "v1" }, true);

		dragOverAt(row, 5); // GP1: a line appears above quarry-drones
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(Array.from(container.children)).toEqual([fake.dropIndicatorEl, row]);

		row.dispatchEvent(new Event("drop", { bubbles: true })); // GP2
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["projects"]);
		expect(root[0].children.map((n) => n.id)).toEqual(["zebra", "quarry", "annual"]);
	});

	it("rows with no edge zone (bucket-root/inbox-area targets) keep today's behaviour: always a plain nest append, no line", () => {
		const vm = makeVm([node("a", "A.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "New.md" }] };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "bucket-root", viewId: "v1" });

		dragOverAt(row, 10); // bucket-root/inbox-area targets never carry an edge zone
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(vm.getViews()[0].root.map((n) => n.ref?.path)).toEqual(["A.md", "New.md"]);
	});

	it("an inbox drop on an edge places the batch at that position, in order, instead of appending last", () => {
		const vm = makeVm([node("a", "A.md"), node("b", "B.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "X.md" }, { kind: "file", path: "Y.md" }] };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10); // before "b"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.ref?.path)).toEqual(["A.md", "X.md", "Y.md", "B.md"]);
	});

	// PR-4 (G4/G5/G20/G22/E3/E13/E14/GP4/GP5): a target list's own effective sort gates an edge
	// drop -- the plain-nest and cycle-guard behaviour above is completely untouched (all 23 PR-3
	// tests above still pass unmodified), this only changes what happens on an edge once a line
	// would otherwise have appeared.
	function folderNode(id: string, label: string, children: ViewNode[], extra: Partial<ViewNode> = {}): ViewNode {
		return { id, type: "meta", label, children, ...extra };
	}

	it("GP4/G4: an edge drop of a row within its own sorted (A-Z) parent is refused outright -- no line, no outline, no nest highlight, nothing moves, exact Notice text", async () => {
		const annual = node("annual", "Annual Review.md");
		const quarry = node("quarry", "quarry-drones.md");
		const zebra = node("zebra", "Zebra Census.md");
		const projects = folderNode("projects", "Projects", [annual, quarry, zebra], { sortMode: "alphabetical" });
		const vm = makeVm([projects]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["zebra"], viewId: "v1" };
		Notice.reset();

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "quarry", viewId: "v1" }, true);

		dragOverAt(row, 5); // top edge of quarry-drones
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(container.querySelectorAll(".atlas-sorted-drop-outline")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(false);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();
		expect(Notice.instances.map((n) => n.message)).toEqual(["Projects is sorted A-Z. Set it to Manual to reorder."]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["annual", "quarry", "zebra"]); // untouched
	});

	it("GP5: dragging a row from the Inbox over a sorted folder's rows shows no line and outlines the whole list; dropping it lands at the dropped slot (sorted-insert)", () => {
		const annual = node("annual", "Annual Review.md");
		const quarry = node("quarry", "quarry-drones.md");
		const zebra = node("zebra", "Zebra Census.md");
		const projects = folderNode("projects", "Projects", [annual, quarry, zebra], { sortMode: "alphabetical" });
		const vm = makeVm([projects]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "Harbour Notes.md" }] };
		Notice.reset();

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 90); // bottom edge of Annual Review
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(true);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(false);
		expect(Notice.instances).toHaveLength(0);
		expect(vm.getViews()[0].root[0].children.map((n) => n.ref?.path ?? n.label)).toEqual([
			"Annual Review.md",
			"Harbour Notes.md",
			"quarry-drones.md",
			"Zebra Census.md",
		]);
	});

	it("E3: dropping a row from a different folder onto a sorted folder's edge is allowed (different parent, not refused)", () => {
		const x = node("x", "X.md");
		const other = folderNode("other", "Other", [x]);
		const annual = node("annual", "Annual Review.md");
		const projects = folderNode("projects", "Projects", [annual], { sortMode: "alphabetical" });
		const vm = makeVm([projects, other]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["x"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 90); // bottom edge
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(Notice.instances).toHaveLength(0);
		expect(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.map((n) => n.id)).toEqual(["annual", "x"]);
		expect(vm.getViews()[0].root.find((n) => n.id === "other")!.children).toEqual([]);
	});

	it("E13: a batch mixing one of the sorted folder's own children with a row from elsewhere is refused whole -- neither row moves, exactly one Notice", async () => {
		const annual = node("annual", "Annual Review.md");
		const quarry = node("quarry", "quarry-drones.md");
		const projects = folderNode("projects", "Projects", [annual, quarry], { sortMode: "alphabetical" });
		const y = node("y", "Y.md");
		const other = folderNode("other", "Other", [y]);
		const vm = makeVm([projects, other]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["quarry", "y"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 90);
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();

		expect(Notice.instances).toHaveLength(1);
		expect(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.map((n) => n.id)).toEqual(["annual", "quarry"]);
		expect(vm.getViews()[0].root.find((n) => n.id === "other")!.children.map((n) => n.id)).toEqual(["y"]);
	});

	it("a batch made up only of rows from elsewhere lands every row in the sorted folder's (manual, stored) order at the dropped slot", () => {
		const annual = node("annual", "Annual Review.md");
		const quarry = node("quarry", "quarry-drones.md");
		const projects = folderNode("projects", "Projects", [annual, quarry], { sortMode: "alphabetical" });
		const x1 = node("x1", "X1.md");
		const x2 = node("x2", "X2.md");
		const other = folderNode("other", "Other", [x1, x2]);
		const vm = makeVm([projects, other]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["x1", "x2"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 90);
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(Notice.instances).toHaveLength(0);
		expect(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.map((n) => n.id)).toEqual(["annual", "x1", "x2", "quarry"]);
	});

	it("E14: a folder that already sorts by Status refuses an in-folder reorder, Notice names Status / Status, reversed", async () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const projects = folderNode("projects", "Projects", [a, b], { statusEnabled: true, statusSetId: "S", sortMode: "status", sortReverse: true });
		const vm = makeVm([projects]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10);
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();

		expect(Notice.instances.map((n) => n.message)).toEqual(["Projects is sorted Status, reversed. Set it to Manual to reorder."]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("E14: a folder with no sort setting of its own, under a governor whose status sort inherits down (inheritToSubfolders), still refuses an in-folder reorder", async () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const sub = folderNode("sub", "Sub", [a, b]); // no sort setting of its own
		const governor = folderNode("gov", "Gov", [sub], { statusEnabled: true, statusSetId: "S", sortMode: "status", inheritToSubfolders: true });
		const vm = makeVm([governor]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10);
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();

		expect(Notice.instances.map((n) => n.message)).toEqual(["Sub is sorted Status. Set it to Manual to reorder."]);
		expect(vm.getViews()[0].root[0].children[0].children.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("explicit Manual overriding an inherited status sort allows the in-folder reorder, with no Notice", () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const sub = folderNode("sub", "Sub", [a, b], { sortMode: "manual" });
		const governor = folderNode("gov", "Gov", [sub], { statusEnabled: true, statusSetId: "S", sortMode: "status", inheritToSubfolders: true });
		const vm = makeVm([governor]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10);
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(Notice.instances).toHaveLength(0);
		expect(vm.getViews()[0].root[0].children[0].children.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("G4 at the Bucket root: a sorted Bucket root refuses an in-root edge reorder of its own top-level rows, Notice reads \"Bucket is sorted ...\"", async () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const app = new MockApp() as unknown as App;
		const vm = new ViewsManager(app, [{ id: "v1", name: "Default", inboxMode: "view", root: [a, b], sortMode: "alphabetical" }], "v1", () => {});
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10);
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();

		expect(Notice.instances.map((n) => n.message)).toEqual(["Bucket is sorted A-Z. Set it to Manual to reorder."]);
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("G22: the target's effective list being an Outside-Vault source folder behaves exactly as today, regardless of any sortMode configured on it -- no outline, no Notice", () => {
		const m = node("m", "M.md");
		const n2 = node("n", "N.md");
		const outside = folderNode("outside", "Outside", [m, n2], {
			sortMode: "alphabetical",
			folderSource: { location: "outside", path: "", showFiles: true, showFolders: true },
		});
		const vm = makeVm([outside]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["n"], viewId: "v1" };
		Notice.reset();

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "m", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "m" -- today's plain reorder line, sort ignored for this list
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(container.querySelectorAll(".atlas-sorted-drop-outline")).toHaveLength(0);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(Notice.instances).toHaveLength(0);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["n", "m"]);
	});

	it("dragging away from a sorted folder's row without dropping clears the outline, same as the indicator line does", () => {
		const annual = node("annual", "Annual Review.md");
		const projects = folderNode("projects", "Projects", [annual], { sortMode: "alphabetical" });
		const vm = makeVm([projects]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "New.md" }] };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 90);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(true);

		row.dispatchEvent(new Event("dragleave", { bubbles: true }));
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(false);
		expect(fake.sortedDropOutlineEl).toBeNull();
	});

	it("a refused drop leaves the tree, sort settings and selection state completely unchanged (data safety)", async () => {
		const annual = node("annual", "Annual Review.md");
		const quarry = node("quarry", "quarry-drones.md");
		const projects = folderNode("projects", "Projects", [annual, quarry], { sortMode: "alphabetical" });
		const vm = makeVm([projects]);
		const before = JSON.parse(JSON.stringify(vm.getViews()[0].root));
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "node", nodeIds: ["quarry"], viewId: "v1" };
		fake.selectedBucketNodeIds.add("quarry");
		Notice.reset();

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 10);
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		await flushNoticeMicrotasks();

		expect(vm.getViews()[0].root).toEqual(before);
		expect(fake.selectedBucketNodeIds.has("quarry")).toBe(true);
		expect(Notice.instances).toHaveLength(1);
	});

	// PR-4 (T4/T8/C33 fix): the data-safety snapshot above covers only a refused drop. This
	// covers the accepted half: a sorted-insert drop (G5) touches only the dragged unit's own
	// new slot -- every *other* node's own `children`, `sortMode`, `sortReverse` and `placedAt`
	// stay byte-for-byte unchanged (full-tree snapshot compare, same style as the refused-drop
	// test above).
	it("an accepted sorted-insert drop leaves every unrelated node's children, sortMode, sortReverse and placedAt completely unchanged (data safety)", () => {
		const annual = node("annual", "Annual Review.md");
		const quarry = node("quarry", "quarry-drones.md");
		const projects = folderNode("projects", "Projects", [annual, quarry], { sortMode: "alphabetical", sortReverse: true });
		const x = node("x", "X.md", [{ id: "x-child", type: "unit", ref: { kind: "file", path: "XChild.md" }, children: [], placedAt: 42 }]);
		const other = folderNode("other", "Other", [x], { sortMode: "modified" });
		const vm = makeVm([projects, other]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		// "x" (from "other", a different parent) dropped onto the edge of "annual" inside the
		// sorted "projects" list -- a sorted-insert (G5), not a refusal.
		fake.dragPayload = { kind: "node", nodeIds: ["x"], viewId: "v1" };
		Notice.reset();

		// Snapshot every node this drag does NOT touch, before the drop. ("other" itself is the
		// source parent "x" is dragged out of, so its own `children` list is expected to change --
		// that's covered separately below -- but its own sort settings must not.)
		const otherSettingsBefore = { sortMode: other.sortMode, sortReverse: other.sortReverse, placedAt: other.placedAt };
		const annualBefore = JSON.parse(JSON.stringify(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.find((n) => n.id === "annual")));
		const quarryBefore = JSON.parse(JSON.stringify(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.find((n) => n.id === "quarry")));
		const projectsSettingsBefore = {
			sortMode: projects.sortMode,
			sortReverse: projects.sortReverse,
			placedAt: projects.placedAt,
		};

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		dragOverAt(row, 90); // bottom edge of "annual" -- sorted-insert, allowed (different parent)
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(Notice.instances).toHaveLength(0); // not refused
		// "x" actually moved -- confirms this was a real accepted drop, not a silent no-op.
		expect(vm.getViews()[0].root.find((n) => n.id === "other")!.children).toEqual([]);
		expect(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.map((n) => n.id)).toEqual(["annual", "x", "quarry"]);

		// Everything this drag didn't touch is byte-for-byte unchanged.
		const otherAfter = vm.getViews()[0].root.find((n) => n.id === "other")!;
		expect({ sortMode: otherAfter.sortMode, sortReverse: otherAfter.sortReverse, placedAt: otherAfter.placedAt }).toEqual(otherSettingsBefore);
		expect(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.find((n) => n.id === "annual")).toEqual(annualBefore);
		expect(vm.getViews()[0].root.find((n) => n.id === "projects")!.children.find((n) => n.id === "quarry")).toEqual(quarryBefore);
		const projectsAfter = vm.getViews()[0].root.find((n) => n.id === "projects")!;
		expect({ sortMode: projectsAfter.sortMode, sortReverse: projectsAfter.sortReverse, placedAt: projectsAfter.placedAt }).toEqual(
			projectsSettingsBefore
		);
		// The moved node's own sort settings (it has none) and the one grandchild it carried along
		// (its own `placedAt`, untouched by the move) are preserved too.
		const movedX = vm.getViews()[0].root.find((n) => n.id === "projects")!.children.find((n) => n.id === "x")!;
		expect(movedX.children).toEqual([{ id: "x-child", type: "unit", ref: { kind: "file", path: "XChild.md" }, children: [], placedAt: 42 }]);
	});
});
