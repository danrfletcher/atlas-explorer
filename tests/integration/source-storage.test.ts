import { describe, expect, it } from "vitest";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, View, ViewNode } from "../../src/types";
import type { App } from "obsidian";

/** G3: `mappingMode`/`jsSource` persistence through `ViewsManager`'s load-save round-trip — the JS
 * source lives in synced `data.json` `source` (not device-local, unlike headers, per the spec's own
 * "not a secret" call). Mirrors `api-source-storage.test.ts`'s own conventions/helpers. */

function jsSource(overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshEveryMinutesEnabled: false,
		refreshEveryMinutes: undefined,
		keepOnEmpty: undefined,
		confirmBeforeDelete: undefined,
		mappingMode: "js",
		jsSource: "(response) => response.map((item) => ({ id: item.id, label: item.name }))",
		...overrides,
	};
}

function makeViewsManager(views: View[] = [], persist: () => void = () => {}) {
	return new ViewsManager({} as App, views, "", persist);
}

describe("Persisted view data — G3: mappingMode/jsSource are plain fields on the node's source", () => {
	it("a js-mode source round-trips through setApiSource/getNode, present in what would be saved to data.json", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, jsSource());

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.apiSource?.mappingMode).toBe("js");
		expect(node.apiSource?.jsSource).toBe(jsSource().jsSource);

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("\"mappingMode\":\"js\"");
		expect(persistedJson).toContain("response.map");
	});

	it("a drag-mode source has no mappingMode/jsSource at all", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, jsSource({ mappingMode: undefined, jsSource: undefined }));

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.apiSource?.mappingMode).toBeUndefined();
		expect(node.apiSource?.jsSource).toBeUndefined();
	});
});

describe("Loading a persisted js-mode source (sanitizeApiFields) — G3: valid on jsSource, not drag mapping", () => {
	function nodeWithApiSource(overrides: Partial<ViewNode> = {}): ViewNode {
		return { id: "n1", type: "meta", label: "API folder", children: [], apiSource: jsSource(), ...overrides };
	}

	function loadedNode(node: ViewNode): ViewNode {
		const views: View[] = [{ id: "v1", name: "V", root: [node], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		return vm.getNode("v1", "n1")!;
	}

	it("a well-formed js-mode source round-trips unchanged", () => {
		const sanitized = loadedNode(nodeWithApiSource());
		expect(sanitized.apiSource?.mappingMode).toBe("js");
		expect(sanitized.apiSource?.jsSource).toBe(jsSource().jsSource);
	});

	it("a js-mode source is kept even though its drag `mapping` was never touched (defaulted to empty fields)", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com", mappingMode: "js", jsSource: "(response) => []" } as unknown as ApiSourceConfig,
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeDefined();
		expect(sanitized.apiSource?.mappingMode).toBe("js");
		expect(sanitized.apiSource?.mapping).toEqual({ idField: "", labelField: "", secondaryField: undefined, arrayField: undefined });
	});

	it("a js-mode source with a non-string jsSource is dropped entirely (not usable)", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com", mapping: { idField: "id", labelField: "name" }, mappingMode: "js", jsSource: 12345 } as unknown as ApiSourceConfig,
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeUndefined();
	});

	it("switching mappingMode back to drag on load keeps whatever drag mapping was last set, jsSource retained as-is", () => {
		const node = nodeWithApiSource({
			apiSource: { ...jsSource(), mappingMode: undefined, mapping: { idField: "id", labelField: "name" } },
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource?.mappingMode).toBeUndefined();
		expect(sanitized.apiSource?.mapping).toEqual({ idField: "id", labelField: "name", secondaryField: undefined, arrayField: undefined });
		// jsSource is retained (not cleared) so switching back to js in the modal restores it.
		expect(sanitized.apiSource?.jsSource).toBe(jsSource().jsSource);
	});

	it("a drag-mode source (no mappingMode) with no mapping object at all is still dropped, same as before PR-4", () => {
		const node = nodeWithApiSource({
			apiSource: { url: "https://api.example.com" } as unknown as ApiSourceConfig,
		});
		const sanitized = loadedNode(node);
		expect(sanitized.apiSource).toBeUndefined();
	});
});

describe("Cache shape is unchanged by JS mode — G3: fetchedAt/ok/error/rows/skippedCount/truncated/lastSuccessAt", () => {
	it("a js-mode node's apiCache has the exact same shape as a drag-mode node's", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, jsSource());

		const node = vm.getNode(view.id, folder.id)!;
		node.apiCache = {
			fetchedAt: 123,
			ok: true,
			error: null,
			rows: [{ id: "1", label: "One", extra: { count: 1 } }],
			skippedCount: 0,
			truncated: false,
			lastSuccessAt: 123,
		};

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("\"fetchedAt\":123");
		expect(persistedJson).toContain("\"extra\":{\"count\":1}");
	});
});
