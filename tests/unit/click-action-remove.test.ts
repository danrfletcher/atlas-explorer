import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, ClickAction, PLACEHOLDER_ROW_KIND, View, ViewNode } from "../../src/types";

const PARENT_ACTION: ClickAction = { kind: "terminal", value: "open -a Docker" };
const CHILD_ACTION: ClickAction = { kind: "command", value: "app-runner:open-live-captions" };

function manager(root: ViewNode[]) {
	const saved: string[] = [];
	const view: View = { id: "v", name: "V", root, inboxMode: "view" };
	const vm = new ViewsManager({} as App, [view], "v", () => saved.push(JSON.stringify(vm.getViews())));
	return { vm, saved };
}

function tree(): ViewNode[] {
	return [
		{ id: "before", type: "meta", label: "Before", children: [] },
		{
			id: "parent",
			type: "meta",
			label: "Parent",
			clickAction: { ...PARENT_ACTION },
			children: [
				{ id: "c1", type: "unit", ref: { kind: "folder", path: "C1" }, children: [], clickAction: { ...CHILD_ACTION } },
				{ id: "c2", type: "meta", label: "C2", children: [], clickAction: { kind: "uri", value: "obsidian://open?file=x" } },
			],
		},
		{ id: "after", type: "meta", label: "After", children: [] },
	];
}

describe("removing a node lifts its children and discards its own action (E8)", () => {
	it("deleteMetaFolder: children are lifted in place with their own actions untouched", () => {
		const { vm, saved } = manager(tree());
		vm.deleteMetaFolder("v", "parent");
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["before", "c1", "c2", "after"]);
		expect(root[1].clickAction).toEqual(CHILD_ACTION);
		expect(root[2].clickAction).toEqual({ kind: "uri", value: "obsidian://open?file=x" });
		expect(vm.getNode("v", "parent")).toBeNull();
		const lastSaved = saved[saved.length - 1];
		expect(lastSaved).not.toContain("open -a Docker");
		expect(lastSaved).toContain(CHILD_ACTION.value);
	});

	it("unplaceNode on a module: its action goes with it, its children keep theirs", () => {
		const { vm, saved } = manager([
			{
				id: "mod",
				type: "unit",
				ref: { kind: "folder", path: "Mod" },
				clickAction: { ...PARENT_ACTION },
				children: [{ id: "kid", type: "unit", ref: { kind: "folder", path: "Kid" }, children: [], clickAction: { ...CHILD_ACTION } }],
			},
		]);
		vm.unplaceNode("v", "mod");
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["kid"]);
		expect(root[0].clickAction).toEqual(CHILD_ACTION);
		expect(saved[saved.length - 1]).not.toContain("open -a Docker");
	});

	it("unplaceNode on a Folder behaves the same", () => {
		const { vm, saved } = manager(tree());
		vm.unplaceNode("v", "parent");
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["before", "c1", "c2", "after"]);
		expect(vm.getViews()[0].root[1].clickAction).toEqual(CHILD_ACTION);
		expect(saved[saved.length - 1]).not.toContain("open -a Docker");
	});
});

describe("removing a Folder with API rows discards their Item overrides (E8)", () => {
	const source: ApiSourceConfig = {
		type: "api",
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
	};
	const OVERRIDE = "obsidian://override-marker";

	function withRows(extra: Partial<ViewNode>): ViewNode[] {
		return [
			{
				id: "api",
				type: "meta",
				label: "API",
				children: [{ id: "kid", type: "unit", ref: { kind: "folder", path: "Kid" }, children: [], clickAction: { ...CHILD_ACTION } }],
				apiItemOrder: ["1"],
				apiItemState: { "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, clickAction: { kind: "uri", value: OVERRIDE } } },
				...extra,
			},
		];
	}

	it.each([
		["with a live source", { apiSource: source }],
		["with static rows only", {}],
	])("deleteMetaFolder %s leaves no orphan override in the saved views", (_name, extra) => {
		const { vm, saved } = manager(withRows(extra));
		vm.deleteMetaFolder("v", "api");
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["kid"]);
		expect(JSON.stringify(vm.getViews())).not.toContain(OVERRIDE);
		expect(saved[saved.length - 1]).not.toContain(OVERRIDE);
		expect(vm.getViews()[0].root[0].clickAction).toEqual(CHILD_ACTION);
	});

	it("unplaceNode on the Folder also discards the overrides", () => {
		const { vm } = manager(withRows({ apiSource: source }));
		vm.unplaceNode("v", "api");
		expect(JSON.stringify(vm.getViews())).not.toContain(OVERRIDE);
	});

	it("removeApiItem discards that row's override with the row", () => {
		const { vm } = manager(withRows({ apiSource: source }));
		vm.removeApiItem("v", "api", "1");
		expect(JSON.stringify(vm.getViews())).not.toContain(OVERRIDE);
	});
});
