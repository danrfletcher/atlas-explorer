import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, CsvSourceConfig, FolderSourceConfig, MarkdownTableSourceConfig, ViewNode, createEmptyView, unitRefKey } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";

/** PR-1.S1 integration: a Folder source with YAML file rules, reconciled through the real
 * `ViewsManager`. Frontmatter comes from a fake `metadataCache` keyed by path. A `null` entry means the
 * cache has nothing for that file, and `{}` means a cache entry with no `frontmatter` key. */
type CacheEntry = { frontmatter?: Record<string, unknown> } | null;

interface Fixture {
	app: MockApp;
	vm: ViewsManager;
	viewId: string;
	caches: Map<string, CacheEntry>;
	lookups: string[];
}

function setup(files: Record<string, CacheEntry>): Fixture {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	const caches = new Map<string, CacheEntry>(Object.entries(files));
	const lookups: string[] = [];
	for (const path of caches.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => {
		lookups.push(file.path);
		return caches.get(file.path) ?? null;
	}) as unknown as typeof app.metadataCache.getFileCache;
	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	return { app, vm, viewId: vm.getViews()[0].id, caches, lookups };
}

function addSource(f: Fixture, label: string, rules?: YamlFilterRule[], mode: FolderSourceConfig["mode"] = "merge"): ViewNode {
	const folder = f.vm.addMetaFolder(f.viewId, null, label)!;
	const source: FolderSourceConfig = {
		type: "folder",
		location: "inside",
		path: "Jobs",
		showFiles: true,
		showFolders: false,
		refreshOnViewLoad: false,
		mode,
		...(rules ? { filters: { files: { yaml: { rules } } } } : {}),
	};
	f.vm.setFolderSource(f.viewId, folder.id, source);
	return f.vm.getViews()[0].root.find((n) => n.id === folder.id)!;
}

function rowPaths(f: Fixture, node: ViewNode): string[] {
	const live = f.vm.getViews()[0].root.find((n) => n.id === node.id)!;
	return live.children.map((child) => child.ref?.path ?? "").sort();
}

function refresh(f: Fixture, node: ViewNode): void {
	f.vm.refreshFolderSource(f.viewId, node.id);
}

const GP1_FILES: Record<string, CacheEntry> = {
	"Jobs/acme.md": { frontmatter: { status: "active" } },
	"Jobs/beta.md": { frontmatter: { status: "done" } },
	"Jobs/gamma.md": { frontmatter: { Status: "Active", company: "[[Gamma Ltd]]" } },
	"Jobs/brief.pdf": null,
};

describe("GP2: unfiltered baseline", () => {
	it("lists all four files exactly as before", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search");
		refresh(f, node);
		expect(rowPaths(f, node)).toEqual(["Jobs/acme.md", "Jobs/beta.md", "Jobs/brief.pdf", "Jobs/gamma.md"]);
	});
});

describe("GP1: rule status = active", () => {
	it("selects acme and gamma only, and brief.pdf fails", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search", [{ key: "status", value: "active" }]);
		refresh(f, node);
		f.vm.onMetadataResolved();
		expect(rowPaths(f, node)).toEqual(["Jobs/acme.md", "Jobs/gamma.md"]);
	});

	it("company = Gamma Ltd selects gamma via the link form", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search", [{ key: "company", value: "Gamma Ltd" }]);
		f.vm.onMetadataResolved();
		expect(rowPaths(f, node)).toEqual(["Jobs/gamma.md"]);
	});
});

describe("E10: files are held back until metadataCache has resolved", () => {
	it("produces no rows before resolved, then evaluates and shows them on resolved", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search", [{ key: "status", value: "active" }]);
		refresh(f, node);
		expect(rowPaths(f, node)).toEqual([]);

		f.vm.onMetadataResolved();
		expect(rowPaths(f, node)).toEqual(["Jobs/acme.md", "Jobs/gamma.md"]);
	});

	it("an unfiltered source is not held back", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search");
		refresh(f, node);
		expect(rowPaths(f, node)).toHaveLength(4);
	});
});

describe("G8: a new file joins on the next refresh only if it matches", () => {
	it("a new non-matching file is skipped, and a new matching file joins", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search", [{ key: "status", value: "active" }]);
		f.vm.onMetadataResolved();
		expect(rowPaths(f, node)).toEqual(["Jobs/acme.md", "Jobs/gamma.md"]);

		f.app.vault.seedFile("Jobs/delta.md");
		f.caches.set("Jobs/delta.md", { frontmatter: { status: "done" } });
		refresh(f, node);
		expect(rowPaths(f, node)).not.toContain("Jobs/delta.md");

		f.app.vault.seedFile("Jobs/zeta.md");
		f.caches.set("Jobs/zeta.md", { frontmatter: { status: "active" } });
		refresh(f, node);
		expect(rowPaths(f, node)).toContain("Jobs/zeta.md");
	});

	it("a later resolved event does not pull in new files (no live arrival)", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search", [{ key: "status", value: "active" }]);
		f.vm.onMetadataResolved();
		f.app.vault.seedFile("Jobs/zeta.md");
		f.caches.set("Jobs/zeta.md", { frontmatter: { status: "active" } });
		f.vm.onMetadataResolved();
		expect(rowPaths(f, node)).not.toContain("Jobs/zeta.md");
	});

	it("a file whose cache entry has no frontmatter key does not join", () => {
		const f = setup({ ...GP1_FILES, "Jobs/body-only.md": {} });
		const node = addSource(f, "Job search", [{ key: "status", value: "" }]);
		f.vm.onMetadataResolved();
		expect(rowPaths(f, node)).not.toContain("Jobs/body-only.md");
	});
});

describe("E3: a renamed note keeps its managed row, and the filter is recomputed on the new path", () => {
	it("keeps the row id and looks the new path up in the cache", async () => {
		const f = setup(GP1_FILES);
		f.caches.set("Jobs/acme-renamed.md", { frontmatter: { status: "active" } });
		const node = addSource(f, "Job search", [{ key: "status", value: "active" }]);
		f.vm.onMetadataResolved();
		const before = f.vm.getViews()[0].root.find((n) => n.id === node.id)!.children.find((c) => c.ref?.path === "Jobs/acme.md")!;

		const acme = f.app.vault.getAbstractFileByPath("Jobs/acme.md") as TFile;
		await f.app.vault.rename(acme, "Jobs/acme-renamed.md");
		f.vm.onVaultRename("Jobs/acme.md", "Jobs/acme-renamed.md");
		f.lookups.length = 0;
		refresh(f, node);

		const live = f.vm.getViews()[0].root.find((n) => n.id === node.id)!;
		const after = live.children.find((c) => c.ref?.path === "Jobs/acme-renamed.md")!;
		expect(after.id).toBe(before.id);
		expect(f.lookups).toContain("Jobs/acme-renamed.md");
	});
});

describe("E7: two Folder sources on the same folder evaluate independently", () => {
	it("a file matched by one and not the other appears only under the first", () => {
		const f = setup(GP1_FILES);
		const active = addSource(f, "Active", [{ key: "status", value: "active" }]);
		const done = addSource(f, "Done", [{ key: "status", value: "done" }]);
		f.vm.onMetadataResolved();
		expect(rowPaths(f, active)).toEqual(["Jobs/acme.md", "Jobs/gamma.md"]);
		expect(rowPaths(f, done)).toEqual(["Jobs/beta.md"]);
	});
});

describe("F4: filtering never writes removedRefs and leaves existing rows intact", () => {
	it("a non-matching existing row keeps its id, status, children and position, and removedRefs is unchanged", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search");
		refresh(f, node);

		const live = () => f.vm.getViews()[0].root.find((n) => n.id === node.id)!;
		live().folderSource!.removedRefs = [unitRefKey({ kind: "file", path: "Jobs/ghost.md" })];
		const removedBefore = JSON.stringify(live().folderSource!.removedRefs);

		const beta = live().children.find((c) => c.ref?.path === "Jobs/beta.md")!;
		beta.explicitStatusId = "status-in-progress";
		beta.position = 3;
		beta.children.push({ id: "nested-1", type: "meta", label: "Nested", children: [] });
		const betaSnapshot = JSON.stringify(beta);

		f.vm.setFolderSource(f.viewId, node.id, { ...live().folderSource!, filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } } });
		f.vm.onMetadataResolved();
		refresh(f, node);

		expect(JSON.stringify(live().folderSource!.removedRefs)).toBe(removedBefore);
		const betaAfter = live().children.find((c) => c.ref?.path === "Jobs/beta.md")!;
		expect(JSON.stringify(betaAfter)).toBe(betaSnapshot);
		expect(betaAfter.id).toBe(beta.id);
	});

	it("a filtered reconcile that drops nothing adds no removedRefs entries", () => {
		const f = setup(GP1_FILES);
		const node = addSource(f, "Job search", [{ key: "status", value: "active" }]);
		f.vm.onMetadataResolved();
		expect(f.vm.getViews()[0].root.find((n) => n.id === node.id)!.folderSource!.removedRefs).toBeUndefined();
	});
});

const API_SOURCE: ApiSourceConfig = {
	url: "https://api.example.com/items",
	method: "GET",
	mapping: { idField: "id", labelField: "name" },
	mode: "merge",
	refreshOnViewLoad: false,
	refreshEveryMinutesEnabled: false,
};

const CSV_SOURCE: CsvSourceConfig = {
	path: "Data/items.csv",
	mapping: { idField: "id", labelField: "name" },
	mode: "append",
	refreshOnViewLoad: false,
};

const TABLE_SOURCE: MarkdownTableSourceConfig = {
	path: "Data/tables.md",
	tableIndex: 0,
	mapping: { idField: "id", labelField: "name" },
	mode: "overwrite",
	refreshOnViewLoad: false,
};

/** A single meta node carrying one non-Folder source, loaded through the real `ViewsManager` constructor. */
function viewWithNode(node: Partial<ViewNode>): ViewManagerFixture {
	const view = createEmptyView("v1", "View");
	view.root.push({ id: "n1", type: "meta", label: "Data", children: [], ...node } as ViewNode);
	const vm = new ViewsManager({} as App, [view], "v1", () => {});
	return { vm, node: vm.getViews()[0].root[0] };
}

interface ViewManagerFixture {
	vm: ViewsManager;
	node: ViewNode;
}

describe("F6: API, Markdown Table and CSV source configs are untouched by sanitize and duplicate", () => {
	it("sanitize (on load) keeps every saved field of each source config and adds no filters key", () => {
		const cases = [
			["apiSource", API_SOURCE],
			["csvSource", CSV_SOURCE],
			["markdownTableSource", TABLE_SOURCE],
		] as const;
		for (const [key, source] of cases) {
			const loaded = viewWithNode({ [key]: source }).node[key] as unknown as Record<string, unknown>;
			// `toMatchObject` rather than `toEqual`: sanitize fills in defaults (e.g. `type`), but must not drop or change a saved field.
			expect(loaded).toMatchObject(source);
			expect("filters" in loaded).toBe(false);
		}
	});

	it("duplicate copies each source config equal to the original, with no shared reference and no filters key", () => {
		for (const key of ["apiSource", "csvSource", "markdownTableSource"] as const) {
			const source = key === "apiSource" ? API_SOURCE : key === "csvSource" ? CSV_SOURCE : TABLE_SOURCE;
			const { vm, node } = viewWithNode({ [key]: source });
			const clone = vm.duplicateNode("v1", node.id)!;
			const original = node[key] as unknown as Record<string, unknown>;
			const copy = clone[key] as unknown as Record<string, unknown>;
			expect(copy).toEqual(original);
			expect(copy).not.toBe(original);
			expect("filters" in copy).toBe(false);
		}
	});
});

describe("F6: reconcileFolderSourceChildDelete behaves identically for filtered and unfiltered Folder sources", () => {
	/** The placeholder rows a delete leaves on the owning Folder node, minus the generated child id and
	 * the wall-clock `lastSeenAt`, which differ between any two runs. */
	function placeholders(f: Fixture, node: ViewNode): Record<string, unknown>[] {
		const owner = f.vm.getNode(f.viewId, node.id)!;
		return Object.values(owner.apiItemState ?? {}).map(({ id: _id, lastSeenAt: _seen, ...rest }) => rest);
	}

	it.each(["merge", "append", "overwrite"] as const)("mode=%s: deleting a matching file leaves the same placeholder with or without rules", (mode) => {
		const unfiltered = setup(GP1_FILES);
		const unfilteredNode = addSource(unfiltered, "Job search", undefined, mode);
		refresh(unfiltered, unfilteredNode);
		unfiltered.vm.onMetadataResolved();

		const filtered = setup(GP1_FILES);
		const filteredNode = addSource(filtered, "Job search", [{ key: "status", value: "active" }], mode);
		refresh(filtered, filteredNode);
		filtered.vm.onMetadataResolved();

		unfiltered.vm.onVaultDelete("Jobs/acme.md");
		filtered.vm.onVaultDelete("Jobs/acme.md");

		expect(rowPaths(filtered, filteredNode)).not.toContain("Jobs/acme.md");
		expect(rowPaths(unfiltered, unfilteredNode)).not.toContain("Jobs/acme.md");
		expect(placeholders(filtered, filteredNode)).toEqual(placeholders(unfiltered, unfilteredNode));
		// Guard against a vacuous pass: merge and append keep a placeholder, overwrite keeps none (G14).
		expect(placeholders(filtered, filteredNode)).toHaveLength(mode === "overwrite" ? 0 : 1);
	});
});
