import { describe, expect, it } from "vitest";
import { ApiSourceConfig, DataSourceConfig, DataSourceType } from "../../src/types";

describe("PR-3 — DataSourceConfig type discriminant", () => {
	it("config shape includes type discriminant and narrows correctly for api type", () => {
		const types: DataSourceType[] = ["api", "folder", "markdown-table", "csv"];
		expect(types).toEqual(["api", "folder", "markdown-table", "csv"]);

		const apiSource: ApiSourceConfig = {
			type: "api",
			url: "https://api.example.com/items",
			method: "GET",
			mapping: { idField: "id", labelField: "name" },
			mode: "merge",
		};

		const config: DataSourceConfig = apiSource;
		if (config.type === "api") {
			// Narrowed to ApiSourceConfig — its api-only fields are accessible without a cast.
			expect(config.url).toBe("https://api.example.com/items");
			expect(config.method).toBe("GET");
		} else {
			throw new Error("expected config.type to narrow to \"api\"");
		}

		// A pre-PR-3 config with no `type` at all still satisfies ApiSourceConfig (optional field) —
		// existing persisted sources without a type keep loading as before this PR.
		const legacyApiSource: ApiSourceConfig = {
			url: "https://legacy.example.com/items",
			method: "GET",
			mapping: { idField: "id", labelField: "name" },
			mode: "merge",
		};
		expect(legacyApiSource.type).toBeUndefined();

		// The stub sibling shapes carry only their own discriminant, as this PR intentionally leaves
		// them with no real config — PR-4 through PR-8 grow these into full shapes.
		const folderStub: DataSourceConfig = { type: "folder" };
		const tableStub: DataSourceConfig = { type: "markdown-table" };
		const csvStub: DataSourceConfig = { type: "csv" };
		expect(folderStub.type).toBe("folder");
		expect(tableStub.type).toBe("markdown-table");
		expect(csvStub.type).toBe("csv");
	});
});
