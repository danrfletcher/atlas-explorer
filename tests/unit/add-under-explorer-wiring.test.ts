import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice, type WorkspaceLeaf } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { View, ViewNode, unitRefKey, unitToRef } from "../../src/types";
import { acquireParentLock } from "../../src/create-and-nest";
import { flush, key, modals, type } from "../helpers";
import { file, folder, meta, setup, unit } from "../integration/create-from-meta-fixtures";

// The AtlasExplorerView side of "Add under…": a REAL view instance (so the real private methods run
// against each other, not hand-copied onto a fake `this`) over a real ViewsManager, UnitIndex and
// in-memory vault. Only `render`/`awaitRenderSettled` are stubbed — the DOM check that decides
// whether a Notice fires reads `bucketListEl`, which is a bare <div> the new row never reaches, so
// every added row counts as hidden and the Notice text is the thing under test.

// The Folder flow's label prompt is a recorder that behaves like the real `TextPromptModal` where it
// matters here: `close()` on an open prompt without a submit reports a cancel; `submit()` closes it
// first and then reports the value. (The shared Obsidian `Setting` mock has no `addText`, so the real
// modal can't open under jsdom.)
const captured = vi.hoisted(() => ({
	prompts: [] as { isOpen: boolean; submit(value: string): void; close(): void }[],
}));
vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingPrompt {
		isOpen = false;
		constructor(
			_app: unknown,
			_title: string,
			_initial: string,
			private onSubmit: (v: string) => void,
			_placeholder?: string,
			private onCancel?: () => void
		) {
			captured.prompts.push(this);
		}
		open(): void {
			this.isOpen = true;
		}
		close(): void {
			if (!this.isOpen) return;
			this.isOpen = false;
			this.onCancel?.();
		}
		submit(value: string): void {
			this.isOpen = false;
			this.onSubmit(value);
		}
	}
	return { ...actual, TextPromptModal: RecordingPrompt };
});

const FB_PATH = "_pool/20260101000000-aaaa.md";
const DONE_SET: StatusSet = {
	id: "D",
	name: "D",
	defaultStatusId: "done",
	statuses: [
		{ id: "todo", label: "Todo", color: "#888888" },
		{ id: "done", label: "Done", color: "#00cc00" },
	],
};

/** Projects
 *   ├─ quarry-drones.md          (a file row)
 *   │    └─ Existing.md          (its one child; the governor for the truncation cases is added per test)
 *   ├─ <free block "Drone launch notes">
 *   ├─ Existing Folder           (a module row)
 *   └─ Deep (Folder)
 *        └─ MixedCase.md         (a file row two levels down) */
function tree(): ViewNode[] {
	return [
		meta(
			"projects",
			"Projects",
			[
				unit("qd", file("quarry-drones.md"), { children: [unit("qd-child", file("Existing.md"))] }),
				unit("fb", file(FB_PATH)),
				unit("mod", folder("Existing Folder")),
				meta("deep", "Deep", [unit("deep-file", file("MixedCase.md"))]),
			],
			{ collapsed: true }
		),
	];
}

type Internals = {
	startAddUnder(kind: string, view: View, node: ViewNode): void;
	runAddUnderBlock(view: View, node: ViewNode): Promise<void>;
	addUnderParentLabel(viewId: string, parentId: string): Promise<string>;
	computeEffectiveCollapsed(node: ViewNode, view: View): Promise<boolean>;
	restoreFoldStateAfterFilterClear(): void;
	openAddUnderPrompts: Set<unknown>;
	preFilterCollapsedState: Map<string, boolean | undefined> | null;
	filterText: string;
	bucketListEl: HTMLElement;
	unitsByRefKey: Map<string, unknown>;
	selectedBucketNodeIds: Set<string>;
	render: ReturnType<typeof vi.fn>;
	awaitRenderSettled: ReturnType<typeof vi.fn>;
};

function host(options: { filterText?: string; statuses?: StatusSet[]; root?: ViewNode[] } = {}) {
	const s = setup(options.root ?? tree());
	s.app.vault.seedFile("quarry-drones.md");
	s.app.vault.contents.set(FB_PATH, "Drone launch notes\nsecond line");
	s.index.rebuild();
	const openFile = vi.fn(async (_file: unknown) => {});
	(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({ openFile }));
	(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => null);

	const plugin = {
		app: s.app,
		viewsManager: s.views,
		unitIndex: s.index,
		statusesManager: new StatusesManager(JSON.parse(JSON.stringify(options.statuses ?? [DONE_SET])) as StatusSet[], [], () => {}),
		settings: { ...DEFAULT_SETTINGS, poolFolder: "_pool", excludedFolders: ["_pool"] },
		freeBlockTextCache: undefined,
		flushSave: async () => {},
	};
	const explorer = new AtlasExplorerView({} as WorkspaceLeaf, plugin as never);
	const internals = explorer as unknown as Internals;
	internals.render = vi.fn(async () => {});
	internals.awaitRenderSettled = vi.fn(async () => {});
	internals.bucketListEl = document.createElement("div");
	internals.filterText = options.filterText ?? "";
	// What the first real render() pass would have filled in.
	internals.unitsByRefKey = new Map(s.index.getUnits().map((u) => [unitRefKey(unitToRef(u)), u]));
	const view = s.views.getViews()[0];
	const node = (id: string): ViewNode => s.views.getNode(view.id, id)!;
	return { ...s, plugin, explorer, internals, view, node, openFile };
}

const notices = () => Notice.instances.map((n) => n.message);
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await flush();
}

let originalCSS: unknown;
beforeEach(() => {
	Notice.reset();
	captured.prompts.length = 0;
	// jsdom has no CSS global; the hidden-row check builds its selector with CSS.escape.
	originalCSS = (globalThis as { CSS?: unknown }).CSS;
	(globalThis as { CSS?: { escape: (v: string) => string } }).CSS = { escape: (v: string) => v };
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
	(globalThis as { CSS?: unknown }).CSS = originalCSS;
});

describe("addUnderParentLabel — the clicked row's displayed text, never a raw ref path or pool ID", () => {
	it.each([
		["a Folder row", "projects", "Projects"],
		["a file row (no .md)", "qd", "quarry-drones"],
		["a module (folder-unit) row", "mod", "Existing Folder"],
		["a nested file row, two levels down", "deep-file", "MixedCase"],
		["a nested Folder row", "deep", "Deep"],
		["a child of a file row", "qd-child", "Existing"],
	])("%s", async (_name, id, expected) => {
		const h = host();
		expect(await h.internals.addUnderParentLabel(h.view.id, id)).toBe(expected);
	});

	it("a free-block row shows its first line, never the pool ID or path", async () => {
		const h = host();
		const label = await h.internals.addUnderParentLabel(h.view.id, "fb");
		expect(label).toBe("Drone launch notes");
		expect(label).not.toContain("20260101");
		expect(label).not.toContain("_pool");
		expect(label).not.toContain(".md");
	});

	it("an empty free block shows the empty-block text, still not its ID", async () => {
		const h = host();
		h.app.vault.contents.set(FB_PATH, "");
		const label = await h.internals.addUnderParentLabel(h.view.id, "fb");
		expect(label).toBe("(empty block)");
	});

	it("a parent that no longer exists gives an empty label", async () => {
		const h = host();
		expect(await h.internals.addUnderParentLabel(h.view.id, "gone")).toBe("");
	});

	it("follows a Folder's rename: the live node is read, not a value captured earlier", async () => {
		const h = host();
		h.node("projects").label = "Renamed";
		expect(await h.internals.addUnderParentLabel(h.view.id, "projects")).toBe("Renamed");
	});
});

describe("the hidden-row Notice names the parent the way its row reads", () => {
	it("File under a file row: 'quarry-drones', not 'quarry-drones.md' (exact text)", async () => {
		const h = host({ filterText: "zzz" });
		h.internals.startAddUnder("file", h.view, h.node("qd"));
		await settle();
		expect(modals()).toHaveLength(1);
		type("Quarry Notes");
		key("Enter");
		await settle();

		expect(h.node("qd").children.map((c) => (c.ref as { path: string }).path)).toEqual(["Existing.md", "Quarry Notes.md"]);
		expect(notices()).toEqual(["Atlas: Added Quarry Notes under quarry-drones (hidden by the current filter)"]);
	});

	it("Module under a nested file row", async () => {
		const h = host({ filterText: "zzz" });
		h.internals.startAddUnder("module", h.view, h.node("deep-file"));
		await settle();
		type("Field Ops");
		key("Enter");
		await settle();

		expect(notices()).toEqual(["Atlas: Added Field Ops under MixedCase (hidden by the current filter)"]);
	});

	it("Block under a free-block row: the parent is its first line, the pool ID appears nowhere in the Notice", async () => {
		const h = host({ filterText: "zzz" });
		h.internals.startAddUnder("block", h.view, h.node("fb"));
		await settle();

		expect(notices()).toEqual(["Atlas: Added (empty block) under Drone launch notes (hidden by the current filter)"]);
		expect(notices().join("\n")).not.toContain("20260101");
	});

	it("Block under a Folder row keeps the Folder's own label", async () => {
		const h = host({ filterText: "zzz" });
		h.internals.startAddUnder("block", h.view, h.node("projects"));
		await settle();

		expect(notices()).toEqual(["Atlas: Added (empty block) under Projects (hidden by the current filter)"]);
	});

	describe("a truncated group is named the way the group row reads (pluralized, or the configured label)", () => {
		const governed = (config: { enabled: boolean; label?: string }): ViewNode[] => {
			const root = tree();
			const qd = root[0].children[0];
			Object.assign(qd, { statusEnabled: true, statusSetId: "D", truncatedStatuses: { done: config } });
			return root;
		};

		it("no custom label: 'Dones' (pluralizeStatusLabel), not the raw status label 'Done'", async () => {
			const h = host({ root: governed({ enabled: true }) });
			h.internals.startAddUnder("block", h.view, h.node("qd"));
			await settle();

			expect(notices()).toEqual(['Atlas: Added (empty block) under quarry-drones (hidden by the truncated "Dones" group)']);
		});

		it("a configured group label wins over the pluralized one", async () => {
			const h = host({ root: governed({ enabled: true, label: " Finished " }) });
			h.internals.startAddUnder("block", h.view, h.node("qd"));
			await settle();

			expect(notices()).toEqual(['Atlas: Added (empty block) under quarry-drones (hidden by the truncated "Finished" group)']);
		});

		it("truncation off for the status: no group, so no Notice", async () => {
			const h = host({ root: governed({ enabled: false }) });
			h.internals.startAddUnder("block", h.view, h.node("qd"));
			await settle();

			expect(notices()).toEqual([]);
		});
	});
});

describe("a Block whose editor open fails is still a completed add (runAddUnderBlock)", () => {
	it("openFile rejects: the run resolves, the open-failure Notice shows, the view renders and the hidden-row Notice still runs", async () => {
		const h = host({ filterText: "zzz" });
		h.openFile.mockRejectedValue(new Error("no leaf available"));

		await expect(h.internals.runAddUnderBlock(h.view, h.node("projects"))).resolves.toBeUndefined();

		const added = h.node("projects").children.at(-1)!;
		expect((added.ref as { path: string }).path).toMatch(/^_pool\/.*\.md$/);
		expect([...h.internals.selectedBucketNodeIds]).toEqual([added.id]);
		expect(h.internals.render).toHaveBeenCalled();
		expect(h.internals.awaitRenderSettled).toHaveBeenCalled();
		expect(notices()).toEqual([
			"Atlas: the block was added, but opening it failed: no leaf available",
			"Atlas: Added (empty block) under Projects (hidden by the current filter)",
		]);
		const lock = acquireParentLock(h.view.id, "projects", false);
		expect(lock).not.toBeNull();
		lock!();
	});

	it("the same through the menu's dispatcher: no unhandled rejection, same two Notices", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const h = host({ filterText: "zzz" });
			h.openFile.mockRejectedValue(new Error("no leaf available"));

			h.internals.startAddUnder("block", h.view, h.node("projects"));
			await settle();

			expect(h.node("projects").children).toHaveLength(5);
			expect(notices()).toHaveLength(2);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("expanding the parent during an active filter survives clearing the filter", () => {
	it("the parent was collapsed before the filter, the add expands it, clearing the filter leaves it expanded", async () => {
		const h = host({ filterText: "zzz" });
		expect(h.node("projects").collapsed).toBe(true);
		// A render with the filter active snapshots every row's fold state (as `computeEffectiveCollapsed` does).
		await h.internals.computeEffectiveCollapsed(h.node("projects"), h.view);
		await h.internals.computeEffectiveCollapsed(h.node("deep"), h.view);
		h.node("deep").collapsed = true;
		expect(h.internals.preFilterCollapsedState!.get("projects")).toBe(true);

		await h.internals.runAddUnderBlock(h.view, h.node("projects"));
		expect(h.node("projects").collapsed).toBe(false);

		h.internals.filterText = "";
		h.internals.restoreFoldStateAfterFilterClear();

		expect(h.node("projects").collapsed).toBe(false); // the add's expansion is kept
		expect(h.node("deep").collapsed).toBe(false); // untouched rows still go back to what the snapshot recorded (undefined → expanded)
		expect(h.internals.preFilterCollapsedState).toBeNull();
	});

	it("rows the filter merely force-opened are still restored to collapsed", async () => {
		const root = tree();
		root[0].children[3].collapsed = true; // "deep" starts collapsed
		const h = host({ filterText: "zzz", root });
		await h.internals.computeEffectiveCollapsed(h.node("projects"), h.view);
		await h.internals.computeEffectiveCollapsed(h.node("deep"), h.view);
		h.node("deep").collapsed = false; // the filter's force-reveal opened it

		await h.internals.runAddUnderBlock(h.view, h.node("projects"));
		h.internals.filterText = "";
		h.internals.restoreFoldStateAfterFilterClear();

		expect(h.node("projects").collapsed).toBe(false);
		expect(h.node("deep").collapsed).toBe(true);
	});

	it("with no filter active, the snapshot is not created by the add", async () => {
		const h = host();
		await h.internals.runAddUnderBlock(h.view, h.node("projects"));
		expect(h.node("projects").collapsed).toBe(false);
		expect(h.internals.preFilterCollapsedState).toBeNull();
	});

	it("a filter was active but no render had snapshotted yet: the add still records the expansion", async () => {
		const h = host({ filterText: "zzz" });
		expect(h.internals.preFilterCollapsedState).toBeNull();
		await h.internals.runAddUnderBlock(h.view, h.node("projects"));
		h.internals.filterText = "";
		h.internals.restoreFoldStateAfterFilterClear();
		expect(h.node("projects").collapsed).toBe(false);
	});
});

describe("closing the view closes an open Add under > Folder prompt, which resolves as a cancel", () => {
	it("onClose closes the prompt: no addMetaFolder call, no new node, no render, no Notice, lock free", async () => {
		const h = host();
		const addMetaFolder = vi.spyOn(h.views, "addMetaFolder");

		h.internals.startAddUnder("folder", h.view, h.node("projects"));
		await settle();
		expect(captured.prompts).toHaveLength(1);
		expect(captured.prompts[0].isOpen).toBe(true);
		expect(h.internals.openAddUnderPrompts.size).toBe(1);

		await h.explorer.onClose();
		await settle();

		expect(captured.prompts[0].isOpen).toBe(false);
		expect(h.internals.openAddUnderPrompts.size).toBe(0);
		expect(addMetaFolder).not.toHaveBeenCalled();
		expect(h.node("projects").children).toHaveLength(4);
		expect(h.internals.render).not.toHaveBeenCalled(); // nothing redraws a closed view
		expect(notices()).toEqual([]);
		expect([...h.internals.selectedBucketNodeIds]).toEqual([]);
		const lock = acquireParentLock(h.view.id, "projects", false);
		expect(lock).not.toBeNull();
		lock!();
	});

	it("control: confirming a still-open prompt un-registers it and adds the Folder", async () => {
		const h = host();
		const addMetaFolder = vi.spyOn(h.views, "addMetaFolder");

		h.internals.startAddUnder("folder", h.view, h.node("projects"));
		await settle();
		expect(h.internals.openAddUnderPrompts.size).toBe(1);
		captured.prompts[0].submit("Archive");
		await settle();

		expect(addMetaFolder).toHaveBeenCalledTimes(1);
		expect(h.node("projects").children.at(-1)!.label).toBe("Archive");
		expect(h.internals.openAddUnderPrompts.size).toBe(0);
		expect(h.internals.render).toHaveBeenCalled();
	});

	it("control: cancelling a prompt un-registers it too (nothing is left for onClose to close)", async () => {
		const h = host();
		h.internals.startAddUnder("folder", h.view, h.node("projects"));
		await settle();
		captured.prompts[0].close();
		await settle();

		expect(h.internals.openAddUnderPrompts.size).toBe(0);
		expect(h.node("projects").children).toHaveLength(4);
	});

	it("two prompts open on different parents are both closed", async () => {
		const h = host();
		const addMetaFolder = vi.spyOn(h.views, "addMetaFolder");
		h.internals.startAddUnder("folder", h.view, h.node("projects"));
		h.internals.startAddUnder("folder", h.view, h.node("deep"));
		await settle();
		expect(h.internals.openAddUnderPrompts.size).toBe(2);

		await h.explorer.onClose();
		await settle();

		expect(captured.prompts.map((p) => p.isOpen)).toEqual([false, false]);
		expect(h.internals.openAddUnderPrompts.size).toBe(0);
		expect(addMetaFolder).not.toHaveBeenCalled();
		expect(h.node("projects").children).toHaveLength(4);
		expect(h.node("deep").children).toHaveLength(1);
	});
});
