import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { ViewNode } from "../../src/types";

/** PR-1 (G2): the Folder, CSV and markdown-table sanitizers silently drop the three removed refresh
 * fields on load. Driven through the `ViewsManager` constructor, which is the public path that runs
 * `sanitizeViewsApiFields` over every view's nodes. */

const REMOVED_FIELDS = ["refreshEveryMinutesEnabled", "refreshEveryMinutes", "refreshOnViewLoad"] as const;

const legacyPresent: Record<string, unknown> = { refreshEveryMinutesEnabled: true, refreshEveryMinutes: 5, refreshOnViewLoad: true };
const legacyAbsent: Record<string, unknown> = {};
const legacyMalformed: Record<string, unknown> = {
	refreshEveryMinutesEnabled: "yes",
	refreshEveryMinutes: "soon",
	refreshOnViewLoad: null,
};
const legacyNaN: Record<string, unknown> = { refreshEveryMinutes: Number.NaN, refreshEveryMinutesEnabled: 1 };

const cases: Array<{ name: string; legacy: Record<string, unknown> }> = [
	{ name: "legacy fields present", legacy: legacyPresent },
	{ name: "legacy fields absent", legacy: legacyAbsent },
	{ name: "legacy fields malformed", legacy: legacyMalformed },
	{ name: "legacy fields NaN or wrong type", legacy: legacyNaN },
];

const mapping = { idField: "id", labelField: "label" };

/** A saved meta node whose source config carries the legacy fields, as a pre-PR-1 `data.json` would. */
function metaWith(configKey: "folderSource" | "csvSource" | "markdownTableSource", config: Record<string, unknown>, legacy: Record<string, unknown>): ViewNode {
	return { id: "n1", type: "meta", label: "Source", children: [], [configKey]: { ...config, ...legacy } } as ViewNode;
}

function loadNode(node: ViewNode): ViewNode {
	const views = [{ id: "v1", name: "v1", root: [node], inboxMode: "view" as const }];
	const vm = new ViewsManager({} as App, views, "v1", vi.fn());
	const loaded = vm.getNode("v1", "n1");
	if (!loaded) throw new Error("node was not loaded");
	return loaded;
}

function expectNoRemovedFields(config: object | undefined): void {
	expect(config).toBeDefined();
	for (const field of REMOVED_FIELDS) expect(config).not.toHaveProperty(field);
}

describe("PR-1 (G2): sanitizers drop the removed refresh fields on load", () => {
	describe.each(cases)("$name", ({ legacy }) => {
		it("Folder source loads without the removed fields and keeps its real settings", () => {
			const node = loadNode(
				metaWith(
					"folderSource",
					{ location: "inside", path: "Projects", showFiles: true, showFolders: false, mode: "append" },
					legacy
				)
			);
			expectNoRemovedFields(node.folderSource);
			expect(node.folderSource).toMatchObject({ location: "inside", path: "Projects", showFiles: true, showFolders: false, mode: "append" });
		});

		it("CSV source loads without the removed fields and keeps its real settings", () => {
			const node = loadNode(metaWith("csvSource", { path: "data.csv", mapping, mode: "merge" }, legacy));
			expectNoRemovedFields(node.csvSource);
			expect(node.csvSource).toMatchObject({ path: "data.csv", mode: "merge" });
		});

		it("markdown-table source loads without the removed fields and keeps its real settings", () => {
			const node = loadNode(
				metaWith("markdownTableSource", { path: "table.md", tableIndex: 0, mapping, mode: "overwrite" }, legacy)
			);
			expectNoRemovedFields(node.markdownTableSource);
			expect(node.markdownTableSource).toMatchObject({ path: "table.md", tableIndex: 0, mode: "overwrite" });
		});
	});

	it("a malformed legacy value never makes a Folder source fail to load", () => {
		expect(() =>
			loadNode(metaWith("folderSource", { location: "inside", path: "Projects", showFiles: true, showFolders: true }, legacyMalformed))
		).not.toThrow();
	});
});
