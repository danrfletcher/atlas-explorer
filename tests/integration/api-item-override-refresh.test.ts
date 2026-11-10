import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ApiSourceController } from "../../src/api-source-controller";
import { CsvSourceController } from "../../src/csv-source-controller";
import { RequestFn } from "../../src/api-http";
import { ApiItemClickAction, ApiSourceConfig, CsvSourceConfig, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";

/** Atlas-18 E14/E16: what an API refresh does to an Item override. Runs the real `ApiSourceController` and
 * `CsvSourceController` refresh (with the repo's sample-api fixture served by a stub request function) and the
 * real `ViewsManager` for the removed-source and reload cases. Rows are Docker 4.34 and git, as in the spec. */

const sample = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "sample-api.json"), "utf8")) as { id: string; name: string }[];
const DOCKER = sample[0];
const GIT = sample[1];

const URI: ApiItemClickAction = { kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" };
const NONE: ApiItemClickAction = { kind: "none" };

/** A request function that answers every GET with `rows`. */
const serving = (rows: { id: string; name: string }[]): RequestFn => async () => ({ status: 200, text: JSON.stringify(rows) });

const source = (mode: ApiSourceConfig["mode"]): ApiSourceConfig => ({
	url: "https://api.example.com/apps",
	method: "GET",
	mapping: { idField: "id", labelField: "name" },
	mode,
	refreshOnViewLoad: false,
	confirmBeforeDelete: false,
	keepOnEmpty: false,
});

/** A Folder already holding both sample rows, each with an Item override. */
function nodeWithOverrides(): ViewNode {
	return {
		id: "apps",
		type: "meta",
		label: "Apps",
		children: [],
		apiItemOrder: [DOCKER.id, GIT.id],
		apiItemState: {
			[DOCKER.id]: { id: DOCKER.id, label: DOCKER.name, kind: PLACEHOLDER_ROW_KIND, clickAction: { ...URI }, lastSeenAt: "2026-11-01T00:00:00.000Z" },
			[GIT.id]: { id: GIT.id, label: GIT.name, kind: PLACEHOLDER_ROW_KIND, clickAction: { ...NONE }, lastSeenAt: "2026-11-01T00:00:00.000Z" },
		},
	};
}

async function refresh(node: ViewNode, mode: ApiSourceConfig["mode"], rows: { id: string; name: string }[]): Promise<void> {
	await new ApiSourceController().refresh(node, source(mode), [], () => {}, { requestImpl: serving(rows) });
	expect(node.apiCache?.ok).toBe(true);
}

describe("E14 Overwrite: a row that vanishes loses its whole apiItemState entry, override included", () => {
	it("drops the vanished row and its override; the surviving row keeps its own", async () => {
		const node = nodeWithOverrides();
		await refresh(node, "overwrite", [GIT]);
		expect(Object.keys(node.apiItemState!)).toEqual([GIT.id]);
		expect(node.apiItemState![DOCKER.id]).toBeUndefined();
		expect(node.apiItemState![GIT.id].clickAction).toEqual(NONE);
		expect(node.apiItemOrder).toEqual([GIT.id]);
	});

	it("a row that returns later starts fresh, with no override", async () => {
		const node = nodeWithOverrides();
		await refresh(node, "overwrite", [GIT]);
		await refresh(node, "overwrite", [DOCKER, GIT]);
		const returned = node.apiItemState![DOCKER.id];
		expect(returned).toBeDefined();
		expect("clickAction" in returned).toBe(false);
		expect(JSON.stringify(returned)).not.toContain("obsidian://");
		expect(node.apiItemState![GIT.id].clickAction).toEqual(NONE);
	});
});

describe("E14 Merge: the override stays", () => {
	it("a row still reported keeps its override, while label and last-seen follow the API", async () => {
		const node = nodeWithOverrides();
		await refresh(node, "merge", [{ id: DOCKER.id, name: "Docker 4.35" }, GIT]);
		expect(node.apiItemState![DOCKER.id].label).toBe("Docker 4.35");
		expect(node.apiItemState![DOCKER.id].clickAction).toEqual(URI);
		expect(node.apiItemState![GIT.id].clickAction).toEqual(NONE);
	});

	it("a row that turns not found keeps its override (it still runs it), and keeps it when it returns", async () => {
		const node = nodeWithOverrides();
		await refresh(node, "merge", [GIT]);
		expect(node.apiItemState![DOCKER.id].notFound).toBe(true);
		expect(node.apiItemState![DOCKER.id].clickAction).toEqual(URI);
		expect(node.apiItemOrder).toContain(DOCKER.id);

		await refresh(node, "merge", [DOCKER, GIT]);
		expect(node.apiItemState![DOCKER.id].notFound).toBe(false);
		expect(node.apiItemState![DOCKER.id].clickAction).toEqual(URI);
	});

	it("Append mode keeps it too", async () => {
		const node = nodeWithOverrides();
		await refresh(node, "append", [GIT]);
		expect(node.apiItemState![DOCKER.id].clickAction).toEqual(URI);
	});
});

describe("E16: an override under a removed source, or on a CSV row, is kept in data.json", () => {
	const roundTrip = (views: ViewsManager): ViewsManager => new ViewsManager(new App(), JSON.parse(JSON.stringify(views.getViews())), views.getViews()[0].id, () => {});

	it("Remove data source leaves the rows and their overrides stored, and a reload keeps them", () => {
		const views = new ViewsManager(new App(), [{ id: "v1", name: "Default", inboxMode: "view", root: [{ ...nodeWithOverrides(), apiSource: source("merge") }] }], "v1", () => {});
		views.setApiSource("v1", "apps", undefined);
		const afterRemoval = views.getNode("v1", "apps")!;
		expect(afterRemoval.apiSource).toBeUndefined();
		expect(afterRemoval.apiItemState![DOCKER.id].clickAction).toEqual(URI);
		expect(afterRemoval.apiItemState![GIT.id].clickAction).toEqual(NONE);

		const reloaded = roundTrip(views).getNode("v1", "apps")!;
		expect(reloaded.apiItemState![DOCKER.id].clickAction).toEqual(URI);
		expect(reloaded.apiItemState![GIT.id].clickAction).toEqual(NONE);
	});

	it("a CSV refresh keeps an override on a surviving row, and a CSV row with an override survives a reload", async () => {
		const app = new App();
		await app.vault.create("apps.csv", `id,name\n${DOCKER.id},${DOCKER.name}\n${GIT.id},${GIT.name}\n`);
		const node: ViewNode = { id: "apps", type: "meta", label: "Apps", children: [] };
		const csv: CsvSourceConfig = { path: "apps.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" };
		const controller = new CsvSourceController();
		await controller.refresh(node, csv, () => {}, { vault: app.vault, now: () => 1000 });
		node.apiItemState![DOCKER.id].clickAction = { ...URI };

		await controller.refresh(node, csv, () => {}, { vault: app.vault, now: () => 2000 });
		expect(node.apiItemState![DOCKER.id].clickAction).toEqual(URI);

		const views = new ViewsManager(new App(), [{ id: "v1", name: "Default", inboxMode: "view", root: [{ ...node, csvSource: csv }] }], "v1", () => {});
		expect(roundTrip(views).getNode("v1", "apps")!.apiItemState![DOCKER.id].clickAction).toEqual(URI);
	});
});
