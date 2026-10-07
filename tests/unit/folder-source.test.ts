import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "obsidian";
import { App as MockApp, TFolder, Vault } from "../../tests/mocks/obsidian";
import { buildFolderSourceChildren, folderToRows, isAncestorOrSelf, reconcileManagedChildren } from "../../src/folder-source";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, UnitRef, ViewNode } from "../../src/types";

function source(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		...overrides,
	};
}

let nextId = 0;
function unitNode(ref: UnitRef, overrides: Partial<ViewNode> = {}): ViewNode {
	nextId += 1;
	return { id: `n${nextId}`, type: "unit", ref, children: [], ...overrides };
}

describe("folderToRows — G3/G4", () => {
	it("lists only direct children, filtered independently by showFiles/showFolders", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		vault.seedFolder("Projects/Sub");
		vault.seedFile("Projects/b.md");
		const target = vault.getAbstractFileByPath("Projects") as TFolder;

		expect(folderToRows(target, { showFiles: true, showFolders: true })).toEqual([
			{ kind: "file", path: "Projects/a.md" },
			{ kind: "folder", path: "Projects/Sub" },
			{ kind: "file", path: "Projects/b.md" },
		]);
	});

	it("showFiles off hides files, keeps folders", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		vault.seedFolder("Projects/Sub");
		const target = vault.getAbstractFileByPath("Projects") as TFolder;

		expect(folderToRows(target, { showFiles: false, showFolders: true })).toEqual([{ kind: "folder", path: "Projects/Sub" }]);
	});

	it("showFolders off hides folders, keeps files", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		vault.seedFolder("Projects/Sub");
		const target = vault.getAbstractFileByPath("Projects") as TFolder;

		expect(folderToRows(target, { showFiles: true, showFolders: false })).toEqual([{ kind: "file", path: "Projects/a.md" }]);
	});

	it("an empty folder with both toggles off (or just empty) produces zero rows", () => {
		const vault = new Vault();
		vault.seedFolder("Empty");
		const target = vault.getAbstractFileByPath("Empty") as TFolder;

		expect(folderToRows(target, { showFiles: true, showFolders: true })).toEqual([]);
		expect(folderToRows(target, { showFiles: false, showFolders: false })).toEqual([]);
	});
});

describe("isAncestorOrSelf", () => {
	it("is true for the identical path", () => {
		expect(isAncestorOrSelf("Projects", "Projects")).toBe(true);
	});

	it("is true for a descendant path", () => {
		expect(isAncestorOrSelf("Projects", "Projects/Sub/file.md")).toBe(true);
	});

	it("is false for an unrelated or sibling path", () => {
		expect(isAncestorOrSelf("Projects", "Other")).toBe(false);
		expect(isAncestorOrSelf("Projects", "ProjectsArchive")).toBe(false);
	});
});

describe("reconcileManagedChildren — G7/G9/E2", () => {
	it("appends new managed children for refs with no existing match", () => {
		const result = reconcileManagedChildren([], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "file", path: "Projects/a.md" });
		expect(result[0].folderSourceManaged).toBe(true);
	});

	it("keeps a reordered/renested managed child in place even if its ref vanished from desiredRefs (never auto-removed)", () => {
		const existing = [unitNode({ kind: "file", path: "Projects/gone.md" }, { folderSourceManaged: true })];
		const result = reconcileManagedChildren(existing, [], { showFiles: true, showFolders: true }, (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(result).toEqual(existing);
	});

	it("leaves non-managed children (hand-nested by the user) untouched and does not dedupe them against managed rows", () => {
		const handNested = unitNode({ kind: "file", path: "Projects/a.md" });
		const result = reconcileManagedChildren([handNested], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		// The hand-nested node is kept, and a second managed node for the same ref is also added —
		// reconcile only matches against its own previously-managed rows, not arbitrary existing refs.
		expect(result).toHaveLength(2);
		expect(result[0]).toBe(handNested);
	});

	it("toggling a kind off removes that kind's managed children, lifting their own children up one level", () => {
		const grandchild = unitNode({ kind: "file", path: "Projects/Sub/inner.md" });
		const managedFolder = unitNode({ kind: "folder", path: "Projects/Sub" }, { folderSourceManaged: true, children: [grandchild] });
		const managedFile = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true });
		const result = reconcileManagedChildren([managedFolder, managedFile], [], { showFiles: true, showFolders: false }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toEqual([grandchild, managedFile]);
	});

	it("a managed child whose kind is still enabled is kept exactly once even when its ref reappears in desiredRefs", () => {
		const existing = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true });
		const result = reconcileManagedChildren([existing], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toEqual([existing]);
	});

	it("R1: does not duplicate a ref already managed elsewhere in the view (dedupe.managedElsewhere)", () => {
		const result = reconcileManagedChildren(
			[],
			[{ kind: "file", path: "Projects/a.md" }],
			{ showFiles: true, showFolders: true },
			(ref) => unitNode(ref, { folderSourceManaged: true }),
			{ managedElsewhere: new Set(["file:Projects/a.md"]) }
		);
		expect(result).toEqual([]);
	});

	it("R1: does not recreate a ref the user explicitly removed (dedupe.removedRefs)", () => {
		const result = reconcileManagedChildren(
			[],
			[{ kind: "file", path: "Projects/a.md" }],
			{ showFiles: true, showFolders: true },
			(ref) => unitNode(ref, { folderSourceManaged: true }),
			{ removedRefs: new Set(["file:Projects/a.md"]) }
		);
		expect(result).toEqual([]);
	});
});

describe("buildFolderSourceChildren — G16/E1", () => {
	// PR-5: Outside Vault is no longer a no-op — see tests/unit/folder-source-outside-children-behavior.test.ts
	// for the full Outside-Vault reconciliation contract. This just confirms hand-placed (non-managed)
	// children in `existingChildren` pass through untouched when no outside path resolves, matching the
	// "anything else is left alone" contract `reconcileManagedChildren` already documents.
	it("location 'outside' with no resolving path leaves hand-placed (non-managed) children untouched", () => {
		const existing = [unitNode({ kind: "file", path: "x.md" })];
		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ location: "outside" }), existing, (ref) => unitNode(ref));
		expect(result).toEqual(existing);
	});

	it("an unresolvable target folder falls back to a single missing-ref sentinel managed child", () => {
		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Gone" }), [], (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "folder", path: "Gone" });
		expect(result[0].folderSourceManaged).toBe(true);
	});

	it("reuses the same sentinel node (by ref equality) across refreshes while the target stays missing", () => {
		const vaultLike = { getAbstractFileByPath: () => null };
		const first = buildFolderSourceChildren(vaultLike, source({ path: "Gone" }), [], (ref) => unitNode(ref, { folderSourceManaged: true }));
		const second = buildFolderSourceChildren(vaultLike, source({ path: "Gone" }), first, (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(second).toHaveLength(1);
		expect(second[0]).toBe(first[0]);
	});

	it("drops non-managed children too once the target becomes unresolvable (nothing resolvable to reconcile against)", () => {
		const nonManaged = unitNode({ kind: "file", path: "keep-me.md" });
		const existingSentinel = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Gone" }), [], (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Gone" }), [nonManaged, ...existingSentinel], (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toContain(nonManaged);
		expect(result.filter((n) => n.folderSourceManaged)).toHaveLength(1);
	});

	it("a resolvable target reconciles ordinary rows via folderToRows/reconcileManagedChildren", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		const result = buildFolderSourceChildren(vault, source(), [], (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(result).toEqual([expect.objectContaining({ ref: { kind: "file", path: "Projects/a.md" }, folderSourceManaged: true })]);
	});

	it("edge case: a target folder that is an ancestor of, or identical to, the source Folder's own location does not crash (isAncestorOrSelf is available for callers to guard with)", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFolder("Projects/Sub");
		expect(isAncestorOrSelf("Projects", "Projects")).toBe(true);
		expect(() => buildFolderSourceChildren(vault, source({ path: "Projects" }), [], (ref) => unitNode(ref, { folderSourceManaged: true }))).not.toThrow();
	});

	it("R2: keeps existing managed rows as-is when the target folder stops resolving, instead of collapsing them into a sentinel", () => {
		const nestedChild = unitNode({ kind: "file", path: "Projects/Sub/inner.md" });
		const managedFolder = unitNode(
			{ kind: "folder", path: "Projects/Sub" },
			{ folderSourceManaged: true, children: [nestedChild], explicitStatusId: "done" }
		);
		const managedFile = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true, collapsed: true });
		const existing = [managedFolder, managedFile];

		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Projects" }), existing, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);

		expect(result).toBe(existing);
		expect(result).toEqual([managedFolder, managedFile]);
	});
});

describe("buildFolderSourceChildren — location 'outside', R1/R2 (PR-5)", () => {
	it("R1/R2: keeps existing managed rows exactly as-is — same array, preserving explicitStatusId/collapsed/nested children — when the device-local path is unresolved", () => {
		const nestedChild = unitNode({ kind: "file", path: "inner.md" });
		const managedFolder = unitNode({ kind: "folder", path: "Sub" }, { folderSourceManaged: true, children: [nestedChild], explicitStatusId: "done" });
		const managedFile = unitNode({ kind: "file", path: "a.md" }, { folderSourceManaged: true, collapsed: true });
		const existing = [managedFolder, managedFile];

		// "" simulates both R1 (a local path that's set but the drive is currently unplugged — the
		// path itself fails to resolve) and R2 (a second device that has never had a local path stored
		// for this source at all — `folderSourcePathStore.get` returns "").
		const result = buildFolderSourceChildren(
			{ getAbstractFileByPath: () => null },
			source({ location: "outside" }),
			existing,
			(ref) => unitNode(ref, { folderSourceManaged: true }),
			undefined,
			""
		);

		expect(result).toBe(existing);
		expect(result).toEqual([managedFolder, managedFile]);
	});

	it("R2: a second device with no local path stored for this source never wipes the managed children the first device already synced", () => {
		const managedFromDeviceA = unitNode({ kind: "file", path: "notes.md" }, { folderSourceManaged: true, explicitStatusId: "doing" });
		const existing = [managedFromDeviceA];

		const onDeviceB = buildFolderSourceChildren(
			{ getAbstractFileByPath: () => null },
			source({ location: "outside" }),
			existing,
			(ref) => unitNode(ref, { folderSourceManaged: true }),
			undefined,
			"" // device B's folderSourcePathStore has no entry for this node id
		);

		expect(onDeviceB).toBe(existing);
		expect(onDeviceB[0]).toBe(managedFromDeviceA);
		expect(onDeviceB[0].explicitStatusId).toBe("doing");
	});

	it("R1: recovers automatically once the path resolves again — the same managed node is kept (never recreated), preserving explicit status/collapsed state/nested children", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-folder-recover-test-"));
		try {
			fs.writeFileSync(path.join(tmpDir, "a.md"), "x");

			const nestedChild = unitNode({ kind: "file", path: "inner.md" });
			const managedFolder = unitNode(
				{ kind: "folder", path: "Sub" },
				{ folderSourceManaged: true, children: [nestedChild], explicitStatusId: "done" }
			);
			const managedFile = unitNode({ kind: "file", path: "a.md" }, { folderSourceManaged: true, collapsed: true });
			const existing = [managedFolder, managedFile];

			// The drive is unplugged: everything is left exactly as-is (R1/R2).
			const whileUnplugged = buildFolderSourceChildren(
				{ getAbstractFileByPath: () => null },
				source({ location: "outside" }),
				existing,
				(ref) => unitNode(ref, { folderSourceManaged: true }),
				undefined,
				""
			);
			expect(whileUnplugged).toBe(existing);

			// The drive reconnects at tmpDir: the previously-managed rows are kept, not rebuilt from scratch.
			const afterRecovery = buildFolderSourceChildren(
				{ getAbstractFileByPath: () => null },
				source({ location: "outside" }),
				whileUnplugged,
				(ref) => unitNode(ref, { folderSourceManaged: true }),
				undefined,
				tmpDir
			);

			expect(afterRecovery).toContain(managedFile);
			expect(managedFile.collapsed).toBe(true);
			expect(afterRecovery).toContain(managedFolder);
			expect(managedFolder.explicitStatusId).toBe("done");
			expect(managedFolder.children).toEqual([nestedChild]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

function makeViewsManager() {
	return new ViewsManager({} as App, [], "", () => {});
}

describe("vault-relative path storage round-trip — G5", () => {
	it("setFolderSource stores a plain vault-relative path string, unchanged through a save/reload cycle, with no absolute-path leakage", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects/Sub" }));

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("\"path\":\"Projects/Sub\"");
		expect(persistedJson).not.toMatch(/"path":"\/|"path":"[A-Za-z]:\\/);

		const reloaded = new ViewsManager({} as App, JSON.parse(persistedJson), "", () => {});
		const reloadedSource = reloaded.getNode(view.id, folder.id)!.folderSource!;
		expect(reloadedSource.location).toBe("inside");
		expect(reloadedSource.path).toBe("Projects/Sub");
		expect(reloadedSource.showFiles).toBe(true);
		expect(reloadedSource.showFolders).toBe(true);
	});
});

describe("ref-rewrite-on-rename — G5", () => {
	it("onVaultRename rewrites folderSource.path when the target folder itself is renamed/moved, via the same rewrite call used by other reference types", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects" }));

		vm.onVaultRename("Projects", "Renamed");

		expect(vm.getNode(view.id, folder.id)!.folderSource!.path).toBe("Renamed");
	});

	it("onVaultRename rewrites folderSource.path when an ancestor folder is renamed/moved (descendant path)", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects/Sub" }));

		vm.onVaultRename("Projects", "Renamed");

		expect(vm.getNode(view.id, folder.id)!.folderSource!.path).toBe("Renamed/Sub");
	});

	it("onVaultRename leaves an unrelated folderSource.path untouched", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Unrelated" }));

		vm.onVaultRename("Projects", "Renamed");

		expect(vm.getNode(view.id, folder.id)!.folderSource!.path).toBe("Unrelated");
	});
});

describe("removedRefs-rewrite-on-rename — R8", () => {
	it("onVaultRename rewrites a removedRefs key when the source's own target folder is renamed/moved", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects", removedRefs: ["file:Projects/a.md"] }));

		vm.onVaultRename("Projects", "Renamed");

		const rewritten = vm.getNode(view.id, folder.id)!.folderSource!;
		expect(rewritten.path).toBe("Renamed");
		expect(rewritten.removedRefs).toEqual(["file:Renamed/a.md"]);
	});

	it("onVaultRename rewrites a removedRefs key when the individually removed child itself is renamed", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects", removedRefs: ["file:Projects/a.md"] }));

		vm.onVaultRename("Projects/a.md", "Projects/renamed.md");

		const rewritten = vm.getNode(view.id, folder.id)!.folderSource!;
		expect(rewritten.path).toBe("Projects");
		expect(rewritten.removedRefs).toEqual(["file:Projects/renamed.md"]);
	});

	it("onVaultRename rewrites a removedRefs key for a folder- or block-kind ref the same way", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(
			view.id,
			folder.id,
			source({ path: "Projects", removedRefs: ["folder:Projects/Sub", "block:Projects/a.md#^abc"] })
		);

		vm.onVaultRename("Projects", "Renamed");

		const rewritten = vm.getNode(view.id, folder.id)!.folderSource!;
		expect(rewritten.removedRefs).toEqual(["folder:Renamed/Sub", "block:Renamed/a.md#^abc"]);
	});

	it("onVaultRename leaves an unrelated removedRefs key untouched", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects", removedRefs: ["file:Unrelated/a.md"] }));

		vm.onVaultRename("Projects", "Renamed");

		const rewritten = vm.getNode(view.id, folder.id)!.folderSource!;
		expect(rewritten.removedRefs).toEqual(["file:Unrelated/a.md"]);
	});

	it("end-to-end: removing a managed child, then renaming it, then refreshing, does not resurrect it under its new name", () => {
		const app = new MockApp();
		app.vault.seedFolder("Proj");
		const aFile = app.vault.seedFile("Proj/a.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Proj" }));
		vm.refreshFolderSource(view.id, folder.id);

		const aNode = vm.getNode(view.id, folder.id)!.children.find((n) => n.ref && n.ref.path === "Proj/a.md")!;
		vm.unplaceNode(view.id, aNode.id);
		expect(vm.getNode(view.id, folder.id)!.folderSource!.removedRefs).toEqual(["file:Proj/a.md"]);

		return app.vault.rename(aFile, "Proj/renamed.md").then(() => {
			vm.onVaultRename("Proj/a.md", "Proj/renamed.md");
			expect(vm.getNode(view.id, folder.id)!.folderSource!.removedRefs).toEqual(["file:Proj/renamed.md"]);

			vm.refreshFolderSource(view.id, folder.id);

			const renamedRef: UnitRef = { kind: "file", path: "Proj/renamed.md" };
			expect(countRef(view.root, renamedRef)).toBe(0);
		});
	});
});

/** Counts how many nodes anywhere in the tree (recursively, not just direct children) carry `ref`. */
function countRef(nodes: ViewNode[], ref: UnitRef): number {
	let count = 0;
	for (const node of nodes) {
		if (node.ref && node.ref.kind === ref.kind && node.ref.path === ref.path) count += 1;
		count += countRef(node.children, ref);
	}
	return count;
}

describe("R1 end-to-end — a managed row survives refresh after being moved or removed by hand", () => {
	function makeRealViewsManager() {
		const app = new MockApp();
		app.vault.seedFolder("Projects");
		app.vault.seedFile("Projects/a.md");
		app.vault.seedFile("Projects/b.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source());
		vm.refreshFolderSource(view.id, folder.id);
		return { vm, view, folder };
	}

	it("nesting a managed child under another managed child, then refreshing, does not duplicate it", () => {
		const { vm, view, folder } = makeRealViewsManager();
		const aRef: UnitRef = { kind: "file", path: "Projects/a.md" };
		const children = vm.getNode(view.id, folder.id)!.children;
		const aNode = children.find((n) => n.ref && n.ref.path === "Projects/a.md")!;
		const bNode = children.find((n) => n.ref && n.ref.path === "Projects/b.md")!;

		expect(vm.moveNode(view.id, aNode.id, bNode.id, 0)).toBe(true);
		vm.refreshFolderSource(view.id, folder.id);

		expect(countRef(view.root, aRef)).toBe(1);
		expect(vm.getNode(view.id, bNode.id)!.children.some((n) => n.id === aNode.id)).toBe(true);
	});

	it("dragging a managed child out to the view's top level, then refreshing, does not duplicate it", () => {
		const { vm, view, folder } = makeRealViewsManager();
		const aRef: UnitRef = { kind: "file", path: "Projects/a.md" };
		const children = vm.getNode(view.id, folder.id)!.children;
		const aNode = children.find((n) => n.ref && n.ref.path === "Projects/a.md")!;

		expect(vm.moveNode(view.id, aNode.id, null, view.root.length)).toBe(true);
		vm.refreshFolderSource(view.id, folder.id);

		expect(countRef(view.root, aRef)).toBe(1);
		expect(view.root.some((n) => n.id === aNode.id)).toBe(true);
	});

	it("removing a managed child via unplaceNode, then refreshing, does not resurrect it", () => {
		const { vm, view, folder } = makeRealViewsManager();
		const aRef: UnitRef = { kind: "file", path: "Projects/a.md" };
		const children = vm.getNode(view.id, folder.id)!.children;
		const aNode = children.find((n) => n.ref && n.ref.path === "Projects/a.md")!;

		vm.unplaceNode(view.id, aNode.id);
		expect(countRef(view.root, aRef)).toBe(0);

		vm.refreshFolderSource(view.id, folder.id);

		expect(countRef(view.root, aRef)).toBe(0);
	});
});
