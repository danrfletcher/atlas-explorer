/** PR-1 (R1 fix) — model/storage tests for the sort setting itself (sortMode/sortReverse) and its
 * interaction with the stored `children` order, separate from the comparator-level tests in
 * `sort.test.ts` and the render-pass tests in `explorer-view-sort.test.ts`. Covers: G16/E11
 * (round-trip through data.json, per node and per view root), E8 (old data.json loads as Manual
 * with no stamps, unrewritten), G16 (Duplicate copies sortMode/sortReverse), G14/F2/G15 (a sort
 * never mutates `children`; place/remove/drop under a sorted folder edit the stored order
 * underneath), E7 (Folder removal under a sorted vs Manual parent), E15 (folder-source
 * reconciliation stamps new nodes it creates). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { App as MockApp } from "../../tests/mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { currentSortMode } from "../../src/sort";
import type { View, ViewNode } from "../../src/types";
import { callRenderNodeList, makeFakeExplorer, makeStatusesManager, rowOrder } from "./explorer-view-sort-truncate-helpers";

describe("PR-1 G16/E11 — sortMode/sortReverse round-trip through data.json", () => {
	it("a node's sortMode/sortReverse survive a save-then-reload cycle", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "modified", sortReverse: true });

		// Simulate the real persist/reload cycle: `main.ts` serializes `getViews()` into data.json,
		// then re-constructs a ViewsManager from the parsed JSON on the next load.
		const roundTripped: View[] = JSON.parse(JSON.stringify(views.getViews()));
		const reloaded = new ViewsManager(app as unknown as App, roundTripped, viewId, () => {});
		const reloadedFolder = reloaded.getNode(viewId, folder.id)!;
		expect(reloadedFolder.sortMode).toBe("modified");
		expect(reloadedFolder.sortReverse).toBe(true);
	});

	it("a view's own root sortMode/sortReverse survive a save-then-reload cycle (G7/E11)", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.updateStatusGovernance(viewId, null, { sortMode: "time-added", sortReverse: false });

		const roundTripped: View[] = JSON.parse(JSON.stringify(views.getViews()));
		const reloaded = new ViewsManager(app as unknown as App, roundTripped, viewId, () => {});
		const reloadedView = reloaded.getView(viewId)!;
		expect(reloadedView.sortMode).toBe("time-added");
		expect(reloadedView.sortReverse).toBe(false);
	});

	it("E11: switching between two views keeps each one's own root sort setting independently", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewA = views.getViews()[0];
		const viewB = views.createView("Second")!;
		views.updateStatusGovernance(viewA.id, null, { sortMode: "alphabetical" });
		views.updateStatusGovernance(viewB.id, null, { sortMode: "modified" });

		expect(currentSortMode(views.getView(viewA.id)!)).toBe("alphabetical");
		expect(currentSortMode(views.getView(viewB.id)!)).toBe("modified");

		// Round-trip both, same as above, and check they're still independent afterwards.
		const roundTripped: View[] = JSON.parse(JSON.stringify(views.getViews()));
		const reloaded = new ViewsManager(app as unknown as App, roundTripped, viewA.id, () => {});
		expect(currentSortMode(reloaded.getView(viewA.id)!)).toBe("alphabetical");
		expect(currentSortMode(reloaded.getView(viewB.id)!)).toBe("modified");
	});
});

describe("PR-1 E8 — a data.json written before this feature loads as Manual with no stamps, and is not rewritten", () => {
	it("a node and a view root with no sortMode/sortReverse/placedAt fields read back as Manual/no-stamp, and construction alone never persists", () => {
		const persist = vi.fn();
		const preExistingNode: ViewNode = { id: "n1", type: "unit", ref: { kind: "file", path: "A.md" }, children: [] };
		const preExistingView: View = { id: "v1", name: "Default", inboxMode: "view", root: [preExistingNode] };
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [preExistingView], "v1", persist);

		// Just constructing + reading never writes anything back.
		expect(persist).not.toHaveBeenCalled();

		const node = views.getNode("v1", "n1")!;
		expect(currentSortMode(node)).toBe("manual");
		expect(node.placedAt).toBeUndefined();
		expect(node.sortMode).toBeUndefined();

		const view = views.getView("v1")!;
		expect(currentSortMode(view)).toBe("manual");
		expect(view.placedAt).toBeUndefined();

		// The pre-existing node/view objects are untouched byte-for-byte (no field was added by load).
		expect(Object.keys(node).sort()).toEqual(Object.keys(preExistingNode).sort());
		expect(Object.keys(view).sort()).toEqual(Object.keys(preExistingView).sort());
	});
});

describe("PR-1 G16 — Duplicate (Meta) copies sortMode and sortReverse", () => {
	it("duplicateNode's clone carries the same sortMode/sortReverse as the original", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "alphabetical", sortReverse: true });

		const clone = views.duplicateNode(viewId, folder.id)!;
		expect(clone.sortMode).toBe("alphabetical");
		expect(clone.sortReverse).toBe(true);
		// Different node, not the same stamp/position concern — covered by views-placed-at-stamps.test.ts.
		expect(clone.id).not.toBe(folder.id);
	});
});

describe("PR-1 G14/F2 — a sort never mutates children; changing the setting alone is a no-op on children", () => {
	it("toggling sortMode back and forth leaves the folder's children array byte-identical", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.placeUnit(viewId, { kind: "file", path: "Z.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folder.id);

		const before = JSON.stringify(views.getNode(viewId, folder.id)!.children);
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "alphabetical" });
		views.updateStatusGovernance(viewId, folder.id, { sortReverse: true });
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "modified" });
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "manual", sortReverse: false });
		const after = JSON.stringify(views.getNode(viewId, folder.id)!.children);

		expect(after).toBe(before);
	});
});

describe("PR-1 G14/G15 — place, remove and drop edit the stored manual order underneath a sorted folder", () => {
	it("placeUnit still appends to the stored children order of a sorted folder (the sorted display comes from the render pass, not from insertion position)", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "alphabetical" });

		views.placeUnit(viewId, { kind: "file", path: "Zebra.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "Apple.md" }, folder.id);

		const children = views.getNode(viewId, folder.id)!.children;
		// Stored (manual) order is still build/insertion order, untouched by the folder's sort setting.
		expect(children.map((n) => n.ref && "path" in n.ref ? n.ref.path : null)).toEqual(["Zebra.md", "Apple.md"]);
	});

	it("moveNode (a drop-into) edits the stored order of a sorted folder — the index argument still lands the node structurally", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "alphabetical" });
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, folder.id);
		const outsider = views.placeUnit(viewId, { kind: "file", path: "C.md" }, null);
		const outsiderId = views.getView(viewId)!.root.find((n) => n.ref && "path" in n.ref && n.ref.path === "C.md")!.id;
		void outsider;

		expect(views.moveNode(viewId, outsiderId, folder.id, 1)).toBe(true);
		const children = views.getNode(viewId, folder.id)!.children;
		expect(children.map((n) => n.ref && "path" in n.ref ? n.ref.path : null)).toEqual(["A.md", "C.md", "B.md"]);
	});

	it("unplaceNode removes the row from a sorted folder's stored order", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.updateStatusGovernance(viewId, folder.id, { sortMode: "modified" });
		views.placeUnit(viewId, { kind: "file", path: "A.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "B.md" }, folder.id);
		const bId = views.getNode(viewId, folder.id)!.children.find((n) => n.ref && "path" in n.ref && n.ref.path === "B.md")!.id;

		views.unplaceNode(viewId, bId);
		const children = views.getNode(viewId, folder.id)!.children;
		expect(children.map((n) => n.ref && "path" in n.ref ? n.ref.path : null)).toEqual(["A.md"]);
	});
});

describe("PR-1 E7 — Folder removal under a sorted vs Manual parent", () => {
	function buildThreeSiblings(views: ViewsManager, viewId: string) {
		const a = views.addMetaFolder(viewId, null, "A")!;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		const b = views.addMetaFolder(viewId, null, "B")!;
		views.placeUnit(viewId, { kind: "file", path: "C1.md" }, folder.id);
		views.placeUnit(viewId, { kind: "file", path: "C2.md" }, folder.id);
		return { a, folder, b };
	}

	it("under a Manual parent (the view root), the lifted children take the removed Folder's exact position among its siblings", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const { a, folder, b } = buildThreeSiblings(views, viewId);

		views.deleteMetaFolder(viewId, folder.id);
		const rootLabels = views.getView(viewId)!.root.map((n) => (n.type === "meta" ? n.label : n.ref && "path" in n.ref ? n.ref.path : n.id));
		expect(rootLabels).toEqual(["A", "C1.md", "C2.md", "B"]);
		void a;
		void b;
	});

	it("under a sorted parent (the view root), the structural splice at the Folder's position is unchanged — the parent's sort rules decide the render order from there", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		views.updateStatusGovernance(viewId, null, { sortMode: "alphabetical" });
		const { a, folder, b } = buildThreeSiblings(views, viewId);

		views.deleteMetaFolder(viewId, folder.id);
		const rootLabels = views.getView(viewId)!.root.map((n) => (n.type === "meta" ? n.label : n.ref && "path" in n.ref ? n.ref.path : n.id));
		// Same structural splice as the Manual case above — removal never special-cases the parent's
		// sortMode; a sorted parent's render pass (covered in explorer-view-sort.test.ts) is what
		// actually reorders these for display.
		expect(rootLabels).toEqual(["A", "C1.md", "C2.md", "B"]);
		void a;
		void b;
	});

	// PR-1 R7: the splice assertions above are identical for Manual and sorted parents, so on their
	// own they can't show that the lifted children follow the *parent's* sort. Render both lists.
	describe("rendered through the real renderNodeList", () => {
		async function renderRoot(sortMode: "manual" | "alphabetical") {
			const app = new MockApp();
			const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
			const viewId = views.getViews()[0].id;
			views.updateStatusGovernance(viewId, null, { sortMode });
			const { folder } = buildThreeSiblings(views, viewId);
			views.deleteMetaFolder(viewId, folder.id);
			const root = views.getView(viewId)!;

			const label = (n: ViewNode) => (n.type === "meta" ? n.label! : (n.ref as { path: string }).path);
			const fake = makeFakeExplorer(makeStatusesManager(), {
				resolveRef: vi.fn(async (ref: { path: string }) => ({ text: ref.path, icon: "file", promoted: false, added: false, missing: false })),
			});
			const container = document.createElement("div");
			await callRenderNodeList(fake, root.root, container, root, 0, [root]);
			const byId = new Map(root.root.map((n) => [n.id, label(n)]));
			return rowOrder(container).map((id) => byId.get(id));
		}

		it("under a Manual parent the lifted children render in the removed Folder's slot", async () => {
			expect(await renderRoot("manual")).toEqual(["A", "C1.md", "C2.md", "B"]);
		});

		it("under an A-Z parent the lifted children are sorted with their new siblings, not left in the Folder's slot", async () => {
			// Same stored order as above; only the parent's sort differs — B now precedes the lifted C files.
			expect(await renderRoot("alphabetical")).toEqual(["A", "B", "C1.md", "C2.md"]);
		});
	});
});

describe("PR-1 E15 — folder-source reconciliation stamps new nodes it creates", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(7_000_000);
	});

	// PR-1 R7: put the real timers back so a block added below this one can't inherit fake ones.
	afterEach(() => {
		vi.useRealTimers();
	});

	it("refreshFolderSource stamps a freshly-discovered managed child with placedAt", () => {
		const app = new MockApp();
		app.vault.seedFolder("Projects");
		app.vault.seedFile("Projects/a.md");
		const views = new ViewsManager(app as unknown as App, [], "", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Projects")!;

		views.setFolderSource(viewId, folder.id, {
			type: "folder",
			location: "inside",
			path: "Projects",
			showFiles: true,
			showFolders: true,
		});
		views.refreshFolderSource(viewId, folder.id);

		const children = views.getNode(viewId, folder.id)!.children;
		expect(children.length).toBeGreaterThan(0);
		for (const child of children) {
			expect(child.placedAt).toBe(7_000_000);
		}
	});
});
