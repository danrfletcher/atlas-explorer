import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { mapSampleRows, mapResponseRows } from "../../src/api-mapping";
import { detectMarkdownTables, selectMarkdownTable } from "../../src/markdown-table-mapping";
import { MarkdownTableSourceController } from "../../src/markdown-table-source-controller";
import { dotStateFor } from "../../src/api-source-controller";
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

describe("markdown table rows — mapping-reuse rule", () => {
	it("a parsed table's plain-object rows feed mapSampleRows and produce the same kind of ApiMappedRow[] shape an API/CSV source would, under the same mapping", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n";
		const tables = detectMarkdownTables(text);
		const table = selectMarkdownTable(tables, 0);
		const mapping = { idField: "id", labelField: "name" };

		const fromMarkdown = mapSampleRows(table.rows, mapping);
		const fromApiLikeResponse = mapSampleRows(
			[
				{ id: "1", name: "One" },
				{ id: "2", name: "Two" },
			],
			mapping
		);

		expect(fromMarkdown.rows).toEqual(fromApiLikeResponse.rows);
		expect(fromMarkdown.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
	});

	it("mapResponseRows (used by the refresh controller) produces the identical row shape for the same parsed rows and mapping", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n";
		const table = selectMarkdownTable(detectMarkdownTables(text), 0);
		const mapping = { idField: "id", labelField: "name" };
		const result = mapResponseRows(table.rows, mapping);
		expect("error" in result).toBe(false);
		if (!("error" in result)) {
			expect(result.rows).toEqual([{ id: "1", label: "One" }]);
		}
	});
});

describe("MarkdownTableSourceController — missing-file rule (G23/E4)", () => {
	it("deleting the backing .md file after setup causes the same 'missing' apiCache state a dead API URL/missing CSV file would, reusing the same flag", async () => {
		const app = new App();
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();
		let persisted = 0;
		await controller.refresh(node, baseSource("missing.md"), () => persisted++, { vault: app.vault, now: () => 1000 });

		expect(persisted).toBe(1);
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toContain("missing.md");
		expect(dotStateFor(node.apiCache)).toBe("red");
	});

	it("a file that existed, was successfully read, and is then deleted reports the same missing state on the next refresh", async () => {
		const app = new App();
		const file = await app.vault.create("table.md", "| id | name |\n|---|---|\n| 1 | One |\n");
		const node = makeNode("n1");
		const controller = new MarkdownTableSourceController();

		await controller.refresh(node, baseSource("table.md"), () => {}, { vault: app.vault, now: () => 1000 });
		expect(node.apiCache?.ok).toBe(true);

		await app.vault.delete(file);
		await controller.refresh(node, baseSource("table.md"), () => {}, { vault: app.vault, now: () => 2000 });
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toContain("table.md");
	});
});
