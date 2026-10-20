import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { UnitRef, ViewNode } from "../../src/types";
import { AddUnderModuleDeps, startAddUnderModule } from "../../src/add-under-module";
import { acquireParentLock } from "../../src/create-and-nest";
import { file, meta, unit } from "../integration/create-from-meta-fixtures";
import { heldCount, seedRoot } from "../helpers";

// PR-3.F3: mirrors add-under-file.test.ts (PR-3.F2) almost exactly — same shared foundation, same
// name dialog, same mock-driving pattern — but for the Module kind: `<name>/<name>.md` instead of
// `<name>.md`, and a `{ kind: "folder" }` ref instead of `{ kind: "file" }`. `openNameDialog` is
// replaced by a controllable spy for most of this file; one test (the "real dialog" clash case)
// leaves `dialogMock.impl` unset, so the spy falls through to the real implementation (kept via
// `importOriginal`), proving the exact options this flow builds really drive a real dialog's clash
// detection, not just that the spy was called with the right shape.
const dialogMock = vi.hoisted(() => ({ impl: null as ((app: unknown, options: unknown) => Promise<string | null>) | null }));

vi.mock("../../src/name-dialog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/name-dialog")>();
	return {
		...actual,
		openNameDialog: vi.fn((app: unknown, options: unknown) => (dialogMock.impl ?? actual.openNameDialog)(app, options)),
	};
});

// eslint-disable-next-line import/order
import { openNameDialog } from "../../src/name-dialog";
// eslint-disable-next-line import/order
import { button, flush, inputEl, key, messageEl, modals, type } from "../helpers";

const VIEW_ID = "v1";

/** Folder "Projects" containing file row "quarry-drones" and a Folder "Docs", as the spec asks for. */
function tree(): ViewNode[] {
	return [meta("projects", "Projects", [unit("quarry-drones", file("quarry-drones.md")), meta("docs", "Docs")])];
}

function setup(root: ViewNode[] = tree(), extraRootFiles: string[] = [], extraRootFolders: string[] = []) {
	const app = new App();
	seedRoot(app, ["quarry-drones.md", ...extraRootFiles], extraRootFolders);
	const vm = new ViewsManager(app as unknown as App, [{ id: VIEW_ID, name: "Default", inboxMode: "view", root }], VIEW_ID, () => {});
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, poolFolder: "_pool", excludedFolders: ["_pool"] }, []);
	index.rebuild();
	app.vault.on("create", (f) => index.onVaultCreate(f));
	app.vault.on("delete", (f) => index.onVaultDelete(f.path));
	const selection = new Set<string>();
	const placeNewUnit = vi.fn((viewId: string, ref: UnitRef, parentId: string | null) => vm.placeNewUnit(viewId, ref, parentId));
	const getParentLabel = vi.fn(async (viewId: string, parentId: string) => {
		const node = vm.getNode(viewId, parentId);
		if (!node) return "";
		return node.type === "meta" ? node.label ?? "" : "quarry-drones";
	});
	const deps: AddUnderModuleDeps = {
		app: app as unknown as App,
		getPoolFolder: () => "_pool",
		getExcludedFolders: () => ["_pool"],
		holdUnit: (path: string) => index.holdUnit(path),
		getNode: (viewId, nodeId) => vm.getNode(viewId, nodeId),
		getParentLabel: (viewId, parentId) => getParentLabel(viewId, parentId),
		placeNewUnit: (viewId, ref, parentId) => placeNewUnit(viewId, ref, parentId),
		expandParent: (viewId, parentId) => vm.setNodeCollapsed(viewId, parentId, false),
		selectOnly: (nodeId) => {
			selection.clear();
			selection.add(nodeId);
		},
		save: vi.fn(async () => {}),
	};
	return { app, vm, index, deps, selection, placeNewUnit, getParentLabel };
}

/** A lightweight `AddUnderModuleDeps` for tests that only care about the dialog's own options
 * (title label), not a real tree — the parent always "exists", nothing is ever placed. */
function minimalDeps(overrides: Partial<AddUnderModuleDeps> = {}): AddUnderModuleDeps {
	return {
		app: new App() as unknown as App,
		getPoolFolder: () => "_pool",
		getExcludedFolders: () => [],
		holdUnit: () => () => {},
		getNode: () => ({ id: "p", type: "meta", children: [] }) as ViewNode,
		getParentLabel: async () => "Parent",
		placeNewUnit: () => null,
		expandParent: () => {},
		selectOnly: () => {},
		save: async () => {},
		...overrides,
	};
}

beforeEach(() => {
	dialogMock.impl = null;
	Notice.reset();
	vi.clearAllMocks();
});

// Defensive, not required by any one test: a thrown assertion inside the "real dialog" test (E2)
// would otherwise leave that modal open and its parent lock held forever, silently failing every
// later test that targets the same parent id with "already adding something here" instead of its
// own real assertion.
afterEach(async () => {
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
});

describe("startAddUnderModule — G3 happy path", () => {
	it("dialog options, creates the folder+note, nests as last child, expands, selects; not opened; not in the inbox", async () => {
		const s = setup();
		dialogMock.impl = async () => "Field Ops";

		const created = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");

		expect(openNameDialog).toHaveBeenCalledWith(s.deps.app, {
			title: "Add module under quarry-drones",
			confirmLabel: "Add",
			mode: "full",
			initialValue: "",
			poolFolder: "_pool",
			excludedFolders: ["_pool"],
		});
		expect(created).not.toBeNull();
		expect(created!.type).toBe("unit");
		expect(created!.ref).toEqual({ kind: "folder", path: "Field Ops" });
		expect(s.app.vault.contents.get("Field Ops/Field Ops.md")).toBe("# Field Ops\n");
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).not.toBeNull();

		const parent = s.vm.getNode(VIEW_ID, "quarry-drones")!;
		expect(parent.children.at(-1)!.id).toBe(created!.id);
		expect(s.placeNewUnit).toHaveBeenCalledWith(VIEW_ID, { kind: "folder", path: "Field Ops" }, "quarry-drones");
		expect(parent.collapsed).toBe(false);
		expect([...s.selection]).toEqual([created!.id]);

		// E7: not left in the Inbox — it was held until nested, and the hold is released right after.
		expect(heldCount(s.index, "Field Ops")).toBe(0);
		const inbox = s.vm.getInboxUnits(s.index.getUnits(), VIEW_ID, "view").map((u) => u.path);
		expect(inbox).not.toContain("Field Ops");
		expect(inbox).not.toContain("Field Ops/Field Ops.md");
	});

	it("works on a Folder row too, and at a deeper nesting depth", async () => {
		const nested: ViewNode[] = [meta("outer", "Outer", [meta("mid", "Mid", [unit("c", file("C.md"))])])];
		const s = setup(nested);

		dialogMock.impl = async () => "Report Module";
		const created = await startAddUnderModule(s.deps, VIEW_ID, "mid");

		expect(created).not.toBeNull();
		expect(s.vm.getNode(VIEW_ID, "mid")!.children.at(-1)!.id).toBe(created!.id);
	});

	it("the unit index's list never contains the module while held, and does after the release, with the node already in the tree", async () => {
		const s = setup();
		let duringNest: boolean | null = null;
		const realPlaceNewUnit = s.deps.placeNewUnit;
		s.deps.placeNewUnit = (viewId, ref, parentId) => {
			// Right before the node is placed — still inside the hold, before `made.release()` runs.
			duringNest = s.index.getUnits().some((u) => u.path === "Field Ops");
			return realPlaceNewUnit(viewId, ref, parentId);
		};
		dialogMock.impl = async () => "Field Ops";

		const created = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");

		expect(created).not.toBeNull();
		expect(duringNest).toBe(false);
		expect(s.index.getUnits().some((u) => u.path === "Field Ops")).toBe(true);
		expect(s.vm.getNode(VIEW_ID, created!.id)).not.toBeNull();
	});
});

describe("startAddUnderModule — G8/E1 cancel", () => {
	it("dialog resolves null: zero vault writes, zero tree writes, lock released", async () => {
		const s = setup();
		const createSpy = vi.spyOn(s.app.vault, "create");
		const createFolderSpy = vi.spyOn(s.app.vault, "createFolder");
		dialogMock.impl = async () => null;

		const result = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(result).toBeNull();
		expect(createSpy).not.toHaveBeenCalled();
		expect(createFolderSpy).not.toHaveBeenCalled();
		expect(s.placeNewUnit).not.toHaveBeenCalled();
		expect(s.vm.getNode(VIEW_ID, "projects")!.children).toHaveLength(2);
		expect(s.selection.size).toBe(0);
		expect(Notice.instances).toHaveLength(0);

		// Lock released: a second attempt on the same parent runs again right away.
		dialogMock.impl = async () => "Fine";
		const second = await startAddUnderModule(s.deps, VIEW_ID, "projects");
		expect(second).not.toBeNull();
	});
});

describe("startAddUnderModule — E2 name taken: the real dialog blocks it", () => {
	it("a real dialog over a vault already containing folder \"Field Ops\": red state and message, no resolve on Enter", async () => {
		const s = setup(tree(), [], ["Field Ops"]);
		// dialogMock.impl stays null here, so the spy falls through to the real openNameDialog.
		const promise = startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");
		await flush();
		expect(modals()).toHaveLength(1);
		expect(document.querySelector(".modal-title")!.textContent).toBe("Add module under quarry-drones");
		expect(button("Add")).toBeTruthy();

		type("Field Ops");
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		expect(messageEl().textContent).toBe("A note or folder called 'Field Ops' already exists at the vault root");
		expect(button("Add").disabled).toBe(true);

		key("Enter");
		await flush();
		expect(modals()).toHaveLength(1); // still open: Enter on an invalid name does nothing

		key("Escape");
		const result = await promise;
		expect(result).toBeNull();
		document.body.innerHTML = "";
	});
});

describe("startAddUnderModule — F5 no moves, only the module's own disk calls", () => {
	it("never calls vault.rename, fileManager.renameFile, or any meta-replace path", async () => {
		const s = setup();
		const renameSpy = vi.spyOn(s.app.vault, "rename");
		const fileManagerRenameSpy = vi.spyOn(s.app.fileManager, "renameFile");
		const replaceSpy = vi.spyOn(s.vm, "replaceMetaNodeWithUnit");
		dialogMock.impl = async () => "Field Ops";

		const created = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(created).not.toBeNull();
		expect(renameSpy).not.toHaveBeenCalled();
		expect(fileManagerRenameSpy).not.toHaveBeenCalled();
		expect(replaceSpy).not.toHaveBeenCalled();
		expect(s.app.vault.calls).toEqual(["createFolder", "create"]);
	});

	it("the parent row's path, its vault file and every other note are untouched", async () => {
		const s = setup();
		const before = [...s.app.vault.getFiles().map((f) => f.path)].sort();
		dialogMock.impl = async () => "Field Ops";

		await startAddUnderModule(s.deps, VIEW_ID, "projects");

		const after = s.app.vault.getFiles().map((f) => f.path).sort();
		expect(after).toEqual([...before, "Field Ops/Field Ops.md"].sort());
		expect(s.app.vault.getAbstractFileByPath("quarry-drones.md")).not.toBeNull();
	});
});

describe("startAddUnderModule — E4 parent-exists checks", () => {
	it("parent already gone before the dialog opens: Notice, no dialog, no node", async () => {
		const s = setup();
		const result = await startAddUnderModule(s.deps, VIEW_ID, "does-not-exist");
		expect(result).toBeNull();
		expect(openNameDialog).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("no longer exists");
	});

	it("parent removed while the dialog is open: on confirm, Notice, no node, nothing created", async () => {
		const s = setup();
		dialogMock.impl = async () => {
			s.vm.deleteMetaFolder(VIEW_ID, "docs");
			return "Archive";
		};
		const createSpy = vi.spyOn(s.app.vault, "createFolder");

		const result = await startAddUnderModule(s.deps, VIEW_ID, "docs");

		expect(result).toBeNull();
		expect(createSpy).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Archive");
		expect(Notice.instances[0].message).toContain("no longer exists");
	});

	it("parent removed between create and nest: folder and note rolled back, Notice, no node", async () => {
		const s = setup();
		const originalCreateFolder = s.app.vault.createFolder.bind(s.app.vault);
		s.app.vault.createFolder = async (path: string) => {
			const f = await originalCreateFolder(path);
			s.vm.deleteMetaFolder(VIEW_ID, "projects");
			return f;
		};
		dialogMock.impl = async () => "Field Ops";

		const result = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(result).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops/Field Ops.md")).toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Field Ops");
		expect(Notice.instances[0].message).toContain("no longer exists");
	});
});

describe("startAddUnderModule — G9 failure rolls back", () => {
	it("createFolder throws: nothing left on disk, one Notice, no node, lock released", async () => {
		const s = setup();
		const shouldFail = { value: true };
		vi.spyOn(s.app.vault, "createFolder").mockImplementation(async () => {
			if (shouldFail.value) throw new Error("disk full");
			throw new Error("unreachable");
		});
		dialogMock.impl = async () => "Field Ops";

		const result = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(result).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Field Ops");
		expect(Notice.instances[0].message).toContain("disk full");
		expect(s.selection.size).toBe(0);

		shouldFail.value = false;
		vi.restoreAllMocks();
		const again = await startAddUnderModule(s.deps, VIEW_ID, "projects");
		expect(again).not.toBeNull();
	});

	it("the folder is created and then its note create throws: the folder is removed, one Notice names the module and the reason, no node", async () => {
		const s = setup();
		vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("note write failed"));
		dialogMock.impl = async () => "Field Ops";

		const result = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(result).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Field Ops");
		expect(Notice.instances[0].message).toContain("note write failed");
		expect(s.selection.size).toBe(0);
	});

	it("placeNewUnit returns null: the folder and note are deleted, Notice, no node, selection unchanged", async () => {
		const s = setup();
		s.placeNewUnit.mockImplementation(() => null);
		dialogMock.impl = async () => "Field Ops";

		const result = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(result).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Field Ops");
		expect(Notice.instances[0].message).toContain("no longer exists");
		expect(s.selection.size).toBe(0);
	});

	it("a module folder that gains an extra child before rollback is left in place, and the Notice says so", async () => {
		const s = setup();
		s.placeNewUnit.mockImplementation(() => null);
		dialogMock.impl = async () => {
			// After the folder+note are created but before the nest/rollback step runs, something
			// else drops an extra file into the module folder — the rollback can't remove it then.
			return "Field Ops";
		};
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		let noteCreated = false;
		s.app.vault.create = async (path: string, data: string) => {
			const f = await originalCreate(path, data);
			if (path === "Field Ops/Field Ops.md" && !noteCreated) {
				noteCreated = true;
				await originalCreate("Field Ops/extra.md", "");
			}
			return f;
		};

		const result = await startAddUnderModule(s.deps, VIEW_ID, "projects");

		expect(result).toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).not.toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops/extra.md")).not.toBeNull();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("isn't empty");
	});
});

/** Every file and folder path in the mock vault, folders suffixed "/", sorted: a full before/after listing. */
function vaultListing(app: App): string[] {
	const out: string[] = [];
	const walk = (folder: { children: unknown[] }) => {
		for (const child of folder.children) {
			const c = child as { path: string; children?: unknown[] };
			out.push(c.children ? `${c.path}/` : c.path);
			if (c.children) walk(c as { children: unknown[] });
		}
	};
	walk(app.vault.getRoot() as unknown as { children: unknown[] });
	return out.sort();
}

// PR-3.F3 R3/R4 (polish): the G9 failure paths asserted in full — the vault is back to its seed (a
// whole before/after listing, not just "Field Ops is absent"), the inbox hold is released, the lock is
// released (the same parent can add again right afterwards) and the selection is untouched.
describe("startAddUnderModule — G9 every failure path restores the seed, releases the hold and the lock", () => {
	const FAILURES: [string, (s: ReturnType<typeof setup>) => void][] = [
		["createFolder throws", (s) => void vi.spyOn(s.app.vault, "createFolder").mockRejectedValue(new Error("disk full"))],
		["the note create throws after the folder was made", (s) => void vi.spyOn(s.app.vault, "create").mockRejectedValue(new Error("note write failed"))],
		["placeNewUnit returns null", (s) => void s.placeNewUnit.mockImplementation(() => null)],
		[
			"placeNewUnit throws",
			(s) =>
				void s.placeNewUnit.mockImplementation(() => {
					throw new Error("nest blew up");
				}),
		],
		[
			"the parent is removed while the disk step runs",
			(s) => {
				const original = s.app.vault.create.bind(s.app.vault);
				vi.spyOn(s.app.vault, "create").mockImplementation(async (...args: Parameters<typeof original>) => {
					s.vm.unplaceNode(VIEW_ID, "quarry-drones");
					return original(...args);
				});
			},
		],
	];

	it.each(FAILURES)("%s", async (_name, arrange) => {
		const s = setup();
		const seed = vaultListing(s.app);
		const rootBefore = s.vm.getView(VIEW_ID)!.root.map((n) => n.id);
		arrange(s);
		dialogMock.impl = async () => "Field Ops";

		const result = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");

		expect(result).toBeNull();
		expect(vaultListing(s.app)).toEqual(seed);
		expect(heldCount(s.index, "Field Ops")).toBe(0);
		expect(s.selection.size).toBe(0);
		expect(s.vm.getView(VIEW_ID)!.root.map((n) => n.id)).toEqual(rootBefore);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain('module "Field Ops"');

		// The lock is free again: a second add under the very same parent goes through (it needs the
		// parent back for the case where the failure removed it).
		vi.restoreAllMocks();
		if (!s.vm.getNode(VIEW_ID, "quarry-drones")) return;
		const again = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");
		expect(again).not.toBeNull();
		expect(heldCount(s.index, "Field Ops")).toBe(0);
	});

	it("rollback incomplete: a delete throws — the Notice says what was left in place, and the hold and lock still clear", async () => {
		const s = setup();
		s.placeNewUnit.mockImplementation(() => null);
		vi.spyOn(s.app.vault, "delete").mockRejectedValue(new Error("permission denied"));
		dialogMock.impl = async () => "Field Ops";

		const result = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");

		expect(result).toBeNull();
		// Nothing could be removed, so the folder and its note are still there...
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).not.toBeNull();
		expect(s.app.vault.getAbstractFileByPath("Field Ops/Field Ops.md")).not.toBeNull();
		// ...and the one Notice says so, with the reason the clean-up gave up.
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain('module "Field Ops"');
		expect(Notice.instances[0].message).toContain("the parent no longer exists");
		expect(Notice.instances[0].message).toContain("Atlas couldn't clean up what it had made (permission denied)");
		expect(heldCount(s.index, "Field Ops")).toBe(0);
		expect(s.vm.getNode(VIEW_ID, "quarry-drones")!.children.map((c) => c.ref)).not.toContainEqual({ kind: "folder", path: "Field Ops" });
		const lock = acquireParentLock(VIEW_ID, "quarry-drones", false);
		expect(lock).not.toBeNull();
		lock!();
	});
});

describe("startAddUnderModule — R1 (G3 edge case): a save failure after a successful add", () => {
	it("flushSave rejecting leaves the module and its node in place and shows its own Notice, not a rollback", async () => {
		const s = setup();
		s.deps.save = vi.fn(async () => Promise.reject(new Error("disk full")));
		dialogMock.impl = async () => "Field Ops";

		const created = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");

		// The add itself still succeeded: real node, real files on disk, nested and selected —
		// none of that is rolled back just because the save afterwards failed.
		expect(created).not.toBeNull();
		expect(created!.ref).toEqual({ kind: "folder", path: "Field Ops" });
		expect(s.app.vault.getAbstractFileByPath("Field Ops")).not.toBeNull();
		expect(s.app.vault.contents.get("Field Ops/Field Ops.md")).toBe("# Field Ops\n");
		const parent = s.vm.getNode(VIEW_ID, "quarry-drones")!;
		expect(parent.children.at(-1)!.id).toBe(created!.id);
		expect([...s.selection]).toEqual([created!.id]);

		expect(s.deps.save).toHaveBeenCalledTimes(1);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Field Ops");
		expect(Notice.instances[0].message).toContain("created");
		expect(Notice.instances[0].message).toContain("saving");
		expect(Notice.instances[0].message).toContain("disk full");
	});

	it("a resolving save shows no Notice at all", async () => {
		const s = setup();
		dialogMock.impl = async () => "Field Ops";

		const created = await startAddUnderModule(s.deps, VIEW_ID, "quarry-drones");

		expect(created).not.toBeNull();
		expect(s.deps.save).toHaveBeenCalledTimes(1);
		expect(Notice.instances).toHaveLength(0);
	});
});

describe("startAddUnderModule — E6 the shared per-parent lock", () => {
	it("a second Module add on the same parent while one runs is ignored with a Notice", async () => {
		const s = setup();
		let resolveDialog: (v: string | null) => void = () => {};
		dialogMock.impl = () => new Promise((resolve) => (resolveDialog = resolve));

		const first = startAddUnderModule(s.deps, VIEW_ID, "projects");
		const second = startAddUnderModule(s.deps, VIEW_ID, "projects");
		await flush(); // lets `first`'s own await-chain reach the dialog call before we resolve it
		resolveDialog("Field Ops");
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult).not.toBeNull();
		expect(secondResult).toBeNull();
		expect(Notice.instances.some((n) => n.message.toLowerCase().includes("already adding"))).toBe(true);
	});

	it("a held lock gives a Notice and no second dialog", async () => {
		const s = setup();
		let resolveDialog: (v: string | null) => void = () => {};
		dialogMock.impl = () => new Promise((resolve) => (resolveDialog = resolve));

		const first = startAddUnderModule(s.deps, VIEW_ID, "projects");
		await flush();
		expect(openNameDialog).toHaveBeenCalledTimes(1);
		Notice.reset();

		const second = await startAddUnderModule(s.deps, VIEW_ID, "projects");
		expect(second).toBeNull();
		expect(openNameDialog).toHaveBeenCalledTimes(1); // no second dialog opened
		expect(Notice.instances.some((n) => n.message.toLowerCase().includes("already adding"))).toBe(true);

		resolveDialog("Field Ops");
		await first;
	});

	it("a different parent still proceeds while the first lock is held", async () => {
		const s = setup();
		let resolveDialog: (v: string | null) => void = () => {};
		dialogMock.impl = async (_app: unknown, options: unknown) => {
			const title = (options as { title: string }).title;
			if (title === "Add module under Projects") return new Promise<string | null>((resolve) => (resolveDialog = resolve));
			return "Notes";
		};

		const first = startAddUnderModule(s.deps, VIEW_ID, "projects");
		const other = startAddUnderModule(s.deps, VIEW_ID, "docs");
		await flush();
		resolveDialog("Field Ops");
		const [firstResult, otherResult] = await Promise.all([first, other]);

		expect(firstResult).not.toBeNull();
		expect(otherResult).not.toBeNull();
	});
});

describe("startAddUnderModule — title label uses the parent's displayed label verbatim", () => {
	it.each([
		["a unit row's own displayed text", "quarry-drones"],
		["a Folder row's label", "Projects"],
		["a nested row", "Deeply Nested Label"],
		["a label with quotes", 'Say "hi"'],
		["a label with an emoji", "Rockets 🚀"],
	])("%s: title is \"Add module under <label>\"", async (_desc, label) => {
		dialogMock.impl = async () => null; // only the title matters here
		const deps = minimalDeps({ getParentLabel: async () => label });

		await startAddUnderModule(deps, "v", "p");

		expect(openNameDialog).toHaveBeenCalledWith(deps.app, expect.objectContaining({ title: `Add module under ${label}` }));
	});
});
