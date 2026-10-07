import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { resolveUnit } from "../../src/unit-display";
import { UnitRef, unitRefKey, unitToRef } from "../../src/types";
import { seedRoot } from "../helpers";

/** T1: Inside-Vault Folder-source children must resolve as real units through `UnitIndex`/
 * `ExplorerView.resolveRef`'s normal `unitsByRefKey` lookup, not the generic missing-ref fallback —
 * the overwhelmingly common case, since only vault-root folders are base units and a Folder-source
 * target's direct children are (per G3's own example) ordinary nested files/folders, never promoted
 * by a link or manual promotion. `ViewsManager.getFolderSourceManagedRefs` + `UnitIndex.setFolderSourceRefs`
 * is the fix `main.ts` wires on every `ViewsManager` change; this exercises both together, plus the
 * exact `unitRefKey`/`resolveUnit` lookup `ExplorerView.resolveRef` performs, without needing to stand
 * up the real `ExplorerView` (which needs a full `AtlasPlugin`). */
describe("T1 — Folder-source-managed refs resolve as real units via UnitIndex", () => {
	it("a managed nested file is invisible to the index until synced, then resolves as a promoted-file unit", async () => {
		const app = new App();
		seedRoot(app, ["Test Folder/Alpha.md"], ["Test Folder"]);
		const settings = { ...DEFAULT_SETTINGS };
		const index = new UnitIndex(app, settings, []);
		index.rebuild();

		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];
		const ref: UnitRef = { kind: "file", path: "Test Folder/Alpha.md" };
		vm.placeUnit(view.id, ref, null);
		const node = vm.getViews()[0].root[0];
		node.folderSourceManaged = true;
		node.folderSourceOwnerId = "owner-1";

		// Reproduces T1: a nested file placed as a Folder-source-managed child is not a root-level
		// unit, never promoted by a link or manual promotion, so the index has never heard of it.
		expect(index.getUnits().some((u) => u.path === ref.path)).toBe(false);

		index.setFolderSourceRefs(vm.getFolderSourceManagedRefs());

		const unit = index.getUnits().find((u) => u.path === ref.path);
		expect(unit).toEqual({ type: "promoted-file", path: ref.path, topLevelFolder: "Test Folder" });

		// The exact lookup `ExplorerView.resolveRef` performs (`unitsByRefKey`, keyed by `unitRefKey`).
		const unitsByRefKey = new Map(index.getUnits().map((u) => [unitRefKey(unitToRef(u)), u]));
		expect(unitsByRefKey.get(unitRefKey(ref))).toEqual(unit);

		// resolveUnit needs the mock file's `stat` (unset by `seedFile`, which never gave it one).
		(app.vault.getAbstractFileByPath(ref.path) as TFile).stat = { ctime: 0, mtime: 0, size: 0 };
		const resolved = await resolveUnit(app, settings, unit!);
		expect(resolved).not.toBeNull();
		expect(resolved?.text).toBe("Alpha");
		expect(resolved?.promoted).toBe(true);
	});

	it("a managed nested folder resolves the same way", () => {
		const app = new App();
		seedRoot(app, [], ["Test Folder", "Test Folder/Sub"]);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, []);
		index.rebuild();

		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];
		const ref: UnitRef = { kind: "folder", path: "Test Folder/Sub" };
		vm.placeUnit(view.id, ref, null);
		vm.getViews()[0].root[0].folderSourceManaged = true;

		index.setFolderSourceRefs(vm.getFolderSourceManagedRefs());

		expect(index.getUnits()).toContainEqual({ type: "promoted-folder", path: ref.path, topLevelFolder: "Test Folder" });
	});

	it("drops a ref that's no longer managed by any source on the next sync (stops being a unit again)", () => {
		const app = new App();
		seedRoot(app, ["Test Folder/Alpha.md"], ["Test Folder"]);
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, []);
		index.rebuild();

		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];
		const ref: UnitRef = { kind: "file", path: "Test Folder/Alpha.md" };
		vm.placeUnit(view.id, ref, null);
		const node = vm.getViews()[0].root[0];
		node.folderSourceManaged = true;
		index.setFolderSourceRefs(vm.getFolderSourceManagedRefs());
		expect(index.getUnits().some((u) => u.path === ref.path)).toBe(true);

		// The user removes the row from the view entirely (unplaceNode) — no source manages it anymore.
		vm.unplaceNode(view.id, node.id);
		index.setFolderSourceRefs(vm.getFolderSourceManagedRefs());

		expect(index.getUnits().some((u) => u.path === ref.path)).toBe(false);
	});

	it("getFolderSourceManagedRefs collects managed refs nested under meta folders, across every view, and ignores unmanaged units", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view1 = vm.getViews()[0];
		const view2 = vm.createView("Second")!;

		vm.addMetaFolder(view1.id, null, "Source Folder A");
		const metaA = vm.getViews().find((v) => v.id === view1.id)!.root[0];
		vm.placeUnit(view1.id, { kind: "file", path: "A/managed.md" }, metaA.id);
		const managedInA = vm.getNode(view1.id, metaA.id)!.children[0];
		managedInA.folderSourceManaged = true;
		managedInA.folderSourceOwnerId = metaA.id;

		vm.placeUnit(view1.id, { kind: "file", path: "A/hand-nested.md" }, metaA.id); // not managed

		vm.placeUnit(view2.id, { kind: "folder", path: "B/managed-folder" }, null);
		vm.getViews().find((v) => v.id === view2.id)!.root[0].folderSourceManaged = true;

		const refs = vm.getFolderSourceManagedRefs();
		expect(refs).toContainEqual({ kind: "file", path: "A/managed.md" });
		expect(refs).toContainEqual({ kind: "folder", path: "B/managed-folder" });
		expect(refs).not.toContainEqual({ kind: "file", path: "A/hand-nested.md" });
		expect(refs).toHaveLength(2);
	});

	it("R4: excludes refs managed by an Outside-Vault-location source, since their root-relative path (e.g. 'note.md') is no longer globally unique and could collide with a real vault path or another Outside source's same-named child", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view1 = vm.getViews()[0];

		vm.addMetaFolder(view1.id, null, "Outside Source");
		const outsideOwner = vm.getViews().find((v) => v.id === view1.id)!.root[0];
		vm.setFolderSource(view1.id, outsideOwner.id, { location: "outside", path: "", showFiles: true, showFolders: true });

		vm.placeUnit(view1.id, { kind: "file", path: "note.md" }, outsideOwner.id);
		const outsideManaged = vm.getNode(view1.id, outsideOwner.id)!.children[0];
		outsideManaged.folderSourceManaged = true;
		outsideManaged.folderSourceOwnerId = outsideOwner.id;

		// An ordinary Inside-Vault managed ref, for contrast — still included.
		vm.addMetaFolder(view1.id, null, "Inside Source");
		const insideOwner = vm.getViews().find((v) => v.id === view1.id)!.root[1];
		vm.placeUnit(view1.id, { kind: "file", path: "Projects/a.md" }, insideOwner.id);
		const insideManaged = vm.getNode(view1.id, insideOwner.id)!.children[0];
		insideManaged.folderSourceManaged = true;
		insideManaged.folderSourceOwnerId = insideOwner.id;

		const refs = vm.getFolderSourceManagedRefs();
		expect(refs).not.toContainEqual({ kind: "file", path: "note.md" });
		expect(refs).toContainEqual({ kind: "file", path: "Projects/a.md" });
		expect(refs).toHaveLength(1);
	});
});
