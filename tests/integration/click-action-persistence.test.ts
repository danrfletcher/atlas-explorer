import { readFileSync } from "fs";
import { join } from "path";
import type { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, ClickAction, PLACEHOLDER_ROW_KIND, View, ViewNode } from "../../src/types";

/** A stand-in for `data.json`: the views as the plugin would write them (a JSON string) and read them
 * back, so each "reload" starts from serialised text and not from live objects. */
class FakeDataJson {
	text = "[]";
	save(views: View[]): void {
		this.text = JSON.stringify(views);
	}
	manager(): ViewsManager {
		const views = JSON.parse(this.text) as View[];
		const vm = new ViewsManager({} as App, views, views[0]?.id ?? "", () => this.save(vm.getViews()));
		return vm;
	}
}

const MODULE_ACTION: ClickAction = { kind: "command", value: "app-runner:open-live-captions" };
const FOLDER_ACTION: ClickAction = { kind: "terminal", value: "open -a Docker" };
const ROW_ACTION: ClickAction = { kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" };

const SOURCE: ApiSourceConfig = {
	type: "api",
	url: "https://api.example.com/items",
	method: "GET",
	mapping: { idField: "id", labelField: "name" },
	mode: "merge",
	refreshOnViewLoad: false,
	clickFunction: "(item) => undefined",
};

function seed(): View[] {
	return [
		{
			id: "v",
			name: "V",
			inboxMode: "view",
			root: [
				{ id: "mod", type: "unit", ref: { kind: "folder", path: "Live Captions" }, children: [], clickAction: { ...MODULE_ACTION } },
				{
					id: "apps",
					type: "meta",
					label: "Apps",
					clickAction: { ...FOLDER_ACTION },
					children: [{ id: "nested", type: "unit", ref: { kind: "folder", path: "Nested" }, children: [], clickAction: { ...MODULE_ACTION } }],
				},
				{
					id: "api",
					type: "meta",
					label: "API",
					children: [],
					apiSource: { ...SOURCE },
					apiItemOrder: ["1"],
					apiItemState: { "1": { id: "1", label: "Docker", kind: PLACEHOLDER_ROW_KIND, clickAction: { ...ROW_ACTION } } },
				},
			],
		},
	];
}

function findOrNull(nodes: ViewNode[], id: string): ViewNode | null {
	for (const n of nodes) {
		if (n.id === id) return n;
		const hit = findOrNull(n.children, id);
		if (hit) return hit;
	}
	return null;
}

function find(nodes: ViewNode[], id: string): ViewNode {
	const hit = findOrNull(nodes, id);
	if (!hit) throw new Error(`no node ${id}`);
	return hit;
}

afterEach(() => vi.restoreAllMocks());

describe("click action: load, mutate, save, reload", () => {
	it("round-trips module, Folder, nested and Item override actions plus clickFunction unchanged", () => {
		const data = new FakeDataJson();
		data.text = JSON.stringify(seed());

		const first = data.manager();
		// a mutation that saves: duplicating the Folder (which has a nested module with its own action)
		const clone = first.duplicateNode("v", "apps")!;
		expect(clone.clickAction).toEqual(FOLDER_ACTION);

		const second = data.manager();
		const root = second.getViews()[0].root;
		expect(find(root, "mod").clickAction).toEqual(MODULE_ACTION);
		expect(find(root, "apps").clickAction).toEqual(FOLDER_ACTION);
		expect(find(root, "nested").clickAction).toEqual(MODULE_ACTION);
		expect(find(root, "api").apiSource?.clickFunction).toBe(SOURCE.clickFunction);
		expect(find(root, "api").apiItemState!["1"].clickAction).toEqual(ROW_ACTION);
		expect(find(root, clone.id).clickAction).toEqual(FOLDER_ACTION);
		expect(find(root, clone.id).children[0].clickAction).toEqual(MODULE_ACTION);
		expect(find(root, clone.id).children[0].id).not.toBe("nested");
		// a further save/reload changes nothing
		second.duplicateNode("v", "mod");
		const third = data.manager();
		expect(find(third.getViews()[0].root, "apps").clickAction).toEqual(FOLDER_ACTION);
		expect(find(third.getViews()[0].root, "api").apiItemState!["1"].clickAction).toEqual(ROW_ACTION);
	});

	it("an Item override on a row whose source was removed is kept on load, not stripped (E16)", () => {
		const views = seed();
		delete (find(views[0].root, "api") as { apiSource?: unknown }).apiSource;
		const data = new FakeDataJson();
		data.text = JSON.stringify(views);

		const vm = data.manager();
		const api = find(vm.getViews()[0].root, "api");
		expect(api.apiSource).toBeUndefined();
		expect(api.apiItemState!["1"].clickAction).toEqual(ROW_ACTION);
		expect(api.apiItemOrder).toEqual(["1"]);
	});

	it("a corrupted action is dropped on load and gone from the next save; the node still loads", () => {
		const views = seed();
		(find(views[0].root, "mod") as unknown as { clickAction: unknown }).clickAction = { kind: "shell", value: 5 };
		(find(views[0].root, "api").apiItemState!["1"] as unknown as { clickAction: unknown }).clickAction = "junk";
		const data = new FakeDataJson();
		data.text = JSON.stringify(views);

		const vm = data.manager();
		const mod = find(vm.getViews()[0].root, "mod");
		expect(mod.clickAction).toBeUndefined();
		expect(mod.ref).toEqual({ kind: "folder", path: "Live Captions" });
		vm.duplicateNode("v", "apps"); // any save
		const saved = JSON.parse(data.text) as View[];
		expect(JSON.stringify(find(saved[0].root, "mod"))).not.toContain("clickAction");
		expect(JSON.stringify(find(saved[0].root, "api").apiItemState)).not.toContain("clickAction");
		expect(find(saved[0].root, "apps").clickAction).toEqual(FOLDER_ACTION);
	});

	it("a terminal action loads unchanged on a mobile-like platform (E17/G13)", () => {
		vi.stubGlobal("navigator", { userAgent: "Mobile iPhone", platform: "iPhone" });
		try {
			const data = new FakeDataJson();
			data.text = JSON.stringify(seed());
			expect(find(data.manager().getViews()[0].root, "apps").clickAction).toEqual(FOLDER_ACTION);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

/** Every object key path in a JSON value, e.g. `root[].children[].ref.path`, so two documents can be
 * compared on shape (keys) independently of values. Array indices collapse to `[]`. */
function keyPaths(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const v of value) keyPaths(v, `${prefix}[]`, out);
	} else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			out.add(`${prefix}.${k}`);
			keyPaths(v, `${prefix}.${k}`, out);
		}
	}
	return out;
}

describe("E10: an older data.json loads and saves without gaining the new keys", () => {
	const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/data-v0.2.1.json"), "utf8")) as { views: View[]; activeViewId: string };

	it("loads with no clickAction/clickFunction anywhere and raises no console warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const data = new FakeDataJson();
		data.text = JSON.stringify(fixture.views);
		const vm = data.manager();
		const serialised = JSON.stringify(vm.getViews());
		expect(serialised).not.toContain("clickAction");
		expect(serialised).not.toContain("clickFunction");
		const walk = (nodes: ViewNode[]): void => {
			for (const n of nodes) {
				expect(n.clickAction).toBeUndefined();
				expect(n.apiSource?.clickFunction).toBeUndefined();
				walk(n.children);
			}
		};
		for (const view of vm.getViews()) walk(view.root);
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it("load then save adds no key: the saved key set equals the fixture's, and nothing is serialised as null", () => {
		const data = new FakeDataJson();
		data.text = JSON.stringify(fixture.views);
		const vm = data.manager();
		// A plain load-then-save with no mutation: what is written must equal what was loaded.
		const before = JSON.stringify(vm.getViews());
		data.save(vm.getViews());
		const after = JSON.parse(data.text) as View[];
		expect(JSON.stringify(after)).toBe(before);
		expect([...keyPaths(after)].sort()).toEqual([...keyPaths(fixture.views)].sort());
		expect(data.text).not.toContain("null");
	});

	it("a real save after a mutation still introduces no new key on the pre-existing nodes", () => {
		const data = new FakeDataJson();
		data.text = JSON.stringify(fixture.views);
		const vm = data.manager();
		const viewId = vm.getViews()[0].id;
		vm.addMetaFolder(viewId, null, "Scratch"); // saves through the persist callback
		const saved = JSON.parse(data.text) as View[];
		const fixtureKeys = keyPaths(fixture.views);
		const extra = [...keyPaths(saved)].filter((k) => !fixtureKeys.has(k));
		// only the new scratch node's own fields may appear, never a click-action key
		expect(extra.filter((k) => /click/i.test(k))).toEqual([]);
		for (const k of fixtureKeys) expect(keyPaths(saved).has(k)).toBe(true);
	});
});
