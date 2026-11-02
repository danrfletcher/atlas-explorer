/** PR-1 polish for the reorder/sorted-drop work (PR-3 R2/R3/R4/R6, PR-4 R1/R2/R4): drives the real
 * `makeDropZone` / `handleDrop` / `assessDrop` / `renderNode` / `renderNodeList` through a real
 * `ViewsManager`, using the shared helpers in `explorer-view-drop-helpers.ts`. */
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ViewsManager } from "../../src/views";
import type { View, ViewNode } from "../../src/types";
import { App as MockApp } from "../mocks/obsidian";
import { dragOverAt, flushNoticeMicrotasks, folderNode, makeDropFake, makeRow, makeVm, node } from "./explorer-view-drop-helpers";
import { callRenderNodeList, makeFakeExplorer, makeStatusesManager, rowOrder, view as baseView } from "./explorer-view-sort-truncate-helpers";

const proto = AtlasExplorerView.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const paths = (nodes: ViewNode[]) => nodes.map((n) => n.ref?.path ?? n.label);

/** Mounts a row for `nodeId` as a real drop zone and returns it plus its list container. */
function mountZone(fake: ReturnType<typeof makeDropFake>, nodeId: string, hasBottomZone = true) {
	const container = document.createElement("div");
	const row = makeRow();
	container.appendChild(row);
	fake.makeDropZone(row, { kind: "node", nodeId, viewId: "v1" }, hasBottomZone);
	return { container, row };
}
const drop = (row: HTMLElement) => row.dispatchEvent(new Event("drop", { bubbles: true }));

describe("PR-3 R3 — golden path from the spec's real starting state: a same-parent upward reorder", () => {
	it("Projects = quarry-drones, Annual Review, Zebra Census; dragging Zebra Census to quarry-drones' top edge reorders inside Projects", () => {
		const quarry = node("quarry", "quarry-drones.md");
		const annual = node("annual", "Annual Review.md");
		const zebra = node("zebra", "Zebra Census.md");
		const projects = folderNode("projects", "Projects", [quarry, annual, zebra]);
		const vm = makeVm([projects]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["zebra"], viewId: "v1" };

		const { container, row } = mountZone(fake, "quarry");
		dragOverAt(row, 5); // GP1: a line above quarry-drones
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(Array.from(container.children)).toEqual([fake.dropIndicatorEl, row]);

		drop(row); // GP2
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["projects"]); // nothing left the folder, nothing nested
		expect(root[0].children.map((n) => n.id)).toEqual(["zebra", "quarry", "annual"]);
	});
});

describe("PR-3 R2 — a selection that includes the drop target is part of the batch", () => {
	// The spec says the target "is treated as part of the batch and the cycle guard and no-op rules
	// still hold". An edge drop therefore lands the whole batch together at the slot beside the
	// target, in drag order (the target's own move is the E1 no-op or a harmless reorder); only the
	// nest zone onto a dragged row itself is refused, by the cycle guard. Provisional reading, pending
	// Dan's confirmation (docs/decisions.md).
	function setup(ids: string[], dragged: string[]) {
		const nodes = ids.map((id) => node(id, `${id.toUpperCase()}.md`));
		const vm = makeVm(nodes);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: dragged, viewId: "v1" };
		return { vm, fake };
	}
	const rootIds = (vm: ReturnType<typeof makeVm>) => vm.getViews()[0].root.map((n) => n.id);

	it("select B and D, drop on D's top edge: shows a line before D and B lands before D (nothing nests)", () => {
		const { vm, fake } = setup(["b", "c", "d"], ["b", "d"]);
		const { container, row } = mountZone(fake, "d");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(Array.from(container.children)).toEqual([fake.dropIndicatorEl, row]);
		expect(row.classList.contains("atlas-drop-target")).toBe(false);

		drop(row);
		expect(rootIds(vm)).toEqual(["c", "b", "d"]);
		expect(vm.getViews()[0].root.every((n) => n.children.length === 0)).toBe(true);
	});

	it("select B and D, drop on D's bottom edge: the batch lands together after the target's slot, in drag order", () => {
		const { vm, fake } = setup(["b", "c", "d", "e"], ["b", "d"]);
		const { row } = mountZone(fake, "d");
		dragOverAt(row, 95);
		drop(row);
		expect(rootIds(vm)).toEqual(["c", "b", "d", "e"]);
	});

	it("select B and D, drop on D's middle: nests B into D; D itself stays put (cycle guard)", () => {
		const { vm, fake } = setup(["b", "c", "d"], ["b", "d"]);
		const { row } = mountZone(fake, "d");
		dragOverAt(row, 50);
		expect(row.classList.contains("atlas-drop-target")).toBe(true);
		drop(row);
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["c", "d"]);
		expect(root[1].children.map((n) => n.id)).toEqual(["b"]);
	});

	it("a lone drag onto its own top edge is the E1 no-op: a line shows, the order is unchanged", () => {
		const { vm, fake } = setup(["a", "b"], ["a"]);
		const { container, row } = mountZone(fake, "a");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		drop(row);
		expect(rootIds(vm)).toEqual(["a", "b"]);
		expect(vm.getViews()[0].root[0].children).toEqual([]);
	});

	it("a lone drag onto its own middle is a no-op (the cycle guard refuses the nest)", () => {
		const { vm, fake } = setup(["a", "b"], ["a"]);
		const { row } = mountZone(fake, "a");
		dragOverAt(row, 50);
		drop(row);
		expect(rootIds(vm)).toEqual(["a", "b"]);
		expect(vm.getViews()[0].root[0].children).toEqual([]);
	});

	it("in a sorted folder the whole drop is refused with the Notice, target in the batch or not", async () => {
		const a = node("a", "a.md");
		const b = node("b", "b.md");
		const c = node("c", "c.md");
		const grand = folderNode("grand", "Grand", [a, b, c], { sortMode: "alphabetical" });
		const vm = makeVm([grand]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "node", nodeIds: ["a", "c"], viewId: "v1" };
		Notice.reset();
		const { container, row } = mountZone(fake, "c");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0); // no line in a sorted list
		drop(row);
		await flushNoticeMicrotasks();
		expect(Notice.instances.map((n) => n.message)).toEqual(["Grand is sorted A-Z. Set it to Manual to reorder."]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["a", "b", "c"]);
	});

	it("a target inside a dragged node's subtree still falls back to the nest highlight and refuses the drop", () => {
		const child = node("child", "Child.md");
		const parent = node("parent", "Parent.md", [child]);
		const other = node("other", "Other.md");
		const vm = makeVm([parent, other]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["parent", "child"], viewId: "v1" };
		const { container, row } = mountZone(fake, "child");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true);
		drop(row);
		expect(rootIds(vm)).toEqual(["parent", "other"]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["child"]);
	});
});

describe("PR-3 R4 / PR-4 R2 — rows with no edge zone never get a drop zone", () => {
	/** A `this` that answers every unknown method with a no-op spy, so the real row renderers run
	 * without hand-listing each collaborator. `makeDropZone` is the one thing under test. */
	function spyFake(extra: Record<string, unknown> = {}) {
		const makeDropZone = vi.fn();
		const base: Record<string, unknown> = {
			plugin: { statusesManager: undefined, settings: {}, viewsManager: { managedRowFilterState: vi.fn(() => "shown"), getNode: vi.fn() }, folderSourcePathStore: { get: vi.fn(() => "") } },
			selectedBucketNodeIds: new Set<string>(),
			filterText: "",
			makeDropZone,
			isOutsideManagedUnit: proto.isOutsideManagedUnit,
			resolveOutsideManagedRowInfo: proto.resolveOutsideManagedRowInfo,
			matchesFilter: proto.matchesFilter,
			pseudoNodeForApiItem: proto.pseudoNodeForApiItem,
			renderConnectionDots: proto.renderConnectionDots,
			bucketVisibleOrder: vi.fn(() => []),
			handleSelectionClick: vi.fn(() => false),
			buildNodeDragPayload: vi.fn(),
			resolveRef: vi.fn(async () => ({ text: "t", icon: "file", promoted: false, added: false, missing: false })),
			computeEffectiveCollapsed: vi.fn(async () => false),
			...extra,
		};
		const fake = new Proxy(base, {
			get(target, prop: string) {
				if (!(prop in target)) target[prop] = vi.fn();
				return target[prop];
			},
		});
		return { fake, makeDropZone };
	}

	it("an Outside-Vault-managed child (even under a sorted owner) is never given a drop zone", async () => {
		const owner: ViewNode = folderNode("owner", "Owner", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true }, sortMode: "alphabetical" });
		const child: ViewNode = { id: "c1", type: "unit", ref: { kind: "file", path: "a.md" }, children: [], folderSourceManaged: true, folderSourceOwnerId: "owner" };
		const { fake, makeDropZone } = spyFake({ plugin: { statusesManager: undefined, settings: {}, viewsManager: { managedRowFilterState: vi.fn(() => "shown"), getNode: vi.fn(() => owner) }, folderSourcePathStore: { get: vi.fn(() => "") } } });
		const container = document.createElement("div");
		await proto.renderNode.call(fake, child, container, baseView, 0, []);
		expect(container.querySelector(".atlas-row-unit")).not.toBeNull(); // it did render
		expect(makeDropZone).not.toHaveBeenCalled();
	});

	it("an API item row is never given a drop zone", () => {
		const { fake, makeDropZone } = spyFake({ renderRowIcon: vi.fn() });
		const owner = folderNode("owner", "Owner", []);
		const container = document.createElement("div");
		proto.renderApiItemRow.call(fake, { id: "api-1", label: "One" }, container, baseView, owner, 1, [owner]);
		expect(container.querySelector(".atlas-row-api-item")).not.toBeNull();
		expect(makeDropZone).not.toHaveBeenCalled();
		// and a dragover on it neither draws a line nor highlights anything
		const apiRow = container.querySelector(".atlas-row-api-item") as HTMLElement;
		apiRow.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: 5 }));
		expect(container.querySelector(".atlas-drop-indicator")).toBeNull();
		expect(apiRow.classList.contains("atlas-drop-target")).toBe(false);
	});

	it("a truncation placeholder row is never given a drop zone", () => {
		const { fake, makeDropZone } = spyFake();
		const container = document.createElement("div");
		proto.renderTruncationGroupHeader.call(fake, container, baseView, "k", { id: "done", label: "Done", color: "#fff" }, { statusId: "done", label: "{n} done" }, 3, 1, false);
		expect(container.querySelector(".atlas-truncation-row")).not.toBeNull();
		expect(makeDropZone).not.toHaveBeenCalled();
	});

	it("control: an ordinary hand-placed unit row does get one", async () => {
		const { fake, makeDropZone } = spyFake();
		const child: ViewNode = { id: "c2", type: "unit", ref: { kind: "file", path: "a.md" }, children: [] };
		await proto.renderNode.call(fake, child, document.createElement("div"), baseView, 0, []);
		expect(makeDropZone).toHaveBeenCalledTimes(1);
	});

	it("a manually-added child of an Outside-Vault source folder with a sort set still reorders on an edge drop — the sort gate never applies there (G22)", () => {
		const m1 = node("m1", "m1.md");
		const m2 = node("m2", "m2.md");
		const owner = folderNode("owner", "Owner", [m1, m2], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true }, sortMode: "alphabetical" });
		const vm = makeVm([owner]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "node", nodeIds: ["m2"], viewId: "v1" };

		const { container, row } = mountZone(fake, "m1");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1); // a line, not a refusal
		drop(row);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["m2", "m1"]);
	});

	it("the Inbox area never carries an edge zone, whatever the pointer height", () => {
		const vm = makeVm([node("a", "A.md")]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };
		Notice.reset();
		const container = document.createElement("div");
		const area = makeRow();
		container.appendChild(area);
		fake.makeDropZone(area, { kind: "inbox-area", viewId: "v1" });
		dragOverAt(area, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(container.querySelectorAll(".atlas-sorted-drop-outline")).toHaveLength(0);
		expect(area.classList.contains("atlas-drop-target")).toBe(true);
	});
});

describe("PR-4 R2 — folder-source hoisted rows and lifting out of a sub-folder resolve against the real tree", () => {
	it("a hoisted row (its hidden owner renders in the sorted grandparent's list) uses its real parent's Manual order, not the grandparent's sort", () => {
		const c1 = node("c1", "c1.md");
		const c2 = node("c2", "c2.md");
		const owner = folderNode("owner", "Hidden owner", [c1, c2]); // Manual
		const grand = folderNode("grand", "Grand", [owner], { sortMode: "alphabetical" });
		const vm = makeVm([grand]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "New.md" }] };

		// c1's row is rendered inside the grandparent's list in the DOM, but its real parent is `owner`.
		const { container, row } = mountZone(fake, "c1");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(false);
		drop(row);
		expect(paths(vm.getViews()[0].root[0].children[0].children)).toEqual(["New.md", "c1.md", "c2.md"]);
		expect(paths(vm.getViews()[0].root[0].children)).toEqual(["Hidden owner"]); // grandparent's list untouched
	});

	it("a hoisted row whose real parent IS sorted gets the sorted-insert outline and lands in that parent", () => {
		const c1 = node("c1", "c1.md");
		const owner = folderNode("owner", "Hidden owner", [c1], { sortMode: "alphabetical" });
		const grand = folderNode("grand", "Grand", [owner]); // Manual
		const vm = makeVm([grand]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "New.md" }] };

		const { container, row } = mountZone(fake, "c1");
		dragOverAt(row, 5);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(true);
		drop(row);
		expect(paths(vm.getViews()[0].root[0].children[0].children)).toEqual(["New.md", "c1.md"]);
	});

	it("dragging a row UP out of a sub-folder onto an edge of the sorted grandparent list is a sorted-insert there, not a refusal", async () => {
		const a = node("a", "a.md");
		const x = node("x", "x.md");
		const sub = folderNode("sub", "Sub", [x]);
		const grand = folderNode("grand", "Grand", [a, sub], { sortMode: "alphabetical" });
		const vm = makeVm([grand]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "node", nodeIds: ["x"], viewId: "v1" };
		Notice.reset();

		const { container, row } = mountZone(fake, "a");
		dragOverAt(row, 5);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(true);
		drop(row);
		await flushNoticeMicrotasks();
		expect(Notice.instances).toHaveLength(0);
		const g = vm.getViews()[0].root[0];
		expect(g.children.map((n) => n.id)).toEqual(["x", "a", "sub"]); // lifted into Grand at the dropped slot
		expect(g.children[2].children).toEqual([]); // and gone from Sub
	});

	it("contrast: dragging a row that is already in the sorted grandparent list onto its edge is refused with the Notice", async () => {
		const a = node("a", "a.md");
		const z = node("z", "z.md");
		const grand = folderNode("grand", "Grand", [a, z], { sortMode: "alphabetical" });
		const vm = makeVm([grand]);
		const fake = makeDropFake(vm, makeStatusesManager());
		fake.dragPayload = { kind: "node", nodeIds: ["z"], viewId: "v1" };
		Notice.reset();

		const { row } = mountZone(fake, "a");
		dragOverAt(row, 5);
		drop(row);
		await flushNoticeMicrotasks();
		expect(Notice.instances.map((n) => n.message)).toEqual(["Grand is sorted A-Z. Set it to Manual to reorder."]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["a", "z"]);
	});
});

describe("PR-2 R7 — the G13 sort indicator on a unit row", () => {
	async function unitRow(n: ViewNode, governor: unknown = null): Promise<HTMLElement> {
		const base: Record<string, unknown> = {
			plugin: { statusesManager: { findSortGovernor: vi.fn(() => governor) }, settings: {}, viewsManager: { managedRowFilterState: vi.fn(() => "shown"), getNode: vi.fn() }, folderSourcePathStore: { get: vi.fn(() => "") } },
			selectedBucketNodeIds: new Set<string>(),
			filterText: "",
			isOutsideManagedUnit: proto.isOutsideManagedUnit,
			matchesFilter: proto.matchesFilter,
			renderConnectionDots: proto.renderConnectionDots,
			renderSortIndicator: proto.renderSortIndicator,
			bucketVisibleOrder: vi.fn(() => []),
			handleSelectionClick: vi.fn(() => false),
			resolveRef: vi.fn(async () => ({ text: "t", icon: "file", promoted: false, added: false, missing: false })),
			computeEffectiveCollapsed: vi.fn(async () => false),
		};
		const fake = new Proxy(base, {
			get(target, prop: string) {
				if (!(prop in target)) target[prop] = vi.fn();
				return target[prop];
			},
		});
		const container = document.createElement("div");
		await proto.renderNode.call(fake, n, container, baseView, 0, []);
		return container.querySelector(".atlas-row-unit") as HTMLElement;
	}

	it("a unit row whose own children are sorted shows the icon and the tooltip", async () => {
		const row = await unitRow({ ...node("u", "u.md"), sortMode: "alphabetical", sortReverse: true });
		expect(row.querySelector(".atlas-sort-indicator")).toBeTruthy();
	});

	it("a Manual unit row shows none", async () => {
		expect((await unitRow(node("u", "u.md"))).querySelector(".atlas-sort-indicator")).toBeNull();
		expect((await unitRow({ ...node("u", "u.md"), sortMode: "manual" })).querySelector(".atlas-sort-indicator")).toBeNull();
	});

	const governor = { statusSetId: "s1", sortMode: "status", sortReverse: false, inheritToSubfolders: true };

	it("a unit row with children under a governor that sorts by status shows the status indicator", async () => {
		const row = await unitRow({ ...node("u", "u.md"), children: [node("k", "k.md")] }, governor);
		expect(row.querySelector(".atlas-sort-indicator")).toBeTruthy();
	});

	it("a childless leaf under a governor that sorts by status shows no indicator", async () => {
		const row = await unitRow(node("u", "u.md"), governor);
		expect(row.querySelector(".atlas-sort-indicator")).toBeNull();
	});

	it("a childless unit with its own explicit non-Manual mode still shows the indicator", async () => {
		const row = await unitRow({ ...node("u", "u.md"), sortMode: "alphabetical" });
		expect(row.querySelector(".atlas-sort-indicator")).toBeTruthy();
	});
});

describe("PR-3 R6 — the Q7 wiring in renderNode: an expanded row with children has no bottom zone", () => {
	function spyFake(collapsed: boolean) {
		const makeDropZone = vi.fn();
		const base: Record<string, unknown> = {
			plugin: { statusesManager: undefined, settings: {}, viewsManager: { managedRowFilterState: vi.fn(() => "shown"), getNode: vi.fn() }, folderSourcePathStore: { get: vi.fn(() => "") } },
			selectedBucketNodeIds: new Set<string>(),
			filterText: "",
			makeDropZone,
			isOutsideManagedUnit: proto.isOutsideManagedUnit,
			matchesFilter: proto.matchesFilter,
			renderConnectionDots: proto.renderConnectionDots,
			bucketVisibleOrder: vi.fn(() => []),
			handleSelectionClick: vi.fn(() => false),
			resolveRef: vi.fn(async () => ({ text: "t", icon: "file", promoted: false, added: false, missing: false })),
			computeEffectiveCollapsed: vi.fn(async () => collapsed),
		};
		const fake = new Proxy(base, {
			get(target, prop: string) {
				if (!(prop in target)) target[prop] = vi.fn();
				return target[prop];
			},
		});
		return { fake, makeDropZone };
	}
	async function bottomZoneFlag(n: ViewNode, collapsed: boolean): Promise<boolean> {
		const { fake, makeDropZone } = spyFake(collapsed);
		await proto.renderNode.call(fake, n, document.createElement("div"), baseView, 0, []);
		expect(makeDropZone).toHaveBeenCalledTimes(1);
		return makeDropZone.mock.calls[0][2] as boolean;
	}
	const withKids = (n: ViewNode): ViewNode => ({ ...n, children: [node("k", "k.md")] });

	it("Folder row: expanded with children -> false; collapsed with children -> true; childless -> true", async () => {
		expect(await bottomZoneFlag(withKids(folderNode("f", "F", [])), false)).toBe(false);
		expect(await bottomZoneFlag(withKids(folderNode("f", "F", [])), true)).toBe(true);
		expect(await bottomZoneFlag(folderNode("f", "F", []), false)).toBe(true);
	});

	it("unit row: expanded with children -> false; collapsed with children -> true; childless -> true", async () => {
		expect(await bottomZoneFlag(withKids(node("u", "u.md")), false)).toBe(false);
		expect(await bottomZoneFlag(withKids(node("u", "u.md")), true)).toBe(true);
		expect(await bottomZoneFlag(node("u", "u.md"), false)).toBe(true);
	});

	it("unit row: a childless row never even asks whether it is collapsed", async () => {
		const { fake } = spyFake(false);
		await proto.renderNode.call(fake, node("u", "u.md"), document.createElement("div"), baseView, 0, []);
		expect(fake.computeEffectiveCollapsed).not.toHaveBeenCalled();
	});
});

describe("PR-4 R1 — a sorted-place landing, at render level", () => {
	/** Renders `folder`'s children through the real sort pass and returns their paths in display order. */
	async function displayed(vm: ViewsManager): Promise<(string | undefined)[]> {
		const v = vm.getViews()[0] as View;
		const folder = v.root[0];
		const byId = new Map<string, string | undefined>();
		const collect = (ns: ViewNode[]) => ns.forEach((n) => (byId.set(n.id, n.ref?.path ?? n.label), collect(n.children)));
		collect(v.root);
		const fake = makeFakeExplorer(makeStatusesManager(), {
			resolveRef: vi.fn(async (ref: { path: string }) => ({ text: ref.path, icon: "file", promoted: false, added: false, missing: false })),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, folder.children, container, v, 1, [folder, v]);
		return rowOrder(container).map((id) => byId.get(id));
	}

	function seeded() {
		const projects = folderNode("projects", "Projects", [node("annual", "Annual Review.md"), node("quarry", "quarry-drones.md"), node("zebra", "Zebra Census.md")], { sortMode: "alphabetical" });
		const vm = makeVm([projects]);
		return { vm, fake: makeDropFake(vm, makeStatusesManager()) };
	}

	it("a from-elsewhere drop on an edge lands at the dropped slot in storage, but the displayed order is the comparator's; switching to Manual shows the stored slot", async () => {
		const { vm, fake } = seeded();
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "Zulu Notes.md" }] };
		const { row } = mountZone(fake, "annual");
		dragOverAt(row, 5); // top edge of the first row
		drop(row);

		const folder = () => vm.getViews()[0].root[0];
		// stored: the dropped slot (first), which A-Z would never produce
		expect(paths(folder().children)).toEqual(["Zulu Notes.md", "Annual Review.md", "quarry-drones.md", "Zebra Census.md"]);
		// displayed: the A-Z comparator order (case-insensitive), the new row sorted into place
		expect(await displayed(vm)).toEqual(["Annual Review.md", "quarry-drones.md", "Zebra Census.md", "Zulu Notes.md"]);

		// ... and Manual then shows the stored drop slot, with nothing rewritten by having been sorted
		vm.updateStatusGovernance("v1", "projects", { sortMode: "manual", sortReverse: false });
		expect(await displayed(vm)).toEqual(["Zulu Notes.md", "Annual Review.md", "quarry-drones.md", "Zebra Census.md"]);
	});

	it("a cross-parent node drop behaves the same way", async () => {
		const { vm, fake } = seeded();
		const outsider = node("outsider", "Zed.md");
		vm.getViews()[0].root.push(outsider);
		fake.dragPayload = { kind: "node", nodeIds: ["outsider"], viewId: "v1" };
		const { row } = mountZone(fake, "quarry");
		dragOverAt(row, 90); // bottom edge of quarry-drones
		drop(row);
		expect(paths(vm.getViews()[0].root[0].children)).toEqual(["Annual Review.md", "quarry-drones.md", "Zed.md", "Zebra Census.md"]);
		expect(await displayed(vm)).toEqual(["Annual Review.md", "quarry-drones.md", "Zebra Census.md", "Zed.md"]);
	});
});

describe("PR-4 R4 — an accepted sorted-insert drop touches nothing it should not", () => {
	function build() {
		const app = new MockApp();
		const kept = node("kept", "kept.md", [node("kept-child", "kept-child.md")]);
		kept.sortMode = "modified";
		kept.sortReverse = true;
		kept.placedAt = 111;
		const other = folderNode("other", "Other", [node("o1", "o1.md"), node("o2", "o2.md")], { sortMode: "time-added", sortReverse: false, placedAt: 222 });
		const a = node("a", "a.md");
		a.placedAt = 333;
		const z = node("z", "z.md");
		z.placedAt = 444;
		const sorted = folderNode("sorted", "Sorted", [a, z], { sortMode: "alphabetical", sortReverse: true, placedAt: 555 });
		const vm = new ViewsManager(app as unknown as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [kept, other, sorted] }], "v1", () => {});
		return { app, vm, fake: makeDropFake(vm, makeStatusesManager()) };
	}
	const snap = (n: ViewNode): unknown => JSON.parse(JSON.stringify(n));

	it("an inbox drop leaves every unrelated node, the target's own settings and its existing children exactly as they were", () => {
		const { app, vm, fake } = build();
		const root = () => vm.getViews()[0].root;
		const before = { kept: snap(root()[0]), other: snap(root()[1]), a: snap(root()[2].children[0]), z: snap(root()[2].children[1]) };
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "New.md" }] };

		const { row } = mountZone(fake, "a");
		dragOverAt(row, 90);
		drop(row);

		const sorted = root()[2];
		expect(sorted.children).toHaveLength(3);
		expect(snap(root()[0])).toEqual(before.kept);
		expect(snap(root()[1])).toEqual(before.other);
		expect(snap(sorted.children.find((n) => n.id === "a")!)).toEqual(before.a);
		expect(snap(sorted.children.find((n) => n.id === "z")!)).toEqual(before.z);
		expect({ sortMode: sorted.sortMode, sortReverse: sorted.sortReverse, placedAt: sorted.placedAt, label: sorted.label }).toEqual({ sortMode: "alphabetical", sortReverse: true, placedAt: 555, label: "Sorted" });
		expect(app.vault.calls).toEqual([]);
	});

	it("a cross-parent move leaves everyone but the moved node and the two lists' membership exactly as they were", () => {
		const { app, vm, fake } = build();
		const root = () => vm.getViews()[0].root;
		const before = { kept: snap(root()[0]), otherSettings: { sortMode: "time-added", sortReverse: false, placedAt: 222 }, a: snap(root()[2].children[0]), z: snap(root()[2].children[1]) };
		fake.dragPayload = { kind: "node", nodeIds: ["o1"], viewId: "v1" };

		const { row } = mountZone(fake, "z");
		dragOverAt(row, 5);
		drop(row);

		expect(snap(root()[0])).toEqual(before.kept);
		const other = root()[1];
		expect(other.children.map((n) => n.id)).toEqual(["o2"]);
		expect({ sortMode: other.sortMode, sortReverse: other.sortReverse, placedAt: other.placedAt }).toEqual(before.otherSettings);
		const sorted = root()[2];
		expect(sorted.children.map((n) => n.id).sort()).toEqual(["a", "o1", "z"]);
		expect(snap(sorted.children.find((n) => n.id === "a")!)).toEqual(before.a);
		expect(snap(sorted.children.find((n) => n.id === "z")!)).toEqual(before.z);
		expect({ sortMode: sorted.sortMode, sortReverse: sorted.sortReverse, placedAt: sorted.placedAt }).toEqual({ sortMode: "alphabetical", sortReverse: true, placedAt: 555 });
		expect(app.vault.calls).toEqual([]);
	});
});

