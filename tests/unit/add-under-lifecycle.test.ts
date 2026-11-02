import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { ViewNode } from "../../src/types";
import { acquireParentLock } from "../../src/create-and-nest";
import { startAddUnderBlock } from "../../src/add-under-block";
import { startAddUnderFile } from "../../src/add-under-file";
import { startAddUnderModule } from "../../src/add-under-module";
import { startAddUnderFolder } from "../../src/add-under-folder";
import { file, meta, unit } from "../integration/create-from-meta-fixtures";
import { flush, heldCount, key, modals, seedRoot } from "../helpers";

// PR-1.S1 R1/R2 (polish): every add-under kind driven through its own real entry point
// (startAddUnderBlock/File/Module/Folder) against a real ViewsManager, UnitIndex and mock vault —
// not raw acquireParentLock/parentExists calls. Two things are proved for all four kinds:
//   1. E4 — a parent removed mid-flow (between the dialog closing and the nest, or while the disk
//      step runs) is refused: placeUnit/placeNewUnit/addMetaFolder are never called, nothing lands at
//      the view root, nothing is left on disk, the hold is zero and the lock is free again.
//   2. The per-parent lock is taken by the kind's own entry point and released on success, failure,
//      cancel and a thrown error.
// The dialogs are controllable: `openNameDialog` is replaced by a spy for File/Module, and the
// `TextPromptModal` constructor by a recorder for Folder.
const dialogMock = vi.hoisted(() => ({ impl: null as ((app: unknown, options: unknown) => Promise<string | null>) | null }));
const captured = vi.hoisted(() => ({
	prompts: [] as { title: string; onSubmit: (v: string) => void; onCancel?: () => void }[],
}));

vi.mock("../../src/name-dialog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/name-dialog")>();
	return { ...actual, openNameDialog: vi.fn((app: unknown, options: unknown) => (dialogMock.impl ?? actual.openNameDialog)(app, options)) };
});

vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingPrompt {
		constructor(
			_app: unknown,
			public title: string,
			_initial: string,
			public onSubmit: (v: string) => void,
			_placeholder?: string,
			public onCancel?: () => void
		) {
			captured.prompts.push(this);
		}
		open(): void {}
		close(): void {}
	}
	return { ...actual, TextPromptModal: RecordingPrompt };
});

const VIEW = "v1";
const NOW = new Date(2026, 0, 1, 0, 0, 0);
const BLOCK_PATH = "_pool/20260101000000-0000.md";
const notices = () => Notice.instances.map((n) => n.message);

type Kind = "block" | "file" | "module" | "folder";
const KINDS: Kind[] = ["block", "file", "module", "folder"];
/** The two parent row kinds the spec asks for: a unit row and a Folder row. */
const PARENTS = { unit: "quarry-drones", folder: "docs" } as const;
type ParentKind = keyof typeof PARENTS;

function tree(): ViewNode[] {
	return [meta("projects", "Projects", [unit("quarry-drones", file("quarry-drones.md")), meta("docs", "Docs")])];
}

function setup() {
	const app = new App();
	(app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({ openFile: vi.fn(async () => {}) }));
	(app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => null);
	seedRoot(app, ["quarry-drones.md"], []);
	const vm = new ViewsManager(app as unknown as App, [{ id: VIEW, name: "Default", inboxMode: "view", root: tree() }], VIEW, () => {});
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, poolFolder: "_pool", excludedFolders: ["_pool"] }, []);
	index.rebuild();
	app.vault.on("create", (f) => index.onVaultCreate(f));
	app.vault.on("delete", (f) => index.onVaultDelete(f.path));

	// Spies go on the real manager *before* the deps wrap it, so every call the flows make is seen.
	const spies = {
		placeUnit: vi.spyOn(vm, "placeUnit"),
		placeNewUnit: vi.spyOn(vm, "placeNewUnit"),
		addMetaFolder: vi.spyOn(vm, "addMetaFolder"),
	};
	const selection = new Set<string>();
	const hooks = { expandParent: (viewId: string, parentId: string) => vm.setNodeCollapsed(viewId, parentId, false) };
	const common = {
		app: app as unknown as App,
		getPoolFolder: () => "_pool",
		getExcludedFolders: () => ["_pool"],
		holdUnit: (path: string) => index.holdUnit(path),
		getNode: (viewId: string, nodeId: string) => vm.getNode(viewId, nodeId),
		expandParent: (viewId: string, parentId: string) => hooks.expandParent(viewId, parentId),
		selectOnly: (nodeId: string) => {
			selection.clear();
			selection.add(nodeId);
		},
		now: () => NOW,
		random: () => 0,
	};
	const named = {
		...common,
		getParentLabel: async () => "Parent",
		placeNewUnit: (viewId: string, ref: Parameters<ViewsManager["placeNewUnit"]>[1], parentId: string) => vm.placeNewUnit(viewId, ref, parentId),
		save: async () => {},
	};
	const start: Record<Kind, (parentId: string) => Promise<ViewNode | null>> = {
		block: (parentId) => startAddUnderBlock({ ...common, placeUnit: (v, r, p) => vm.placeUnit(v, r, p) }, VIEW, parentId),
		file: (parentId) => startAddUnderFile(named, VIEW, parentId),
		module: (parentId) => startAddUnderModule(named, VIEW, parentId),
		folder: (parentId) =>
			startAddUnderFolder(
				{
					app: app as unknown as App,
					getNode: common.getNode,
					addMetaFolder: (v, p, l) => vm.addMetaFolder(v, p, l),
					expandParent: common.expandParent,
					selectOnly: common.selectOnly,
					trackPrompt: () => () => {},
				},
				VIEW,
				parentId
			),
	};
	const listing = () => [...app.vault.getFiles().map((f) => f.path), ...(app.vault.getAbstractFileByPath("_pool") ? ["_pool/"] : [])].sort();
	return { app, vm, index, spies, selection, hooks, start, listing, rootIds: () => vm.getView(VIEW)!.root.map((n) => n.id) };
}

type Ctx = ReturnType<typeof setup>;

/** Removes the parent row from the view, the way a data sync or another action could mid-flow. */
function removeParent(s: Ctx, parent: ParentKind): void {
	if (parent === "unit") s.vm.unplaceNode(VIEW, PARENTS.unit);
	else s.vm.deleteMetaFolder(VIEW, PARENTS.folder);
}

/** Sets the flow up to pause at its first await after the lock is taken, and hands back what's
 * needed to let it carry on. File/Module: the name dialog. Folder: the label prompt. Block (which has
 * no dialog): the disk create. */
function pauseAtFirstAwait(s: Ctx, kind: Kind): { proceed(name: string): void; cancel(): void; started(): boolean } {
	if (kind === "file" || kind === "module") {
		let resolve!: (v: string | null) => void;
		let opened = false;
		dialogMock.impl = () =>
			new Promise<string | null>((r) => {
				opened = true;
				resolve = r;
			});
		return { proceed: (name) => resolve(name), cancel: () => resolve(null), started: () => opened };
	}
	if (kind === "folder") {
		return { proceed: (name) => captured.prompts[0].onSubmit(name), cancel: () => captured.prompts[0].onCancel?.(), started: () => captured.prompts.length > 0 };
	}
	const original = s.app.vault.create.bind(s.app.vault);
	let release!: () => void;
	let reached = false;
	vi.spyOn(s.app.vault, "create").mockImplementation(async (...args: Parameters<typeof original>) => {
		reached = true;
		await new Promise<void>((r) => (release = r));
		return original(...args);
	});
	return { proceed: () => release(), cancel: () => release(), started: () => reached };
}

beforeEach(() => {
	dialogMock.impl = null;
	captured.prompts.length = 0;
	Notice.reset();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
});

/** Every path a flow could hold for this kind (all balanced to zero once it ends). */
function heldPaths(kind: Kind): string[] {
	return kind === "block" ? [BLOCK_PATH] : kind === "file" ? ["Field Ops.md"] : kind === "module" ? ["Field Ops"] : [];
}

describe("E4 — the parent is removed mid-flow: refused, nothing placed, nothing left behind", () => {
	const cases = KINDS.flatMap((kind) => (Object.keys(PARENTS) as ParentKind[]).map((parent) => [kind, parent] as const));

	// Block has no dialog: its "between the dialog and the nest" window is the disk step, covered below.
	it.each(cases.filter(([kind]) => kind !== "block"))("%s under a %s parent, removed after the dialog closes (before the nest)", async (kind, parent) => {
		const s = setup();
		const before = s.listing();
		const rootBefore = s.rootIds();
		const pause = pauseAtFirstAwait(s, kind);

		const run = s.start[kind](PARENTS[parent]);
		await flush();
		expect(pause.started()).toBe(true);
		removeParent(s, parent);
		pause.proceed("Field Ops");
		const result = await run;

		expect(result).toBeNull();
		expect(s.spies.placeUnit).not.toHaveBeenCalled();
		expect(s.spies.placeNewUnit).not.toHaveBeenCalled();
		expect(s.spies.addMetaFolder).not.toHaveBeenCalled();
		expect(s.rootIds()).toEqual(rootBefore); // never planted at the view root
		expect(s.listing()).toEqual(before);
		for (const path of heldPaths(kind)) expect(heldCount(s.index, path)).toBe(0);
		expect([...s.selection]).toEqual([]);
		expect(notices().some((m) => m.includes("the parent no longer exists"))).toBe(true);
		const lock = acquireParentLock(VIEW, PARENTS[parent], false);
		expect(lock).not.toBeNull();
		lock!();
	});

	it.each(cases.filter(([kind]) => kind !== "folder"))("%s under a %s parent, removed while the disk step runs: rolled back, hold zero", async (kind, parent) => {
		const s = setup();
		const before = s.listing();
		const rootBefore = s.rootIds();
		const original = s.app.vault.create.bind(s.app.vault);
		vi.spyOn(s.app.vault, "create").mockImplementation(async (...args: Parameters<typeof original>) => {
			removeParent(s, parent);
			return original(...args);
		});
		dialogMock.impl = async () => "Field Ops";

		const result = await s.start[kind](PARENTS[parent]);

		expect(result).toBeNull();
		expect(s.spies.placeUnit).not.toHaveBeenCalled();
		expect(s.spies.placeNewUnit).not.toHaveBeenCalled();
		expect(s.rootIds()).toEqual(rootBefore);
		expect(s.listing()).toEqual(before);
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).toBeNull();
		for (const path of heldPaths(kind)) expect(heldCount(s.index, path)).toBe(0);
		expect(notices().some((m) => m.includes("the parent no longer exists"))).toBe(true);
		const lock = acquireParentLock(VIEW, PARENTS[parent], false);
		expect(lock).not.toBeNull();
		lock!();
	});

	it.each(KINDS)("%s: a parent already gone when the flow starts is refused before anything is asked or written", async (kind) => {
		const s = setup();
		const before = s.listing();
		s.vm.deleteMetaFolder(VIEW, "docs");
		dialogMock.impl = async () => {
			throw new Error("the dialog must not open");
		};

		const result = await s.start[kind]("docs");

		expect(result).toBeNull();
		expect(captured.prompts).toHaveLength(0);
		expect(s.spies.placeUnit).not.toHaveBeenCalled();
		expect(s.spies.placeNewUnit).not.toHaveBeenCalled();
		expect(s.spies.addMetaFolder).not.toHaveBeenCalled();
		expect(s.listing()).toEqual(before);
		expect(notices().some((m) => m.includes("the parent no longer exists"))).toBe(true);
	});
});

describe("the per-parent lock is taken by each kind's own entry point", () => {
	it.each(KINDS)("%s: while running, a second start on the same parent is refused with a Notice; another parent and another view are not blocked", async (kind) => {
		const s = setup();
		const pause = pauseAtFirstAwait(s, kind);
		const first = s.start[kind]("docs");
		await flush();
		expect(pause.started()).toBe(true);

		Notice.reset();
		const second = await s.start[kind]("docs");
		expect(second).toBeNull();
		expect(notices()).toEqual(["Atlas: already adding something here"]);

		const otherParent = acquireParentLock(VIEW, "quarry-drones", false);
		expect(otherParent).not.toBeNull();
		otherParent!();
		const otherView = acquireParentLock("other-view", "docs", false);
		expect(otherView).not.toBeNull();
		otherView!();

		pause.cancel();
		await first;
	});

	it.each(KINDS)("%s: released after success, so the same parent can be added under again", async (kind) => {
		const s = setup();
		dialogMock.impl = async () => "Field Ops";
		const run = s.start[kind]("docs");
		await flush();
		if (kind === "folder") captured.prompts[0].onSubmit("Field Ops");
		const node = await run;
		expect(node).not.toBeNull();
		for (const path of heldPaths(kind)) expect(heldCount(s.index, path)).toBe(0);
		const again = acquireParentLock(VIEW, "docs", false);
		expect(again).not.toBeNull();
		again!();
	});

	it.each(KINDS)("%s: released after a failure", async (kind) => {
		const s = setup();
		const before = s.listing();
		dialogMock.impl = async () => "Field Ops";
		if (kind === "folder") s.spies.addMetaFolder.mockReturnValue(null);
		else vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("disk says no"));
		const run = s.start[kind]("docs");
		await flush();
		if (kind === "folder") captured.prompts[0].onSubmit("Field Ops");
		expect(await run).toBeNull();
		expect(s.listing()).toEqual(before);
		for (const path of heldPaths(kind)) expect(heldCount(s.index, path)).toBe(0);
		const again = acquireParentLock(VIEW, "docs", false);
		expect(again).not.toBeNull();
		again!();
	});

	it.each(KINDS.filter((k) => k !== "block"))("%s: released after the dialog is cancelled; nothing is written", async (kind) => {
		const s = setup();
		const before = s.listing();
		const pause = pauseAtFirstAwait(s, kind);
		const run = s.start[kind]("docs");
		await flush();
		pause.cancel();
		expect(await run).toBeNull();
		expect(s.listing()).toEqual(before);
		expect(s.spies.placeNewUnit).not.toHaveBeenCalled();
		expect(s.spies.addMetaFolder).not.toHaveBeenCalled();
		const again = acquireParentLock(VIEW, "docs", false);
		expect(again).not.toBeNull();
		again!();
	});

	it.each(KINDS)("%s: released after a thrown error, and the hold is zero", async (kind) => {
		const s = setup();
		// The nest has already happened and the hold been released when expandParent runs; a throw
		// from here rejects the flow's promise. The lock must still come free.
		s.hooks.expandParent = () => {
			throw new Error("boom");
		};
		dialogMock.impl = async () => "Field Ops";
		const run = s.start[kind]("docs");
		const outcome = run.then(
			() => "resolved",
			(error: Error) => error.message
		);
		await flush();
		if (kind === "folder") captured.prompts[0].onSubmit("Field Ops");
		expect(await outcome).toBe("boom");
		for (const path of heldPaths(kind)) expect(heldCount(s.index, path)).toBe(0);
		const again = acquireParentLock(VIEW, "docs", false);
		expect(again).not.toBeNull();
		again!();
	});
});
