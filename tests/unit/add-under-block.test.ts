import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { AddUnderBlockDeps, startAddUnderBlock } from "../../src/add-under-block";
import { acquireParentLock } from "../../src/create-and-nest";
import { UnitRef, ViewNode } from "../../src/types";
import { heldCount } from "../helpers";
import { setup, tMany, tNested } from "../integration/create-from-meta-fixtures";

// PR-3.F1 (G1): `startAddUnderBlock` is driven against the real `ViewsManager`/`UnitIndex` the
// `create-from-meta-fixtures` setup already builds (same pattern `create-from-meta.test.ts` and
// `add-under-folder.test.ts` use) — a real in-memory `Vault`, not hand-rolled path/content mocks —
// plus a workspace stub for `getLeaf().openFile`/`getActiveViewOfType` (not modelled by the shared
// `App` mock, since nothing else in this repo opens a file from a bare `AddUnderBlockDeps`).
vi.mock("../../src/commands", () => ({ addBlock: vi.fn(), registerAddBlockCommand: vi.fn() }));
// eslint-disable-next-line import/order
import { addBlock } from "../../src/commands";

type Setup = ReturnType<typeof setup>;

const NOW = new Date(2026, 8, 25, 14, 30, 12); // 20260925143012

function openFileSpy(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => {});
}

/** Wires `AddUnderBlockDeps` to the real `ViewsManager`/`UnitIndex` from `s`, with the workspace
 * stubbed so `startAddUnderBlock`'s own open-in-editor step is observable but never touches a real
 * Obsidian workspace (the shared `App` mock models neither `getLeaf` nor `getActiveViewOfType`). */
function blockDeps(s: Setup, overrides: Partial<AddUnderBlockDeps> = {}): AddUnderBlockDeps {
	const openFile = overrides.app ? undefined : openFileSpy();
	if (!overrides.app) {
		(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({ openFile }));
		(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => null);
	}
	return {
		app: s.app,
		getPoolFolder: () => "_pool",
		holdUnit: (path: string) => s.index.holdUnit(path),
		getNode: (viewId: string, nodeId: string) => s.views.getNode(viewId, nodeId),
		placeUnit: (viewId: string, ref: UnitRef, parentId: string) => s.views.placeUnit(viewId, ref, parentId),
		expandParent: (viewId: string, parentId: string) => s.views.setNodeCollapsed(viewId, parentId, false),
		selectOnly: vi.fn(),
		now: () => NOW,
		random: () => 0,
		...overrides,
	};
}

function newBlockPath(created: ViewNode): string {
	return (created.ref as { path: string }).path;
}

beforeEach(() => {
	Notice.reset();
	vi.clearAllMocks();
});

describe("startAddUnderBlock — G1 happy path", () => {
	it("creates an empty block in the pool, places it as the parent's last child, expands, selects and opens — in that order", async () => {
		const s = setup(tMany());
		const order: string[] = [];
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		s.app.vault.create = async (path: string, data: string) => {
			order.push("create");
			return originalCreate(path, data);
		};
		const openFile = vi.fn(async () => {
			order.push("open");
		});
		(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({ openFile }));
		(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => null);
		const placeUnitSpy = vi.fn((viewId: string, ref: UnitRef, parentId: string) => {
			const node = s.views.placeUnit(viewId, ref, parentId);
			order.push("place");
			return node;
		});
		const deps: AddUnderBlockDeps = {
			app: s.app,
			getPoolFolder: () => "_pool",
			holdUnit: (path) => s.index.holdUnit(path),
			getNode: (viewId, nodeId) => s.views.getNode(viewId, nodeId),
			placeUnit: placeUnitSpy,
			expandParent: (viewId, parentId) => {
				s.views.setNodeCollapsed(viewId, parentId, false);
				order.push("expand");
			},
			selectOnly: () => order.push("select"),
			now: () => NOW,
			random: () => 0,
		};

		const created = await startAddUnderBlock(deps, "default", "ft");

		expect(created).not.toBeNull();
		expect(created!.type).toBe("unit");
		const path = newBlockPath(created!);
		expect(path).toBe("_pool/20260925143012-0000.md");
		expect(s.contentOf(path)).toBe("");
		expect(placeUnitSpy).toHaveBeenCalledWith("default", { kind: "file", path }, "ft");
		const ft = s.views.getNode("default", "ft")!;
		expect(ft.children.at(-1)!.id).toBe(created!.id);
		expect(ft.collapsed).toBe(false);
		expect(openFile).toHaveBeenCalledWith(s.app.vault.getAbstractFileByPath(path));
		expect(order).toEqual(["create", "place", "expand", "select", "open"]);
		expect(Notice.instances).toHaveLength(0);
	});

	it("works on a unit row too, and at a deeper nesting depth", async () => {
		const s = setup(tNested());
		const deps = blockDeps(s);
		// "mid" is a Folder (meta) row nested two levels deep; "c-mixed" is a unit row.
		const underFolder = await startAddUnderBlock(deps, "default", "mid");
		expect(underFolder).not.toBeNull();
		expect(s.views.getNode("default", "mid")!.children.at(-1)!.id).toBe(underFolder!.id);

		const underUnit = await startAddUnderBlock(blockDeps(s, { random: () => 1 / 36 }), "default", "c-mixed");
		expect(underUnit).not.toBeNull();
		expect(s.views.getNode("default", "c-mixed")!.children.at(-1)!.id).toBe(underUnit!.id);
	});
});

describe("startAddUnderBlock — E3 pool misconfigured", () => {
	it.each(["", "  ", ".", "/", "//"])("pool %j: Notice with the existing wording, zero vault writes, zero placeUnit calls, lock released", async (pool) => {
		const s = setup(tMany());
		const placeUnitSpy = vi.fn();
		const selectOnly = vi.fn();
		const createSpy = vi.spyOn(s.app.vault, "create");
		const createFolderSpy = vi.spyOn(s.app.vault, "createFolder");
		const deps = blockDeps(s, { getPoolFolder: () => pool, placeUnit: placeUnitSpy, selectOnly });

		const result = await startAddUnderBlock(deps, "default", "ft");

		expect(result).toBeNull();
		expect(createSpy).not.toHaveBeenCalled();
		expect(createFolderSpy).not.toHaveBeenCalled();
		expect(placeUnitSpy).not.toHaveBeenCalled();
		expect(selectOnly).not.toHaveBeenCalled(); // the selection is left exactly as it was
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("the pool folder setting is empty or the vault root");
		expect(s.views.getNode("default", "ft")!.children).toHaveLength(4); // unchanged (tMany's "ft")

		// The lock is released even on this failure: a second attempt on the same parent runs again
		// right away (and fails the same way, since the pool is still misconfigured).
		Notice.reset();
		const second = await startAddUnderBlock(deps, "default", "ft");
		expect(second).toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).not.toContain("already adding"); // the lock really was free
		expect(selectOnly).not.toHaveBeenCalled();
	});

	it("a missing pool folder with a valid setting is created on demand, then removed again (empty) if the nest step fails", async () => {
		const s = setup(tMany(), { pool: "_pool" });
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		s.app.vault.create = async (path: string, data: string) => {
			const file = await originalCreate(path, data);
			s.views.deleteMetaFolder("default", "ft"); // vanishes between create and nest
			return file;
		};
		const deps = blockDeps(s, { getPoolFolder: () => "_fresh_pool" });

		const result = await startAddUnderBlock(deps, "default", "ft");

		expect(result).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("_fresh_pool")).toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");
	});
});

describe("startAddUnderBlock — failure paths roll back, Notice, no node, selection unchanged", () => {
	it("vault.create rejects: rolled back, Notice, no node added, lock released", async () => {
		const s = setup(tMany());
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		let shouldFail = true;
		s.app.vault.create = async (path: string, data: string) => {
			if (shouldFail) throw new Error("disk full");
			return originalCreate(path, data);
		};
		const before = s.listing();
		const selectOnly = vi.fn();
		const deps = blockDeps(s, { selectOnly });

		const result = await startAddUnderBlock(deps, "default", "ft");

		expect(result).toBeNull();
		expect(s.listing()).toEqual(before);
		expect(s.views.getNode("default", "ft")!.children).toHaveLength(4);
		expect(selectOnly).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("disk full");

		// Lock released: the same parent can run again right away.
		shouldFail = false;
		const again = await startAddUnderBlock(blockDeps(s, { random: () => 1 / 36 }), "default", "ft");
		expect(again).not.toBeNull();
	});

	it("placeUnit returns null (parent gone immediately before nesting): file deleted, Notice, no node, selection unchanged, lock and hold released", async () => {
		const s = setup(tMany());
		const before = s.listing().filter((p) => !p.startsWith("_pool/"));
		const selectOnly = vi.fn();
		const expandParent = vi.fn();
		const placeUnit = vi.fn(() => null);
		const heldPaths: string[] = [];
		const deps = blockDeps(s, {
			placeUnit,
			selectOnly,
			expandParent,
			holdUnit: (path: string) => {
				heldPaths.push(path);
				return s.index.holdUnit(path);
			},
		});

		const result = await startAddUnderBlock(deps, "default", "ft");

		expect(result).toBeNull();
		// The file `createOnDisk` made is rolled back; nothing new is left on disk anywhere.
		expect(s.listing().filter((p) => !p.startsWith("_pool/"))).toEqual(before);
		expect(s.app.vault.getFiles().some((f) => f.path.startsWith("_pool/") && f.path.endsWith(".md") && s.contentOf(f.path) === "")).toBe(false);
		expect(placeUnit).toHaveBeenCalledTimes(1);
		expect(s.views.getNode("default", "ft")!.children).toHaveLength(4); // nothing added under the parent
		expect(selectOnly).not.toHaveBeenCalled();
		expect(expandParent).not.toHaveBeenCalled();
		expect(heldPaths).toHaveLength(1);
		expect(heldCount(s.index, heldPaths[0])).toBe(0);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");

		const lock = acquireParentLock("default", "ft", false);
		expect(lock).not.toBeNull();
		lock!();
	});

	it("placeUnit throws (treated the same as a null return): rolled back, Notice, no node, selection unchanged, lock and hold released", async () => {
		const s = setup(tMany());
		const selectOnly = vi.fn();
		const placeUnit = vi.fn(() => {
			throw new Error("boom");
		});
		const heldPaths: string[] = [];
		const deps = blockDeps(s, {
			placeUnit,
			selectOnly,
			holdUnit: (path: string) => {
				heldPaths.push(path);
				return s.index.holdUnit(path);
			},
		});

		const result = await startAddUnderBlock(deps, "default", "ft");

		expect(result).toBeNull();
		expect(s.app.vault.getFiles().some((f) => f.path.startsWith("_pool/") && s.contentOf(f.path) === "")).toBe(false);
		expect(s.views.getNode("default", "ft")!.children).toHaveLength(4);
		expect(selectOnly).not.toHaveBeenCalled();
		expect(heldPaths).toHaveLength(1);
		expect(heldCount(s.index, heldPaths[0])).toBe(0);
		expect(Notice.instances).toHaveLength(1);

		// The lock is free again: a real add on the same parent now runs to completion.
		const again = await startAddUnderBlock(blockDeps(s, { random: () => 1 / 36 }), "default", "ft");
		expect(again).not.toBeNull();
		expect(s.views.getNode("default", "ft")!.children).toHaveLength(5);
	});

	it("parent already gone before anything is created: Notice, zero vault writes, no node", async () => {
		const s = setup(tMany());
		const createSpy = vi.spyOn(s.app.vault, "create");
		const deps = blockDeps(s);

		const result = await startAddUnderBlock(deps, "default", "does-not-exist");

		expect(result).toBeNull();
		expect(createSpy).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");
	});
});

describe("startAddUnderBlock — opening the new block in the editor fails", () => {
	it("openFile rejects: still resolves to the node (already placed, expanded, selected), with a Notice naming the open failure", async () => {
		const s = setup(tMany());
		const selectOnly = vi.fn();
		const deps = blockDeps(s, { selectOnly });
		(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = vi.fn(() => ({
			openFile: vi.fn(async () => {
				throw new Error("no leaf available");
			}),
		}));

		const created = await startAddUnderBlock(deps, "default", "ft");

		expect(created).not.toBeNull();
		const ft = s.views.getNode("default", "ft")!;
		expect(ft.children.at(-1)!.id).toBe(created!.id);
		expect(ft.collapsed).toBe(false);
		expect(selectOnly).toHaveBeenCalledWith(created!.id);
		expect(s.contentOf(newBlockPath(created!))).toBe(""); // the file stays: nothing is rolled back
		expect(heldCount(s.index, newBlockPath(created!))).toBe(0);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toBe("Atlas: the block was added, but opening it failed: no leaf available");

		// And the lock came free, so the same parent can be added under again.
		const lock = acquireParentLock("default", "ft", false);
		expect(lock).not.toBeNull();
		lock!();
	});

	it("the editor cursor step failing is reported the same way", async () => {
		const s = setup(tMany());
		const deps = blockDeps(s);
		(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getActiveViewOfType = vi.fn(() => {
			throw new Error("editor gone");
		});

		const created = await startAddUnderBlock(deps, "default", "ft");

		expect(created).not.toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("the block was added, but opening it failed: editor gone");
	});
});

describe("startAddUnderBlock — E7 inbox hold", () => {
	it("the hold is active across create to placeUnit, and released once the node is nested", async () => {
		const s = setup(tMany());
		const inboxPaths = () => s.views.getInboxUnits(s.index.getUnits(), "default", "view").map((u) => u.path);
		let midCreatePaths: string[] | null = null;
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		s.app.vault.create = async (path: string, data: string) => {
			const file = await originalCreate(path, data);
			midCreatePaths = inboxPaths();
			return file;
		};
		const deps = blockDeps(s);

		const created = await startAddUnderBlock(deps, "default", "ft");

		expect(created).not.toBeNull();
		const path = newBlockPath(created!);
		expect(midCreatePaths).not.toContain(path);
		expect(heldCount(s.index, path)).toBe(0);
	});

	it("the hold is released on a failure too, so nothing stays hidden", async () => {
		const s = setup(tMany());
		let createdPath = "";
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		s.app.vault.create = async (path: string, data: string) => {
			createdPath = path;
			const file = await originalCreate(path, data);
			s.views.deleteMetaFolder("default", "ft");
			return file;
		};
		const deps = blockDeps(s);

		const result = await startAddUnderBlock(deps, "default", "ft");

		expect(result).toBeNull();
		expect(heldCount(s.index, createdPath)).toBe(0);
	});
});

describe("startAddUnderBlock — E6 the shared per-parent lock (concurrency)", () => {
	it("a second Block add on the same parent while one runs is ignored with a Notice; a different parent still proceeds", async () => {
		const s = setup(tMany());
		const deps = blockDeps(s);

		const first = startAddUnderBlock(deps, "default", "ft");
		const second = startAddUnderBlock(deps, "default", "ft");
		const other = startAddUnderBlock(blockDeps(s, { random: () => 1 / 36 }), "default", "b");
		const [firstResult, secondResult, otherResult] = await Promise.all([first, second, other]);

		expect(firstResult).not.toBeNull();
		expect(secondResult).toBeNull();
		expect(otherResult).not.toBeNull();
		expect(Notice.instances.some((n) => n.message.toLowerCase().includes("already adding"))).toBe(true);
	});
});

describe("startAddUnderBlock — F6 pool-only, and never the toolbar's addBlock", () => {
	it("never calls commands.ts's addBlock, and writes only under the pool (nothing new at the vault root)", async () => {
		const s = setup(tMany());
		const rootEntriesBefore = s.app.vault.getRoot().children.length;
		const deps = blockDeps(s);

		const created = await startAddUnderBlock(deps, "default", "ft");

		expect(created).not.toBeNull();
		expect(addBlock).not.toHaveBeenCalled();
		const path = newBlockPath(created!);
		expect(path.startsWith("_pool/")).toBe(true);
		expect(s.app.vault.getRoot().children.length).toBe(rootEntriesBefore);
	});
});
