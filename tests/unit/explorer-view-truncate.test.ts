import { describe, expect, it, vi } from "vitest";
import { ApiItemState } from "../../src/types";
import { basenameRowInfo, callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, proto, realNode, rowOrder, useRealRenderNode, view } from "./explorer-view-sort-truncate-helpers";

function apiItem(id: string, explicitStatusId?: string): ApiItemState {
	return { id, label: id, explicitStatusId };
}

describe("G25 — truncate: API item rows share the one truncation-group count real units get", () => {
	it("a truncated status shared by one real unit and one API item groups them into a single '2 X' header", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
		expect(fake.renderTruncationGroupHeader).toHaveBeenCalledTimes(1);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2); // count
		expect(fake.renderNode).not.toHaveBeenCalled();
		expect(fake.renderApiItemRow).not.toHaveBeenCalled();
	});

	it("a status used only by API items still truncates once 2+ API items share it", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { doing: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "doing") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" }); // different status, untouched

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "group:node:folder:doing"]);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});

	it("a status used only by real units still truncates once 2+ real units share it, API items untouched", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { done: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "done" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:done", "api-1"]);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});

	it("expanding the group reveals both real units and API items together, in sorted order", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		fake.expandedTruncationGroups.add("node:folder:todo");
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo", "real-1", "api-1"]);
	});

	it("hideCompleted wins outright over truncation and excludes both real units and API items from the count", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ hideCompleted: true, truncatedStatuses: { done: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "done"), "api-2": apiItem("api-2", "done") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-2"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("hideCancelled behaves the same way for API items as it does for real units", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ hideCancelled: true });
		folder.apiItemState = { "api-1": apiItem("api-1", "cancelled") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "cancelled" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-2"]);
	});

	it("a status absent from truncatedStatuses config falls back to always-shown for both unit kinds", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { done: { enabled: true } } }); // "todo" not configured
		folder.apiItemState = { "api-1": apiItem("api-1", "todo"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "real-2", "api-1", "api-2"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("a single matching item (no sibling sharing the status) never collapses into a group of one", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "api-1"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("a stale apiItemOrder id degrades gracefully and does not corrupt the group count", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1", "ghost-id"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});
});

// PR-2.F3 (G10) regression: the "Add under…" hidden-row helper decides whether a new row rendered
// by looking for an element carrying `data-select-key="<node id>"` in the bucket's DOM. These run the
// REAL `renderNode` (it is what sets that attribute), so the check is tied to the attribute the
// helper queries rather than to a marker a stub invented.
describe("PR-2.F3 (G10) regression — a node folded into a truncated group has no data-select-key element, matching the hidden-row helper's own DOM check", () => {
	it("the third same-status sibling (standing in for one just added under the group) yields no data-select-key element, while a visible sibling does", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { ref: { kind: "file", path: "R1.md" }, explicitStatusId: "todo" });
		const real2 = realNode("real-2", { ref: { kind: "file", path: "R2.md" }, explicitStatusId: "todo" }); // stands in for the newly added-under row
		const other = realNode("other", { ref: { kind: "file", path: "Other.md" }, explicitStatusId: "doing" }); // positive control: renders normally

		const fake = makeFakeExplorer(sm, { resolveRef: basenameRowInfo });
		useRealRenderNode(fake);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2, other], container, view, 1, [folder], folder);

		expect(container.querySelector("[data-select-key]")).not.toBeNull();
		expect(container.querySelector('[data-select-key="other"]')).not.toBeNull();
		expect(container.querySelector('[data-select-key="real-1"]')).toBeNull();
		expect(container.querySelector('[data-select-key="real-2"]')).toBeNull();
		expect(fake.renderNode).toHaveBeenCalledTimes(1); // only "other" was ever handed to renderNode
	});
});


// PR-1 (R1 fix, G17): A-Z/Modified/Time added run before hide and truncate, so a truncation
// placeholder lands at its first member's SORTED position, not its build-order position, and a
// filter match keeps following the sort even while it bypasses hide/truncate outright.
describe("PR-1 G17 — the direct sort modes (alphabetical/modified/time-added) run before hide and truncate", () => {
	it("the truncation placeholder lands at its first member's sorted position, not its build position", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical", truncatedStatuses: { todo: { enabled: true } } });
		// Build order: zebra, mango, apple. Alphabetical order: apple, mango, zebra.
		const zebra = realNode("zebra", { ref: { kind: "file", path: "Z.md" }, explicitStatusId: "todo" });
		const mango = realNode("mango", { ref: { kind: "file", path: "M.md" }, explicitStatusId: "done" });
		const apple = realNode("apple", { ref: { kind: "file", path: "A.md" }, explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "Z.md" ? "Zebra" : ref.path === "M.md" ? "Mango" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [zebra, mango, apple], container, view, 1, [folder]);

		// Sorted order is apple(todo), mango(done), zebra(todo). apple and zebra share "todo"
		// (truncated, count 2); apple is first in the SORTED iteration, so the group header renders
		// at apple's slot (before mango) — if truncate ran before sort (or on build order), the
		// group would instead land at zebra's build-order slot, after mango.
		expect(rowOrder(container)).toEqual(["group:node:folder:todo", "mango"]);
	});

	it("a filter match still follows the folder's sort order, not its build order, even while bypassing truncate", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		// Build order: zebra, apple — both carry "a" so both bypass the filter.
		const zebra = realNode("zebra", { ref: { kind: "file", path: "Z.md" } });
		const apple = realNode("apple", { ref: { kind: "file", path: "A.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "Z.md" ? "Zebra" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		fake.filterText = "a"; // matches both "Zebra" and "Apple"
		const container = document.createElement("div");
		await callRenderNodeList(fake, [zebra, apple], container, view, 1, [folder]);

		// Both rows bypass hide/truncate (filter match), but still render in sorted order, not the
		// zebra-then-apple build order.
		expect(rowOrder(container)).toEqual(["apple", "zebra"]);
	});
});

// PR-4 (T1/T5/C30 fix): G20 — a truncation-group placeholder row has no edge zone at all; the
// new sorted-drop gating lives entirely inside `makeDropZone`'s own dragover/drop closures
// (explorer-view.ts), which `renderTruncationGroupHeader` never calls, sorted folder or not.
// Drives the real (unstubbed) group header through the real merged sort/truncate pass and
// confirms a dragover at the row produces today's result: nothing at all (no line, no outline,
// not draggable).
describe("PR-4 G20 — a truncation-group placeholder row takes no edge drops, whether or not its owning folder is sorted", () => {
	it("a real group header rendered under a sorted (A-Z) folder is never draggable and ignores a dragover at its own top/bottom edge", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical", truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm, { renderTruncationGroupHeader: vi.fn(proto.renderTruncationGroupHeader as (...a: unknown[]) => void) });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder]);

		const row = container.querySelector(".atlas-truncation-row") as HTMLElement;
		expect(row).toBeTruthy();
		expect(row.getAttribute("draggable")).toBeNull(); // never made draggable, unaffected by sort

		for (const clientY of [5, 50, 95]) {
			row.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }));
		}
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(false);
		expect(row.classList.contains("atlas-drop-target")).toBe(false);
	});
});
