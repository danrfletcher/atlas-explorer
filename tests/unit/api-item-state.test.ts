import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiItemState, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

function setupNode(apiItemState: Record<string, ApiItemState>, apiItemOrder: string[]) {
	const persist = vi.fn();
	const vm = new ViewsManager({} as App, [], "", persist);
	const viewId = vm.getViews()[0].id;
	const node = vm.addMetaFolder(viewId, null, "Folder") as ViewNode;
	node.apiItemState = apiItemState;
	node.apiItemOrder = apiItemOrder;
	persist.mockClear(); // addMetaFolder itself already triggered one persist call
	return { vm, viewId, nodeId: node.id, persist };
}

describe("ViewsManager.removeApiItem (G26)", () => {
	it("deletes the apiItemState entry and removes it from apiItemOrder", () => {
		const { vm, viewId, nodeId } = setupNode(
			{ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, notFound: true }, "2": { id: "2", label: "Two", kind: PLACEHOLDER_ROW_KIND } },
			["1", "2"]
		);
		vm.removeApiItem(viewId, nodeId, "1");
		const node = vm.getNode(viewId, nodeId)!;
		expect(node.apiItemState).toEqual({ "2": { id: "2", label: "Two", kind: PLACEHOLDER_ROW_KIND } });
		expect(node.apiItemOrder).toEqual(["2"]);
	});

	it("removes the entry even when notFound is false — the method itself never gates on notFound", () => {
		const { vm, viewId, nodeId } = setupNode({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } }, ["1"]);
		vm.removeApiItem(viewId, nodeId, "1");
		expect(vm.getNode(viewId, nodeId)!.apiItemState).toEqual({});
	});

	it("is a safe no-op for an unknown item id", () => {
		const { vm, viewId, nodeId, persist } = setupNode({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } }, ["1"]);
		vm.removeApiItem(viewId, nodeId, "missing");
		expect(vm.getNode(viewId, nodeId)!.apiItemState).toEqual({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } });
		expect(persist).not.toHaveBeenCalled();
	});

	it("persists the change (F4: no undo — the deletion is immediately durable)", () => {
		const { vm, viewId, nodeId, persist } = setupNode({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } }, ["1"]);
		vm.removeApiItem(viewId, nodeId, "1");
		expect(persist).toHaveBeenCalled();
	});
});

describe("ViewsManager.clearApiItemNoteRef (G28)", () => {
	it("clears only noteRef, preserving notFound/lastSeenAt/label/explicitStatusId", () => {
		const { vm, viewId, nodeId } = setupNode(
			{
				"1": {
					id: "1",
					label: "One",
					kind: PLACEHOLDER_ROW_KIND,
					notFound: true,
					lastSeenAt: "2020-01-01T00:00:00.000Z",
					explicitStatusId: "done",
					noteRef: { kind: "file", path: "Note.md" },
				},
			},
			["1"]
		);
		vm.clearApiItemNoteRef(viewId, nodeId, "1");
		const item = vm.getNode(viewId, nodeId)!.apiItemState!["1"];
		expect(item.noteRef).toBeUndefined();
		expect(item.notFound).toBe(true);
		expect(item.lastSeenAt).toBe("2020-01-01T00:00:00.000Z");
		expect(item.explicitStatusId).toBe("done");
		expect(item.label).toBe("One");
	});

	// PR-2 R2 fix: previously called save() (and so fired every change listener/re-render) even
	// though noteRef was already unset — now returns early, matching onVaultDelete's guarded no-save
	// no-op for the same situation.
	it("is a safe no-op when noteRef is already unset, and does not persist", () => {
		const { vm, viewId, nodeId, persist } = setupNode({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } }, ["1"]);
		vm.clearApiItemNoteRef(viewId, nodeId, "1");
		expect(vm.getNode(viewId, nodeId)!.apiItemState!["1"].noteRef).toBeUndefined();
		expect(persist).not.toHaveBeenCalled();
	});

	it("is a safe no-op for an unknown item id", () => {
		const { vm, viewId, nodeId, persist } = setupNode({}, []);
		vm.clearApiItemNoteRef(viewId, nodeId, "missing");
		expect(persist).not.toHaveBeenCalled();
	});

	it("does not delete the apiItemState entry itself", () => {
		const { vm, viewId, nodeId } = setupNode({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, noteRef: { kind: "file", path: "Note.md" } } }, ["1"]);
		vm.clearApiItemNoteRef(viewId, nodeId, "1");
		expect(vm.getNode(viewId, nodeId)!.apiItemState).toHaveProperty("1");
	});
});

describe("G29: load-time sanitization always assigns the shared placeholder kind tag", () => {
	it("assigns PLACEHOLDER_ROW_KIND even to legacy data.json content that never had a kind field", () => {
		const legacyRaw = {
			id: "root",
			type: "meta" as const,
			label: "Folder",
			children: [],
			apiItemState: { "1": { id: "1", label: "One" } } as unknown as Record<string, ApiItemState>,
			apiItemOrder: ["1"],
		};
		const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [legacyRaw] }], "v1", vi.fn());
		const node = vm.getNode("v1", "root")!;
		expect(node.apiItemState!["1"].kind).toBe(PLACEHOLDER_ROW_KIND);
	});
});
