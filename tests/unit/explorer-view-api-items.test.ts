import { describe, expect, it, vi } from "vitest";
import { ApiItemState } from "../../src/types";
import {
	callRenderApiItemRow,
	callRenderNodeList,
	folderGovernor,
	makeFakeExplorer,
	makeStatusesManager,
	proto,
	realNode,
	rowOrder,
	view,
} from "./explorer-view-sort-truncate-helpers";

describe("G25 — regression: renderApiItemRow output is unchanged by the merged sort/truncate pass", () => {
	it("row content/icon/click wiring is byte-identical called directly vs. via the merged renderNodeList path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "My Item", secondary: "extra", explicitStatusId: "doing" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
	});

	it("a 'not found' item's last-seen text and icon are unchanged via the merged path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "Gone", explicitStatusId: "todo", notFound: true, lastSeenAt: "2026-09-25T10:00:00.000Z" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
		expect(mergedContainer.textContent).toContain("not found, last seen 2026-09-25");
	});

	it("an item with no explicit status falls back to the fallback 'plug' icon identically via either path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ statusEnabled: false, statusSetId: undefined, sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "No status" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
	});
});

describe("PR-6 R3 fix: a Folder-source-demoted row renders back at its recorded position among real children", () => {
	it("a row demoted from the middle slot re-renders between the two real children that were either side of it", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demoted: ApiItemState = { id: "demoted-b", label: "b", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 1 };
		folder.apiItemState = { "demoted-b": demoted };
		folder.apiItemOrder = ["demoted-b"];
		const realChildren = [realNode("a-real"), realNode("c-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "demoted-b", "c-real"]);
	});

	it("a genuine API row (no folderSourceDeleted marker) still always renders after every real child, unaffected by this fix", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const genuine: ApiItemState = { id: "api-1", label: "Genuine API row" };
		folder.apiItemState = { "api-1": genuine };
		folder.apiItemOrder = ["api-1"];
		const realChildren = [realNode("a-real"), realNode("c-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "c-real", "api-1"]);
	});

	it("a position past the end of the current real children clamps to the end instead of throwing or dropping the row", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demoted: ApiItemState = { id: "demoted-z", label: "z", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 99 };
		folder.apiItemState = { "demoted-z": demoted };
		folder.apiItemOrder = ["demoted-z"];
		const realChildren = [realNode("a-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "demoted-z"]);
	});
});

// PR-1 (G11d/G11c/E-b): a sourced unit gets the same filter bypass as an Atlas folder, and a unit's
// rows come from `apiOwner`, not only from a meta node.
describe("PR-1 G11d — the filter bypass shows a sourced unit when one of its rows matches", () => {
	const apiSource = { url: "https://x", method: "GET" as const, mapping: { idField: "id", labelField: "name" }, mode: "merge" as const, refreshOnViewLoad: false };

	it("a unit whose API row matches the filter is handed to renderNode (bypass path)", async () => {
		const sm = makeStatusesManager();
		const sourced = realNode("sourced-unit", {
			ref: { kind: "file", path: "Linear.md" },
			apiSource,
			apiItemState: { "api-1": { id: "api-1", label: "Zed bug", explicitStatusId: "todo" } },
			apiItemOrder: ["api-1"],
		} as Partial<ViewNode>);
		const plain = realNode("plain-unit", { ref: { kind: "file", path: "Other.md" } } as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, {
			filterText: "zed",
			resolveRef: vi.fn((ref: { path: string }) => ({ text: ref.path })),
			apiItemsMatchFilter: proto.apiItemsMatchFilter,
			matchesFilter: proto.matchesFilter,
			pseudoNodeForApiItem: proto.pseudoNodeForApiItem,
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [plain, sourced], container, view, 0, []);
		const shown = Array.from(container.querySelectorAll("[data-id]")).map((el) => (el as HTMLElement).dataset.id);
		expect(shown).toContain("sourced-unit");
	});
});

describe("PR-1 E-b — a unit with neither source nor children draws no row container", () => {
	it("apiItemsMatchFilter is false for a unit with no rows, so it is never bypassed", () => {
		const sm = makeStatusesManager();
		const fake = makeFakeExplorer(sm, { filterText: "zed", apiItemsMatchFilter: proto.apiItemsMatchFilter });
		expect(fake.apiItemsMatchFilter(realNode("bare", { ref: { kind: "file", path: "B.md" } } as Partial<ViewNode>))).toBe(false);
	});
});

describe("PR-1 G11c — a unit with source rows renders them via apiOwner, with no children", () => {
	it("passing a unit as apiOwner draws each of its rows, in apiItemOrder", async () => {
		const sm = makeStatusesManager();
		const unit = realNode("unit-owner", {
			ref: { kind: "file", path: "Linear.md" },
			apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false },
			apiItemState: {
				a: { id: "a", label: "A", explicitStatusId: "todo" },
				b: { id: "b", label: "B", explicitStatusId: "todo" },
			},
			apiItemOrder: ["b", "a"],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		const text = container.textContent ?? "";
		expect(text).toContain("A");
		expect(text).toContain("B");
		expect(text.indexOf("B")).toBeLessThan(text.indexOf("A"));
	});

	it("E-b: a source with zero rows and no children draws no empty container", async () => {
		const sm = makeStatusesManager();
		const unit = realNode("empty-owner", {
			ref: { kind: "file", path: "Empty.md" },
			apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false },
			apiItemState: {},
			apiItemOrder: [],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		expect(container.children).toHaveLength(0);
	});
});

// PR-1 (G11c, T1/T4): a unit whose rows came from a CSV or markdown-table source renders them through
// `apiOwner` exactly as an API unit does — all three source kinds store their rows in `apiItemState`/`apiItemOrder`.
describe("PR-1 G11c — a unit with CSV or markdown-table rows renders them via apiOwner", () => {
	const mapping = { idField: "id", labelField: "name" };
	const sourceKinds: { kind: string; source: Partial<ViewNode> }[] = [
		{ kind: "API", source: { apiSource: { url: "https://x", method: "GET", mapping, mode: "merge", refreshOnViewLoad: false } } },
		{ kind: "CSV", source: { csvSource: { path: "Rows.csv", mapping, mode: "merge", refreshOnViewLoad: false } } },
		{
			kind: "markdown-table",
			source: { markdownTableSource: { path: "Rows.md", tableIndex: 0, mapping, mode: "merge", refreshOnViewLoad: false } },
		},
	];

	it.each(sourceKinds)("a unit holding a $kind source draws each of its rows, in apiItemOrder", async ({ source }) => {
		const sm = makeStatusesManager();
		const unit = realNode("unit-owner", {
			ref: { kind: "file", path: "Rows.md" },
			...source,
			apiItemState: {
				a: { id: "a", label: "Alpha row", explicitStatusId: "todo" },
				b: { id: "b", label: "Bravo row", explicitStatusId: "doing" },
			},
			apiItemOrder: ["b", "a"],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		const text = container.textContent ?? "";
		expect(text).toContain("Alpha row");
		expect(text).toContain("Bravo row");
		expect(text.indexOf("Bravo row")).toBeLessThan(text.indexOf("Alpha row"));
	});

	it.each(sourceKinds)("a unit holding a $kind source with zero rows draws no row container", async ({ source }) => {
		const sm = makeStatusesManager();
		const unit = realNode("empty-unit", {
			ref: { kind: "file", path: "Empty.md" },
			...source,
			apiItemState: {},
			apiItemOrder: [],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		expect(container.children).toHaveLength(0);
	});
});
