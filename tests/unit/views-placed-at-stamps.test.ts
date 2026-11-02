/** PR-1 (G10/G15/G16/E15): `ViewNode.placedAt` stamping — `placeUnit`, `addMetaFolder` and
 * Folder-source discovery stamp a brand-new node at creation; `placeUnit`/`moveNode` restamp on
 * an actual reparent but never on a same-parent reorder; `duplicateNode` restamps only the
 * clone's own root, leaving its cloned subtree's stamps untouched. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { ViewsManager } from "../../src/views";

describe("PR-1 — placedAt stamping", () => {
	let app: App;
	let views: ViewsManager;
	let viewId: string;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		app = new App();
		views = new ViewsManager(app, [], "v1", () => {});
		viewId = views.getViews()[0].id;
	});

	it("placeUnit stamps a brand-new node with the current time", () => {
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		const node = views.getView(viewId)!.root[0];
		expect(node.placedAt).toBe(1_000_000);
	});

	it("placeUnit restamps an existing node moved to a different parent", () => {
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		const folderId = views.addMetaFolder(viewId, null, "Folder")!.id;
		vi.setSystemTime(2_000_000);
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folderId);
		const moved = views.getView(viewId)!.root.find((n) => n.id === folderId)!.children[0];
		expect(moved.placedAt).toBe(2_000_000);
	});

	it("PR-1 R3: placeUnit does NOT restamp when the target is the node's own current parent (root)", () => {
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		vi.setSystemTime(2_000_000);
		const result = views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		expect(result!.placedAt).toBe(1_000_000);
		expect(views.getView(viewId)!.root[0].placedAt).toBe(1_000_000);
	});

	it("PR-1 R3: placeUnit does NOT restamp when the target is the node's own current parent (a Folder)", () => {
		const folderId = views.addMetaFolder(viewId, null, "Folder")!.id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folderId);
		vi.setSystemTime(2_000_000);
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folderId);
		const child = views.getView(viewId)!.root.find((n) => n.id === folderId)!.children[0];
		expect(child.placedAt).toBe(1_000_000);
	});

	it("PR-1 R3: a same-parent placeUnit that is not a no-op (explicit position) still leaves the stamp alone", () => {
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null);
		vi.setSystemTime(2_000_000);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null, 0);
		const root = views.getView(viewId)!.root;
		expect(root.map((n) => n.ref!.path)).toEqual(["B.md", "A.md"]);
		expect(root[0].placedAt).toBe(1_000_000);
	});

	it("addMetaFolder stamps a new Folder with the current time", () => {
		const node = views.addMetaFolder(viewId, null, "Folder")!;
		expect(node.placedAt).toBe(1_000_000);
	});

	it("moveNode restamps a node moved to a different parent", () => {
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		const unitId = views.getView(viewId)!.root[0].id;
		const folderId = views.addMetaFolder(viewId, null, "Folder")!.id;
		vi.setSystemTime(3_000_000);
		expect(views.moveNode(viewId, unitId, folderId, 0)).toBe(true);
		const moved = views.getView(viewId)!.root.find((n) => n.id === folderId)!.children[0];
		expect(moved.placedAt).toBe(3_000_000);
	});

	it("moveNode does NOT restamp a same-parent reorder (drag within one list)", () => {
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null);
		const [first, second] = views.getView(viewId)!.root;
		expect(first.placedAt).toBe(1_000_000);
		vi.setSystemTime(9_000_000);
		// Reorder `second` to index 0, still under the view root (same parent).
		expect(views.moveNode(viewId, second.id, null, 0)).toBe(true);
		const reordered = views.getView(viewId)!.root.find((n) => n.id === second.id)!;
		expect(reordered.placedAt).toBe(1_000_000); // unchanged by the reorder
	});

	it("moveNode restamps when moving from a child parent back to the view root", () => {
		const folderId = views.addMetaFolder(viewId, null, "Folder")!.id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folderId);
		const unitId = views.getView(viewId)!.root.find((n) => n.id === folderId)!.children[0].id;
		vi.setSystemTime(4_000_000);
		expect(views.moveNode(viewId, unitId, null, 0)).toBe(true);
		const moved = views.getView(viewId)!.root.find((n) => n.id === unitId)!;
		expect(moved.placedAt).toBe(4_000_000);
	});

	it("duplicateNode stamps the clone's own root with a fresh time, but leaves its cloned subtree's stamps unchanged (E15)", () => {
		const folderId = views.addMetaFolder(viewId, null, "Parent")!.id;
		views.placeUnit(viewId, { kind: "file", path: "Child.md" }, folderId);
		const originalChild = views.getView(viewId)!.root.find((n) => n.id === folderId)!.children[0];
		expect(originalChild.placedAt).toBe(1_000_000);

		vi.setSystemTime(5_000_000);
		const clone = views.duplicateNode(viewId, folderId)!;
		expect(clone.placedAt).toBe(5_000_000); // the clone's own root gets a fresh stamp
		expect(clone.children[0].placedAt).toBe(1_000_000); // its cloned subtree keeps its own stamp
	});

	it("removing/deleting a Folder lifts its children without touching their stamps", () => {
		const folderId = views.addMetaFolder(viewId, null, "Folder")!.id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folderId);
		const child = views.getView(viewId)!.root.find((n) => n.id === folderId)!.children[0];
		expect(child.placedAt).toBe(1_000_000);

		vi.setSystemTime(6_000_000);
		views.deleteMetaFolder(viewId, folderId);
		const lifted = views.getView(viewId)!.root.find((n) => n.id === child.id)!;
		expect(lifted.placedAt).toBe(1_000_000); // untouched by the lift
	});
});
