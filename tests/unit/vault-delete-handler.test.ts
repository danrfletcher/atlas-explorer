import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiItemState, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

function item(overrides: Partial<ApiItemState> & { id: string }): ApiItemState {
	return { label: overrides.id, kind: PLACEHOLDER_ROW_KIND, ...overrides };
}

function setup(views: Array<{ id: string; root: ViewNode[] }>) {
	const persist = vi.fn();
	const vm = new ViewsManager(
		{} as App,
		views.map((v) => ({ id: v.id, name: v.id, root: v.root, inboxMode: "view" as const })),
		views[0]?.id ?? "",
		persist
	);
	persist.mockClear();
	return { vm, persist };
}

describe("ViewsManager.onVaultDelete (G27)", () => {
	it("clears a single matching noteRef, leaving the entry itself intact", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Folder",
			children: [],
			apiItemState: { "1": item({ id: "1", noteRef: { kind: "file", path: "Note.md" } }) },
			apiItemOrder: ["1"],
		};
		const { vm, persist } = setup([{ id: "v1", root: [node] }]);

		vm.onVaultDelete("Note.md");

		const result = vm.getNode("v1", "n1")!;
		expect(result.apiItemState!["1"].noteRef).toBeUndefined();
		expect(result.apiItemState).toHaveProperty("1");
		expect(persist).toHaveBeenCalled();
	});

	it("E5: a path matching nothing is a no-op — no mutation, persist not called", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Folder",
			children: [],
			apiItemState: { "1": item({ id: "1", noteRef: { kind: "file", path: "Note.md" } }) },
			apiItemOrder: ["1"],
		};
		const { vm, persist } = setup([{ id: "v1", root: [node] }]);

		vm.onVaultDelete("Other.md");

		const result = vm.getNode("v1", "n1")!;
		expect(result.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Note.md" });
		expect(persist).not.toHaveBeenCalled();
	});

	it("clears every matching entry across multiple nodes and views sharing the same deleted path", () => {
		const nodeA: ViewNode = {
			id: "a",
			type: "meta",
			label: "A",
			children: [],
			apiItemState: {
				"1": item({ id: "1", noteRef: { kind: "file", path: "Shared.md" } }),
				"2": item({ id: "2", noteRef: { kind: "file", path: "Other.md" } }),
			},
			apiItemOrder: ["1", "2"],
		};
		const nodeB: ViewNode = {
			id: "b",
			type: "meta",
			label: "B",
			children: [],
			apiItemState: { "3": item({ id: "3", noteRef: { kind: "file", path: "Shared.md" } }) },
			apiItemOrder: ["3"],
		};
		const { vm } = setup([
			{ id: "v1", root: [nodeA] },
			{ id: "v2", root: [nodeB] },
		]);

		vm.onVaultDelete("Shared.md");

		expect(vm.getNode("v1", "a")!.apiItemState!["1"].noteRef).toBeUndefined();
		expect(vm.getNode("v1", "a")!.apiItemState!["2"].noteRef).toEqual({ kind: "file", path: "Other.md" });
		expect(vm.getNode("v2", "b")!.apiItemState!["3"].noteRef).toBeUndefined();
	});

	it("clears matches nested under child folders too", () => {
		const child: ViewNode = {
			id: "child",
			type: "meta",
			label: "Child",
			children: [],
			apiItemState: { "1": item({ id: "1", noteRef: { kind: "file", path: "Nested.md" } }) },
			apiItemOrder: ["1"],
		};
		const parent: ViewNode = { id: "parent", type: "meta", label: "Parent", children: [child] };
		const { vm } = setup([{ id: "v1", root: [parent] }]);

		vm.onVaultDelete("Nested.md");

		expect(vm.getNode("v1", "child")!.apiItemState!["1"].noteRef).toBeUndefined();
	});

	// PR-2 R1 fix: Obsidian can fire a single delete event for a whole folder instead of one per
	// child file, so a noteRef inside that folder must clear on a `${path}/` prefix match too, the
	// same subtree rule unitIndex.onVaultDelete already applies.
	it("clears a noteRef inside a deleted folder, matched by subtree prefix rather than exact path", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Folder",
			children: [],
			apiItemState: { "1": item({ id: "1", noteRef: { kind: "file", path: "Folder/Inside.md" } }) },
			apiItemOrder: ["1"],
		};
		const { vm, persist } = setup([{ id: "v1", root: [node] }]);

		vm.onVaultDelete("Folder");

		expect(vm.getNode("v1", "n1")!.apiItemState!["1"].noteRef).toBeUndefined();
		expect(persist).toHaveBeenCalled();
	});

	it("does not clear a noteRef for a similarly-named sibling path that is not actually under the deleted folder", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Folder",
			children: [],
			apiItemState: { "1": item({ id: "1", noteRef: { kind: "file", path: "Folder2/Inside.md" } }) },
			apiItemOrder: ["1"],
		};
		const { vm, persist } = setup([{ id: "v1", root: [node] }]);

		vm.onVaultDelete("Folder");

		expect(vm.getNode("v1", "n1")!.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Folder2/Inside.md" });
		expect(persist).not.toHaveBeenCalled();
	});

	it("does not remove the apiItemState entry, only the noteRef field", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Folder",
			children: [],
			apiItemState: { "1": item({ id: "1", explicitStatusId: "done", noteRef: { kind: "file", path: "Note.md" } }) },
			apiItemOrder: ["1"],
		};
		const { vm } = setup([{ id: "v1", root: [node] }]);

		vm.onVaultDelete("Note.md");

		const result = vm.getNode("v1", "n1")!.apiItemState!["1"];
		expect(result).toEqual({ id: "1", label: "1", kind: PLACEHOLDER_ROW_KIND, explicitStatusId: "done" });
	});

	it("a noteRef pointing elsewhere is untouched by a delete for a different, unrelated path", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Folder",
			children: [],
			// The deleted path below ("Note.md") does not match this noteRef's path at all — the delete
			// handler only clears refs under the path it was actually called with.
			apiItemState: { "1": item({ id: "1", noteRef: { kind: "file", path: "Moved.md" } }) },
			apiItemOrder: ["1"],
		};
		const { vm, persist } = setup([{ id: "v1", root: [node] }]);

		vm.onVaultDelete("Note.md");

		expect(vm.getNode("v1", "n1")!.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Moved.md" });
		expect(persist).not.toHaveBeenCalled();
	});
});
