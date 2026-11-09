import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, attachLongPress } from "../../src/long-press";

const down = (el: Element, x = 10, y = 10, button = 0) =>
	el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button }));
const move = (el: Element, x: number, y: number) => el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
const up = (el: Element) => el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

/** The module row as `wireModuleRow` really builds it: the real prototype method on a stub explorer. */
function wiredRow() {
	const open = vi.fn();
	const row = document.body.appendChild(document.createElement("div"));
	row.className = "atlas-row";
	const icon = row.appendChild(document.createElement("span"));
	icon.className = "atlas-icon";
	const stub = { openModuleContentsModal: open, dragPayload: null } as Record<string, unknown>;
	(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>).wireModuleRow.call(stub, row, icon, "Mod");
	return { row, icon, open };
}

describe("G2 long-press: 500 ms hold on a module row opens Module Contents", () => {
	it("opens exactly once, with the row's folder path, after 500 ms (and not a tick before)", () => {
		const { row, open } = wiredRow();
		down(row);
		vi.advanceTimersByTime(LONG_PRESS_MS - 1);
		expect(open).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith("Mod");
	});

	it("the constants are the spec's: 500 ms and a 5 px slop", () => {
		expect(LONG_PRESS_MS).toBe(500);
		expect(LONG_PRESS_SLOP_PX).toBe(5);
	});

	it("also fires when the hold starts on the row's icon (a status/module icon is part of the row)", () => {
		const { icon, open } = wiredRow();
		down(icon);
		vi.advanceTimersByTime(500);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("moving more than 5 px cancels the timer", () => {
		const { row, open } = wiredRow();
		down(row, 10, 10);
		move(row, 10, 16); // 6 px
		vi.advanceTimersByTime(2000);
		expect(open).not.toHaveBeenCalled();
	});

	it("moving up to 5 px does not cancel it", () => {
		const { row, open } = wiredRow();
		down(row, 10, 10);
		move(row, 13, 14); // sqrt(9+16) = 5 px, exactly the slop
		move(row, 10, 15); // 5 px
		vi.advanceTimersByTime(500);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("releasing before 500 ms clears the timer, opens nothing and lets the click run as normal", () => {
		const { row, open } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		down(row);
		vi.advanceTimersByTime(300);
		up(row);
		row.click();
		vi.advanceTimersByTime(2000);
		expect(open).not.toHaveBeenCalled();
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("a completed hold swallows the click that follows, so it never also selects or opens the row", () => {
		const { row, open } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		down(row);
		vi.advanceTimersByTime(500);
		up(row);
		row.click();
		expect(open).toHaveBeenCalledTimes(1);
		expect(clicked).not.toHaveBeenCalled();
		// ...and only that one click: the next press-and-release is an ordinary click again.
		down(row);
		up(row);
		row.click();
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("a right-click (contextmenu) cancels a pending hold so the modal never collides with the native menu", () => {
		const { row, open } = wiredRow();
		down(row);
		vi.advanceTimersByTime(200);
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		vi.advanceTimersByTime(2000);
		expect(open).not.toHaveBeenCalled();
	});

	it("a non-primary button never starts a hold", () => {
		const { row, open } = wiredRow();
		down(row, 10, 10, 2);
		vi.advanceTimersByTime(2000);
		expect(open).not.toHaveBeenCalled();
	});

	it("a native drag starting, or the pointer leaving or being cancelled, cancels the hold", () => {
		for (const type of ["dragstart", "pointerleave", "pointercancel"]) {
			const { row, open } = wiredRow();
			down(row);
			row.dispatchEvent(new Event(type, { bubbles: true }));
			vi.advanceTimersByTime(2000);
			expect(open, type).not.toHaveBeenCalled();
		}
	});

	it("a press on a row action or chevron belongs to that control and starts no hold", () => {
		const { row, open } = wiredRow();
		const action = row.appendChild(document.createElement("button"));
		action.className = "atlas-row-action";
		down(action);
		vi.advanceTimersByTime(2000);
		expect(open).not.toHaveBeenCalled();
	});

	it("a second press restarts the timer rather than stacking a second one", () => {
		const { row, open } = wiredRow();
		down(row);
		vi.advanceTimersByTime(400);
		down(row);
		vi.advanceTimersByTime(400);
		expect(open).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("the returned detach function removes the listeners and clears a pending hold", () => {
		const el = document.body.appendChild(document.createElement("div"));
		const cb = vi.fn();
		const detach = attachLongPress(el, cb);
		down(el);
		detach();
		vi.advanceTimersByTime(2000);
		expect(cb).not.toHaveBeenCalled();
		down(el);
		vi.advanceTimersByTime(2000);
		expect(cb).not.toHaveBeenCalled();
	});
});
