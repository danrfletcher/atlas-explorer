import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "obsidian";
import { App as MockApp, TFile, TFolder, Vault } from "../../tests/mocks/obsidian";
import { buildFolderSourceChildren, collectManagedRefKeys, folderToRows, reconcileManagedChildren } from "../../src/folder-source";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, UnitRef, ViewNode, unitRefKey } from "../../src/types";

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

describe("reconcileManagedChildren — G7/G9/E2", () => {
	it("appends new managed children for refs with no existing match", () => {
		const result = reconcileManagedChildren([], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "file", path: "Projects/a.md" });
		expect(result[0].folderSourceManaged).toBe(true);
	});

	it("PR-4 R6: keeps a managed child in place even if its ref vanished from desiredRefs (never auto-removed)", () => {
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

describe("collectManagedRefKeys — R1 fix", () => {
	it("PR-4 R6: finds a managed row that got dragged out of its source Folder and renested elsewhere in the view", () => {
		const renested = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true, folderSourceOwnerId: "owner1" });
		const unrelatedParent = unitNode({ kind: "folder", path: "Elsewhere" }, { children: [renested] });
		const keys = collectManagedRefKeys([unrelatedParent], "owner1");
		expect(keys.has("file:Projects/a.md")).toBe(true);
	});

	it("ignores a managed row owned by a different Folder source", () => {
		const otherOwners = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true, folderSourceOwnerId: "owner2" });
		const keys = collectManagedRefKeys([otherOwners], "owner1");
		expect(keys.size).toBe(0);
	});

	it("ignores a hand-placed (non-managed) row even if its ref would otherwise match", () => {
		const handPlaced = unitNode({ kind: "file", path: "Projects/a.md" });
		const keys = collectManagedRefKeys([handPlaced], "owner1");
		expect(keys.size).toBe(0);
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

	it("PR-4 R6: keeps non-managed children, and keeps the existing sentinel without duplicating it, once the target is already unresolvable", () => {
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

	it("PR-4 R4: a user-removed sentinel (its key remembered in removedRefs) is not recreated while the target stays missing", () => {
		const removedKey = "folder:Gone";
		const result = buildFolderSourceChildren(
			{ getAbstractFileByPath: () => null },
			source({ path: "Gone", removedRefs: [removedKey] }),
			[],
			(ref) => unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toEqual([]);
	});

	it("PR-4 R4: a sentinel from an unrelated removedRefs entry is unaffected (only its own key suppresses it)", () => {
		const result = buildFolderSourceChildren(
			{ getAbstractFileByPath: () => null },
			source({ path: "Gone", removedRefs: ["file:Projects/a.md"] }),
			[],
			(ref) => unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "folder", path: "Gone" });
	});

	it("PR-4 R10: a managed row dragged elsewhere in the view (not a direct child of this source) still suppresses the missing-target sentinel", () => {
		const renested = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true, folderSourceOwnerId: "src1" });
		const unrelatedParent = unitNode({ kind: "folder", path: "Elsewhere" }, { children: [renested] });
		const result = buildFolderSourceChildren(
			{ getAbstractFileByPath: () => null },
			source({ path: "Gone" }),
			[],
			(ref) => unitNode(ref, { folderSourceManaged: true }),
			{ sourceNodeId: "src1", viewRoot: [unrelatedParent] }
		);
		expect(result).toEqual([]);
	});

	it("PR-4 R10: a managed row owned by a different Folder source does not suppress this source's missing-target sentinel", () => {
		const otherOwners = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true, folderSourceOwnerId: "src2" });
		const result = buildFolderSourceChildren(
			{ getAbstractFileByPath: () => null },
			source({ path: "Gone" }),
			[],
			(ref) => unitNode(ref, { folderSourceManaged: true }),
			{ sourceNodeId: "src1", viewRoot: [otherOwners] }
		);
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "folder", path: "Gone" });
	});

	it("PR-4 R4: once the target folder reappears, the stale missing-target sentinel is dropped instead of rendering the folder as a child of its own source", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		const sentinel = unitNode({ kind: "folder", path: "Projects" }, { folderSourceManaged: true });

		const result = buildFolderSourceChildren(vault, source({ path: "Projects" }), [sentinel], (ref) => unitNode(ref, { folderSourceManaged: true }));

		expect(result.some((n) => n.ref && unitRefKey(n.ref) === "folder:Projects")).toBe(false);
		expect(result).toEqual([expect.objectContaining({ ref: { kind: "file", path: "Projects/a.md" }, folderSourceManaged: true })]);
	});

	it("PR-4 R4: dropping the stale sentinel on reappearance leaves other hand-nested rows untouched", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		const sentinel = unitNode({ kind: "folder", path: "Projects" }, { folderSourceManaged: true });
		const handPlaced = unitNode({ kind: "file", path: "keep-me.md" });

		const result = buildFolderSourceChildren(vault, source({ path: "Projects" }), [sentinel, handPlaced], (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);

		expect(result).toContain(handPlaced);
		expect(result.some((n) => n.ref && unitRefKey(n.ref) === "folder:Projects")).toBe(false);
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

describe("leftSource — PR-1 R3: a managed row whose owner is missing keeps the plain rewrite", () => {
	it("rewrites the ref in place instead of detaching the row when folderSourceOwnerId points at no node", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const orphan: ViewNode = {
			id: "orphan",
			type: "unit",
			ref: { kind: "file", path: "Projects/a.md" },
			children: [],
			folderSourceManaged: true,
			folderSourceOwnerId: "missing-owner",
		};
		view.root.push(orphan);

		vm.onVaultRename("Projects/a.md", "Projects/renamed.md");

		const node = vm.getNode(view.id, "orphan");
		expect(node).toBeDefined();
		expect(node!.ref).toEqual({ kind: "file", path: "Projects/renamed.md" });
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

	it("R5: onVaultRename rewrites a removedRefs block key whose subpath itself contains '#' (a nested-heading link, [[Ideas#H1#H2]])", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects", removedRefs: ["block:Projects/Ideas.md#H1#H2"] }));

		vm.onVaultRename("Projects/Ideas.md", "Projects/Renamed.md");

		const rewritten = vm.getNode(view.id, folder.id)!.folderSource!;
		// Splitting at the last '#' (the R4 fix) would misread the path as 'Projects/Ideas.md#H1' and
		// leave this key unrewritten; splitting at the first would misread a '#'-in-path case (R4).
		// Only matching the known `oldPath` by prefix gets both right.
		expect(rewritten.removedRefs).toEqual(["block:Projects/Renamed.md#H1#H2"]);
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

describe("R1 fix — removing a folder-source owner lifts a hand-nested grandchild of its managed child", () => {
	/** Builds `owner` (a folder-source meta node) → `managed` (its managed child) → `grandchild`
	 * (a plain, non-managed unit hand-nested under `managed` — something only possible for an
	 * Inside-Vault owner, whose managed rows stay ordinary drop zones; an Outside-Vault managed row
	 * is never a drop zone, but the tree shape is built the same way here to exercise the drop path
	 * explicitly regardless). */
	function buildOwnerWithManagedChild(location: "inside" | "outside") {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const grandchild: ViewNode = { id: "grandchild", type: "unit", ref: { kind: "file", path: "Other.md" }, children: [] };
		const managed: ViewNode = {
			id: "managed",
			type: "unit",
			ref: { kind: "file", path: "Projects/a.md" },
			children: [grandchild],
			folderSourceManaged: true,
			folderSourceOwnerId: "owner",
		};
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Folder source",
			children: [managed],
			folderSource: source({ location, path: location === "inside" ? "Projects" : "" }),
		};
		view.root.push(owner);
		return { vm, view };
	}

	it("Inside-Vault: the managed child and its hand-nested grandchild are promoted up one level, not dropped", () => {
		const { vm, view } = buildOwnerWithManagedChild("inside");

		vm.unplaceNode(view.id, "owner");

		expect(view.root.some((n) => n.id === "managed")).toBe(true);
		const promoted = vm.getNode(view.id, "managed")!;
		expect(promoted).toBeDefined();
		expect(promoted.children.some((n) => n.id === "grandchild")).toBe(true);
		expect(vm.getNode(view.id, "grandchild")).toBeDefined();
	});

	it("Outside-Vault: the managed child and its hand-nested grandchild are still dropped with the owner", () => {
		const { vm, view } = buildOwnerWithManagedChild("outside");

		vm.unplaceNode(view.id, "owner");

		expect(view.root).toEqual([]);
		expect(vm.getNode(view.id, "managed")).toBeNull();
		expect(vm.getNode(view.id, "grandchild")).toBeNull();
	});

	/** R1 fix (round 2): a promoted Inside-Vault row must lose its managed identity entirely, not just
	 * move up a level still flagged `folderSourceManaged` with a now-dangling `folderSourceOwnerId` —
	 * every lookup that gates on those fields (delete reconciliation, Swap, another source's own
	 * reconcile) only checks `folderSourceManaged`/`folderSourceOwnerId`, never whether the owner they
	 * point at still exists. */
	it("Inside-Vault: the promoted row's folderSourceManaged/folderSourceOwnerId/folderSourceHiddenAtSave are all cleared", () => {
		const { vm, view } = buildOwnerWithManagedChild("inside");
		const managedBefore = vm.getNode(view.id, "managed")!;
		managedBefore.folderSourceHiddenAtSave = true;

		vm.unplaceNode(view.id, "owner");

		const promoted = vm.getNode(view.id, "managed")!;
		expect(promoted.folderSourceManaged).toBeUndefined();
		expect(promoted.folderSourceOwnerId).toBeUndefined();
		expect(promoted.folderSourceHiddenAtSave).toBeUndefined();
	});

	/** R1 (a): before this fix, `onVaultDelete` still matched the promoted row through
	 * `collectManagedMatches` (it only checks `folderSourceManaged`), found no owner to compute a
	 * placeholder from, and spliced the row out with nothing put back — the whole row vanished instead
	 * of becoming a greyed missing row. Now that promotion clears `folderSourceManaged`, the row is an
	 * ordinary unit node and `onVaultDelete` leaves it alone entirely, exactly like any other unit whose
	 * file goes missing (rendered as a missing row elsewhere, never auto-removed). */
	it("delete-after-removal: deleting the promoted row's file leaves it in the tree instead of vanishing", () => {
		const { vm, view } = buildOwnerWithManagedChild("inside");

		vm.unplaceNode(view.id, "owner");
		vm.onVaultDelete("Projects/a.md");

		const survivor = vm.getNode(view.id, "managed");
		expect(survivor).toBeDefined();
		expect(survivor!.ref).toEqual({ kind: "file", path: "Projects/a.md" });
		expect(survivor!.folderSourceManaged).toBeUndefined();
	});

	/** R1 (b): before this fix, `canSwapNode`/`swapNodeWithUnit` refused the promoted row forever,
	 * since both only check the still-true `folderSourceManaged` flag — "Swap with…" never appeared for
	 * an otherwise-ordinary top-level row. */
	it("swap-after-removal: the promoted row can now be swapped for another unit", () => {
		const { vm, view } = buildOwnerWithManagedChild("inside");

		vm.unplaceNode(view.id, "owner");
		const didSwap = vm.swapNodeWithUnit(view.id, "managed", { kind: "file", path: "Elsewhere.md" });

		expect(didSwap).toBe(true);
		expect(vm.getNode(view.id, "managed")!.ref).toEqual({ kind: "file", path: "Elsewhere.md" });
	});
});

/** PR-1.F2: reconcile with YAML rules. Existing managed rows are always kept, a new non-matching file never
 * joins, and a removed "filtered out" row only comes back once its file matches. The hidden-at-save flag is
 * set by `ViewsManager`, so its per-mode table is checked through that manager at the end. The fixture is a
 * mocked metadataCache with frontmatter for acme, beta and gamma, plus a PDF with none. */
const FRONTMATTER: Record<string, Record<string, unknown> | undefined> = {
	"Jobs/acme.md": { status: "active" },
	"Jobs/beta.md": { status: "done" },
	"Jobs/gamma.md": { status: "active" },
};
const ACTIVE_RULES = [{ key: "status", value: "active" }];

function jobsVault(): Vault {
	const vault = new Vault();
	vault.seedFolder("Jobs");
	for (const path of ["Jobs/acme.md", "Jobs/beta.md", "Jobs/gamma.md", "Jobs/brief.pdf"]) vault.seedFile(path);
	return vault;
}

function jobsSource(rules?: { key: string; value: string }[]): FolderSourceConfig {
	return source({ path: "Jobs", ...(rules ? { filters: { files: { yaml: { rules } } } } : {}) });
}

const managedRow = (path: string): ViewNode => unitNode({ kind: "file", path }, { folderSourceManaged: true, folderSourceOwnerId: "folder" });

function reconcileJobs(existing: ViewNode[], config: FolderSourceConfig, vault = jobsVault()): ViewNode[] {
	const filter = { metadataResolved: true, frontmatterOf: (file: { path: string }) => FRONTMATTER[file.path] };
	return buildFolderSourceChildren(vault, config, existing, (ref) => managedRow(ref.path), { sourceNodeId: "folder", viewRoot: existing, filter });
}

const pathsOf = (nodes: ViewNode[]): (string | undefined)[] => nodes.map((n) => n.ref?.path);

describe("PR-1.F2 — reconcile widens the desired set, and never drops a non-matching managed row", () => {
	it("keeps an existing row that no longer matches in its slot, adds a matching new file, and never adds the PDF", () => {
		const out = reconcileJobs([managedRow("Jobs/acme.md"), managedRow("Jobs/beta.md")], jobsSource(ACTIVE_RULES));
		expect(pathsOf(out)).toEqual(["Jobs/acme.md", "Jobs/beta.md", "Jobs/gamma.md"]);
	});

	it("a new non-matching file is never added; a new matching one is", () => {
		FRONTMATTER["Jobs/delta.md"] = { status: "done" };
		FRONTMATTER["Jobs/eps.md"] = { status: "active" };
		try {
			const vault = jobsVault();
			vault.seedFile("Jobs/delta.md");
			vault.seedFile("Jobs/eps.md");
			const out = reconcileJobs([managedRow("Jobs/acme.md")], jobsSource(ACTIVE_RULES), vault);
			expect(pathsOf(out)).toContain("Jobs/eps.md");
			expect(pathsOf(out)).not.toContain("Jobs/delta.md");
		} finally {
			delete FRONTMATTER["Jobs/delta.md"];
			delete FRONTMATTER["Jobs/eps.md"];
		}
	});

	it("a removed filtered-out row is not re-added while it does not match, and returns at the end once it does", () => {
		// The user removed beta while it was filtered out, so it is absent from the existing children.
		const first = reconcileJobs([managedRow("Jobs/acme.md")], jobsSource(ACTIVE_RULES));
		expect(pathsOf(first)).not.toContain("Jobs/beta.md");

		FRONTMATTER["Jobs/beta.md"] = { status: "active" };
		try {
			const second = reconcileJobs(first, jobsSource(ACTIVE_RULES));
			expect(pathsOf(second)).toEqual(["Jobs/acme.md", "Jobs/gamma.md", "Jobs/beta.md"]);
			expect(second[second.length - 1].children).toEqual([]);
		} finally {
			FRONTMATTER["Jobs/beta.md"] = { status: "done" };
		}
	});

	it("a PDF fails every rule, since it has no frontmatter", () => {
		const out = reconcileJobs([], jobsSource([{ key: "status", value: "active" }, { key: "company", value: "" }]));
		expect(pathsOf(out)).not.toContain("Jobs/brief.pdf");
	});

	it("with no usable rule, every file joins as before", () => {
		const out = reconcileJobs([], jobsSource([{ key: " ", value: "x" }]));
		expect(pathsOf(out)).toEqual(["Jobs/acme.md", "Jobs/beta.md", "Jobs/gamma.md", "Jobs/brief.pdf"]);
	});
});

describe("PR-1.F2 — the hidden-at-save flag per mode, set on Save and cleared on match", () => {
	function managerWith(mode: "merge" | "append" | "overwrite") {
		const app = new MockApp();
		app.vault.seedFolder("Jobs");
		for (const path of ["Jobs/acme.md", "Jobs/beta.md", "Jobs/gamma.md"]) app.vault.seedFile(path);
		app.vault.seedFile("Jobs/brief.pdf");
		app.metadataCache.getFileCache = ((file: TFile) => ({ frontmatter: FRONTMATTER[file.path] })) as unknown as typeof app.metadataCache.getFileCache;
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const viewId = vm.getViews()[0].id;
		const folder = vm.addMetaFolder(viewId, null, "Job search")!;
		vm.setFolderSource(viewId, folder.id, { ...jobsSource(), mode });
		vm.refreshFolderSource(viewId, folder.id);
		vm.onMetadataResolved();
		const rowOf = (path: string) => vm.getNode(viewId, folder.id)!.children.find((c) => c.ref?.path === path)!;
		return { vm, viewId, folder, rowOf };
	}

	for (const mode of ["merge", "overwrite"] as const) {
		it(`${mode}: Save flags the non-matching rows, including the PDF`, () => {
			const { vm, viewId, folder, rowOf } = managerWith(mode);
			vm.setFolderSource(viewId, folder.id, { ...jobsSource(ACTIVE_RULES), mode });
			vm.onMetadataResolved();
			expect(rowOf("Jobs/beta.md").folderSourceHiddenAtSave).toBe(true);
			expect(rowOf("Jobs/brief.pdf").folderSourceHiddenAtSave).toBe(true);
			expect(rowOf("Jobs/acme.md").folderSourceHiddenAtSave).toBeUndefined();
		});
	}

	it("append: Save never flags a row", () => {
		const { vm, viewId, folder, rowOf } = managerWith("append");
		vm.setFolderSource(viewId, folder.id, { ...jobsSource(ACTIVE_RULES), mode: "append" });
		vm.onMetadataResolved();
		expect(rowOf("Jobs/beta.md").folderSourceHiddenAtSave).toBeUndefined();
	});

	it("the flag clears once its row matches again, and removing every rule clears them all", () => {
		const { vm, viewId, folder, rowOf } = managerWith("merge");
		vm.setFolderSource(viewId, folder.id, { ...jobsSource(ACTIVE_RULES), mode: "merge" });
		vm.onMetadataResolved();
		vm.setFolderSource(viewId, folder.id, { ...jobsSource([{ key: "status", value: "done" }]), mode: "merge" });
		expect(rowOf("Jobs/beta.md").folderSourceHiddenAtSave).toBeUndefined();
		expect(rowOf("Jobs/acme.md").folderSourceHiddenAtSave).toBe(true);
		vm.setFolderSource(viewId, folder.id, { ...jobsSource(), mode: "merge" });
		expect(vm.getNode(viewId, folder.id)!.children.some((c) => c.folderSourceHiddenAtSave)).toBe(false);
	});
});
