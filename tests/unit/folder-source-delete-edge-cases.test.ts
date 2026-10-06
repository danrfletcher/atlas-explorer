import type { App } from "obsidian";
import { App as MockApp, Menu } from "../../tests/mocks/obsidian";
import { describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, FolderSourceConfig, View, ViewNode } from "../../src/types";

function source(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		type: "folder",
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		refreshOnViewLoad: false,
		mode: "merge",
		...overrides,
	};
}

function makeVm(mode: FolderSourceConfig["mode"]) {
	const app = new MockApp();
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/a.md");
	app.vault.seedFile("Projects/b.md");
	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const view = vm.getViews()[0];
	const folder = vm.addMetaFolder(view.id, null, "Projects")!;
	vm.setFolderSource(view.id, folder.id, source({ mode }));
	vm.refreshFolderSource(view.id, folder.id);
	return { vm, view, folder, app };
}

describe("E9: a same-named file recreated after a merge-mode deletion is treated as fresh", () => {
	it("the recreated file produces a brand-new real row, independent of the old last-seen placeholder — no re-link attempt", () => {
		const { vm, view, folder, app } = makeVm("merge");

		vm.onVaultDelete("Projects/a.md");
		const staleEntry = Object.values(vm.getNode(view.id, folder.id)!.apiItemState ?? {})[0];
		expect(staleEntry.notFound).toBe(true);

		// Recreate a file at the same path, then refresh — as if the user undid the deletion or made
		// a new file with the same name.
		app.vault.seedFile("Projects/a.md");
		vm.refreshFolderSource(view.id, folder.id);

		const after = vm.getNode(view.id, folder.id)!;
		const freshRow = after.children.find((n) => n.ref?.path === "Projects/a.md");
		expect(freshRow).toBeTruthy();
		expect(freshRow!.id).not.toBe(staleEntry.id); // a brand-new node, not the demoted one resurrected.

		// The stale last-seen placeholder is untouched — still present, still not-found, no attempt to
		// fold the fresh row back into it.
		expect(after.apiItemState![staleEntry.id]).toEqual(staleEntry);
	});
});

describe("mode is read at reconciliation time, not delete time", () => {
	it("merge-mode deletion, then switch to overwrite before the next refresh: the stale last-seen row is swept away with no warning", () => {
		const { vm, view, folder } = makeVm("merge");

		vm.onVaultDelete("Projects/a.md");
		expect(Object.keys(vm.getNode(view.id, folder.id)!.apiItemState ?? {})).toHaveLength(1);

		vm.setFolderSource(view.id, folder.id, { ...vm.getNode(view.id, folder.id)!.folderSource!, mode: "overwrite" });
		vm.refreshFolderSource(view.id, folder.id);

		expect(vm.getNode(view.id, folder.id)!.apiItemState ?? {}).toEqual({});
	});

	it("append-mode deletion, then switch to merge before the next refresh: the link-cleared row converts to a last-seen placeholder with Remove available", () => {
		const { vm, view, folder } = makeVm("append");

		vm.onVaultDelete("Projects/a.md");
		const appendEntry = Object.values(vm.getNode(view.id, folder.id)!.apiItemState ?? {})[0];
		expect(appendEntry.notFound).toBeFalsy();

		vm.setFolderSource(view.id, folder.id, { ...vm.getNode(view.id, folder.id)!.folderSource!, mode: "merge" });
		vm.refreshFolderSource(view.id, folder.id);

		const converted = vm.getNode(view.id, folder.id)!.apiItemState![appendEntry.id];
		expect(converted.notFound).toBe(true); // "Remove available" is gated on notFound in the explorer menu.
		expect(converted.id).toBe(appendEntry.id);
		expect(converted.label).toBe(appendEntry.label);
	});
});

describe("batch deletion of multiple children from the same Folder source", () => {
	it("each row reconciles independently per the source's single configured mode, no cross-row interference", () => {
		const { vm, view, folder } = makeVm("merge");

		vm.onVaultDelete("Projects/a.md");
		vm.onVaultDelete("Projects/b.md");

		const owner = vm.getNode(view.id, folder.id)!;
		expect(owner.children.some((n) => n.ref?.path === "Projects/a.md" || n.ref?.path === "Projects/b.md")).toBe(false);
		const entries = Object.values(owner.apiItemState ?? {});
		expect(entries).toHaveLength(2);
		expect(entries.every((e) => e.notFound === true)).toBe(true);
		expect(new Set(entries.map((e) => e.id)).size).toBe(2); // distinct ids, no collision/merge of the two.
	});
});

describe("deleting a child of a Folder source that has zero other rows", () => {
	it("merge mode: reconciliation completes cleanly, leaving exactly one last-seen row", () => {
		const app = new MockApp();
		app.vault.seedFolder("Solo");
		app.vault.seedFile("Solo/only.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Solo")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Solo", mode: "merge" }));
		vm.refreshFolderSource(view.id, folder.id);

		vm.onVaultDelete("Solo/only.md");

		const owner = vm.getNode(view.id, folder.id)!;
		expect(owner.children).toHaveLength(0);
		expect(Object.keys(owner.apiItemState ?? {})).toHaveLength(1);
	});

	it("overwrite mode: leaves an empty source with no error", () => {
		const app = new MockApp();
		app.vault.seedFolder("Solo");
		app.vault.seedFile("Solo/only.md");
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Solo")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Solo", mode: "overwrite" }));
		vm.refreshFolderSource(view.id, folder.id);

		expect(() => vm.onVaultDelete("Solo/only.md")).not.toThrow();

		const owner = vm.getNode(view.id, folder.id)!;
		expect(owner.children).toHaveLength(0);
		expect(owner.apiItemState ?? {}).toEqual({});
	});
});

// PR-1 (G15/E-g): the confirm-and-clean-up path. `ConfirmModal` is replaced with a recorder so each test
// can read the message and run (or not run) the confirm callback itself.
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
	removeUnitsFromView(viewId: string, units: ViewNode[], after?: () => void): void;
	holdsLiveDataSource(node: ViewNode): boolean;
	forgetDeviceLocalSourceState(nodeId: string): void;
	showMetaFolderMenu(evt: MouseEvent, node: ViewNode, view: View): void;
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
	const plugin = { app, viewsManager: vm, apiHeadersStore, folderSourcePathStore };
	const fake = {
		plugin,
		holdsLiveDataSource: explorer.holdsLiveDataSource,
		forgetDeviceLocalSourceState: explorer.forgetDeviceLocalSourceState,
		removeUnitsFromView: explorer.removeUnitsFromView,
		showMetaFolderMenu: explorer.showMetaFolderMenu,
	};
	const place = (path: string, sourced: boolean): ViewNode => {
		vm.placeUnit(viewId, { kind: "file", path }, null);
		const node = vm.getViews()[0].root.find((n) => n.ref.kind === "file" && n.ref.path === path)!;
		if (sourced) vm.setApiSource(viewId, node.id, apiSource());
		return vm.getNode(viewId, node.id)!;
	};
	return { vm, viewId, fake: fake as unknown as ExplorerHelpers, apiHeadersStore, folderSourcePathStore, place };
}

describe("G15a — Remove from view on a sourced unit confirms, and Cancel changes nothing (E-g)", () => {
	it("opens one confirm naming the unit and leaves node, source and both stores untouched on Cancel", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const unit = place("A.md", true);
		fake.removeUnitsFromView(viewId, [unit]);
		expect(confirms).toHaveLength(1);
		expect(confirms[0].message).toContain('"A.md"');
		// Cancel = the confirm callback never runs.
		expect(vm.getNode(viewId, unit.id)).not.toBeNull();
		expect(vm.getNode(viewId, unit.id)!.apiSource).toBeDefined();
		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
		expect(folderSourcePathStore.delete).not.toHaveBeenCalled();
	});

	it("Confirm removes the node and clears ApiHeadersStore and FolderSourcePathStore for its id", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const unit = place("A.md", true);
		const after = vi.fn();
		fake.removeUnitsFromView(viewId, [unit], after);
		confirms[0].onConfirm();
		expect(vm.getNode(viewId, unit.id)).toBeNull();
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(unit.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(unit.id);
		expect(after).toHaveBeenCalledOnce();
	});
});

describe("G15b — the Delete key and drag-to-inbox share the same path; an unsourced unit has no confirm", () => {
	it("an unsourced unit is removed at once with no confirm and no store cleanup", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const unit = place("C.md", false);
		fake.removeUnitsFromView(viewId, [unit]);
		expect(confirms).toHaveLength(0);
		expect(vm.getNode(viewId, unit.id)).toBeNull();
		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
		expect(folderSourcePathStore.delete).not.toHaveBeenCalled();
	});

	it("a multi-selection asks once, then cleans up every sourced unit and removes the unsourced one too", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore, place } = harness();
		const a = place("A.md", true);
		const b = place("B.md", true);
		const c = place("C.md", false);
		fake.removeUnitsFromView(viewId, [a, b, c]);
		expect(confirms).toHaveLength(1);
		expect(confirms[0].message).toContain("2 items");
		confirms[0].onConfirm();
		for (const n of [a, b, c]) expect(vm.getNode(viewId, n.id)).toBeNull();
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(a.id);
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(b.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(a.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(b.id);
		expect(apiHeadersStore.delete).not.toHaveBeenCalledWith(c.id);
	});
});

describe("G15e — Delete folder on a sourced Atlas folder clears its stored Outside path as well as its headers", () => {
	it("the Delete folder confirm drops both the headers and the folder path for that node", () => {
		const { vm, viewId, fake, apiHeadersStore, folderSourcePathStore } = harness();
		const folder = vm.addMetaFolder(viewId, null, "Linear issues")!;
		vm.setApiSource(viewId, folder.id, apiSource());
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		fake.showMetaFolderMenu(new MouseEvent("contextmenu"), vm.getNode(viewId, folder.id)!, vm.getViews()[0]);
		show.mockRestore();
		const deleteItem = built!.items.find((i) => i.title === "Delete folder")!;
		deleteItem.clickHandler!();
		confirms[confirms.length - 1].onConfirm();
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(folder.id);
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(folder.id);
	});
});
