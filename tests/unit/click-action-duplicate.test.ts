import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, ClickAction, PLACEHOLDER_ROW_KIND, View, ViewNode } from "../../src/types";

const ACTION: ClickAction = { kind: "command", value: "app-runner:open-live-captions" };

function manager(root: ViewNode[]): ViewsManager {
	const view: View = { id: "v", name: "V", root, inboxMode: "view" };
	return new ViewsManager({} as App, [view], "v", () => {});
}

function allNodes(nodes: ViewNode[]): ViewNode[] {
	return nodes.flatMap((n) => [n, ...allNodes(n.children)]);
}

const SOURCE: ApiSourceConfig = {
	type: "api",
	url: "https://api.example.com/items",
	method: "GET",
	mapping: { idField: "id", labelField: "name" },
	mode: "merge",
	refreshOnViewLoad: false,
};

describe("duplicateNode carries a node's own clickAction (G17/E7)", () => {
	it("a module's action is copied to the clone as a new object", () => {
		const vm = manager([{ id: "m", type: "unit", ref: { kind: "folder", path: "Mod" }, children: [], clickAction: { ...ACTION } }]);
		const clone = vm.duplicateNode("v", "m")!;
		const original = vm.getNode("v", "m")!;
		expect(clone.id).not.toBe("m");
		expect(clone.clickAction).toEqual(ACTION);
		expect(clone.clickAction).not.toBe(original.clickAction);
		clone.clickAction!.value = "changed";
		expect(original.clickAction!.value).toBe(ACTION.value);
	});

	it("a Folder's action is copied to the clone as a new object", () => {
		const vm = manager([{ id: "f", type: "meta", label: "Apps", children: [], clickAction: { kind: "terminal", value: "open -a Docker" } }]);
		const clone = vm.duplicateNode("v", "f")!;
		expect(clone.clickAction).toEqual({ kind: "terminal", value: "open -a Docker" });
		expect(clone.clickAction).not.toBe(vm.getNode("v", "f")!.clickAction);
	});

	it("a node with no action gets a clone with no clickAction key", () => {
		const vm = manager([{ id: "f", type: "meta", label: "Apps", children: [] }]);
		expect("clickAction" in vm.duplicateNode("v", "f")!).toBe(false);
	});

	it("a duplicated subtree keeps each child's own action, under fresh node ids", () => {
		const vm = manager([
			{
				id: "root",
				type: "meta",
				label: "Root",
				children: [
					{ id: "a", type: "unit", ref: { kind: "folder", path: "A" }, children: [], clickAction: { ...ACTION } },
					{
						id: "b",
						type: "meta",
						label: "B",
						clickAction: { kind: "uri", value: "obsidian://open?vault=Notes" },
						children: [{ id: "c", type: "unit", ref: { kind: "folder", path: "C" }, children: [], clickAction: { kind: "terminal", value: "ls" } }],
					},
				],
			},
		]);
		const clone = vm.duplicateNode("v", "root")!;
		const originals = allNodes([vm.getNode("v", "root")!]);
		const clones = allNodes([clone]);
		expect(clones).toHaveLength(originals.length);
		const originalIds = new Set(originals.map((n) => n.id));
		for (let i = 0; i < clones.length; i++) {
			expect(originalIds.has(clones[i].id)).toBe(false);
			expect(clones[i].clickAction).toEqual(originals[i].clickAction);
			if (originals[i].clickAction) expect(clones[i].clickAction).not.toBe(originals[i].clickAction);
		}
		expect(clones.map((n) => n.clickAction?.kind)).toEqual([undefined, "command", "uri", "terminal"]);
	});
});

describe("duplicateNode does not copy an Item override (E7)", () => {
	it("a static-rows Folder keeps every other row field but no row clickAction", () => {
		const vm = manager([
			{
				id: "f",
				type: "meta",
				label: "Apps",
				children: [],
				folderSourceOwnerId: undefined,
				apiItemOrder: ["1", "2"],
				apiItemState: {
					"1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, secondary: "s", explicitStatusId: "st", noteRef: { kind: "file", path: "One.md" }, clickAction: { ...ACTION } },
					"2": { id: "2", label: "Two", kind: PLACEHOLDER_ROW_KIND, clickAction: { kind: "uri", value: "obsidian://x" } },
				},
			},
		]);
		const clone = vm.duplicateNode("v", "f")!;
		expect(clone.apiItemOrder).toEqual(["1", "2"]);
		expect(clone.apiItemState).toEqual({
			"1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, secondary: "s", explicitStatusId: "st", noteRef: { kind: "file", path: "One.md" } },
			"2": { id: "2", label: "Two", kind: PLACEHOLDER_ROW_KIND, noteRef: undefined },
		});
		for (const row of Object.values(clone.apiItemState!)) expect("clickAction" in row).toBe(false);
		// the original's overrides are untouched
		const original = vm.getNode("v", "f")!;
		expect(original.apiItemState!["1"].clickAction).toEqual(ACTION);
		expect(original.apiItemState!["2"].clickAction).toEqual({ kind: "uri", value: "obsidian://x" });
	});

	it("a sourced Folder's duplicate starts with apiItemState = {} while keeping the Folder's own action", () => {
		const vm = manager([
			{
				id: "f",
				type: "meta",
				label: "API",
				children: [],
				clickAction: { ...ACTION },
				apiSource: { ...SOURCE },
				apiItemOrder: ["1"],
				apiItemState: { "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, clickAction: { kind: "uri", value: "obsidian://x" } } },
			},
		]);
		const clone = vm.duplicateNode("v", "f")!;
		expect(clone.apiItemState).toEqual({});
		expect(clone.apiItemOrder).toEqual([]);
		expect(clone.clickAction).toEqual(ACTION);
		expect(JSON.stringify(clone)).not.toContain("obsidian://x");
	});

	it("a nested static-rows Folder inside a duplicated subtree also drops its overrides", () => {
		const vm = manager([
			{
				id: "outer",
				type: "meta",
				label: "Outer",
				children: [
					{ id: "inner", type: "meta", label: "Inner", children: [], apiItemOrder: ["1"], apiItemState: { "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, clickAction: { ...ACTION } } } },
				],
			},
		]);
		const clone = vm.duplicateNode("v", "outer")!;
		expect(clone.children[0].apiItemState!["1"].label).toBe("One");
		expect("clickAction" in clone.children[0].apiItemState!["1"]).toBe(false);
	});
});
