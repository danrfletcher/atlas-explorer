import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, ViewNode } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";

/** PR-1.F2 integration: the persisted hidden-at-save flag and the render-time filter state, driven
 * through the real `ViewsManager`. Frontmatter comes from a fake `metadataCache` keyed by path. */
type CacheEntry = { frontmatter?: Record<string, unknown> } | null;

const FILES: Record<string, CacheEntry> = {
	"Jobs/acme.md": { frontmatter: { status: "active" } },
	"Jobs/beta.md": { frontmatter: { status: "done" } },
	"Jobs/gamma.md": { frontmatter: { status: "active" } },
	"Jobs/brief.pdf": null,
};

function setup(caches: Record<string, CacheEntry> = FILES) {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	const live = new Map<string, CacheEntry>(Object.entries(caches));
	for (const path of live.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => live.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;
	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	return { app, vm, viewId: vm.getViews()[0].id, live };
}

type Fixture = ReturnType<typeof setup>;

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

/** Adds an unfiltered folder source, refreshes it, and resolves metadata so all four rows exist. */
function addUnfiltered(f: Fixture, mode: FolderSourceConfig["mode"] = "merge"): ViewNode {
	const folder = f.vm.addMetaFolder(f.viewId, null, "Job search")!;
	f.vm.setFolderSource(f.viewId, folder.id, source(mode));
	f.vm.refreshFolderSource(f.viewId, folder.id);
	f.vm.onMetadataResolved();
	return f.vm.getViews()[0].root.find((n) => n.id === folder.id)!;
}

function live(f: Fixture, node: ViewNode): ViewNode {
	return f.vm.getViews()[0].root.find((n) => n.id === node.id)!;
}

function rowFor(f: Fixture, node: ViewNode, path: string): ViewNode {
	const row = live(f, node).children.find((c) => c.ref?.path === path);
	if (!row) throw new Error(`no row for ${path}`);
	return row;
}

function applyRules(f: Fixture, node: ViewNode, mode: FolderSourceConfig["mode"], rules?: YamlFilterRule[]): void {
	f.vm.setFolderSource(f.viewId, node.id, source(mode, rules));
	f.vm.onMetadataResolved();
}

const ACTIVE: YamlFilterRule[] = [{ key: "status", value: "active" }];

describe("G4: hidden-at-save is set only for non-matching rows when rules change", () => {
	it("merge: non-matching rows (including the PDF) are flagged, matching rows are not", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);
		expect(rowFor(f, node, "Jobs/beta.md").folderSourceHiddenAtSave).toBe(true);
		expect(rowFor(f, node, "Jobs/brief.pdf").folderSourceHiddenAtSave).toBe(true);
		expect(rowFor(f, node, "Jobs/acme.md").folderSourceHiddenAtSave).toBeUndefined();
		expect(rowFor(f, node, "Jobs/gamma.md").folderSourceHiddenAtSave).toBeUndefined();
	});

	it("append: no row is flagged, because append never hides rows", () => {
		const f = setup();
		const node = addUnfiltered(f, "append");
		applyRules(f, node, "append", ACTIVE);
		for (const row of live(f, node).children) expect(row.folderSourceHiddenAtSave).toBeUndefined();
	});

	it("overwrite: non-matching rows are flagged, the same as merge", () => {
		const f = setup();
		const node = addUnfiltered(f, "overwrite");
		applyRules(f, node, "overwrite", ACTIVE);
		expect(rowFor(f, node, "Jobs/beta.md").folderSourceHiddenAtSave).toBe(true);
	});
});

describe("G4: a flag is cleared when its row starts to match, and all flags clear when rules are removed", () => {
	it("changing the rule to match beta clears beta's flag and sets acme's", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);
		applyRules(f, node, "merge", [{ key: "status", value: "done" }]);
		expect(rowFor(f, node, "Jobs/beta.md").folderSourceHiddenAtSave).toBeUndefined();
		expect(rowFor(f, node, "Jobs/acme.md").folderSourceHiddenAtSave).toBe(true);
	});

	it("removing all rules clears every flag", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);
		applyRules(f, node, "merge", undefined);
		for (const row of live(f, node).children) expect(row.folderSourceHiddenAtSave).toBeUndefined();
	});
});

describe("G5/G6: a row that stops matching on a metadata change drops out on resolve, and later resolves never add files", () => {
	it("acme's frontmatter edit drops it out as filtered out, with nothing persisted", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);
		f.live.set("Jobs/acme.md", { frontmatter: { status: "done" } });
		f.vm.onMetadataResolved();
		// A live drop-out is derived at render time, so nothing is persisted for it.
		expect(rowFor(f, node, "Jobs/acme.md").folderSourceHiddenAtSave).toBeUndefined();
		expect(f.vm.managedRowFilterState(f.viewId, rowFor(f, node, "Jobs/acme.md"))).toBe("filteredOut");
	});

	it("a later resolve does not add new non-matching files as rows", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);
		f.app.vault.seedFile("Jobs/delta.md");
		f.live.set("Jobs/delta.md", { frontmatter: { status: "done" } });
		f.vm.onMetadataResolved();
		expect(live(f, node).children.map((c) => c.ref?.path)).not.toContain("Jobs/delta.md");
	});
});

describe("G7: a removed filtered-out row is not re-added until it matches", () => {
	it("removing beta (filtered out) and resolving again does not bring it back", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);
		f.vm.unplaceNode(f.viewId, rowFor(f, node, "Jobs/beta.md").id);
		f.vm.onMetadataResolved();
		expect(live(f, node).children.map((c) => c.ref?.path)).not.toContain("Jobs/beta.md");
	});
});

describe("G4: the flag survives a save and reload", () => {
	it("round-trips through JSON and still reports the row as hidden", () => {
		const f = setup();
		const node = addUnfiltered(f, "merge");
		applyRules(f, node, "merge", ACTIVE);

		const reloaded = JSON.parse(JSON.stringify(f.vm.getViews())) as ReturnType<ViewsManager["getViews"]>;
		const vm2 = new ViewsManager(f.app as unknown as App, reloaded, "", () => {});
		vm2.onMetadataResolved();
		const node2 = vm2.getViews()[0].root.find((n) => n.id === node.id)!;
		const beta = node2.children.find((c) => c.ref?.path === "Jobs/beta.md")!;
		expect(beta.folderSourceHiddenAtSave).toBe(true);
		expect(vm2.managedRowFilterState(f.viewId, beta)).toBe("hidden");
	});
});
