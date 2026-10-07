import { describe, expect, it } from "vitest";
import { ViewsManager, resolveClickAction, resolveExtraFields } from "../../src/views";
import { ApiSourceConfig, View, ViewNode } from "../../src/types";
import type { App } from "obsidian";

function makePr2Source(): ApiSourceConfig {
	return {
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
	};
}

describe("source-migration — G9b/PR-5: PR-2 sources load with action = open attachment and empty extras", () => {
	it("PR-2 sources load with action = open attachment and empty extras", () => {
		const pr2Source = makePr2Source();
		const node: ViewNode = {
			id: "node-1",
			type: "meta",
			label: "Mac Apps",
			children: [],
			apiSource: pr2Source,
			apiCache: {
				fetchedAt: Date.now(),
				ok: true,
				error: null,
				rows: [
					{ id: "docker", label: "Docker" },
				],
				skippedCount: 0,
				truncated: false,
			},
		};

		const views: View[] = [{ id: "v1", name: "Default", root: [node], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		const loaded = vm.getNode("v1", "node-1");

		expect(loaded).toBeDefined();
		expect(loaded?.apiSource).toBeDefined();

		// Effective click action resolves to "open-attachment"
		const action = resolveClickAction(loaded?.apiSource);
		expect(action).toBe("open-attachment");

		// Effective extra fields resolve to empty
		const extras = resolveExtraFields(loaded?.apiSource?.mapping);
		expect(extras).toEqual({});

		// Cached rows without extra fields are preserved
		const cachedRow = loaded?.apiCache?.rows[0];
		expect(cachedRow?.id).toBe("docker");
		expect(cachedRow?.extra).toBeUndefined();
	});

	it("preserves explicit action and extraFields when present", () => {
		const pr5Source: ApiSourceConfig = {
			url: "https://api.example.com/items",
			method: "GET",
			mapping: {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path" },
			},
			mode: "merge",
			action: "run-command",
			command: "record-args {path}",
		};

		const node: ViewNode = {
			id: "node-2",
			type: "meta",
			label: "CLI",
			children: [],
			apiSource: pr5Source,
		};

		const views: View[] = [{ id: "v1", name: "Default", root: [node], inboxMode: "view" }];
		const vm = new ViewsManager({} as App, views, "v1", () => {});
		const loaded = vm.getNode("v1", "node-2");

		expect(resolveClickAction(loaded?.apiSource)).toBe("run-command");
		expect(loaded?.apiSource?.action).toBe("run-command");
		expect(loaded?.apiSource?.command).toBe("record-args {path}");
		expect(resolveExtraFields(loaded?.apiSource?.mapping)).toEqual({ path: "raw_path" });
	});
});
