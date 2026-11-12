import type { App, TAbstractFile, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App as MockApp } from "../mocks/obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { ApiItemState, PLACEHOLDER_ROW_KIND, UnitRef, View, unitRefKey, unitToRef } from "../../src/types";
import { openRepaintRig, RepaintRig } from "./repaint-rig";

function item(overrides: Partial<ApiItemState> & { id: string }): ApiItemState {
	return { label: overrides.id, kind: PLACEHOLDER_ROW_KIND, ...overrides };
}

function makeViewsManager() {
	return new ViewsManager({} as App, [], "", () => {});
}

describe("G27 — onVaultDelete integration: clearing noteRef across a realistic tree", () => {
	it("a delete clears the matching noteRef without disturbing unrelated rows, cache, or source config", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = {
			"1": item({ id: "1", label: "One", noteRef: { kind: "file", path: "Note.md" } }),
			"2": item({ id: "2", label: "Two", explicitStatusId: "done" }),
		};
		node.apiItemOrder = ["1", "2"];
		node.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false };

		vm.onVaultDelete("Note.md");

		const result = vm.getNode(view.id, folder.id)!;
		expect(result.apiItemState!["1"].noteRef).toBeUndefined();
		expect(result.apiItemState!["1"].label).toBe("One");
		expect(result.apiItemState!["2"]).toEqual(item({ id: "2", label: "Two", explicitStatusId: "done" }));
		expect(result.apiCache).toEqual({ fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false });
	});

	it("a rename followed by a stale delete at the old path leaves the already-rewritten noteRef untouched", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": item({ id: "1", noteRef: { kind: "file", path: "Old.md" } }) };
		node.apiItemOrder = ["1"];

		// Rename fires first (e.g. a move), rewriting the live reference away from "Old.md" before a
		// delete event for the old path "Old.md" (e.g. from a watcher that queued both) is processed.
		vm.onVaultRename("Old.md", "New.md");
		vm.onVaultDelete("Old.md");

		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "New.md" });
	});

	it("sequencing: onVaultDelete for an unrelated path never interferes with onVaultRename's own exact/prefix rewriting", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = {
			"1": item({ id: "1", noteRef: { kind: "file", path: "Pool/Old.md" } }),
			"2": item({ id: "2", noteRef: { kind: "file", path: "Unrelated.md" } }),
		};
		node.apiItemOrder = ["1", "2"];

		vm.onVaultDelete("Totally/Different.md");
		vm.onVaultRename("Pool", "Renamed pool");

		const result = vm.getNode(view.id, folder.id)!;
		expect(result.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Renamed pool/Old.md" });
		expect(result.apiItemState!["2"].noteRef).toEqual({ kind: "file", path: "Unrelated.md" });
	});

	it("G26 + G28 sequencing: Remove attachment then Remove leaves no trace of the row", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": item({ id: "1", notFound: true, noteRef: { kind: "file", path: "Note.md" } }) };
		node.apiItemOrder = ["1"];

		vm.clearApiItemNoteRef(view.id, folder.id, "1");
		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toBeUndefined();

		vm.removeApiItem(view.id, folder.id, "1");
		expect(vm.getNode(view.id, folder.id)!.apiItemState).toEqual({});
		expect(vm.getNode(view.id, folder.id)!.apiItemOrder).toEqual([]);
	});

	it("G26 then G28 in the other order: Remove already deletes the entry, so a later Remove attachment on the same id is a no-op", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": item({ id: "1", notFound: true, noteRef: { kind: "file", path: "Note.md" } }) };
		node.apiItemOrder = ["1"];

		vm.removeApiItem(view.id, folder.id, "1");
		vm.clearApiItemNoteRef(view.id, folder.id, "1");

		expect(vm.getNode(view.id, folder.id)!.apiItemState).toEqual({});
	});
});

// Atlas #13 PR-1 (E4/F1/F6): the explorer decides a placed file's row from live vault presence, so it
// must repaint when a file that is NOT an Atlas unit is deleted or recreated. Wired like the plugin:
// vault events -> UnitIndex / ViewsManager, and the real `AtlasExplorerView.onOpen` subscriptions.
describe("Atlas #13 PR-1 — vault events repaint a placed non-unit file's row", () => {
	const MOVED = "FDE Play/Responsibilities.md";
	type Info = { text: string; missing: boolean };

	function wire(viewsData: View[] = [], seedMoved = true) {
		const app = new MockApp();
		app.vault.seedFolder("FDE Play");
		if (seedMoved) app.vault.seedFile(MOVED);
		const unitIndex = new UnitIndex(app as unknown as App, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		unitIndex.rebuild();
		const persisted: string[] = [];
		const views = new ViewsManager(app as unknown as App, viewsData, "", () => persisted.push("save"));
		app.vault.on("create", (f: TAbstractFile) => unitIndex.onVaultCreate(f));
		app.vault.on("delete", (f: TAbstractFile) => {
			unitIndex.onVaultDelete(f.path);
			views.onVaultDelete(f.path);
		});
		app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
			unitIndex.onVaultRename(f, oldPath);
			views.onVaultRename(oldPath, f.path);
		});
		return { app, unitIndex, views, persisted };
	}

	/** The real `onOpen`, run against a fake `this` whose plugin is the real index and views manager. */
	async function openExplorer(w: ReturnType<typeof wire>) {
		const proto = AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
		const render = vi.fn(async () => {});
		const fake: Record<string, unknown> = {
			plugin: { app: { workspace: { on: vi.fn(() => ({})) } }, unitIndex: w.unitIndex, viewsManager: w.views },
			unsubscribers: [] as Array<() => void>,
			renderQueued: false,
			sortRefreshGate: { markDirty: vi.fn() },
			viewLoadTrigger: { activate: () => false, deactivate: vi.fn() },
			registerEvent: vi.fn(),
			registerDomEvent: vi.fn(),
			refreshApiSourcesOnViewLoad: vi.fn(),
			render,
		};
		fake.queueRender = proto.queueRender.bind(fake);
		await proto.onOpen.call(fake);
		return { render };
	}

	const settleTimers = () => new Promise<void>((r) => setTimeout(r, 5));

	it("E4: deleting then recreating a non-unit file queues a render each time, and the row flips missing -> normal", async () => {
		const w = wire();
		expect(w.unitIndex.getUnits().some((u) => u.path === MOVED)).toBe(false); // not a unit
		const { render } = await openExplorer(w);
		render.mockClear();

		const resolve = (ref: UnitRef) =>
			(AtlasExplorerView.prototype as unknown as { resolveRef: (r: UnitRef) => Promise<Info> }).resolveRef.call(
				{ plugin: { app: w.app, settings: { ...DEFAULT_SETTINGS } }, unitsByRefKey: new Map(w.unitIndex.getUnits().map((u) => [unitRefKey(unitToRef(u)), u])) },
				ref
			);
		const ref: UnitRef = { kind: "file", path: MOVED };
		expect((await resolve(ref)).missing).toBe(false);

		await w.app.vault.delete(w.app.vault.getAbstractFileByPath(MOVED)!);
		await settleTimers();
		expect(render).toHaveBeenCalledTimes(1);
		expect((await resolve(ref)).missing).toBe(true);

		render.mockClear();
		await w.app.vault.create(MOVED, "");
		await settleTimers();
		expect(render).toHaveBeenCalledTimes(1);
		expect(await resolve(ref)).toMatchObject({ text: "Responsibilities", missing: false });
	});

	it("F1/F6: a rename into a folder rewrites only the matching ref; everything else in data.json is untouched", async () => {
		const view: View = {
			id: "actionable",
			name: "Actionable",
			inboxMode: "view",
			root: [
				{ id: "folder", type: "meta", label: "FDE Play", children: [{ id: "resp", type: "unit", ref: { kind: "file", path: "Responsibilities.md" }, children: [] }] },
				{ id: "other", type: "unit", ref: { kind: "file", path: "Other.md" }, children: [] },
			],
		};
		const w = wire([view], false);
		w.app.vault.seedFile("Responsibilities.md");
		w.app.vault.seedFile("Other.md");
		const before = JSON.stringify(w.views.getViews());

		await w.app.vault.rename(w.app.vault.getAbstractFileByPath("Responsibilities.md")!, MOVED);

		const expected = before.replace('"path":"Responsibilities.md"', `"path":"${MOVED}"`);
		expect(JSON.stringify(w.views.getViews())).toBe(expected);
		const node = w.views.getNode("actionable", "resp")!;
		expect(node.id).toBe("resp");
		expect(w.views.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["resp"]);
		expect(w.unitIndex.getUnits().some((u) => u.path === MOVED)).toBe(false); // still no promotion made
		expect(w.persisted.length).toBeGreaterThan(0); // the existing rewrite saves, as before
	});
});

// PR-2 (GP1, GP2, E9): the real index and views manager behind the real explorer (see `repaint-rig.ts`),
// wired to vault events the way the plugin does it. A repaint is one replacement of the pane's children.
describe("PR-2 (GP1, GP2, E9) — the pane repaints once per user action, and not at all for a save", () => {
	let rig: RepaintRig;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		rig?.close();
		vi.useRealTimers();
	});

	async function open(settingsOverride: Partial<typeof DEFAULT_SETTINGS> = {}) {
		const app = new MockApp();
		app.vault.seedFile("Alpha.md");
		app.vault.seedFile("Beta.md");
		const unitIndex = new UnitIndex(app as unknown as App, { ...DEFAULT_SETTINGS, ...settingsOverride }, [], {}, [], []);
		unitIndex.rebuild();
		const views = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [] }], "v1", () => {});
		app.vault.on("create", (f: TAbstractFile) => unitIndex.onVaultCreate(f));
		app.vault.on("delete", (f: TAbstractFile) => {
			unitIndex.onVaultDelete(f.path);
			views.onVaultDelete(f.path);
		});
		app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
			unitIndex.onVaultRename(f, oldPath);
			views.onVaultRename(oldPath, f.path);
		});
		// What main.ts runs on every metadataCache "resolved".
		const resolved = () => {
			views.onMetadataResolved();
			unitIndex.onMetadataResolved();
		};
		rig = await openRepaintRig({ unitIndex, viewsManager: views, realLabels: { app: app as unknown as App, settings: { ...DEFAULT_SETTINGS } } });
		expect(rig.inboxRowKeys()).toHaveLength(2);
		rig.resetPaints();
		return { app, unitIndex, views, resolved };
	}

	it("GP1: typing in a note and the autosave that follows (modify, then resolves) repaint nothing", async () => {
		const { app, resolved } = await open();
		const file = app.vault.getAbstractFileByPath("Alpha.md") as TFile;

		await app.vault.modify(file, "typed");
		resolved();
		await rig.settle();
		await app.vault.modify(file, "typed more");
		resolved();
		resolved();
		await rig.settle();

		expect(rig.paints()).toBe(0);
	});

	it("GP2: creating a note shows its row after one repaint; the create and the resolves add no second", async () => {
		const { app, resolved } = await open();

		await app.vault.create("Gamma.md", "");
		resolved();
		resolved();
		await rig.settle();

		expect(rig.inboxRowKeys()).toHaveLength(3);
		expect(rig.paints()).toBe(1);
	});

	it("E9: renaming a note repaints once, with the new name", async () => {
		const { app, resolved } = await open();
		const before = rig.inboxRowKeys();

		await app.vault.rename(app.vault.getAbstractFileByPath("Beta.md")!, "Beta renamed.md");
		resolved();
		await rig.settle();

		const after = rig.inboxRowKeys();
		expect(after).toHaveLength(2);
		expect(after).not.toEqual(before);
		expect(after.some((key) => key.includes("Beta renamed"))).toBe(true);
		expect(rig.paints()).toBe(1);
	});

	it("deleting a note and creating it again at the same path ends with the same list, so the pane is not repainted", async () => {
		const { app, resolved } = await open();

		await app.vault.delete(app.vault.getAbstractFileByPath("Beta.md")!);
		await app.vault.create("Beta.md", "");
		resolved();
		await rig.settle();

		expect(rig.inboxRowKeys()).toHaveLength(2);
		expect(rig.paints()).toBe(0);
	});

	/** A vault-root Source.md linking to a block of Target.md, with a link graph the test controls: the
	 * mock metadata cache answers from `cache`, so adding or removing a link and editing the block's
	 * text go through the real `computePromotions`, `resolveUnit` and `render()`. */
	async function openWithBlockLink() {
		// A link promoting a block into the inbox only happens with auto-promotion on (PR-1, G1).
		const { app, unitIndex, views, resolved } = await open({ autoPromotion: true });
		const caches = new Map<string, { links?: { link: string }[]; blocks?: Record<string, { position: { start: { line: number } } }> }>();
		const metadata = app.metadataCache as unknown as {
			getFileCache: (f: TFile) => unknown;
			getFirstLinkpathDest: (link: string) => TFile | null;
		};
		metadata.getFileCache = (f) => caches.get(f.path) ?? null;
		metadata.getFirstLinkpathDest = (link) => app.vault.getAbstractFileByPath(`${link}.md`) as TFile | null;
		await app.vault.modify(app.vault.getAbstractFileByPath("Beta.md") as TFile, "First line\nThe quarry opens at dawn ^q1\n");
		const link = { link: "Beta#^q1" };
		caches.set("Beta.md", { blocks: { q1: { position: { start: { line: 1 } } } } });
		return { app, unitIndex, views, resolved, caches, link };
	}

	it("GP5: editing the text of a promoted block updates its row label, once", async () => {
		const { app, resolved, caches, link } = await openWithBlockLink();
		caches.set("Alpha.md", { links: [link] });
		resolved();
		await rig.settle();
		expect(rig.inboxRowTexts()).toContain("The quarry opens at dawn");
		rig.resetPaints();

		await app.vault.modify(app.vault.getAbstractFileByPath("Beta.md") as TFile, "First line\nThe quarry closes at dusk ^q1\n");
		resolved();
		await rig.settle();

		expect(rig.inboxRowTexts()).toContain("The quarry closes at dusk");
		expect(rig.inboxRowTexts()).not.toContain("The quarry opens at dawn");
		expect(rig.paints()).toBe(1);

		resolved(); // the resolve that follows is a no-op
		await rig.settle();
		expect(rig.paints()).toBe(1);
	});

	it("E5: a new link adds the block's row, and a removed link takes it away, one repaint each", async () => {
		const { resolved, caches, link } = await openWithBlockLink();
		const rowsBefore = rig.inboxRowKeys().length;
		rig.resetPaints();

		caches.set("Alpha.md", { links: [link] });
		resolved();
		await rig.settle();
		expect(rig.inboxRowKeys()).toHaveLength(rowsBefore + 1);
		expect(rig.paints()).toBe(1);

		caches.set("Alpha.md", { links: [] });
		resolved();
		await rig.settle();
		expect(rig.inboxRowKeys()).toHaveLength(rowsBefore);
		expect(rig.paints()).toBe(2);
	});

	async function createPoolBlock(app: MockApp, name: string, text: string): Promise<TFile> {
		app.vault.seedFolder("_pool");
		return app.vault.create(`_pool/${name}`, text);
	}

	it("E5: editing a free block's first line updates its row, once", async () => {
		const { app, resolved } = await open();
		const block = await createPoolBlock(app, "20260101000000-abcd.md", "Old title\n");
		resolved();
		await rig.settle();
		expect(rig.inboxRowTexts()).toContain("Old title");
		rig.resetPaints();

		await app.vault.modify(block, "New title\n");
		resolved();
		await rig.settle();

		expect(rig.inboxRowTexts()).toContain("New title");
		expect(rig.inboxRowTexts()).not.toContain("Old title");
		expect(rig.paints()).toBe(1);
	});
});
