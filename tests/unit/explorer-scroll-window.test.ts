import { describe, expect, it } from "vitest";
import { computeInboxWindow } from "../../src/explorer-view";

/** PR-1.S1 (E1/E9): the inbox's row window against the single scroll body. Row height 28, overscan 8. */
const ROW = 28;
const OVER = 8;

const cases: {
	name: string;
	args: [scrollTop: number, listOffset: number, viewport: number, total: number];
	expected: { start: number; end: number };
}[] = [
	{ name: "top of the list, inside the viewport", args: [0, 0, 280, 1000], expected: { start: 0, end: Math.ceil(280 / ROW) + OVER } },
	{ name: "list offset below the viewport (bucket taller than the panel)", args: [0, 600, 280, 1000], expected: { start: 0, end: OVER } },
	{ name: "deep in the list, list at the top of the body", args: [2800, 0, 280, 1000], expected: { start: 100 - OVER, end: 100 + 10 + OVER } },
	{ name: "scrolled exactly onto the first row", args: [700, 700, 280, 1000], expected: { start: 0, end: Math.ceil(280 / ROW) + OVER } },
	{ name: "inside the list with a non-zero offset", args: [1400, 700, 280, 1000], expected: { start: 25 - OVER, end: 35 + OVER } },
	{ name: "last row is reached and not overrun", args: [28 * 990, 0, 280, 1000], expected: { start: 990 - OVER, end: 1000 } },
	{ name: "scrolled past the end of a shrunk list clamps to total", args: [28 * 5000, 0, 280, 20], expected: { start: 20, end: 20 } },
	{ name: "total 1", args: [0, 0, 280, 1], expected: { start: 0, end: 1 } },
	{ name: "total 0 (empty inbox)", args: [0, 0, 280, 0], expected: { start: 0, end: 0 } },
	{ name: "zero viewport height (hidden leaf) draws only overscan", args: [0, 0, 0, 1000], expected: { start: 0, end: OVER } },
	{ name: "negative local offset is clamped, never negative", args: [0, 900, 280, 1000], expected: { start: 0, end: OVER } },
	{ name: "non-finite scroll input falls back to the top", args: [Number.NaN, 0, 280, 1000], expected: { start: 0, end: Math.ceil(280 / ROW) + OVER } },
];

describe("computeInboxWindow — E1/E9 boundary table", () => {
	it.each(cases)("$name", ({ args, expected }) => {
		const [scrollTop, listOffset, viewport, total] = args;
		expect(computeInboxWindow(scrollTop, listOffset, viewport, ROW, OVER, total)).toEqual(expected);
	});

	it("never returns a negative index or an end before its start, for any input", () => {
		for (const scrollTop of [-500, 0, 1, 27, 28, 9999, 1e7]) {
			for (const listOffset of [-300, 0, 150, 5000]) {
				for (const total of [0, 1, 3, 500]) {
					const { start, end } = computeInboxWindow(scrollTop, listOffset, 300, ROW, OVER, total);
					expect(start).toBeGreaterThanOrEqual(0);
					expect(end).toBeGreaterThanOrEqual(start);
					expect(end).toBeLessThanOrEqual(total);
				}
			}
		}
	});
});

/** PR-4 (E12): several stacked lists, each given its own offset from the top of the one scroll body. A
 * collapsed section's list has zero height, so the next list's offset is just past its header. */
describe("computeInboxWindow — stacked section lists (PR-4 E12)", () => {
	const H = 30; // section header
	const win = (scrollTop: number, offset: number, total: number, viewport = 280) => computeInboxWindow(scrollTop, offset, viewport, ROW, OVER, total);
	// bucket 600, vault list (100 rows) then a 800-row source list, a collapsed 50-row list, a 20-row list.
	const vaultOffset = 600 + H;
	const sourceOffset = vaultOffset + 100 * ROW + H;
	const collapsedOffset = sourceOffset + 800 * ROW + H;
	const lastOffset = collapsedOffset + 0 + H; // the collapsed list takes no height

	it("only the list under the viewport draws more than its overscan", () => {
		const scrollTop = sourceOffset + 400 * ROW;
		expect(win(scrollTop, vaultOffset, 100)).toEqual({ start: 100, end: 100 }); // scrolled past the end: nothing
		expect(win(scrollTop, sourceOffset, 800)).toEqual({ start: 400 - OVER, end: 400 + 10 + OVER });
		expect(win(scrollTop, lastOffset, 20)).toEqual({ start: 0, end: OVER });
	});

	it("every list's window is bounded by window + overscan however long it is", () => {
		for (let scrollTop = 0; scrollTop < lastOffset + 20 * ROW; scrollTop += 137) {
			for (const [offset, total] of [[vaultOffset, 100], [sourceOffset, 800], [lastOffset, 20]] as const) {
				const { start, end } = win(scrollTop, offset, total);
				expect(end - start).toBeLessThanOrEqual(Math.ceil(280 / ROW) + 2 * OVER + 1);
				expect(start).toBeGreaterThanOrEqual(0);
				expect(end).toBeLessThanOrEqual(total);
			}
		}
	});

	it("a collapsed section between two lists draws at most its overscan and does not shift the next list's offset", () => {
		// the collapsed list (50 rows, zero height) sits at collapsedOffset: whatever is scrolled, it stays small
		for (const scrollTop of [0, sourceOffset, collapsedOffset, collapsedOffset + 5000]) {
			const { start, end } = win(scrollTop, collapsedOffset, 50);
			expect(end - start).toBeLessThanOrEqual(Math.ceil(280 / ROW) + 2 * OVER + 1);
		}
		// the list after it is addressed by its own offset, so the zero-height list does not move it
		expect(win(lastOffset, lastOffset, 20)).toEqual({ start: 0, end: Math.min(20, Math.ceil(280 / ROW) + OVER) });
	});

	it("an 800-row source scrolled end to end always has the viewport's rows covered, with no gap", () => {
		const maxScroll = sourceOffset + 800 * ROW - 280;
		for (let scrollTop = sourceOffset; scrollTop <= maxScroll; scrollTop += 53) {
			const { start, end } = win(scrollTop, sourceOffset, 800);
			const firstVisible = Math.floor((scrollTop - sourceOffset) / ROW);
			const lastVisible = Math.min(799, Math.floor((scrollTop - sourceOffset + 279) / ROW));
			expect(start).toBeLessThanOrEqual(firstVisible);
			expect(end).toBeGreaterThan(lastVisible);
		}
	});
});
