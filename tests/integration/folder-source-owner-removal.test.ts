import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { ViewsManager } from "../../src/views";

/** PR-1 T5: removing a Folder-source owner (via "Remove from view", the Delete key or drag-to-inbox,
 * all of which end up in `ViewsManager.unplaceNode`) used to promote its managed children up one
 * level along with any ordinary ones — exactly the same rule `deleteMetaFolder` uses for a meta
 * folder's children. A managed child has no identity without its owner (an Outside-Vault one's
 * `ref.path` isn't even a real vault path without the owner's "never open/drag/rename" guard still
 * active), so it must be dropped with the owner instead of surfacing as a broken top-level row. A
 * manually-placed, non-managed sibling is unaffected and still promoted. */
describe("PR-1 T5 — removing a Folder-source owner drops its own managed children, not just the owner", () => {
	it("Remove from view (unplaceNode) on an Outside-Vault-sourced unit drops its managed child and still promotes a manual one", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		// The owner is a `unit`, matching T5's own example ("an Outside-Vault-sourced unit").
		vm.placeUnit(view.id, { kind: "file", path: "Owner.md" }, null);
		const owner = vm.getNode(view.id, vm.getViews()[0].root[0].id)!;
		vm.setFolderSource(view.id, owner.id, { location: "outside", path: "", showFiles: true, showFolders: true });

		vm.placeUnit(view.id, { kind: "file", path: "ExternalNote.md" }, owner.id);
		const managedChild = vm.getNode(view.id, owner.id)!.children[0];
		managedChild.folderSourceManaged = true;
		managedChild.folderSourceOwnerId = owner.id;

		vm.placeUnit(view.id, { kind: "file", path: "ManuallyNested.md" }, owner.id);

		vm.unplaceNode(view.id, owner.id);

		const root = vm.getViews()[0].root;
		expect(vm.getNode(view.id, owner.id)).toBeNull();
		expect(vm.getNode(view.id, managedChild.id)).toBeNull();
		expect(root.some((n) => n.ref?.kind === "file" && n.ref.path === "ExternalNote.md")).toBe(false);
		expect(root.some((n) => n.ref?.kind === "file" && n.ref.path === "ManuallyNested.md")).toBe(true);
	});

	it("control: removing a node with only manually-placed (non-managed) children still promotes all of them, unaffected", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		vm.placeUnit(view.id, { kind: "file", path: "Owner.md" }, null);
		const owner = vm.getNode(view.id, vm.getViews()[0].root[0].id)!;
		vm.placeUnit(view.id, { kind: "file", path: "ChildA.md" }, owner.id);
		vm.placeUnit(view.id, { kind: "file", path: "ChildB.md" }, owner.id);

		vm.unplaceNode(view.id, owner.id);

		const root = vm.getViews()[0].root;
		expect(root.some((n) => n.ref?.kind === "file" && n.ref.path === "ChildA.md")).toBe(true);
		expect(root.some((n) => n.ref?.kind === "file" && n.ref.path === "ChildB.md")).toBe(true);
	});

	it("deleteMetaFolder on an Atlas folder that owns a Folder source drops its managed child the same way", () => {
		const app = new App();
		const vm = new ViewsManager(app, [], "", () => {});
		const view = vm.getViews()[0];

		const owner = vm.addMetaFolder(view.id, null, "Outside Source")!;
		vm.setFolderSource(view.id, owner.id, { location: "outside", path: "", showFiles: true, showFolders: true });

		vm.placeUnit(view.id, { kind: "file", path: "ExternalNote.md" }, owner.id);
		const managedChild = vm.getNode(view.id, owner.id)!.children[0];
		managedChild.folderSourceManaged = true;
		managedChild.folderSourceOwnerId = owner.id;

		vm.placeUnit(view.id, { kind: "file", path: "ManuallyNested.md" }, owner.id);

		vm.deleteMetaFolder(view.id, owner.id);

		const root = vm.getViews()[0].root;
		expect(vm.getNode(view.id, owner.id)).toBeNull();
		expect(vm.getNode(view.id, managedChild.id)).toBeNull();
		expect(root.some((n) => n.ref?.kind === "file" && n.ref.path === "ManuallyNested.md")).toBe(true);
	});
});
