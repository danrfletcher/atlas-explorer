import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { AtlasExplorerView } from "../../src/explorer-view";
import { RENDER_TRIGGER_KINDS, RenderLog, RenderLogAdapter, RenderTriggerKind } from "../../src/render-log";
import type { ViewNode } from "../../src/types";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { PressEnv, flush, openExplorer } from "./explorer-view-press-helpers";

/** Drives the real `AtlasExplorerView.render()` (through the shared header harness) with a real
 * `RenderLog` on a fake adapter, and checks the entry each kind of trigger leaves behind. */

class MemoryAdapter implements RenderLogAdapter {
	files = new Map<string, string>();
	writeCount = 0;
	async exists(path: string) {
		return this.files.has(path);
	}
	async read(path: string) {
		return this.files.get(path) ?? "";
	}
	async write(path: string, data: string) {
		this.writeCount++;
		this.files.set(path, data);
	}
}

type Internals = {
	plugin: {
		renderLog: RenderLog;
		saveData: ReturnType<typeof vi.fn>;
		folderSourcePathStore: { get: () => string };
		unitIndex: { getUnits: () => unknown[] };
		viewsManager: { getViews: () => unknown[]; refreshFolderSource: ReturnType<typeof vi.fn>; getActiveView: () => unknown };
	};
	render: () => Promise<void>;
	renderNow: () => Promise<void>;
	renderToolbar: unknown;
	renderNodeList: (nodes: unknown, container: HTMLElement) => Promise<void>;
	refresh: () => void;
	refreshFolderSource: (view: unknown, node: ViewNode) => void;
	refreshApiSourcesOnViewLoad: () => void;
	handleSelectionClick: (evt: MouseEvent, key: string, scope: "bucket" | "inbox", order: string[]) => boolean;
	handleDrop: (target: unknown, zone?: string) => void;
	dragPayload: unknown;
	filterRevealed: boolean;
	filterText: string;
};

let h: SectionHarness;
let env: PressEnv;
let ex: Internals;
let log: RenderLog;
let adapter: MemoryAdapter;

async function open(): Promise<void> {
	vi.useFakeTimers();
	h = makeSectionHarness({ bucketRows: 2, inboxRows: 2 });
	ex = h.explorer as unknown as Internals;
	adapter = new MemoryAdapter();
	log = new RenderLog(adapter, ".obsidian/plugins/atlas-explorer/render-log.json");
	ex.plugin.renderLog = log;
	ex.plugin.saveData = vi.fn();
	ex.plugin.folderSourcePathStore = { get: () => "" };
	env = await openExplorer(h);
}

beforeEach(async () => {
	await open();
});

afterEach(() => {
	env.teardown();
	h.teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const kinds = () => log.entries().map((e) => e.kind);

describe("the first render", () => {
	it("onOpen's first render is logged as `other`, changed, with an integer duration", () => {
		const entries = log.entries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "other", changed: true });
		expect(Number.isInteger(entries[0].durationMs)).toBe(true);
		expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(Object.keys(entries[0]).sort()).toEqual(["at", "changed", "durationMs", "kind"]);
	});
});

describe("trigger kinds", () => {
	const view = { id: "v1", name: "Actionable", inboxMode: "view", root: [] };

	/** [kind, fire, optional setup that runs (and renders) before the baseline is taken]. */
	const triggers: [RenderTriggerKind, () => void | Promise<void>, (() => Promise<void>)?][] = [
		["unit-index", () => env.fireUnitIndexChange()],
		["views-change", () => env.fireViewsChange(false)],
		[
			"leaf-activate",
			() => {
				env.fireLeafChange({}); // another pane was active
				env.fireLeafChange((ex as unknown as { leaf: unknown }).leaf);
			},
		],
		[
			"folder-source-refresh",
			() => {
				// The real chain: the view asks the views manager to refresh, which notifies its listeners inline.
				ex.plugin.viewsManager.refreshFolderSource = vi.fn(() => env.fireViewsChange(false));
				ex.refreshFolderSource(view, { id: "n1" } as ViewNode);
			},
		],
		["settings", () => ex.refresh()],
		["click", () => void ex.handleSelectionClick(new MouseEvent("click"), "row-0", "bucket", ["row-0"])],
		[
			"drop",
			() => {
				ex.dragPayload = { kind: "inbox", viewId: "v1", refs: [] };
				ex.handleDrop({ kind: "inbox-area", viewId: "v1" });
			},
		],
		[
			"filter",
			() => {
				const input = document.querySelector<HTMLInputElement>("input.atlas-filter");
				expect(input).not.toBeNull();
				(input as HTMLInputElement).value = "abc";
				(input as HTMLInputElement).dispatchEvent(new Event("input"));
			},
			async () => {
				// The real toolbar, so the real filter input handler runs.
				delete (ex as { renderToolbar?: unknown }).renderToolbar;
				ex.plugin.viewsManager.getViews = () => [view];
				ex.filterRevealed = true;
				await ex.render();
			},
		],
		["other", () => void ex.render()],
	];

	it("covers every kind the log can carry", () => {
		expect(triggers.map(([k]) => k).sort()).toEqual([...RENDER_TRIGGER_KINDS].sort());
	});

	it.each(triggers)("a %s trigger is logged with that kind, as exactly one entry", async (kind, fire, setup) => {
		await setup?.();
		const before = log.entries().length;

		await fire();
		await flush(env);

		const added = log.entries().slice(before);
		expect(added.map((e) => e.kind)).toEqual([kind]);
	});
});

describe("burst: queueRender coalescing is untouched", () => {
	it("a unit-index change plus a views change in one tick give one render() and one entry, named by the first", async () => {
		const before = log.entries().length;

		env.fireUnitIndexChange();
		env.fireViewsChange(true);
		await flush(env);

		expect(env.renderNow).toHaveBeenCalledTimes(1);
		const added = log.entries().slice(before);
		expect(added.map((e) => e.kind)).toEqual(["unit-index"]);
	});

	it("the reverse order is named by the views change", async () => {
		const before = log.entries().length;

		env.fireViewsChange(true);
		env.fireUnitIndexChange();
		await flush(env);

		expect(env.renderNow).toHaveBeenCalledTimes(1);
		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["views-change"]);
	});

	it("a leaf activation that refreshes sources is named leaf-activate, not by the refresh it started", async () => {
		const before = log.entries().length;
		ex.refreshApiSourcesOnViewLoad = () => env.fireViewsChange(false); // a source refresh notifying inline
		env.fireLeafChange({});

		env.fireLeafChange((ex as unknown as { leaf: unknown }).leaf);
		await flush(env);

		expect(env.renderNow).toHaveBeenCalledTimes(1);
		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["leaf-activate"]);
	});

	it("a request held mid-press keeps its kind for the one render that runs after the press", async () => {
		const before = log.entries().length;
		const row = h.panel().appendChild(document.createElement("div"));
		row.dispatchEvent(new Event("pointerdown", { bubbles: true }));

		env.fireUnitIndexChange();
		env.fireViewsChange(false);
		await vi.advanceTimersByTimeAsync(50); // a held render keeps awaitRenderSettled() pending, so don't wait on it
		expect(log.entries()).toHaveLength(before); // nothing rendered, so nothing logged

		document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		await flush(env);

		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["unit-index"]);
	});
});

describe("attribution through the real stores, wired the way main.ts wires them", () => {
	/** A real `ViewsManager` and `UnitIndex`, with main.ts's Folder-source sync registered on the views
	 * manager FIRST (as `onload` does, so it runs ahead of every explorer listener). The explorer's own
	 * listener bodies are reached through the harness's recorded subscriptions, bridged after it. */
	function wireRealStores(): { views: ViewsManager; index: UnitIndex; viewId: string } {
		const app = new MockApp() as unknown as App;
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
		const views = new ViewsManager(app, [], "", () => {});
		const syncFolderSourceUnits = () => index.setFolderSourceRefs(views.getFolderSourceManagedRefs());
		views.onChange(syncFolderSourceUnits); // main.ts:144, before any explorer listener
		syncFolderSourceUnits();
		views.onChange((persisted) => env.fireViewsChange(persisted)); // what the explorer's onOpen registers
		index.onChange(() => env.fireUnitIndexChange());
		// The stores the drop path reads and writes are the real ones.
		const vm = ex.plugin.viewsManager as unknown as Record<string, unknown>;
		for (const key of ["getView", "moveNode", "placeUnit", "unplaceNode"]) {
			vm[key] = (...args: unknown[]) => (views as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args);
		}
		return { views, index, viewId: views.getViews()[0].id };
	}

	it("a bare ViewsManager notification is logged as views-change, not unit-index", async () => {
		const { views } = wireRealStores();
		const before = log.entries().length;

		views.notifyChange(); // e.g. onMetadataResolved, onVaultRename, onVaultDelete
		await flush(env);

		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["views-change"]);
	});

	it("a persisted ViewsManager save is logged as views-change", async () => {
		const { views, viewId } = wireRealStores();
		const before = log.entries().length;

		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		await flush(env);

		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["views-change"]);
	});

	it("a real unit-index change (no views change behind it) is still logged as unit-index", async () => {
		const { index } = wireRealStores();
		const before = log.entries().length;

		index.setFolderSourceRefs([{ kind: "file", path: "A.md" }]);
		await flush(env);

		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["unit-index"]);
	});

	it("a drop that places a ref is logged as drop", async () => {
		const { views, viewId } = wireRealStores();
		const before = log.entries().length;

		ex.dragPayload = { kind: "inbox", viewId, refs: [{ kind: "file", path: "A.md" }] };
		ex.handleDrop({ kind: "bucket-root", viewId });
		await flush(env);

		expect(views.getView(viewId)!.root).toHaveLength(1); // the drop really changed the views
		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["drop"]);
	});

	it("a drop that moves an existing node is logged as drop", async () => {
		const { views, viewId } = wireRealStores();
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null);
		await flush(env);
		const [first] = views.getView(viewId)!.root;
		const before = log.entries().length;

		ex.dragPayload = { kind: "node", viewId, nodeIds: [first.id] };
		ex.handleDrop({ kind: "bucket-root", viewId });
		await flush(env);

		expect(views.getView(viewId)!.root[1].id).toBe(first.id); // moved to the end
		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["drop"]);
	});

	it("a drop that removes a node (dragged to the inbox) is logged as drop", async () => {
		const { views, viewId } = wireRealStores();
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		await flush(env);
		const [only] = views.getView(viewId)!.root;
		const before = log.entries().length;

		ex.dragPayload = { kind: "node", viewId, nodeIds: [only.id] };
		ex.handleDrop({ kind: "inbox-area", viewId });
		await flush(env);

		expect(views.getView(viewId)!.root).toHaveLength(0);
		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["drop"]);
	});

	it("a drop that moves a node, then an unrelated views change, are two entries with their own kinds", async () => {
		const { views, viewId } = wireRealStores();
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null);
		await flush(env);
		const [first] = views.getView(viewId)!.root;
		const before = log.entries().length;

		ex.dragPayload = { kind: "node", viewId, nodeIds: [first.id] };
		ex.handleDrop({ kind: "bucket-root", viewId });
		await flush(env);
		views.notifyChange();
		await flush(env);

		expect(log.entries().slice(before).map((e) => e.kind)).toEqual(["drop", "views-change"]);
	});
});

describe("the changed flag", () => {
	it("is true for the first render, false for a repeat with identical state, true when a row label is edited", async () => {
		// The first render (onOpen) is already in the log.
		expect(log.entries()[0].changed).toBe(true);

		await ex.render();
		expect(log.entries()[1].changed).toBe(false);

		let label = "Original";
		ex.renderNodeList = async (_nodes, container) => {
			container.createDiv({ cls: "atlas-row atlas-row-unit" }).createSpan({ cls: "atlas-row-text", text: label });
		};
		await ex.render();
		expect(log.entries()[2].changed).toBe(true);

		await ex.render();
		expect(log.entries()[3].changed).toBe(false);

		label = "Edited";
		await ex.render();
		expect(log.entries()[4].changed).toBe(true);

		await ex.render();
		expect(log.entries()[5].changed).toBe(false);
	});

	it("a skipped render stays unchanged after the live pane was touched outside render() (open-note highlight)", async () => {
		// The GP1 sequence: click into a note (active-leaf-change re-highlights the live rows without a
		// render), type, autosave. The render that follows finds identical output and paints nothing.
		let activeRows = 0;
		(ex as unknown as { updateActiveHighlight: (root?: HTMLElement) => void }).updateActiveHighlight = (root?: HTMLElement) => {
			const pane = root ?? h.panel();
			pane.querySelectorAll(".atlas-row-unit").forEach((row, i) => row.classList.toggle("is-active", i < activeRows));
		};
		await ex.render();
		const before = log.entries().length;

		activeRows = 1;
		(ex as unknown as { updateActiveHighlight: () => void }).updateActiveHighlight(); // outside any render
		const pane = h.panel().innerHTML;
		await ex.render();

		expect(h.panel().innerHTML).toBe(pane); // nothing was repainted ...
		expect(log.entries().slice(before)).toEqual([expect.objectContaining({ changed: false })]); // ... and the log says so
	});

	it("an unrelated change in the inbox set also counts as a change", async () => {
		await ex.render();
		expect(log.entries()[1].changed).toBe(false);

		const units = ex.plugin.unitIndex.getUnits();
		const extra = { type: "root-file", path: "New note.md" };
		ex.plugin.unitIndex.getUnits = () => [...units, extra];
		(ex.plugin as unknown as { viewsManager: { getInboxUnits: () => unknown[] } }).viewsManager.getInboxUnits = () => [...units, extra];
		await ex.render();

		expect(log.entries()[2].changed).toBe(true);
	});
});

describe("superseded and throwing renders", () => {
	it("a render superseded by a newer one logs exactly one entry for itself, as unchanged", async () => {
		const before = log.entries().length;
		let release: () => void = () => {};
		let first = true;
		ex.renderNodeList = async (_nodes, container) => {
			if (first) {
				first = false;
				await new Promise<void>((resolve) => (release = resolve));
			}
			container.createDiv({ cls: "atlas-row atlas-row-unit" }).createSpan({ cls: "atlas-row-text", text: "From the newer render" });
		};

		const slow = ex.render(); // stalls inside the bucket
		const fast = ex.render(); // supersedes it, and paints something new
		await fast;
		release();
		await slow;

		const added = log.entries().slice(before);
		expect(added).toHaveLength(2);
		expect(added[0].changed).toBe(true); // the newer render finished first, with new output
		expect(added[1].changed).toBe(false); // the superseded one has no output of its own to report
	});

	it("a render that throws logs exactly one entry and the caller still gets the original error", async () => {
		const before = log.entries().length;
		const boom = new Error("bucket exploded");
		ex.renderNodeList = async () => {
			throw boom;
		};

		await expect(ex.render()).rejects.toBe(boom);

		expect(log.entries().slice(before)).toHaveLength(1);
	});

	it("a log that throws on record does not change a render's outcome", async () => {
		vi.spyOn(log, "record").mockImplementation(() => {
			throw new Error("log broke");
		});
		await expect(ex.render()).resolves.toBeUndefined();

		const boom = new Error("bucket exploded");
		ex.renderNodeList = async () => {
			throw boom;
		};
		await expect(ex.render()).rejects.toBe(boom);
	});
});

describe("no feedback loop and no data.json writes", () => {
	it("saving the log does not trigger a render", async () => {
		await ex.render();
		const rendersBefore = env.renderNow.mock.calls.length;

		await log.flush();
		await vi.advanceTimersByTimeAsync(10_000);
		await flush(env);

		expect(adapter.writeCount).toBeGreaterThan(0);
		expect(env.renderNow.mock.calls.length).toBe(rendersBefore);
	});

	it("a render does not call saveData", async () => {
		for (let i = 0; i < 3; i++) await ex.render();
		env.fireViewsChange(false);
		await flush(env);
		expect(ex.plugin.saveData).not.toHaveBeenCalled();
	});
});

describe("two Atlas leaves share one plugin-wide log", () => {
	it("each render from either leaf adds exactly one entry, and each leaf compares against its own last output", async () => {
		const ex2 = new AtlasExplorerView({} as WorkspaceLeaf, ex.plugin as never) as unknown as Internals;
		const host2 = document.createElement("div");
		host2.appendChild(document.createElement("div"));
		host2.appendChild(document.createElement("div"));
		document.body.appendChild(host2);
		(ex2 as unknown as { containerEl: HTMLElement }).containerEl = host2;
		for (const key of ["renderToolbar", "renderNodeList", "resolveRef", "matchesFilter", "setPlacementTooltip", "updateActiveHighlight", "syncRefreshTimers", "refreshApiSourcesOnViewLoad", "openAddFileModal", "showInboxHeaderMenu"]) {
			(ex2 as unknown as Record<string, unknown>)[key] = (ex as unknown as Record<string, unknown>)[key];
		}
		const before = log.entries().length;

		await Promise.all([ex.render(), ex2.render()]); // overlapping renders in two leaves
		await ex2.render();
		await ex.render();

		const added = log.entries().slice(before);
		expect(added).toHaveLength(4);
		// Leaf 2's first paint is a change even though leaf 1 had already painted the same output.
		expect(added.map((e) => e.changed)).toEqual([false, true, false, false]);
		host2.remove();
	});
});

describe("explorer source", () => {
	it("a view without a render log (a bare test double) still renders", async () => {
		(ex.plugin as unknown as { renderLog?: RenderLog }).renderLog = undefined;
		await expect(ex.render()).resolves.toBeUndefined();
	});
});
