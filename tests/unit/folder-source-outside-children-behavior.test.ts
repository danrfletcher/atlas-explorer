import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AtlasExplorerView } from "../../src/explorer-view";
import { View, ViewNode } from "../../src/types";
import { file, folder, meta, unit } from "../integration/create-from-meta-fixtures";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, realNode, view as baseView } from "./explorer-view-sort-truncate-helpers";

const proto = AtlasExplorerView.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

/** Minimal `this` for driving the real (unstubbed) `renderNode` on a `type: "unit"` row — same
 * "expose just enough of AtlasExplorerView to exercise one real method" pattern as
 * `explorer-view-sort-truncate-helpers.ts`, just shaped for the unit-row branch specifically instead
 * of the sort/truncate pass. `isOutsideManagedUnit`/`resolveOutsideManagedRowInfo` are the two real
 * PR-5 methods under test here, so they're never stubbed. */
function makeFakeExplorerForRenderNode(overrides: Record<string, unknown> = {}) {
	const getNode = vi.fn((_viewId: string, nodeId: string) => (overrides.ownerNode as ViewNode | undefined) ?? null);
	return {
		plugin: {
			viewsManager: { getNode, unplaceNode: vi.fn(), managedRowFilterState: vi.fn(() => "shown") },
			folderSourcePathStore: { get: vi.fn(() => "") },
		},
		filterText: "",
		selectedBucketNodeIds: new Set<string>(),
		bucketVisibleOrder: vi.fn(() => []),
		dragPayload: null as unknown,
		resolveRef: vi.fn(async () => ({ text: "fallback", icon: "file", promoted: false, missing: false })),
		isOutsideManagedUnit: proto.isOutsideManagedUnit,
		resolveOutsideManagedRowInfo: proto.resolveOutsideManagedRowInfo,
		matchesFilter: proto.matchesFilter,
		renderRowIcon: vi.fn(),
		wireModuleRow: vi.fn(),
		makeDropZone: vi.fn(),
		setPlacementTooltip: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		openRef: vi.fn(),
		buildNodeDragPayload: vi.fn(() => ({ kind: "node", nodeId: "x", viewId: "v1" })),
		handleRowKeydown: vi.fn(),
		showUnitMenu: vi.fn(),
		renderFoldableChildren: vi.fn(),
		...overrides,
	};
}

async function renderUnitRow(node: ViewNode, fakeOverrides: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	const fake = makeFakeExplorerForRenderNode(fakeOverrides);
	await proto.renderNode.call(fake, node, container, view, 0, []);
	const row = container.querySelector(".atlas-row-unit") as HTMLElement;
	return { row, fake };
}

describe("G8/F7 — drag-disabled rule", () => {
	it("an Outside-Vault-managed child renders with draggable=false", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c1", file("/Volumes/External/Notes/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { row } = await renderUnitRow(node, { ownerNode: owner });

		expect(row.getAttribute("draggable")).toBe("false");
	});

	it("an ordinary hand-placed child still renders with draggable=true (unaffected)", async () => {
		const node = unit("c2", file("Notes/a.md"));
		const { row } = await renderUnitRow(node);
		expect(row.getAttribute("draggable")).toBe("true");
	});

	it("an Inside-Vault Folder-source-managed child still renders with draggable=true (unaffected, G7)", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "inside", path: "Projects", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c3", file("Projects/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { row } = await renderUnitRow(node, { ownerNode: owner });

		expect(row.getAttribute("draggable")).toBe("true");
	});

	it("a dragstart listener is never attached to an Outside-Vault-managed row — firing dragstart never sets dragPayload", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c1", file("/Volumes/External/Notes/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { row, fake } = await renderUnitRow(node, { ownerNode: owner });
		row.dispatchEvent(new Event("dragstart"));

		expect((fake as { buildNodeDragPayload: ReturnType<typeof vi.fn> }).buildNodeDragPayload).not.toHaveBeenCalled();
		expect(fake.dragPayload).toBeNull();
	});

	it("an ordinary row's dragstart listener does set dragPayload (control case)", async () => {
		const node = unit("c2", file("Notes/a.md"));
		const { row, fake } = await renderUnitRow(node);
		row.dispatchEvent(new Event("dragstart"));

		expect((fake as { buildNodeDragPayload: ReturnType<typeof vi.fn> }).buildNodeDragPayload).toHaveBeenCalledWith("c2", "v1");
	});
});

describe("G8/F7 — nest-disabled rule: an Outside-Vault-managed row is never made a drop zone", () => {
	it("makeDropZone is never called for an Outside-Vault-managed row", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c1", file("/Volumes/External/Notes/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { fake } = await renderUnitRow(node, { ownerNode: owner });

		expect((fake as { makeDropZone: ReturnType<typeof vi.fn> }).makeDropZone).not.toHaveBeenCalled();
	});

	it("makeDropZone IS called for an ordinary row (control case)", async () => {
		const node = unit("c2", file("Notes/a.md"));
		const { fake } = await renderUnitRow(node);

		expect((fake as { makeDropZone: ReturnType<typeof vi.fn> }).makeDropZone).toHaveBeenCalledWith(expect.anything(), { kind: "node", nodeId: "c2", viewId: "v1" });
	});
});

describe("G8/F7 — rename-disabled rule: wireModuleRow (the only rename mechanic for a folder-kind unit row) is never wired for an Outside-Vault-managed child", () => {
	it("a folder-kind Outside-Vault-managed child never calls wireModuleRow", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c1", folder("/Volumes/External/Notes/Sub"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { fake } = await renderUnitRow(node, { ownerNode: owner, resolveOutsideManagedRowInfo: () => ({ text: "Sub", icon: "folder", promoted: false, missing: false }) });

		expect((fake as { wireModuleRow: ReturnType<typeof vi.fn> }).wireModuleRow).not.toHaveBeenCalled();
	});

	it("an ordinary folder-kind child DOES call wireModuleRow (control case)", async () => {
		const node = unit("c2", folder("Projects/Sub"));
		const { fake } = await renderUnitRow(node);

		expect((fake as { wireModuleRow: ReturnType<typeof vi.fn> }).wireModuleRow).toHaveBeenCalled();
	});
});

describe("status/sort/truncate-still-enabled rule — an Outside-Vault-managed row participates in the shared sort/truncate pass exactly like any other node", () => {
	it("an Outside-Vault-managed node is ranked by status and truncated/grouped identically to an ordinary node with the same status", async () => {
		const sm = makeStatusesManager();
		const governor = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });

		const outsideManagedA = realNode("outside-a", { explicitStatusId: "todo", folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const outsideManagedB = realNode("outside-b", { explicitStatusId: "todo", folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const ordinary = realNode("ordinary", { explicitStatusId: "doing" });

		const renderTruncationGroupHeader = vi.fn();
		const fake = makeFakeExplorer(sm, { renderTruncationGroupHeader });

		const container = document.createElement("div");
		await callRenderNodeList(fake, [outsideManagedA, outsideManagedB, ordinary], container, baseView, 0, [governor]);

		// Two nodes sharing the truncation-enabled "todo" status (regardless of folderSourceManaged)
		// collapse into one placeholder group — exactly the same rule an ordinary pair of nodes gets;
		// nothing in the sort/truncate pass special-cases a managed/outside-managed row.
		expect(renderTruncationGroupHeader).toHaveBeenCalledTimes(1);
		const [, , , statusArg, , countArg] = renderTruncationGroupHeader.mock.calls[0];
		expect((statusArg as { id: string }).id).toBe("todo");
		expect(countArg).toBe(2);
	});
});

describe("renderNodeList — R1/R2: render-time skip for an unresolved Outside-Vault source (real isOutsideManagedAndUnresolved)", () => {
	it("skips an Outside-managed node entirely while its owning source's path doesn't resolve, rendering only the ordinary node", async () => {
		const owner = meta("owner", "Folder", [], {
			folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false },
		});
		const outsideManaged = realNode("outside-a", { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const ordinary = realNode("ordinary");

		const getNode = vi.fn((_viewId: string, nodeId: string) => (nodeId === "owner" ? owner : null));
		const sm = makeStatusesManager();
		const fake = makeFakeExplorer(sm, { isOutsideManagedAndUnresolved: proto.isOutsideManagedAndUnresolved as never });
		(fake as unknown as { plugin: Record<string, unknown> }).plugin = {
			...fake.plugin,
			viewsManager: { getNode, managedRowFilterState: vi.fn(() => "shown") },
			folderSourcePathStore: { get: vi.fn(() => "") },
		};

		const container = document.createElement("div");
		await callRenderNodeList(fake, [outsideManaged, ordinary], container, baseView, 0, []);

		expect(fake.renderNode).toHaveBeenCalledTimes(1);
		expect((fake.renderNode as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(ordinary);
	});

	it("renders the Outside-managed node again once its source's device-local path resolves — same persisted node, no gap", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-render-recover-test-"));
		try {
			const owner = meta("owner", "Folder", [], {
				folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false },
			});
			const outsideManaged = realNode("outside-a", { folderSourceManaged: true, folderSourceOwnerId: "owner" });
			const ordinary = realNode("ordinary");

			const getNode = vi.fn((_viewId: string, nodeId: string) => (nodeId === "owner" ? owner : null));
			const sm = makeStatusesManager();
			const fake = makeFakeExplorer(sm, { isOutsideManagedAndUnresolved: proto.isOutsideManagedAndUnresolved as never });
			(fake as unknown as { plugin: Record<string, unknown> }).plugin = {
				...fake.plugin,
				viewsManager: { getNode, managedRowFilterState: vi.fn(() => "shown") },
				folderSourcePathStore: { get: vi.fn(() => tmpDir) },
			};

			const container = document.createElement("div");
			await callRenderNodeList(fake, [outsideManaged, ordinary], container, baseView, 0, []);

			expect(fake.renderNode).toHaveBeenCalledTimes(2);
			const renderedNodes = (fake.renderNode as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
			expect(renderedNodes).toContain(outsideManaged);
			expect(renderedNodes).toContain(ordinary);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("buildNodeDragPayload — R3: an Outside-Vault-managed node id never rides along in a drag payload (real isOutsideManagedNodeId)", () => {
	function fakeDragThis(byId: Map<string, ViewNode>, selected: string[]) {
		const getNode = vi.fn((_viewId: string, nodeId: string) => byId.get(nodeId) ?? null);
		return {
			plugin: { viewsManager: { getNode } },
			selectedBucketNodeIds: new Set(selected),
			selectedInboxRefKeys: new Set<string>(),
			selectionAnchor: null as string | null,
			selectionAnchorScope: null as string | null,
			isOutsideManagedNodeId: proto.isOutsideManagedNodeId,
		};
	}

	it("R3: dragging an ordinary row that's multi-selected alongside an Outside-managed row excludes the Outside-managed id from the payload", () => {
		const owner = meta("owner", "Folder", [], {
			folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false },
		});
		const outsideChild = unit("outside-c", file("/Volumes/External/Notes/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const ordinary = unit("ordinary-c", file("Notes/b.md"));
		const byId = new Map<string, ViewNode>([
			[owner.id, owner],
			[outsideChild.id, outsideChild],
			[ordinary.id, ordinary],
		]);
		const fake = fakeDragThis(byId, [outsideChild.id, ordinary.id]);

		const payload = (proto.buildNodeDragPayload as (...a: unknown[]) => { kind: string; nodeIds: string[]; viewId: string }).call(
			fake,
			ordinary.id,
			"v1"
		);

		expect(payload.nodeIds).toEqual([ordinary.id]);
		expect(payload.nodeIds).not.toContain(outsideChild.id);
		// The multi-select highlight itself is untouched — only the drag payload is filtered.
		expect(fake.selectedBucketNodeIds.has(outsideChild.id)).toBe(true);
	});

	it("a multi-select with no Outside-managed member passes every id through unchanged (control case)", () => {
		const a = unit("a", file("Notes/a.md"));
		const b = unit("b", file("Notes/b.md"));
		const byId = new Map<string, ViewNode>([
			[a.id, a],
			[b.id, b],
		]);
		const fake = fakeDragThis(byId, [a.id, b.id]);

		const payload = (proto.buildNodeDragPayload as (...args: unknown[]) => { kind: string; nodeIds: string[]; viewId: string }).call(
			fake,
			a.id,
			"v1"
		);

		expect([...payload.nodeIds].sort()).toEqual([a.id, b.id].sort());
	});
});

describe("R9(c) — clicking or pressing Enter on an Outside-Vault-managed row never calls openRef: its ref.path is a bare name relative to the source's root, not a vault path, so opening it would open (or create) an unrelated same-named vault-root file/module instead of doing nothing", () => {
	it("the row's click handler no-ops instead of calling openRef", async () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c1", file("notes.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });

		const { row, fake } = await renderUnitRow(node, { ownerNode: owner });
		row.dispatchEvent(new Event("click"));

		expect((fake as { openRef: ReturnType<typeof vi.fn> }).openRef).not.toHaveBeenCalled();
	});

	it("an ordinary row's click handler DOES call openRef (control case)", async () => {
		const node = unit("c2", file("Notes/a.md"));
		const { row, fake } = await renderUnitRow(node);
		row.dispatchEvent(new Event("click"));

		expect((fake as { openRef: ReturnType<typeof vi.fn> }).openRef).toHaveBeenCalledWith({ kind: "file", path: "Notes/a.md" });
	});

	it("handleRowKeydown's real implementation no-ops Enter on an Outside-managed row instead of calling openRef", () => {
		const owner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false } });
		const node = unit("c1", file("notes.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const getNode = vi.fn((_viewId: string, nodeId: string) => (nodeId === "owner" ? owner : null));
		const fake = {
			plugin: { viewsManager: { getNode, setNodeCollapsed: vi.fn() } },
			isOutsideManagedUnit: proto.isOutsideManagedUnit,
			openRef: vi.fn(),
		};
		const evt = new KeyboardEvent("keydown", { key: "Enter" });

		proto.handleRowKeydown.call(fake, evt, node, view);

		expect(fake.openRef).not.toHaveBeenCalled();
	});

	it("handleRowKeydown DOES call openRef for an ordinary row on Enter (control case)", () => {
		const node = unit("c2", file("Notes/a.md"));
		const fake = {
			plugin: { viewsManager: { getNode: vi.fn(() => null), setNodeCollapsed: vi.fn() } },
			isOutsideManagedUnit: proto.isOutsideManagedUnit,
			openRef: vi.fn(),
		};
		const evt = new KeyboardEvent("keydown", { key: "Enter" });

		proto.handleRowKeydown.call(fake, evt, node, view);

		expect(fake.openRef).toHaveBeenCalledWith({ kind: "file", path: "Notes/a.md" });
	});
});
