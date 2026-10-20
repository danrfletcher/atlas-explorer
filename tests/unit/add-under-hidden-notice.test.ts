import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { AddUnderHiddenNoticeSignals, AddUnderHiddenNoticeState, classifyHiddenReason, noticeIfAddedRowHidden } from "../../src/add-under-hidden-notice";

// PR-2.F3 (G10): `classifyHiddenReason` is the pure reason classifier every "Add under…" kind's
// post-add check runs through — table-driven over the signal combinations the spec names:
// filter-miss, filter-hit (no signal set at all — the caller never calls this once the row is
// visible), truncated status, hidden status, no cause, and multiple causes (filter named first).
describe("classifyHiddenReason — G10/E-G10a-e reason priority", () => {
	const CASES: Array<{ name: string; signals: AddUnderHiddenNoticeSignals; expected: string | null }> = [
		{ name: "filter-miss: filter active, nothing else set", signals: { filterActive: true }, expected: "the current filter" },
		{ name: "filter-hit (row would be visible — caller never reaches this, but the classifier alone still reports no cause)", signals: { filterActive: false }, expected: null },
		{ name: "truncated status: group label set, filter inactive", signals: { filterActive: false, truncatedGroupLabel: "Done" }, expected: 'the truncated "Done" group' },
		{ name: "hidden status: sort/grouping flag set, filter inactive, no group", signals: { filterActive: false, hiddenBySortOrGrouping: true }, expected: "the current sort or grouping" },
		{ name: "no cause: every signal falsy", signals: { filterActive: false, truncatedGroupLabel: null, hiddenBySortOrGrouping: false }, expected: null },
		{
			name: "multiple causes (filter and truncation both apply): filter named first (E-G10e)",
			signals: { filterActive: true, truncatedGroupLabel: "Done", hiddenBySortOrGrouping: true },
			expected: "the current filter",
		},
		{
			name: "multiple causes (truncation and hidden-status, no filter): truncation still wins over the catch-all sort/grouping reason",
			signals: { filterActive: false, truncatedGroupLabel: "Done", hiddenBySortOrGrouping: true },
			expected: 'the truncated "Done" group',
		},
	];

	it.each(CASES)("$name", ({ signals, expected }) => {
		expect(classifyHiddenReason(signals)).toBe(expected);
	});
});

// PR-2.F3 (G10/E-G10b/E-G10g): `noticeIfAddedRowHidden` itself — the DOM visibility check (a fake
// `bucketListEl` whose `querySelector('[data-select-key=...]')` returns null or an element) gates
// whether a Notice fires at all, and its text follows the G10 format.
describe("noticeIfAddedRowHidden — visibility gates the Notice, text follows G10's format", () => {
	function state(overrides: Partial<AddUnderHiddenNoticeState> = {}): AddUnderHiddenNoticeState {
		return {
			render: vi.fn(() => Promise.resolve()),
			getBucketListEl: vi.fn(() => null),
			filterActive: false,
			...overrides,
		};
	}

	beforeEach(() => {
		Notice.reset();
	});

	// jsdom in this test environment has no global `CSS` at all (not even without `.escape`), same
	// as `tests/unit/explorer-view.test.ts`'s own PR-2.F2 R2 test notes. None of the ids used below
	// need real escaping, so a minimal stand-in is enough.
	let originalCSS: unknown;
	beforeEach(() => {
		originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (value: string) => string } }).CSS = { escape: (value: string) => value };
	});
	afterEach(() => {
		(globalThis as { CSS?: unknown }).CSS = originalCSS;
	});

	it("row not found in the DOM and the filter is the cause: one Notice, exact G10 wording", async () => {
		const bucketListEl = document.createElement("div"); // empty: the new row never got appended
		await noticeIfAddedRowHidden("new-1", "Quarry Notes", "quarry-drones", state({ getBucketListEl: () => bucketListEl, filterActive: true }));

		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("Added Quarry Notes under quarry-drones");
		expect(Notice.instances[0].message).toContain("(hidden by the current filter)");
		// The whole string, including the codebase-wide "Atlas: " prefix every other Notice carries.
		expect(Notice.instances[0].message).toBe("Atlas: Added Quarry Notes under quarry-drones (hidden by the current filter)");
	});

	it.each([
		["the current filter", { filterActive: true }],
		["the current sort or grouping", { filterActive: false, hiddenBySortOrGrouping: true }],
		['the truncated "Dones" group', { filterActive: false, truncatedGroupLabel: "Dones" }],
	] as const)("exact G10 text for the reason %s", async (reason, signals) => {
		await noticeIfAddedRowHidden("new-1", "Archive", "Projects", state({ getBucketListEl: () => document.createElement("div"), ...signals }));

		expect(Notice.instances.map((n) => n.message)).toEqual([`Atlas: Added Archive under Projects (hidden by ${reason})`]);
	});

	it("row found in the DOM: no Notice at all, even though a cause is also set (G10/E-G10b)", async () => {
		const bucketListEl = document.createElement("div");
		const row = document.createElement("div");
		row.setAttribute("data-select-key", "new-1");
		bucketListEl.appendChild(row);

		await noticeIfAddedRowHidden("new-1", "Quarry Notes", "quarry-drones", state({ getBucketListEl: () => bucketListEl, filterActive: true }));

		expect(Notice.instances).toHaveLength(0);
	});

	it("bucketListEl is null (bucket not showing): treated the same as 'not found'", async () => {
		await noticeIfAddedRowHidden("new-1", "Archive", "Projects", state({ getBucketListEl: () => null, hiddenBySortOrGrouping: true }));

		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain("(hidden by the current sort or grouping)");
	});

	it("row not found but no signal explains why: no Notice (never invents a reason)", async () => {
		const bucketListEl = document.createElement("div");
		await noticeIfAddedRowHidden("new-1", "Archive", "Projects", state({ getBucketListEl: () => bucketListEl, filterActive: false }));

		expect(Notice.instances).toHaveLength(0);
	});
});

// PR-2.F3 (E-G10f): the check must run after the awaited render, never before, and exactly once.
describe("noticeIfAddedRowHidden — timing: runs once, only after its own render step resolves", () => {
	it("doesn't read the DOM before render() resolves, and reads it exactly once after", async () => {
		let resolveRender: (() => void) | null = null;
		const render = vi.fn(() => new Promise<void>((resolve) => (resolveRender = resolve)));
		const getBucketListEl = vi.fn(() => null as HTMLElement | null);

		const promise = noticeIfAddedRowHidden("new-1", "Archive", "Projects", { render, getBucketListEl, filterActive: false });

		// Still pending: render() hasn't resolved yet, so the DOM must not have been touched.
		await Promise.resolve();
		await Promise.resolve();
		expect(getBucketListEl).not.toHaveBeenCalled();

		resolveRender!();
		await promise;

		expect(render).toHaveBeenCalledTimes(1);
		expect(getBucketListEl).toHaveBeenCalledTimes(1);
	});
});
