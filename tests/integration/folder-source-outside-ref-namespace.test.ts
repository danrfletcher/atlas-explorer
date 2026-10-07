import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { ViewsManager } from "../../src/views";

/** R9: an Outside-Vault-managed child's `ref.path` is a bare name relative to its source's root
 * (e.g. "Projects", "notes.md" — see `listOutsideChildrenWith`), not a vault path. That makes it
 * exactly the kind of short, ordinary-looking string a real vault-root unit could also use. Every
 * ref-identity walk in `ViewsManager` (`onVaultRename`'s `rewriteTree`, `isPlaced`/`isPlacedAnywhere`/
 * `getPlacements`'s `findUnitNode`/`allPathsToRef`) must treat Outside-managed refs as a separate
 * namespace that can never collide with a same-named vault-root path. */
describe("R9 — Outside-Vault child refs never collide with same-named vault-root paths", () => {
	it("R9(a): onVaultRename never rewrites an Outside-managed child's ref, or its owning source's path/removedRefs, even when a renamed vault-root folder shares the child's name", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		vm.addMetaFolder(view.id, null, "Outside Source");
		const owner = vm.getViews()[0].root[0];
		vm.setFolderSource(view.id, owner.id, {
			location: "outside",
			path: "",
			showFiles: true,
			showFolders: true,
			removedRefs: ["folder:Projects"],
		});

		vm.placeUnit(view.id, { kind: "folder", path: "Projects" }, owner.id);
		const outsideChild = vm.getNode(view.id, owner.id)!.children[0];
		outsideChild.folderSourceManaged = true;
		outsideChild.folderSourceOwnerId = owner.id;

		// Renaming a vault-root folder named "Projects" to "Archive" must leave the Outside child's
		// ref, and the owning source's own (meaningless-while-outside) path/removedRefs, untouched.
		vm.onVaultRename("Projects", "Archive");

		expect(vm.getNode(view.id, outsideChild.id)!.ref).toEqual({ kind: "folder", path: "Projects" });
		const afterOwner = vm.getNode(view.id, owner.id)!;
		expect(afterOwner.folderSource!.path).toBe("");
		expect(afterOwner.folderSource!.removedRefs).toEqual(["folder:Projects"]);
	});

	it("control: an Inside-Vault managed child's ref, and its owner's path/removedRefs, are still rewritten on the same rename (unaffected)", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		vm.addMetaFolder(view.id, null, "Inside Source");
		const owner = vm.getViews()[0].root[0];
		vm.setFolderSource(view.id, owner.id, {
			location: "inside",
			path: "Projects",
			showFiles: true,
			showFolders: true,
			removedRefs: ["folder:Projects/Removed"],
		});

		vm.placeUnit(view.id, { kind: "folder", path: "Projects/Sub" }, owner.id);
		const insideChild = vm.getNode(view.id, owner.id)!.children[0];
		insideChild.folderSourceManaged = true;
		insideChild.folderSourceOwnerId = owner.id;

		vm.onVaultRename("Projects", "Archive");

		expect(vm.getNode(view.id, insideChild.id)!.ref).toEqual({ kind: "folder", path: "Archive/Sub" });
		const afterOwner = vm.getNode(view.id, owner.id)!;
		expect(afterOwner.folderSource!.path).toBe("Archive");
		expect(afterOwner.folderSource!.removedRefs).toEqual(["folder:Archive/Removed"]);
	});

	it("R9(b): isPlaced/isPlacedAnywhere/getPlacements never count an Outside-managed child as placing a same-named real vault unit", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		vm.addMetaFolder(view.id, null, "Outside Source");
		const owner = vm.getViews()[0].root[0];
		vm.setFolderSource(view.id, owner.id, { location: "outside", path: "", showFiles: true, showFolders: true });

		vm.placeUnit(view.id, { kind: "file", path: "notes.md" }, owner.id);
		const outsideChild = vm.getNode(view.id, owner.id)!.children[0];
		outsideChild.folderSourceManaged = true;
		outsideChild.folderSourceOwnerId = owner.id;

		const realVaultRef = { kind: "file" as const, path: "notes.md" };
		expect(vm.isPlaced(view.id, realVaultRef)).toBe(false);
		expect(vm.isPlacedAnywhere(realVaultRef)).toBe(false);
		expect(vm.getPlacements(realVaultRef)).toEqual([]);
	});

	it("control: a genuinely placed real-vault ref is still reported as placed (unaffected)", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];
		const ref = { kind: "file" as const, path: "notes.md" };
		vm.placeUnit(view.id, ref, null);

		expect(vm.isPlaced(view.id, ref)).toBe(true);
		expect(vm.isPlacedAnywhere(ref)).toBe(true);
		expect(vm.getPlacements(ref)).toEqual([{ viewName: view.name, path: [] }]);
	});

	it("R9(b) control: placeUnit on a ref that collides with an Outside-managed child's name creates a real separate placement rather than silently moving the Outside node", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		vm.addMetaFolder(view.id, null, "Outside Source");
		const owner = vm.getViews()[0].root[0];
		vm.setFolderSource(view.id, owner.id, { location: "outside", path: "", showFiles: true, showFolders: true });

		vm.placeUnit(view.id, { kind: "file", path: "notes.md" }, owner.id);
		const outsideChild = vm.getNode(view.id, owner.id)!.children[0];
		outsideChild.folderSourceManaged = true;
		outsideChild.folderSourceOwnerId = owner.id;

		vm.placeUnit(view.id, { kind: "file", path: "notes.md" }, null);

		const bucketRoot = vm.getViews()[0].root;
		expect(bucketRoot).toHaveLength(2);
		expect(vm.getNode(view.id, owner.id)!.children).toHaveLength(1);
		expect(vm.getNode(view.id, owner.id)!.children[0].id).toBe(outsideChild.id);
	});
});
