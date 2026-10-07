import { describe, expect, it } from "vitest";
import { mergeApiItems } from "../../src/api-merge";
import { planApiRefresh, RefreshPlanInput } from "../../src/api-refresh-plan";
import { ApiSourceController, ConfirmDeleteAnswer, dotStateFor } from "../../src/api-source-controller";
import { RequestFn } from "../../src/api-http";
import { ApiItemState, ApiMappedRow, ApiSourceConfig, ViewNode } from "../../src/types";

const NOW = "2026-01-01T00:00:00.000Z";

function row(id: string, label = `Row ${id}`): ApiMappedRow {
	return { id, label };
}

function state(id: string, overrides: Partial<ApiItemState> = {}): ApiItemState {
	return { id, label: `Row ${id}`, lastSeenAt: "2025-12-31T00:00:00.000Z", ...overrides };
}

describe("mergeApiItems — G6/G6c/E1: mode × response reconciliation", () => {
	it("append: a row no longer reported is kept exactly as it was, never marked", () => {
		const prevState = { "1": state("1"), "2": state("2") };
		const result = mergeApiItems(prevState, ["1", "2"], [row("1")], "append", { truncated: false, nowIso: NOW });
		expect(result.itemState["2"]).toEqual(prevState["2"]);
		expect(result.itemState["2"].notFound).toBeUndefined();
		expect(result.order).toEqual(["1", "2"]);
	});

	it("append: a new id in the response is simply added, in response order after existing kept rows", () => {
		const prevState = { "1": state("1") };
		const result = mergeApiItems(prevState, ["1"], [row("1"), row("2")], "append", { truncated: false, nowIso: NOW });
		expect(Object.keys(result.itemState).sort()).toEqual(["1", "2"]);
		expect(result.order).toEqual(["1", "2"]);
	});

	it("merge: a row no longer reported is kept and marked not-found, last-seen preserved from before", () => {
		const prevState = { "1": state("1"), "2": state("2", { lastSeenAt: "2025-06-01T00:00:00.000Z" }) };
		const result = mergeApiItems(prevState, ["1", "2"], [row("1")], "merge", { truncated: false, nowIso: NOW });
		expect(result.itemState["2"].notFound).toBe(true);
		expect(result.itemState["2"].lastSeenAt).toBe("2025-06-01T00:00:00.000Z");
	});

	it("merge: a row that reappears becomes normal again, with a fresh lastSeenAt", () => {
		const prevState = { "1": state("1", { notFound: true, lastSeenAt: "2025-06-01T00:00:00.000Z" }) };
		const result = mergeApiItems(prevState, ["1"], [row("1")], "merge", { truncated: false, nowIso: NOW });
		expect(result.itemState["1"].notFound).toBe(false);
		expect(result.itemState["1"].lastSeenAt).toBe(NOW);
	});

	it("merge: E4 truncated refresh never marks a merely-pushed-past-the-cap row not-found", () => {
		const prevState = { "1": state("1") };
		const result = mergeApiItems(prevState, ["1"], [], "merge", { truncated: true, nowIso: NOW });
		expect(result.itemState["1"]).toEqual(prevState["1"]);
		expect(result.itemState["1"].notFound).toBeUndefined();
	});

	it("overwrite (G6): a row no longer reported is dropped entirely, not just marked", () => {
		const prevState = { "1": state("1"), "2": state("2") };
		const result = mergeApiItems(prevState, ["1", "2"], [row("1")], "overwrite", { truncated: false, nowIso: NOW });
		expect(result.itemState).toEqual({ "1": { id: "1", label: "Row 1", secondary: undefined, notFound: false, lastSeenAt: NOW } });
		expect(result.order).toEqual(["1"]);
	});

	it("overwrite: E4 truncation exempts a row from deletion the same way merge does", () => {
		const prevState = { "1": state("1") };
		const result = mergeApiItems(prevState, ["1"], [], "overwrite", { truncated: true, nowIso: NOW });
		expect(result.itemState["1"]).toEqual(prevState["1"]);
		expect(result.order).toEqual(["1"]);
	});

	it("G6c: a row overwrite-deleted and later reappearing has no leftover notFound/state — it's a brand new row", () => {
		const prevState = { "1": state("1", { explicitStatusId: "done", notFound: false }) };
		const deleted = mergeApiItems(prevState, ["1"], [], "overwrite", { truncated: false, nowIso: NOW });
		expect(deleted.itemState).toEqual({});

		const reappeared = mergeApiItems(deleted.itemState, deleted.order, [row("1")], "overwrite", { truncated: false, nowIso: NOW });
		expect(reappeared.itemState["1"]).toEqual({ id: "1", label: "Row 1", kind: "placeholder", secondary: undefined, lastSeenAt: NOW });
		expect(reappeared.itemState["1"].explicitStatusId).toBeUndefined();
	});

	it("every mode: status and note are carried over untouched for a row still reported (G8/F5)", () => {
		for (const mode of ["append", "merge", "overwrite"] as const) {
			const prevState = { "1": state("1", { explicitStatusId: "in-progress", noteRef: { kind: "file" as const, path: "x.md" } }) };
			const result = mergeApiItems(prevState, ["1"], [row("1", "Updated label")], mode, { truncated: false, nowIso: NOW });
			expect(result.itemState["1"].explicitStatusId).toBe("in-progress");
			expect(result.itemState["1"].noteRef).toEqual({ kind: "file", path: "x.md" });
			expect(result.itemState["1"].label).toBe("Updated label");
		}
	});
});

describe("planApiRefresh — G6b guards decide whether a plan needs confirmation", () => {
	function plan(overrides: Partial<RefreshPlanInput>): ReturnType<typeof planApiRefresh> {
		return planApiRefresh({
			prevState: {},
			prevOrder: [],
			rows: [],
			mode: "overwrite",
			truncated: false,
			nowIso: NOW,
			keepOnEmpty: true,
			confirmBeforeDelete: true,
			...overrides,
		});
	}

	it("append/merge never need confirmation, regardless of guard settings", () => {
		const prevState = { "1": state("1") };
		for (const mode of ["append", "merge"] as const) {
			const result = plan({ mode, prevState, prevOrder: ["1"], rows: [] });
			expect(result.needsConfirmation).toBe(false);
			expect(result.deletedCount).toBe(0);
		}
	});

	it("overwrite with rows deleted and confirmBeforeDelete on needs confirmation, with the right deleted count", () => {
		const prevState = { "1": state("1"), "2": state("2"), "3": state("3") };
		const result = plan({ prevState, prevOrder: ["1", "2", "3"], rows: [row("1")], confirmBeforeDelete: true });
		expect(result.needsConfirmation).toBe(true);
		expect(result.deletedCount).toBe(2);
	});

	it("overwrite with rows deleted but confirmBeforeDelete off applies without asking", () => {
		const prevState = { "1": state("1"), "2": state("2") };
		const result = plan({ prevState, prevOrder: ["1", "2"], rows: [row("1")], confirmBeforeDelete: false });
		expect(result.needsConfirmation).toBe(false);
		expect(result.deletedCount).toBe(1);
		expect(result.result.itemState).toEqual({ "1": expect.objectContaining({ id: "1" }) });
	});

	it("overwrite with nothing actually deleted never needs confirmation, even with the guard on", () => {
		const prevState = { "1": state("1") };
		const result = plan({ prevState, prevOrder: ["1"], rows: [row("1"), row("2")], confirmBeforeDelete: true });
		expect(result.needsConfirmation).toBe(false);
		expect(result.deletedCount).toBe(0);
	});

	it("G6b(i): an empty response with keepOnEmpty on is a genuine no-op, leaving prior state/order untouched", () => {
		const prevState = { "1": state("1") };
		const result = plan({ prevState, prevOrder: ["1"], rows: [], keepOnEmpty: true, confirmBeforeDelete: true });
		expect(result.noChange).toBe(true);
		expect(result.needsConfirmation).toBe(false);
		expect(result.deletedCount).toBe(0);
		expect(result.result.itemState).toEqual(prevState);
		expect(result.result.order).toEqual(["1"]);
	});

	it("G6b(i): an empty response with keepOnEmpty off deletes everything and asks if the delete guard is on", () => {
		const prevState = { "1": state("1"), "2": state("2") };
		const result = plan({ prevState, prevOrder: ["1", "2"], rows: [], keepOnEmpty: false, confirmBeforeDelete: true });
		expect(result.noChange).toBe(false);
		expect(result.needsConfirmation).toBe(true);
		expect(result.deletedCount).toBe(2);
		expect(result.result.itemState).toEqual({});
	});

	it("E2/E4: a truncated overwrite refresh never counts a truncation-exempted survivor as a deletion", () => {
		const prevState = { "1": state("1"), "2": state("2") };
		const result = plan({ prevState, prevOrder: ["1", "2"], rows: [row("1")], truncated: true, confirmBeforeDelete: true });
		expect(result.deletedCount).toBe(0);
		expect(result.needsConfirmation).toBe(false);
		expect(result.result.itemState["2"]).toEqual(prevState["2"]);
	});

	it("an empty prevState/prevOrder (first-ever refresh) never needs confirmation regardless of guards", () => {
		const result = plan({ prevState: {}, prevOrder: [], rows: [row("1")], confirmBeforeDelete: true, keepOnEmpty: false });
		expect(result.needsConfirmation).toBe(false);
		expect(result.deletedCount).toBe(0);
	});
});

/** R7(a): the unit-level tests above cover `mergeApiItems`/`planApiRefresh` directly with an already-
 * deduped `rows` array — they trust E2's "not silently deleted twice" guarantee rather than proving it.
 * This drives a real duplicate-id API response through the *whole* refresh pipeline
 * (`ApiSourceController.refresh` → `mapResponseRows` → plan → merge → persisted cache), per mode, and
 * asserts the resulting dot state (G11) and `skippedCount` (E2) too — not just `itemState`/`order`. */
describe("ApiSourceController — R7(a): a duplicate-id response through the full refresh pipeline, per mode", () => {
	function node(id: string): ViewNode {
		return {
			id,
			type: "meta",
			label: "API folder",
			children: [],
			apiItemState: { "1": state("1"), "2": state("2") },
			apiItemOrder: ["1", "2"],
		};
	}

	function source(mode: "append" | "merge" | "overwrite", overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
		return {
			url: "http://example.invalid/dup",
			method: "GET",
			mapping: { idField: "id", labelField: "name" },
			mode,
			...overrides,
		};
	}

	// The response reports "1" twice (first wins, per E2) with a fresh label, a brand-new "3", and
	// drops "2" entirely — so every mode's handling of a genuinely-missing row is exercised too.
	const duplicateResponse: RequestFn = async () => ({
		status: 200,
		text: JSON.stringify([
			{ id: "1", name: "One (fresh)" },
			{ id: "1", name: "One (duplicate, must be skipped)" },
			{ id: "3", name: "Three" },
		]),
	});

	it.each([
		{
			mode: "append" as const,
			expectRow2: state("2"),
		},
		{
			mode: "merge" as const,
			expectRow2: { ...state("2"), notFound: true },
		},
		{
			mode: "overwrite" as const,
			expectRow2: undefined,
		},
	])("$mode: the duplicate is skipped (E2) and row 2 is handled per-mode, with a green dot after", async ({ mode, expectRow2 }) => {
		const n = node(`n-${mode}`);
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "confirmed";
		const controller = new ApiSourceController();

		await controller.refresh(n, source(mode, { confirmBeforeDelete: false }), [], () => {}, {
			requestImpl: duplicateResponse,
			confirmDelete,
		});

		expect(n.apiCache?.skippedCount).toBe(1);
		expect(n.apiItemState?.["1"]).toEqual(expect.objectContaining({ id: "1", label: "One (fresh)" }));
		expect(n.apiItemState?.["3"]).toEqual(expect.objectContaining({ id: "3", label: "Three" }));
		expect(n.apiItemState?.["2"]).toEqual(expectRow2);
		expect(dotStateFor(n.apiCache, n.apiAwaitingConfirmation)).toBe("green");
	});
});
