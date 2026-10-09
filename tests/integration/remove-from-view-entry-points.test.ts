import type { App } from "obsidian";
import { App as MockApp, Menu, MenuItem } from "../../tests/mocks/obsidian";
import { describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, UnitRef, View, ViewNode } from "../../src/types";

/** PR-1 R3: G15's own tests (`tests/unit/folder-source-delete-edge-cases.test.ts`) call
 * `removeUnitsFromView` directly on a fake host — they never go through the three entry points the
 * spec names, so nothing would catch one of those call sites falling out of sync with
 * `removeUnitsFromView` (e.g. a future edit wiring the menu item, the Delete key or the inbox drop
 * to some other method instead). These tests call the real entry points: `showUnitMenu`'s "Remove
 * from view" item, `handleRowKeydown`'s Delete branch (single and multi-selection), and
 * `handleDrop`'s inbox-area case. */

const confirms = vi.hoisted(() => [] as Array<{ message: string; onConfirm: () => void }>);
vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingConfirm {
		constructor(_app: unknown, public message: string, _label: string, public onConfirm: () => void) {}
		open(): void {
			confirms.push({ message: this.message, onConfirm: this.onConfirm });
		}
	}
	return { ...actual, ConfirmModal: RecordingConfirm };
});

type ExplorerHelpers = {
	showUnitMenu(evt: MouseEvent, ref: UnitRef, view: View, node: ViewNode, displayName: string): void;
	handleRowKeydown(evt: KeyboardEvent, node: ViewNode, view: View): void;
	handleDrop(target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }): void;
	removeUnitsFromView(viewId: string, units: ViewNode[], after?: () => void): void;
	holdsLiveDataSource(node: ViewNode): boolean;
	forgetDeviceLocalSourceState(nodeId: string): void;
	findNodeAnywhere(nodes: ViewNode[], nodeId: string): { node: ViewNode } | null;
	isOutsideManagedUnit(view: View, node: ViewNode): boolean;
	isOutsideManagedNodeId(viewId: string, nodeId: string): boolean;
	buildNodeDragPayload(nodeId: string, viewId: string): unknown;
};
const explorer = AtlasExplorerView.prototype as unknown as ExplorerHelpers;

function apiSource(): ApiSourceConfig {
	return { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false };
}

function harness() {
	confirms.length = 0;
	const app = new MockApp();
	for (const p of ["A.md", "B.md", "C.md"]) app.vault.seedFile(p);
	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const viewId = vm.getViews()[0].id;
	const apiHeadersStore = { delete: vi.fn() };
	const folderSourcePathStore = { delete: vi.fn() };
	const plugin = {
		app,
		viewsManager: vm,
		apiHeadersStore,
		folderSourcePathStore,
		unitIndex: { getUnits: () => [] },
	};
	const fake = {
		plugin,
		dragPayload: null as unknown,
		selectedBucketNodeIds: new Set<string>(),
		selectedInboxRefKeys: new Set<string>(),
		selectionAnchor: null as string | null,
		selectionAnchorScope: null as "bucket" | "inbox" | null,
		holdsLiveDataSource: explorer.holdsLiveDataSource,
		forgetDeviceLocalSourceState: explorer.forgetDeviceLocalSourceState,
		removeUnitsFromView: explorer.removeUnitsFromView,
		showUnitMenu: explorer.showUnitMenu,
		handleRowKeydown: explorer.handleRowKeydown,
		handleDrop: explorer.handleDrop,
		findNodeAnywhere: explorer.findNodeAnywhere,
		isOutsideManagedNodeId: explorer.isOutsideManagedNodeId,
		buildNodeDragPayload: explorer.buildNodeDragPayload,
		isOutsideManagedUnit: vi.fn(() => false),
		openRef: vi.fn(),
		revealInNativeExplorer: vi.fn(),
		openModuleContentsModal: vi.fn(),
		copyLink: vi.fn(),
		duplicateFolder: vi.fn(),
		placeInViewFlow: vi.fn(),
		openStatusesModal: vi.fn(),
		openApiSourceModal: vi.fn(),
		refreshApiSource: vi.fn(),
		refreshFolderSource: vi.fn(),
		refreshCsvSource: vi.fn(),
		refreshMarkdownTableSource: vi.fn(),
		openSwapPicker: vi.fn(),
		openSwapForFolder: vi.fn(),
		render: vi.fn(),
		queueRender: vi.fn(),
	};
	const place = (path: string, sourced: boolean): ViewNode => {
		vm.placeUnit(viewId, { kind: "file", path }, null);
		const node = vm.getViews()[0].root.find((n) => n.ref?.kind === "file" && n.ref.path === path)!;
		if (sourced) vm.setApiSource(viewId, node.id, apiSource());
		return vm.getNode(viewId, node.id)!;
	};
	return { vm, viewId, fake: fake as unknown as ExplorerHelpers & typeof fake, apiHeadersStore, folderSourcePathStore, place };
}

function buildUnitMenu(fake: ExplorerHelpers, evt: MouseEvent, ref: UnitRef, view: View, node: ViewNode, displayName: string): Menu {
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	fake.showUnitMenu(evt, ref, view, node, displayName);
	show.mockRestore();
	return built!;
}

describe("PR-1 R3: the real menu entry point — showUnitMenu's 'Remove from view'", () => {
	it("a sourced unit's menu item opens the same confirm, and Confirm removes it and clears both stores", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const unit = place("A.md", true);
		const view = vm.getViews()[0];

		const menu = buildUnitMenu(fake, {} as MouseEvent, unit.ref!, view, unit, "A.md");
		menu.items.find((i) => i.title === "Remove from view")!.clickHandler!();
		expect(confirms).toHaveLength(1);

		confirms[0].onConfirm();
		expect(vm.getNode(viewId, unit.id)).toBeNull();
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(unit.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(unit.id);
	});

	it("an unsourced unit's menu item removes it immediately, with no confirm", () => {
		const { vm, viewId, fake, place } = harness();
		const unit = place("A.md", false);
		const view = vm.getViews()[0];

		const menu = buildUnitMenu(fake, {} as MouseEvent, unit.ref!, view, unit, "A.md");
		menu.items.find((i) => i.title === "Remove from view")!.clickHandler!();
		expect(confirms).toHaveLength(0);
		expect(vm.getNode(viewId, unit.id)).toBeNull();
	});
});

describe("PR-1 R3: the real keyboard entry point — handleRowKeydown's Delete branch", () => {
	function deleteEvent(): KeyboardEvent {
		return { key: "Delete", preventDefault: vi.fn() } as unknown as KeyboardEvent;
	}

	it("Delete on a single sourced unit confirms, and Confirm removes it and clears both stores", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const unit = place("A.md", true);
		const view = vm.getViews()[0];

		fake.handleRowKeydown(deleteEvent(), unit, view);
		expect(confirms).toHaveLength(1);

		confirms[0].onConfirm();
		expect(vm.getNode(viewId, unit.id)).toBeNull();
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(unit.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(unit.id);
	});

	it("Delete across a multi-selection removes every selected unit, sourced or not", () => {
		const { vm, viewId, fake, place } = harness();
		const a = place("A.md", true);
		const b = place("B.md", false);
		const view = vm.getViews()[0];
		fake.selectedBucketNodeIds = new Set([a.id, b.id]);

		fake.handleRowKeydown(deleteEvent(), a, view);
		expect(confirms).toHaveLength(1);
		confirms[0].onConfirm();

		expect(vm.getNode(viewId, a.id)).toBeNull();
		expect(vm.getNode(viewId, b.id)).toBeNull();
	});
});

describe("PR-1 R3: the real drag-and-drop entry point — handleDrop's inbox-area case", () => {
	it("dropping a sourced unit on the inbox area confirms, and Confirm removes it and clears both stores", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const unit = place("A.md", true);
		fake.dragPayload = fake.buildNodeDragPayload(unit.id, viewId);

		fake.handleDrop({ kind: "inbox-area", viewId });
		expect(confirms).toHaveLength(1);

		confirms[0].onConfirm();
		expect(vm.getNode(viewId, unit.id)).toBeNull();
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(unit.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(unit.id);
	});

	it("dropping an unsourced unit on the inbox area removes it immediately, with no confirm", () => {
		const { vm, viewId, fake, place } = harness();
		const unit = place("A.md", false);
		fake.dragPayload = fake.buildNodeDragPayload(unit.id, viewId);

		fake.handleDrop({ kind: "inbox-area", viewId });
		expect(confirms).toHaveLength(0);
		expect(vm.getNode(viewId, unit.id)).toBeNull();
	});
});
