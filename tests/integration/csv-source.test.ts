import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { CsvSourceController } from "../../src/csv-source-controller";
import { dotStateFor } from "../../src/api-source-controller";
import { CsvSourceConfig, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

function makeNode(id: string): ViewNode {
	return { id, type: "meta", label: "CSV folder", children: [] };
}

function baseSource(path: string, overrides: Partial<CsvSourceConfig> = {}): CsvSourceConfig {
	return {
		path,
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		...overrides,
	};
}

describe("CsvSourceController — integration: create, map, render-ready state", () => {
	it("G17-G19: a successful refresh parses the file, maps rows through the unmodified mapping pipeline, and goes green", async () => {
		const app = new App();
		await app.vault.create("data.csv", "id,name\n1,One\n2,Two\n");
		const node = makeNode("n1");
		expect(dotStateFor(node.apiCache)).toBe("grey");

		const controller = new CsvSourceController();
		let persisted = 0;
		await controller.refresh(node, baseSource("data.csv"), () => persisted++, { vault: app.vault, now: () => 1000 });

		expect(persisted).toBe(1);
		expect(node.apiCache?.ok).toBe(true);
		expect(node.apiCache?.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
		expect(dotStateFor(node.apiCache)).toBe("green");
		expect(node.apiItemOrder).toEqual(["1", "2"]);
		expect(Object.keys(node.apiItemState ?? {})).toEqual(["1", "2"]);
	});

	it("R3(e)/G17: produced apiItemState rows carry the PLACEHOLDER_ROW_KIND tag, same as an API source's rows", async () => {
		const app = new App();
		await app.vault.create("data.csv", "id,name\n1,One\n2,Two\n");
		const node = makeNode("n1");
		const controller = new CsvSourceController();
		await controller.refresh(node, baseSource("data.csv"), () => {}, { vault: app.vault, now: () => 1000 });

		expect(node.apiItemState?.["1"].kind).toBe(PLACEHOLDER_ROW_KIND);
		expect(node.apiItemState?.["2"].kind).toBe(PLACEHOLDER_ROW_KIND);
	});

	it("R3(f)/G22: node.apiCache.skippedCount is the sum of parse-level and mapping-level skips, not just one of the two", async () => {
		const app = new App();
		// Parse-level skip: the over-long row "2,Two,extra" (R2 fix). Mapping-level skip: the blank-id
		// row "," never produces a valid id for `mapSampleRows` to keep (E2).
		await app.vault.create("data.csv", "id,name\n1,One\n2,Two,extra\n,Blank\n3,Three\n");
		const node = makeNode("n1");
		const controller = new CsvSourceController();
		await controller.refresh(node, baseSource("data.csv"), () => {}, { vault: app.vault, now: () => 1000 });

		expect(node.apiCache?.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "3", label: "Three" },
		]);
		expect(node.apiCache?.skippedCount).toBe(2);
	});

	it("G23/E4: a missing source file is reported the same way a dead API URL would be, never throwing", async () => {
		const app = new App();
		const node = makeNode("n1");
		const controller = new CsvSourceController();
		let persisted = 0;
		await controller.refresh(node, baseSource("missing.csv"), () => persisted++, { vault: app.vault, now: () => 1000 });

		expect(persisted).toBe(1);
		expect(node.apiCache?.ok).toBe(false);
		expect(node.apiCache?.error).toContain("missing.csv");
		expect(dotStateFor(node.apiCache)).toBe("red");
	});

	it("G21: a vault file-save (modify event) triggers a re-parse that picks up the new rows", async () => {
		const app = new App();
		const file = await app.vault.create("data.csv", "id,name\n1,One\n");
		const node = makeNode("n1");
		const controller = new CsvSourceController();
		let persisted = 0;
		const refresh = (trigger: "manual" | "automatic") =>
			controller.refresh(node, baseSource("data.csv"), () => persisted++, { vault: app.vault, now: () => 1000, trigger });

		await refresh("manual");
		expect(node.apiCache?.rows).toEqual([{ id: "1", label: "One" }]);

		let pending: Promise<void> = Promise.resolve();
		app.vault.on("modify", () => {
			pending = refresh("automatic");
		});
		await app.vault.modify(file, "id,name\n1,One\n2,Two\n");
		await pending; // the file-save-triggered automatic refresh

		expect(node.apiCache?.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
	});

	it("overwrite mode asks for confirmation before deleting rows, exactly as it does for an API source", async () => {
		const app = new App();
		const node = makeNode("n1");
		node.apiItemState = {
			"1": { id: "1", label: "One", kind: "placeholder", lastSeenAt: "2025-01-01T00:00:00.000Z" },
			"2": { id: "2", label: "Two", kind: "placeholder", lastSeenAt: "2025-01-01T00:00:00.000Z" },
		};
		node.apiItemOrder = ["1", "2"];
		await app.vault.create("data.csv", "id,name\n1,One\n");

		const controller = new CsvSourceController();
		const confirmedCounts: number[] = [];
		await controller.refresh(node, baseSource("data.csv", { mode: "overwrite" }), () => {}, {
			vault: app.vault,
			now: () => 2000,
			confirmDelete: async (count) => {
				confirmedCounts.push(count);
				return "confirmed";
			},
		});

		expect(confirmedCounts).toEqual([1]);
		expect(node.apiItemOrder).toEqual(["1"]);
	});

	it("PR-1 R4: a refresh that finds the file unchanged reports changed=false, so the caller can skip persisting", async () => {
		const app = new App();
		await app.vault.create("data.csv", "id,name\n1,One\n2,Two\n");
		const node = makeNode("n1");
		const controller = new CsvSourceController();
		const changes: boolean[] = [];
		const refresh = (now: number) => controller.refresh(node, baseSource("data.csv"), (changed) => changes.push(changed), { vault: app.vault, now: () => now });

		await refresh(1000);
		expect(changes).toEqual([true]); // first refresh always moves apiCache.ok from undefined to true

		await refresh(2000);
		expect(changes).toEqual([true, false]); // same rows/itemState/order the second time — nothing to persist
	});

	it("PR-1 R4: a refresh that actually changes the rows still reports changed=true", async () => {
		const app = new App();
		const file = await app.vault.create("data.csv", "id,name\n1,One\n");
		const node = makeNode("n1");
		const controller = new CsvSourceController();
		const changes: boolean[] = [];
		const refresh = (now: number) => controller.refresh(node, baseSource("data.csv"), (changed) => changes.push(changed), { vault: app.vault, now: () => now });

		await refresh(1000);
		await app.vault.modify(file, "id,name\n1,One\n2,Two\n");
		await refresh(2000);

		expect(changes).toEqual([true, true]);
		expect(node.apiCache?.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
	});
});
