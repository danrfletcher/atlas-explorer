import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { MarkdownTableSourceController } from "../../src/markdown-table-source-controller";
import { MarkdownTableSourceConfig, ViewNode } from "../../src/types";

function makeNode(id: string): ViewNode {
	return { id, type: "meta", label: "Markdown table folder", children: [] };
}

function baseSource(path: string, overrides: Partial<MarkdownTableSourceConfig> = {}): MarkdownTableSourceConfig {
	return {
		path,
		tableIndex: 0,
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		...overrides,
	};
}

describe("MarkdownTableSourceController — integration: save-triggered refresh (reuses the existing refresh-toggle plumbing, no new refresh UI)", () => {
	it("saving the watched .md file triggers a re-parse that picks up the new rows, via the same vault 'modify' event CSV's own refresh uses", async () => {
		const app = new App();
		const file = await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();
		let persisted = 0;
		const refresh = (trigger: "manual" | "automatic") =>
			controller.refresh(node, baseSource("table.md"), () => persisted++, { vault: app.vault, now: () => 1000, trigger });

		await refresh("manual");
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }]);

		let pending: Promise<void> = Promise.resolve();
		app.vault.on("modify", () => {
			pending = refresh("automatic");
		});
		await app.vault.modify(file, "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n");
		await pending; // the file-save-triggered automatic refresh

		expect(node.apiCache?.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
	});

	it("a save that changes which table lives at the configured index is read as-is on the next refresh — no drift detection (G24/F9)", async () => {
		const app = new App();
		const file = await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();
		const refresh = () => controller.refresh(node, baseSource("table.md", { tableIndex: 0 }), () => {}, { vault: app.vault, now: () => 1000 });

		await refresh();
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }]);

		// A new table is inserted before the configured index 0.
		await app.vault.modify(
			file,
			"| id | name |\n|---|---|\n| a | Widget |\n\n| id | name |\n|---|---|\n| 1 | One |\n"
		);
		await refresh();

		// Index 0 now points at the newly-inserted table — read silently, no error/warning.
		expect(node.apiCache?.ok).toBe(true);
		expect(node.apiCache?.rows).toEqual([{ id: "a", label: "Widget" }]);
	});

	it("PR-1 R4: a refresh that finds the table unchanged reports changed=false, so the caller can skip persisting", async () => {
		const app = new App();
		await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n");
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();
		const changes: boolean[] = [];
		const refresh = (now: number) =>
			controller.refresh(node, baseSource("table.md"), (changed) => changes.push(changed), { vault: app.vault, now: () => now });

		await refresh(1000);
		expect(changes).toEqual([true]); // first refresh always moves apiCache.ok from undefined to true

		await refresh(2000);
		expect(changes).toEqual([true, false]); // same rows/itemState/order the second time — nothing to persist
	});
});
