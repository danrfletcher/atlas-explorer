import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, ViewNode } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { callRenderNodeList, makeFakeExplorer, makeStatusesManager, proto } from "../unit/explorer-view-sort-truncate-helpers";

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
