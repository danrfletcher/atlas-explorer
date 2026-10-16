import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiItemState, PLACEHOLDER_ROW_KIND } from "../../src/types";

function item(overrides: Partial<ApiItemState> & { id: string }): ApiItemState {
	return { label: overrides.id, kind: PLACEHOLDER_ROW_KIND, ...overrides };
}

function makeViewsManager() {
	return new ViewsManager({} as App, [], "", () => {});
}

describe("G27 — onVaultDelete integration: clearing noteRef across a realistic tree", () => {
	it("a delete clears the matching noteRef without disturbing unrelated rows, cache, or source config", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = {
			"1": item({ id: "1", label: "One", noteRef: { kind: "file", path: "Note.md" } }),
			"2": item({ id: "2", label: "Two", explicitStatusId: "done" }),
		};
		node.apiItemOrder = ["1", "2"];
		node.apiCache = { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false };

		vm.onVaultDelete("Note.md");

		const result = vm.getNode(view.id, folder.id)!;
		expect(result.apiItemState!["1"].noteRef).toBeUndefined();
		expect(result.apiItemState!["1"].label).toBe("One");
		expect(result.apiItemState!["2"]).toEqual(item({ id: "2", label: "Two", explicitStatusId: "done" }));
		expect(result.apiCache).toEqual({ fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false });
	});

	it("a rename followed by a stale delete at the old path leaves the already-rewritten noteRef untouched", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": item({ id: "1", noteRef: { kind: "file", path: "Old.md" } }) };
		node.apiItemOrder = ["1"];

		// Rename fires first (e.g. a move), rewriting the live reference away from "Old.md" before a
		// delete event for the old path "Old.md" (e.g. from a watcher that queued both) is processed.
		vm.onVaultRename("Old.md", "New.md");
		vm.onVaultDelete("Old.md");

		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "New.md" });
	});

	it("sequencing: onVaultDelete for an unrelated path never interferes with onVaultRename's own exact/prefix rewriting", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = {
			"1": item({ id: "1", noteRef: { kind: "file", path: "Pool/Old.md" } }),
			"2": item({ id: "2", noteRef: { kind: "file", path: "Unrelated.md" } }),
		};
		node.apiItemOrder = ["1", "2"];

		vm.onVaultDelete("Totally/Different.md");
		vm.onVaultRename("Pool", "Renamed pool");

		const result = vm.getNode(view.id, folder.id)!;
		expect(result.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Renamed pool/Old.md" });
		expect(result.apiItemState!["2"].noteRef).toEqual({ kind: "file", path: "Unrelated.md" });
	});

	it("G26 + G28 sequencing: Remove attachment then Remove leaves no trace of the row", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": item({ id: "1", notFound: true, noteRef: { kind: "file", path: "Note.md" } }) };
		node.apiItemOrder = ["1"];

		vm.clearApiItemNoteRef(view.id, folder.id, "1");
		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toBeUndefined();

		vm.removeApiItem(view.id, folder.id, "1");
		expect(vm.getNode(view.id, folder.id)!.apiItemState).toEqual({});
		expect(vm.getNode(view.id, folder.id)!.apiItemOrder).toEqual([]);
	});

	it("G26 then G28 in the other order: Remove already deletes the entry, so a later Remove attachment on the same id is a no-op", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": item({ id: "1", notFound: true, noteRef: { kind: "file", path: "Note.md" } }) };
		node.apiItemOrder = ["1"];

		vm.removeApiItem(view.id, folder.id, "1");
		vm.clearApiItemNoteRef(view.id, folder.id, "1");

		expect(vm.getNode(view.id, folder.id)!.apiItemState).toEqual({});
	});
});
