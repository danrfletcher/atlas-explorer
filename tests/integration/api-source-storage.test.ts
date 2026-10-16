import { describe, expect, it } from "vitest";
import { ApiHeadersStore } from "../../src/api-headers-store";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, View, ViewNode } from "../../src/types";
import type { App } from "obsidian";

/** In-memory stand-in for Obsidian's real per-device `loadLocalStorage`/`saveLocalStorage` — good
 * enough to prove `ApiHeadersStore`'s own keying/round-trip behavior without needing the real plugin. */
class FakeLocalStorageHost {
	private store = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.store.get(key) ?? null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		this.store.set(key, data);
	}
}

const SECRET = "Bearer super-secret-token-xyz";

function makeSource(url = "https://api.example.com/items"): ApiSourceConfig {
	return {
		type: "api",
		url,
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
		refreshEveryMinutesEnabled: false,
		refreshEveryMinutes: undefined,
		keepOnEmpty: undefined,
		confirmBeforeDelete: undefined,
	};
}

describe("ApiHeadersStore — G13: device-local only, keyed per Folder", () => {
	it("round-trips headers for a given node id", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		store.set("node-a", [{ key: "Authorization", value: SECRET }]);
		expect(store.get("node-a")).toEqual([{ key: "Authorization", value: SECRET }]);
	});

	it("returns an empty list for a node with no headers set", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		expect(store.get("unknown")).toEqual([]);
	});

	it("keeps headers isolated per node — setting one node's headers never leaks into another's", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		store.set("node-a", [{ key: "X-A", value: "a" }]);
		store.set("node-b", [{ key: "X-B", value: "b" }]);
		expect(store.get("node-a")).toEqual([{ key: "X-A", value: "a" }]);
		expect(store.get("node-b")).toEqual([{ key: "X-B", value: "b" }]);
	});

	it("E6: delete removes exactly that node's entry", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		store.set("node-a", [{ key: "X-A", value: "a" }]);
		store.set("node-b", [{ key: "X-B", value: "b" }]);
		store.delete("node-a");
		expect(store.get("node-a")).toEqual([]);
		expect(store.get("node-b")).toEqual([{ key: "X-B", value: "b" }]);
	});
});

describe("Persisted view data — G13: headers never appear in the synced shape", () => {
	function makeViewsManager(persist: () => void = () => {}) {
		const views: View[] = [];
		return new ViewsManager({} as App, views, "", persist);
	}

	it("source/cache/itemState are plain fields on the node, present in what would be saved to data.json", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		const node = vm.getNode(view.id, folder.id)!;
		node.apiCache = { fetchedAt: 123, ok: true, error: null, rows: [{ id: "1", label: "One" }], skippedCount: 0, truncated: false };

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("api.example.com");
		expect(persistedJson).toContain("\"fetchedAt\":123");
	});

	it("the device-local header value never appears anywhere in the persisted view data", () => {
		const headersStore = new ApiHeadersStore(new FakeLocalStorageHost());
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		headersStore.set(folder.id, [{ key: "Authorization", value: SECRET }]);

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).not.toContain(SECRET);
	});
});

describe("E7 — rename/move leave a Folder's API source untouched", () => {
	function makeViewsManager() {
		return new ViewsManager({} as App, [], "", () => {});
	}

	it("renaming a Folder does not touch its apiSource/cache", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		vm.renameMetaFolder(view.id, folder.id, "Renamed folder");

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.label).toBe("Renamed folder");
		expect(node.apiSource).toEqual(makeSource());
	});

	// R10: this only exercises `moveNode` — plain re-nesting of a meta Folder within the bucket tree.
	// It is not a test of the separate (and, in this codebase, not-yet-implemented) 34n6ct71muguncxk
	// meta-Folder-to-real-folder "promotion" ticket, which this PR coordinates with but does not build.
	it("moveNode (re-nesting a Folder elsewhere in the tree) keeps its apiSource intact", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const target = vm.addMetaFolder(view.id, null, "Target")!;
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		vm.moveNode(view.id, folder.id, target.id, 0);

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.apiSource).toEqual(makeSource());
	});
});

describe("R12 — renaming a file/folder rewrites an API item's attached note (rename integrity)", () => {
	function makeViewsManager() {
		return new ViewsManager({} as App, [], "", () => {});
	}

	it("onVaultRename rewrites apiItemState[*].noteRef the same way it rewrites a unit's own ref", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "One", noteRef: { kind: "file", path: "Old.md" } } };
		node.apiItemOrder = ["1"];

		vm.onVaultRename("Old.md", "New.md");

		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "New.md" });
	});

	it("onVaultRename rewrites a noteRef nested under a renamed containing folder (prefix match)", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "One", noteRef: { kind: "file", path: "Pool/Old.md" } } };
		node.apiItemOrder = ["1"];

		vm.onVaultRename("Pool", "Renamed pool");

		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Renamed pool/Old.md" });
	});

	it("an item with no attachment yet is untouched", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		const node = vm.getNode(view.id, folder.id)!;
		node.apiItemState = { "1": { id: "1", label: "One" } };
		node.apiItemOrder = ["1"];

		vm.onVaultRename("Old.md", "New.md");

		expect(vm.getNode(view.id, folder.id)!.apiItemState!["1"].noteRef).toBeUndefined();
	});
});

describe("E6 — deleting a Folder removes its source/cache and (via the caller) its headers", () => {
	it("deleteMetaFolder discards the node's own apiSource/cache/itemState", () => {
		const vm = new ViewsManager({} as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		vm.deleteMetaFolder(view.id, folder.id);

		expect(vm.getNode(view.id, folder.id)).toBeNull();
	});

	it("the delete flow (headers store + deleteMetaFolder) leaves no trace of the headers either", () => {
		const headersStore = new ApiHeadersStore(new FakeLocalStorageHost());
		const vm = new ViewsManager({} as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		headersStore.set(folder.id, [{ key: "Authorization", value: SECRET }]);

		// Mirrors explorer-view.ts's own delete-folder handler: the headers store has no home inside
		// ViewsManager's own data, so the caller clears it explicitly alongside the node itself.
		headersStore.delete(folder.id);
		vm.deleteMetaFolder(view.id, folder.id);

		expect(headersStore.get(folder.id)).toEqual([]);
		expect(vm.getNode(view.id, folder.id)).toBeNull();
	});
});

describe("R17/E9 — corrupt or missing apiSource/apiCache/apiItemState/apiItemOrder in data.json never crash on load", () => {
	function nodeWithApiSource(overrides: Partial<ViewNode> = {}): ViewNode {
		return {
			id: "n1",
			type: "meta",
			label: "API folder",
			children: [],
			apiSource: makeSource(),
			...overrides,
		};
	}

	function loadedNode(node: ViewNode): ViewNode {
		const views: View[] = [{ id: "v1", name: "V", root: [node], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		return vm.getNode("v1", "n1")!;
	}

	it("apiItemOrder as a plain object (not an array) is replaced with a real array, not left un-iterable", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One" } },
			apiItemOrder: {} as unknown as string[],
		});
		const sanitized = loadedNode(node);
		expect(Array.isArray(sanitized.apiItemOrder)).toBe(true);
		expect(sanitized.apiItemOrder).toEqual(["1"]);
	});

	it("apiItemOrder as a bare number is replaced with a real array", () => {
		const node = nodeWithApiSource({ apiItemOrder: 5 as unknown as string[] });
		const sanitized = loadedNode(node);
		expect(Array.isArray(sanitized.apiItemOrder)).toBe(true);
	});

	it("apiItemOrder entries with no matching apiItemState are dropped", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One" } },
			apiItemOrder: ["1", "stale-id-not-in-state"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemOrder).toEqual(["1"]);
	});

	it("apiItemState missing while apiSource is valid becomes an empty object, not left undefined", () => {
		const node = nodeWithApiSource({ apiItemState: undefined, apiItemOrder: undefined });
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState).toEqual({});
		expect(sanitized.apiItemOrder).toEqual([]);
	});

	it("an apiSource with no mapping is dropped entirely, along with its cache — but PR-3's G4 means its rows survive as static rows, not wiped", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com" } as unknown as ApiSourceConfig,
			apiCache: { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false },
			apiItemState: { "1": { id: "1", label: "One" } },
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeUndefined();
		expect(sanitized.apiCache).toBeUndefined();
		expect(sanitized.apiItemState).toEqual({ "1": { id: "1", label: "One", kind: "placeholder" } });
		expect(sanitized.apiItemOrder).toEqual(["1"]);
	});

	it("an apiSource that isn't even an object is dropped, not thrown on", () => {
		const node = nodeWithApiSource({ apiSource: "not an object" as unknown as ApiSourceConfig });
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeUndefined();
	});

	it("a node with no apiSource at all still has its stray apiCache cleared, but PR-3's G4 means leftover apiItemState/apiItemOrder survive as static rows", () => {
		const node: ViewNode = {
			id: "n1",
			type: "meta",
			label: "Plain folder",
			children: [],
			apiItemState: { "1": { id: "1", label: "One" } },
			apiItemOrder: ["1"],
		};
		const sanitized = loadedNode(node);
		expect(sanitized.apiCache).toBeUndefined();
		expect(sanitized.apiItemState).toEqual({ "1": { id: "1", label: "One", kind: "placeholder" } });
		expect(sanitized.apiItemOrder).toEqual(["1"]);
	});

	it("sanitizing recurses into nested meta-folder children", () => {
		const child = nodeWithApiSource({ id: "child", apiItemOrder: {} as unknown as string[], apiItemState: {} });
		const parent: ViewNode = { id: "parent", type: "meta", label: "Parent", children: [child] };
		const views: View[] = [{ id: "v1", name: "V", root: [parent], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		expect(Array.isArray(vm.getNode("v1", "child")!.apiItemOrder)).toBe(true);
	});

	it("a well-formed apiSource/cache/state round-trips unchanged", () => {
		const node = nodeWithApiSource({
			apiCache: { fetchedAt: 1, ok: true, error: null, rows: [], skippedCount: 0, truncated: false },
			apiItemState: { "1": { id: "1", label: "One" } },
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toEqual(makeSource());
		expect(sanitized.apiItemOrder).toEqual(["1"]);
		expect(sanitized.apiItemState).toEqual({ "1": { id: "1", label: "One", kind: "placeholder" } });
	});

	it("R6: a hand-edited refreshEveryMinutes of zero is clamped to the minimum, not treated as invalid and switched off", () => {
		const node = nodeWithApiSource({
			apiSource: { ...makeSource(), refreshEveryMinutesEnabled: true, refreshEveryMinutes: 0 },
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource!.refreshEveryMinutesEnabled).toBe(true);
		expect(sanitized.apiSource!.refreshEveryMinutes).toBe(5);
	});

	it("R6: a hand-edited negative refreshEveryMinutes is clamped to the minimum, not treated as invalid and switched off", () => {
		const node = nodeWithApiSource({
			apiSource: { ...makeSource(), refreshEveryMinutesEnabled: true, refreshEveryMinutes: -30 },
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource!.refreshEveryMinutesEnabled).toBe(true);
		expect(sanitized.apiSource!.refreshEveryMinutes).toBe(5);
	});

	it("R6: a hand-edited refreshEveryMinutes above the setTimeout-overflow ceiling is clamped down, not left to overflow", () => {
		const node = nodeWithApiSource({
			apiSource: { ...makeSource(), refreshEveryMinutesEnabled: true, refreshEveryMinutes: 999999999 },
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource!.refreshEveryMinutesEnabled).toBe(true);
		expect(sanitized.apiSource!.refreshEveryMinutes).toBe(35791);
	});

	it("a toggle left on with a non-numeric refreshEveryMinutes is forced off, since there's no value to clamp", () => {
		const node = nodeWithApiSource({
			apiSource: { ...makeSource(), refreshEveryMinutesEnabled: true, refreshEveryMinutes: "not a number" as unknown as number },
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource!.refreshEveryMinutesEnabled).toBe(false);
		expect(sanitized.apiSource!.refreshEveryMinutes).toBeUndefined();
	});
});

describe("R20/E9 — corrupt individual apiItemState entries never crash on load", () => {
	function nodeWithApiSource(overrides: Partial<ViewNode> = {}): ViewNode {
		return {
			id: "n1",
			type: "meta",
			label: "API folder",
			children: [],
			apiSource: makeSource(),
			...overrides,
		};
	}

	function loadedNode(node: ViewNode): ViewNode {
		const views: View[] = [{ id: "v1", name: "V", root: [node], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		return vm.getNode("v1", "n1")!;
	}

	it("an entry with no label is dropped, not left to crash label.trim()/toLowerCase() later", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1" } } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState).toEqual({});
		expect(sanitized.apiItemOrder).toEqual([]);
	});

	it("an entry that isn't even an object (a bare number) is dropped", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": 5 } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState).toEqual({});
		expect(sanitized.apiItemOrder).toEqual([]);
	});

	it("a label that is not a string is dropped", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: 42 } } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState).toEqual({});
	});

	it("an entry's id is always retaken from the state map's own key, even if the stored id disagrees", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "different-id", label: "One" } },
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState).toEqual({ "1": { id: "1", label: "One", kind: "placeholder" } });
	});

	it("a lastSeenAt that isn't a string is dropped rather than rendering 'NaN-NaN-NaN'", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", lastSeenAt: 12345 } } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].lastSeenAt).toBeUndefined();
	});

	it("a lastSeenAt that doesn't parse as a date is dropped", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", lastSeenAt: "not-a-date" } },
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].lastSeenAt).toBeUndefined();
	});

	it("a valid lastSeenAt survives untouched", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", lastSeenAt: "2026-09-25T00:00:00.000Z" } },
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].lastSeenAt).toBe("2026-09-25T00:00:00.000Z");
	});

	it("a secondary that isn't a string is dropped", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", secondary: { nested: true } } } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].secondary).toBeUndefined();
	});

	it("a noteRef with no valid shape (missing kind/path) is dropped, not trusted by openRef later", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", noteRef: { kind: "file" } } } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].noteRef).toBeUndefined();
	});

	it("a noteRef that's a bare string (not a UnitRef object) is dropped", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", noteRef: "Notes/One.md" } } as unknown as Record<string, unknown>,
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].noteRef).toBeUndefined();
	});

	it("a well-formed noteRef survives untouched", () => {
		const node = nodeWithApiSource({
			apiItemState: { "1": { id: "1", label: "One", noteRef: { kind: "file", path: "Notes/One.md" } } },
			apiItemOrder: ["1"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState!["1"].noteRef).toEqual({ kind: "file", path: "Notes/One.md" });
	});

	it("one corrupt entry among otherwise-valid ones is dropped without disturbing its siblings", () => {
		const node = nodeWithApiSource({
			apiItemState: {
				"1": { id: "1", label: "One" },
				"2": { id: "2" },
				"3": { id: "3", label: "Three" },
			} as unknown as Record<string, unknown>,
			apiItemOrder: ["1", "2", "3"],
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiItemState).toEqual({
			"1": { id: "1", label: "One", kind: "placeholder" },
			"3": { id: "3", label: "Three", kind: "placeholder" },
		});
		expect(sanitized.apiItemOrder).toEqual(["1", "3"]);
	});
});
