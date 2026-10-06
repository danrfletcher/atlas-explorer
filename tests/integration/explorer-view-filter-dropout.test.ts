import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderRowFilterState } from "../../src/folder-filter";
import { FolderSourceConfig, View, ViewNode } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { callRenderNodeList, makeFakeExplorer, makeStatusesManager, rowOrder } from "../unit/explorer-view-sort-truncate-helpers";

/** PR-1.F2 integration, table-driven: mode (merge, append, overwrite) × cause (hidden at save,
* live drop-out) × event (drop, re-match, Remove, mode switch). Each case runs the real `ViewsManager`
* and the real `renderNodeList` pass, so the rendered rows come from the same state the explorer reads.
*
* Shape of every case: a Folder `Job search` on `Jobs/` holds `acme` (subject S for live drop-out),
* `beta` (subject S for hidden at save) and `gamma`. `gamma` is always nested under S. The rules are
* `status = active`. A rendered `S` means the subject row is listed, and a rendered `C` means only its
* child is listed, so the child was lifted one level because S is hidden. */

type Mode = FolderSourceConfig["mode"];
type Cause = "hidden-at-save" | "live-drop-out";
type Rendered = "S" | "C";

const MODES: Mode[] = ["merge", "append", "overwrite"];
const CAUSES: Cause[] = ["hidden-at-save", "live-drop-out"];
const RULES: YamlFilterRule[] = [{ key: "status", value: "active" }];

/** The expected state and render of the subject just after the drop, per mode and cause. */
const DROP: Record<Mode, Record<Cause, { state: FolderRowFilterState; rendered: Rendered }>> = {
	merge: {
		"live-drop-out": { state: "filteredOut", rendered: "S" },
		"hidden-at-save": { state: "hidden", rendered: "C" },
	},
	append: {
		"live-drop-out": { state: "shown", rendered: "S" },
		"hidden-at-save": { state: "shown", rendered: "S" },
	},
	overwrite: {
		"live-drop-out": { state: "hidden", rendered: "C" },
		"hidden-at-save": { state: "hidden", rendered: "C" },
	},
};

type CacheEntry = { frontmatter?: Record<string, unknown> } | null;

interface Ctx {
	app: MockApp;
	cache: Map<string, CacheEntry>;
	vm: ViewsManager;
	viewId: string;
	folderId: string;
	subjectId: string;
	childId: string;
	subjectPath: string;
	fake: ReturnType<typeof makeFakeExplorer>;
}

function source(mode: Mode, rules?: YamlFilterRule[]): FolderSourceConfig {
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

function findNode(nodes: ViewNode[], id: string): ViewNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		const found = findNode(node.children, id);
		if (found) return found;
	}
	return undefined;
}

function setup(mode: Mode, cause: Cause): Ctx {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	const cache = new Map<string, CacheEntry>([
		["Jobs/acme.md", { frontmatter: { status: "active" } }],
		["Jobs/beta.md", { frontmatter: { status: "done" } }],
		["Jobs/gamma.md", { frontmatter: { status: "active" } }],
	]);
	for (const path of cache.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => cache.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;

	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const viewId = vm.getViews()[0].id;
	const folder = vm.addMetaFolder(viewId, null, "Job search")!;
	vm.setFolderSource(viewId, folder.id, source(mode));
	vm.refreshFolderSource(viewId, folder.id);
	vm.onMetadataResolved();

	const top = vm.getViews()[0].root;
	const subjectPath = cause === "live-drop-out" ? "Jobs/acme.md" : "Jobs/beta.md";
	const subjectId = top.find((n) => n.id === folder.id)!.children.find((c) => c.ref?.path === subjectPath)!.id;
	const childId = top.find((n) => n.id === folder.id)!.children.find((c) => c.ref?.path === "Jobs/gamma.md")!.id;

	const sm = makeStatusesManager();
	const fake = makeFakeExplorer(sm, {
		plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: vm } as never,
	});
	Object.assign(fake, { selectedBucketNodeIds: new Set<string>() });

	return { app, cache, vm, viewId, folderId: folder.id, subjectId, childId, subjectPath, fake };
}

const folderOf = (c: Ctx): ViewNode => findNode(c.vm.getViews()[0].root, c.folderId)!;
const nodeOf = (c: Ctx, id: string): ViewNode => findNode(c.vm.getViews()[0].root, id)!;
const subjectOf = (c: Ctx): ViewNode => nodeOf(c, c.subjectId);
const childOf = (c: Ctx): ViewNode => nodeOf(c, c.childId);
const sourceOf = (c: Ctx): FolderSourceConfig => folderOf(c).folderSource!;

/** The rendered order of the folder's rows, the same list `renderNodeList` builds in the explorer, kept
* to the subject and its child. The other top-level row (`beta` or `acme`) is not under test here. */
async function rendered(c: Ctx): Promise<string[]> {
	const container = document.createElement("div");
	await callRenderNodeList(c.fake, folderOf(c).children, container, c.vm.getViews()[0] as View, 1, [folderOf(c)], undefined);
	return rowOrder(container).filter((id) => id === c.subjectId || id === c.childId);
}

const expectRendered = async (c: Ctx, which: Rendered): Promise<void> => {
	expect(await rendered(c)).toEqual([which === "S" ? c.subjectId : c.childId]);
};

/** Nests the child under the subject, gives the subject a status, and records the pre-drop position. */
function nestAndStatus(c: Ctx): { status: string | undefined; index: number; childIds: string[] } {
	c.vm.moveNode(c.viewId, c.childId, c.subjectId, 0);
	c.vm.setExplicitStatus(c.viewId, c.subjectId, "doing");
	return snapshot(c);
}

function snapshot(c: Ctx): { status: string | undefined; index: number; childIds: string[] } {
	const subject = subjectOf(c);
	return {
		status: subject.explicitStatusId,
		index: folderOf(c).children.indexOf(subject),
		childIds: subject.children.map((child) => child.id),
	};
}

/** Puts the subject into the cause's starting state, after the rules are saved for a hidden-at-save
* drop, or after the frontmatter edit for a live drop-out. Returns the snapshot taken before the drop. */
function drop(c: Ctx, mode: Mode, cause: Cause): { status: string | undefined; index: number; childIds: string[] } {
	const before = nestAndStatus(c);
	if (cause === "hidden-at-save") {
		c.vm.setFolderSource(c.viewId, c.folderId, source(mode, RULES));
		c.vm.onMetadataResolved();
	} else {
		c.vm.setFolderSource(c.viewId, c.folderId, source(mode, RULES));
		c.vm.onMetadataResolved();
		c.cache.set(c.subjectPath, { frontmatter: { status: "done" } });
		c.vm.onMetadataResolved();
	}
	return before;
}

describe("G4/G5 — the drop, per mode and cause", () => {
	for (const mode of MODES) {
		for (const cause of CAUSES) {
			it(`${mode} × ${cause}: the subject is ${DROP[mode][cause].state} and renders as ${DROP[mode][cause].rendered}`, async () => {
				const c = setup(mode, cause);
				drop(c, mode, cause);
				expect(c.vm.managedRowFilterState(c.viewId, subjectOf(c))).toBe(DROP[mode][cause].state);
				await expectRendered(c, DROP[mode][cause].rendered);
				// F4: filtering never writes removedRefs, and never clears the subject's status or nesting.
				expect(sourceOf(c).removedRefs ?? []).toEqual([]);
				expect(subjectOf(c).explicitStatusId).toBe("doing");
				expect(subjectOf(c).children.map((x) => x.id)).toEqual([c.childId]);
			});
		}
	}

	it("E6: a merge filtered-out row keeps its child nested under it", () => {
		const c = setup("merge", "live-drop-out");
		drop(c, "merge", "live-drop-out");
		expect(subjectOf(c).children.map((x) => x.id)).toEqual([c.childId]);
	});

	it("append: a live drop-out is unchanged, and a new non-matching file is never added", async () => {
		const c = setup("append", "live-drop-out");
		drop(c, "append", "live-drop-out");
		c.app.vault.seedFile("Jobs/delta.md");
		c.cache.set("Jobs/delta.md", { frontmatter: { status: "done" } });
		c.vm.refreshFolderSource(c.viewId, c.folderId);
		c.vm.onMetadataResolved();
		expect(folderOf(c).children.map((x) => x.ref?.path)).not.toContain("Jobs/delta.md");
		await expectRendered(c, "S");
	});
});

describe("G6 — re-match restores status, position and nesting exactly", () => {
	for (const mode of MODES) {
		for (const cause of CAUSES) {
			it(`${mode} × ${cause}: the subject returns as it was`, async () => {
				const c = setup(mode, cause);
				const before = drop(c, mode, cause);
				c.cache.set(c.subjectPath, { frontmatter: { status: "active" } });
				c.vm.onMetadataResolved();
				expect(c.vm.managedRowFilterState(c.viewId, subjectOf(c))).toBe("shown");
				expect(snapshot(c)).toEqual(before);
				await expectRendered(c, "S");
				// A hidden-at-save row clears its flag once it matches, so nothing is left to show or hide.
				expect(subjectOf(c).folderSourceHiddenAtSave).toBeUndefined();
				expect(sourceOf(c).removedRefs ?? []).toEqual([]);
			});
		}
	}
});

describe("G7 — Remove on a filtered-out row lifts its children, writes no removedRefs, and does not block a re-match", () => {
	it("merge × live-drop-out: Remove drops the row, gamma lifts into its slot, and nothing is remembered", async () => {
		const c = setup("merge", "live-drop-out");
		drop(c, "merge", "live-drop-out");
		c.vm.unplaceNode(c.viewId, c.subjectId);
		expect(folderOf(c).children.map((x) => x.id)).toContain(c.childId);
		expect(findNode(c.vm.getViews()[0].root, c.subjectId)).toBeUndefined();
		expect(sourceOf(c).removedRefs ?? []).toEqual([]);
		await expectRendered(c, "C");
	});

	it("merge × live-drop-out: while the file still does not match, a refresh does not bring it back", async () => {
		const c = setup("merge", "live-drop-out");
		drop(c, "merge", "live-drop-out");
		c.vm.unplaceNode(c.viewId, c.subjectId);
		c.vm.refreshFolderSource(c.viewId, c.folderId);
		expect(folderOf(c).children.map((x) => x.ref?.path)).not.toContain("Jobs/acme.md");
	});

	it("merge × live-drop-out: once it matches again, the next refresh returns it as a fresh row at the end", () => {
		const c = setup("merge", "live-drop-out");
		drop(c, "merge", "live-drop-out");
		c.vm.unplaceNode(c.viewId, c.subjectId);
		c.cache.set(c.subjectPath, { frontmatter: { status: "active" } });
		c.vm.refreshFolderSource(c.viewId, c.folderId);
		const last = folderOf(c).children[folderOf(c).children.length - 1];
		expect(last.ref?.path).toBe(c.subjectPath);
		expect(last.explicitStatusId).toBeUndefined();
		expect(last.children).toEqual([]);
	});
});

describe("E11 — a mode switch applies on the next render", () => {
	it("merge → overwrite → append → merge, from a live drop-out", async () => {
		const c = setup("merge", "live-drop-out");
		drop(c, "merge", "live-drop-out");
		c.vm.setFolderSource(c.viewId, c.folderId, source("overwrite", RULES));
		expect(c.vm.managedRowFilterState(c.viewId, subjectOf(c))).toBe("hidden");
		await expectRendered(c, "C");
		c.vm.setFolderSource(c.viewId, c.folderId, source("append", RULES));
		await expectRendered(c, "S");
		// A live drop-out has no flag, so going back to merge shows it greyed as filtered out again.
		c.vm.setFolderSource(c.viewId, c.folderId, source("merge", RULES));
		expect(c.vm.managedRowFilterState(c.viewId, subjectOf(c))).toBe("filteredOut");
		await expectRendered(c, "S");
	});

	it("merge → overwrite → merge → append, from a hidden-at-save row: the flag keeps it hidden in merge", async () => {
		const c = setup("merge", "hidden-at-save");
		drop(c, "merge", "hidden-at-save");
		c.vm.setFolderSource(c.viewId, c.folderId, source("overwrite", RULES));
		await expectRendered(c, "C");
		// Overwrite to merge keeps a hidden-at-save row hidden: it is not shown as filtered out.
		c.vm.setFolderSource(c.viewId, c.folderId, source("merge", RULES));
		expect(c.vm.managedRowFilterState(c.viewId, subjectOf(c))).toBe("hidden");
		await expectRendered(c, "C");
		// Merge to append makes it a normal row.
		c.vm.setFolderSource(c.viewId, c.folderId, source("append", RULES));
		await expectRendered(c, "S");
	});
});
