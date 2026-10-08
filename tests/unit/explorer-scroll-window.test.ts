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
