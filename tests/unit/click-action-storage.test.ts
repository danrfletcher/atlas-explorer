import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { cloneApiItemState, sanitizeApiFields, sanitizeApiItemState, sanitizeClickAction, ViewsManager } from "../../src/views";
import { ApiItemState, ApiSourceConfig, ClickAction, PLACEHOLDER_ROW_KIND, View, ViewNode } from "../../src/types";

const ACTION: ClickAction = { kind: "command", value: "app-runner:open-live-captions" };

function moduleNode(id: string, extra: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "unit", ref: { kind: "folder", path: `Mod${id}` }, children: [], ...extra };
}

function folderNode(id: string, extra: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "meta", label: `Folder ${id}`, children: [], ...extra };
}

function apiSource(extra: Record<string, unknown> = {}): ApiSourceConfig {
	return {
		type: "api",
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
		...extra,
	} as ApiSourceConfig;
}

/** Loads nodes through the real `ViewsManager` constructor (the load path) and returns the loaded roots. */
function load(root: ViewNode[]): ViewNode[] {
	const view: View = { id: "v", name: "V", root, inboxMode: "view" };
	return new ViewsManager({} as App, [view], "v", () => {}).getViews()[0].root;
}

/** Every malformed shape a hand-edited or corrupted `data.json` could hold for `clickAction`. */
const MALFORMED: [string, unknown][] = [
	["a string", "run"],
	["a number", 5],
	["true", true],
	["null", null],
	["an array", [{ kind: "command", value: "x" }]],
	["an empty object", {}],
	["a nested object as the whole value", { clickAction: ACTION }],
	["a missing kind", { value: "x" }],
	["an unknown kind", { kind: "shell", value: "x" }],
	["a non-string kind", { kind: 5, value: "x" }],
	["a differently cased kind", { kind: "Command", value: "x" }],
	["a missing value", { kind: "command" }],
	["a numeric value", { kind: "terminal", value: 5 }],
	["an object value", { kind: "uri", value: { a: 1 } }],
	["a null value", { kind: "uri", value: null }],
	["an array value", { kind: "command", value: ["x"] }],
	["an empty value", { kind: "command", value: "" }],
	["a whitespace-only value", { kind: "terminal", value: " \t\n " }],
	["the spec's corrupt example", { kind: "shell", value: 5 }],
];

describe("sanitizeClickAction", () => {
	it.each(["terminal", "command", "uri"] as const)("keeps a well-formed %s action unchanged", (kind) => {
		expect(sanitizeClickAction({ kind, value: "x y" })).toEqual({ kind, value: "x y" });
	});

	it("keeps the value exactly as stored, without trimming", () => {
		expect(sanitizeClickAction({ kind: "terminal", value: "  open -a Docker " })).toEqual({ kind: "terminal", value: "  open -a Docker " });
	});

	it("strips unknown extra keys", () => {
		const out = sanitizeClickAction({ kind: "uri", value: "obsidian://open", extra: 1, nested: { a: 1 } });
		expect(out).toEqual({ kind: "uri", value: "obsidian://open" });
		expect(Object.keys(out!).sort()).toEqual(["kind", "value"]);
	});

	it.each(MALFORMED)("drops %s without throwing", (_name, raw) => {
		expect(() => sanitizeClickAction(raw)).not.toThrow();
		expect(sanitizeClickAction(raw)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(sanitizeClickAction(undefined)).toBeUndefined();
	});

	it("does not depend on the platform: a terminal action is kept (E17/G13)", () => {
		vi.stubGlobal("navigator", { userAgent: "Mobile iPhone", platform: "iPhone" });
		try {
			expect(sanitizeClickAction({ kind: "terminal", value: "open -a Docker" })).toEqual({ kind: "terminal", value: "open -a Docker" });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("sanitizeApiFields: a node's clickAction", () => {
	it("keeps a well-formed action on a module node", () => {
		const node = moduleNode("m", { clickAction: { ...ACTION } });
		sanitizeApiFields(node);
		expect(node.clickAction).toEqual(ACTION);
	});

	it("keeps a well-formed action on a Folder node", () => {
		const node = folderNode("f", { clickAction: { kind: "terminal", value: "open -a Docker" } });
		sanitizeApiFields(node);
		expect(node.clickAction).toEqual({ kind: "terminal", value: "open -a Docker" });
	});

	it("keeps actions on nested children at every depth", () => {
		const grandchild = moduleNode("g", { clickAction: { kind: "uri", value: "obsidian://open?file=A" } });
		const child = folderNode("c", { clickAction: { ...ACTION }, children: [grandchild] });
		const root = folderNode("r", { children: [child] });
		sanitizeApiFields(root);
		expect(root.clickAction).toBeUndefined();
		expect(root.children[0].clickAction).toEqual(ACTION);
		expect(root.children[0].children[0].clickAction).toEqual({ kind: "uri", value: "obsidian://open?file=A" });
	});

	it("strips extra keys from a stored action", () => {
		const node = moduleNode("m", { clickAction: { ...ACTION, junk: true } as ClickAction });
		sanitizeApiFields(node);
		expect(node.clickAction).toEqual(ACTION);
		expect(Object.keys(node.clickAction!).sort()).toEqual(["kind", "value"]);
	});

	it.each(MALFORMED)("drops a malformed action (%s) and leaves the rest of the node alone", (_name, raw) => {
		const node = moduleNode("m", { explicitStatusId: "s1", collapsed: true, placedAt: 42 });
		(node as unknown as { clickAction: unknown }).clickAction = raw;
		expect(() => sanitizeApiFields(node)).not.toThrow();
		expect(node.clickAction).toBeUndefined();
		expect("clickAction" in node).toBe(false);
		expect(node).toMatchObject({ id: "m", type: "unit", explicitStatusId: "s1", collapsed: true, placedAt: 42 });
	});

	it("leaves no clickAction key on a node that never had one", () => {
		const node = moduleNode("m");
		sanitizeApiFields(node);
		expect("clickAction" in node).toBe(false);
	});

	it("one bad node does not stop its siblings or children from loading", () => {
		const roots = load([
			moduleNode("bad", { clickAction: 7 as unknown as ClickAction, children: [moduleNode("bad-child", { clickAction: { ...ACTION } })] }),
			folderNode("good-folder", { clickAction: { kind: "terminal", value: "ls" } }),
			moduleNode("good-module", { clickAction: { ...ACTION } }),
			moduleNode("junk", { clickAction: [[{}]] as unknown as ClickAction }),
			moduleNode("last", { clickAction: { ...ACTION } }),
		]);
		expect(roots.map((n) => n.id)).toEqual(["bad", "good-folder", "good-module", "junk", "last"]);
		expect(roots[0].clickAction).toBeUndefined();
		expect(roots[0].children[0].clickAction).toEqual(ACTION);
		expect(roots[1].clickAction).toEqual({ kind: "terminal", value: "ls" });
		expect(roots[2].clickAction).toEqual(ACTION);
		expect(roots[3].clickAction).toBeUndefined();
		expect(roots[4].clickAction).toEqual(ACTION);
	});
});

describe("sanitizeApiItemState: an Item override", () => {
	const base = { id: "ignored", label: "One", kind: PLACEHOLDER_ROW_KIND };

	it("keeps a well-formed clickAction on an API row", () => {
		const out = sanitizeApiItemState({ ...base, clickAction: { ...ACTION } }, "1");
		expect(out).toEqual({ id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, clickAction: ACTION });
	});

	it("strips extra keys", () => {
		const out = sanitizeApiItemState({ ...base, clickAction: { ...ACTION, junk: 1 } }, "1");
		expect(Object.keys(out!.clickAction!).sort()).toEqual(["kind", "value"]);
	});

	it.each(MALFORMED)("drops a malformed action (%s) and keeps the rest of the row", (_name, raw) => {
		const out = sanitizeApiItemState({ ...base, secondary: "sec", explicitStatusId: "s1", clickAction: raw }, "1");
		expect(out).toEqual({ id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, secondary: "sec", explicitStatusId: "s1" });
		expect("clickAction" in out!).toBe(false);
	});

	it("adds no clickAction key to a row that had none", () => {
		expect("clickAction" in sanitizeApiItemState(base, "1")!).toBe(false);
	});

	it("keeps an override on a row through a node load, with and without a source (E16 static rows)", () => {
		const rows = { "1": { ...base, id: "1", clickAction: { ...ACTION } }, "2": { ...base, id: "2", label: "Two", clickAction: "junk" } };
		const withSource = load([folderNode("a", { apiSource: apiSource(), apiItemState: structuredClone(rows) as never, apiItemOrder: ["1", "2"] })])[0];
		const noSource = load([folderNode("b", { apiItemState: structuredClone(rows) as never, apiItemOrder: ["1", "2"] })])[0];
		for (const node of [withSource, noSource]) {
			expect(node.apiItemState!["1"].clickAction).toEqual(ACTION);
			expect(node.apiItemState!["2"].clickAction).toBeUndefined();
			expect(node.apiItemState!["2"].label).toBe("Two");
		}
	});
});

describe("cloneApiItemState", () => {
	it("copies an Item override as a new object, not a shared reference", () => {
		const state: Record<string, ApiItemState> = { "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND, clickAction: { ...ACTION } } };
		const out = cloneApiItemState(state);
		expect(out["1"].clickAction).toEqual(ACTION);
		expect(out["1"].clickAction).not.toBe(state["1"].clickAction);
		out["1"].clickAction!.value = "changed";
		expect(state["1"].clickAction!.value).toBe(ACTION.value);
	});

	it("adds no clickAction key to a row without one", () => {
		const out = cloneApiItemState({ "1": { id: "1", label: "One", kind: PLACEHOLDER_ROW_KIND } });
		expect("clickAction" in out["1"]).toBe(false);
	});
});

describe("ApiSourceConfig.clickFunction on load", () => {
	const SRC = "(item) => ({ kind: \"none\" })";

	function loadedSource(raw: unknown) {
		return load([folderNode("f", { apiSource: apiSource({ clickFunction: raw }) })])[0].apiSource;
	}

	it("survives load when it is a string", () => {
		expect(loadedSource(SRC)?.clickFunction).toBe(SRC);
	});

	it.each([
		["a number", 5],
		["an object", { a: 1 }],
		["an array", ["x"]],
		["null", null],
		["true", true],
	])("drops %s", (_name, raw) => {
		expect(loadedSource(raw)).toBeDefined();
		expect(loadedSource(raw)?.clickFunction).toBeUndefined();
	});

	it("stores an empty string as absent", () => {
		expect(loadedSource("")?.clickFunction).toBeUndefined();
	});

	it("is absent on a source that never had one, and leaves the source click action alone", () => {
		const src = loadedSource(undefined)!;
		expect(src.clickFunction).toBeUndefined();
		const withAction = load([folderNode("f", { apiSource: apiSource({ action: "run-command", command: "ls" }) })])[0].apiSource!;
		expect(withAction.action).toBe("run-command");
		expect(withAction.clickAction).toBe("run-command");
		expect(withAction.command).toBe("ls");
	});

	it("survives duplicating the Folder (cloneApiSource)", () => {
		const vm = new ViewsManager({} as App, [{ id: "v", name: "V", root: [folderNode("f", { apiSource: apiSource({ clickFunction: SRC }) })], inboxMode: "view" }], "v", () => {});
		const clone = vm.duplicateNode("v", "f")!;
		expect(clone.apiSource?.clickFunction).toBe(SRC);
		expect(clone.apiSource).not.toBe(vm.getNode("v", "f")!.apiSource);
	});
});
