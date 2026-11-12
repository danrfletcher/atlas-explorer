import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager, cloneApiItemState, sanitizeApiItemClickAction, sanitizeApiItemState } from "../../src/views";
import { ApiItemState, ClickAction, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

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

describe("Atlas-18 G10/G17/E10: an Item override (clickAction) on an API item", () => {
	const ACTION: ClickAction = { kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" };
	const base = { id: "ignored", label: "Docker 4.34", kind: PLACEHOLDER_ROW_KIND };

	it("survives sanitizeApiItemState", () => {
		expect(sanitizeApiItemState({ ...base, clickAction: { ...ACTION } }, "1")).toEqual({ id: "1", label: "Docker 4.34", kind: PLACEHOLDER_ROW_KIND, clickAction: ACTION });
	});

	it("survives cloneApiItemState as a new object", () => {
		const state: Record<string, ApiItemState> = { "1": { id: "1", label: "Docker 4.34", kind: PLACEHOLDER_ROW_KIND, clickAction: { ...ACTION } } };
		const out = cloneApiItemState(state);
		expect(out["1"].clickAction).toEqual(ACTION);
		expect(out["1"].clickAction).not.toBe(state["1"].clickAction);
	});

	it("None round-trips through sanitize and clone as an explicit value, distinct from absent", () => {
		const loaded = sanitizeApiItemState({ ...base, clickAction: { kind: "none" } }, "1")!;
		expect(loaded.clickAction).toEqual({ kind: "none" });
		expect("clickAction" in loaded).toBe(true);

		const cloned = cloneApiItemState({ "1": loaded });
		expect(cloned["1"].clickAction).toEqual({ kind: "none" });
		expect(cloned["1"].clickAction).not.toBe(loaded.clickAction);

		const absent = sanitizeApiItemState(base, "1")!;
		expect("clickAction" in absent).toBe(false);
		expect(cloneApiItemState({ "1": absent })["1"].clickAction).toBeUndefined();
	});

	it("None strips extra keys, and a None with junk beside it is still None", () => {
		expect(sanitizeApiItemClickAction({ kind: "none", value: "x", junk: 1 })).toEqual({ kind: "none" });
	});

	it("absent loads as absent", () => {
		expect("clickAction" in sanitizeApiItemState(base, "1")!).toBe(false);
	});

	it.each<[string, unknown]>([
		["an unknown kind", { kind: "shell", value: "x" }],
		["a differently cased None", { kind: "None" }],
		["a non-string kind", { kind: 5, value: "x" }],
		["a missing value", { kind: "terminal" }],
		["a whitespace-only value", { kind: "terminal", value: "   " }],
		["a non-string value", { kind: "uri", value: 5 }],
		["a string", "none"],
		["an array", [{ kind: "none" }]],
		["null", null],
	])("drops a malformed stored override (%s) and keeps the rest of the item", (_name, raw) => {
		const out = sanitizeApiItemState({ ...base, secondary: "sec", explicitStatusId: "doing", clickAction: raw }, "1")!;
		expect(out).toEqual({ id: "1", label: "Docker 4.34", kind: PLACEHOLDER_ROW_KIND, secondary: "sec", explicitStatusId: "doing" });
		expect("clickAction" in out).toBe(false);
	});

	it("loads an older data.json with no clickAction on any item exactly as before (E10)", () => {
		const root = { id: "root", type: "meta" as const, label: "Folder", children: [], apiItemState: { "1": { id: "1", label: "One" }, "2": { id: "2", label: "Two", noteRef: { kind: "file", path: "N.md" } } } as unknown as Record<string, ApiItemState>, apiItemOrder: ["1", "2"] };
		const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [root] }], "v1", vi.fn());
		const state = vm.getNode("v1", "root")!.apiItemState!;
		expect(JSON.stringify(state)).not.toContain("clickAction");
		expect(state["2"].noteRef).toEqual({ kind: "file", path: "N.md" });
	});

	it("loads a stored None and a malformed one on sibling items through the real load path", () => {
		const root = { id: "root", type: "meta" as const, label: "Folder", children: [], apiItemState: { "1": { id: "1", label: "One", clickAction: { kind: "none" } }, "2": { id: "2", label: "Two", clickAction: { kind: "shell", value: 5 } } } as unknown as Record<string, ApiItemState>, apiItemOrder: ["1", "2"] };
		const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view", root: [root] }], "v1", vi.fn());
		const state = vm.getNode("v1", "root")!.apiItemState!;
		expect(state["1"].clickAction).toEqual({ kind: "none" });
		expect(state["2"].clickAction).toBeUndefined();
		expect(state["2"].label).toBe("Two");
	});
});

describe("Atlas-18 G10: ViewsManager.setApiItemClickAction and None", () => {
	const row = (): Record<string, ApiItemState> => ({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } });

	it("stores None as an explicit value, and persists it", () => {
		const { vm, viewId, nodeId, persist } = setupNode(row(), ["1"]);
		expect(vm.setApiItemClickAction(viewId, nodeId, "1", { kind: "none" })).toBe(true);
		expect(vm.getNode(viewId, nodeId)!.apiItemState!["1"].clickAction).toEqual({ kind: "none" });
		expect(persist).toHaveBeenCalled();
	});

	it("setting None again is a no-op that does not persist; None to terminal and back to absent each persist", () => {
		const { vm, viewId, nodeId, persist } = setupNode(row(), ["1"]);
		vm.setApiItemClickAction(viewId, nodeId, "1", { kind: "none" });
		persist.mockClear();
		vm.setApiItemClickAction(viewId, nodeId, "1", { kind: "none" });
		expect(persist).not.toHaveBeenCalled();
		vm.setApiItemClickAction(viewId, nodeId, "1", { kind: "terminal", value: "open -a Docker" });
		expect(vm.getNode(viewId, nodeId)!.apiItemState!["1"].clickAction).toEqual({ kind: "terminal", value: "open -a Docker" });
		vm.setApiItemClickAction(viewId, nodeId, "1", undefined);
		expect("clickAction" in vm.getNode(viewId, nodeId)!.apiItemState!["1"]).toBe(false);
		expect(persist).toHaveBeenCalledTimes(2);
	});

	it("refuses an unsaveable action and leaves a stored None alone", () => {
		const { vm, viewId, nodeId } = setupNode(row(), ["1"]);
		vm.setApiItemClickAction(viewId, nodeId, "1", { kind: "none" });
		expect(vm.setApiItemClickAction(viewId, nodeId, "1", { kind: "shell", value: "x" } as never)).toBe(false);
		expect(vm.getNode(viewId, nodeId)!.apiItemState!["1"].clickAction).toEqual({ kind: "none" });
	});

	it("a module or Folder can never be given a None (setClickAction refuses it)", () => {
		const { vm, viewId, nodeId } = setupNode(row(), ["1"]);
		expect(vm.setClickAction(viewId, nodeId, { kind: "none" } as never)).toBe(false);
		expect(vm.getNode(viewId, nodeId)!.clickAction).toBeUndefined();
	});
});
