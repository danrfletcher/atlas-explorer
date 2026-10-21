/** PR-3 — `placeUnit`'s new optional `position` parameter: an inbox edge-drop lands at a specific
 * index among the parent's children, not always last. */
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";

function labelsOf(nodes: { ref?: { path?: string } }[]): (string | undefined)[] {
	return nodes.map((n) => n.ref?.path);
}

describe("PR-3 — placeUnit: with a position, the unit lands at that index among the parent's children", () => {
	it("places at the root with an explicit position", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "C.md" }, null);

		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null, 1);

		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["A.md", "B.md", "C.md"]);
	});

	it("places inside a meta folder with an explicit position", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "C.md" }, folder.id);

		views.placeUnit(viewId, { kind: "file", path: "B.md" }, folder.id, 1);

		expect(labelsOf(views.getNode(viewId, folder.id)!.children)).toEqual(["A.md", "B.md", "C.md"]);
	});

	it("position 0 inserts at the front", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);

		views.placeUnit(viewId, { kind: "file", path: "Z.md" }, null, 0);

		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["Z.md", "A.md"]);
	});
});

describe("PR-3 — placeUnit: without a position it appends, as today", () => {
	it("omitting position keeps the existing append behaviour", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null);

		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["A.md", "B.md"]);
	});
});

describe("PR-3 — placeUnit: an out-of-range position clamps to the end", () => {
	it("a position past the end of the array clamps rather than throwing or dropping the unit", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null);

		views.placeUnit(viewId, { kind: "file", path: "C.md" }, null, 999);

		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["A.md", "B.md", "C.md"]);
	});

	it("a negative position clamps to the front", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null);

		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null, -5);

		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["B.md", "A.md"]);
	});
});

describe("PR-3 — placeUnit: an already-placed unit moves in place and is not duplicated", () => {
	it("re-placing a unit already in a different folder, with a position, moves it there once", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folderA = views.addMetaFolder(viewId, null, "A")!;
		const folderB = views.addMetaFolder(viewId, null, "B")!;
		views.placeUnit(viewId, { kind: "file", path: "x.md" }, folderA.id);
		views.placeUnit(viewId, { kind: "file", path: "b1.md" }, folderB.id);
		views.placeUnit(viewId, { kind: "file", path: "b2.md" }, folderB.id);

		views.placeUnit(viewId, { kind: "file", path: "x.md" }, folderB.id, 1);

		expect(labelsOf(views.getNode(viewId, folderA.id)!.children)).toEqual([]);
		expect(labelsOf(views.getNode(viewId, folderB.id)!.children)).toEqual(["b1.md", "x.md", "b2.md"]);
	});
});

describe("PR-3 R5 — placeUnit with a position for a unit already placed in that same parent reads the index against the array as it stood before the move, like moveNode", () => {
	function seeded() {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		for (const path of ["A.md", "B.md", "C.md"]) views.placeUnit(viewId, { kind: "file", path }, null);
		return { views, viewId };
	}
	const order = (views: ViewsManager, viewId: string) => labelsOf(views.getView(viewId)!.root);

	it("moving down: A to position 2 (the slot before C) lands between B and C, not after C", () => {
		const { views, viewId } = seeded();
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null, 2);
		expect(order(views, viewId)).toEqual(["B.md", "A.md", "C.md"]);
	});

	it("moving down to the very end: A to position 3 lands last", () => {
		const { views, viewId } = seeded();
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, null, 3);
		expect(order(views, viewId)).toEqual(["B.md", "C.md", "A.md"]);
	});

	it("moving up needs no adjustment: C to position 0 lands first", () => {
		const { views, viewId } = seeded();
		views.placeUnit(viewId, { kind: "file", path: "C.md" }, null, 0);
		expect(order(views, viewId)).toEqual(["C.md", "A.md", "B.md"]);
	});

	it("a position that resolves back to the unit's own slot leaves the order alone", () => {
		const { views, viewId } = seeded();
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null, 1);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, null, 2);
		expect(order(views, viewId)).toEqual(["A.md", "B.md", "C.md"]);
	});

	it("the same index into a different parent is not adjusted (the removal is from another array)", () => {
		const { views, viewId } = seeded();
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.placeUnit(viewId, { kind: "file", path: "X.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "Y.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folder.id, 1);
		expect(labelsOf(views.getNode(viewId, folder.id)!.children)).toEqual(["X.md", "A.md", "Y.md"]);
	});
});
