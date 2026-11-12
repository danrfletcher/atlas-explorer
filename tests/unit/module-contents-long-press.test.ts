import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, LONG_PRESS_SWALLOW_MS, attachLongPress } from "../../src/long-press";

const down = (el: Element, x = 10, y = 10, button = 0) =>
	el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button }));
const downAs = (el: Element, pointerType: string) => {
	const evt = new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10, button: 0 });
	Object.defineProperty(evt, "pointerType", { value: pointerType });
	el.dispatchEvent(evt);
};
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

	// R3: the swallow must stop every listener on the row, including ones registered before it and ones
	// on the row when the click's own target is the row (padding), and must not stay armed afterwards.
	it("swallows a click that targets the row itself even for listeners registered before and after attachLongPress", () => {
		const el = document.body.appendChild(document.createElement("div"));
		const before = vi.fn();
		const after = vi.fn();
		const beforeCapture = vi.fn();
		el.addEventListener("click", before);
		el.addEventListener("click", beforeCapture, true);
		const cb = vi.fn();
		attachLongPress(el, cb);
		el.addEventListener("click", after);
		// Same element, same phase, registered later: only stopImmediatePropagation stops this one.
		const afterCapture = vi.fn();
		el.addEventListener("click", afterCapture, true);
		down(el);
		vi.advanceTimersByTime(500);
		up(el);
		el.click();
		expect(cb).toHaveBeenCalledTimes(1);
		expect(before).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
		expect(afterCapture).not.toHaveBeenCalled();
		// A capture listener registered earlier on the same element still ran first, which is the one
		// ordering a listener on the row itself cannot be stopped from.
		expect(beforeCapture).toHaveBeenCalledTimes(1);
	});

	it("swallows a click on a child of the row too", () => {
		const { row, icon, open } = wiredRow();
		const rowClick = vi.fn();
		const iconClick = vi.fn();
		row.addEventListener("click", rowClick);
		icon.addEventListener("click", iconClick);
		down(row);
		vi.advanceTimersByTime(500);
		up(row);
		icon.click();
		expect(open).toHaveBeenCalledTimes(1);
		expect(rowClick).not.toHaveBeenCalled();
		expect(iconClick).not.toHaveBeenCalled();
	});

	it("the swallow disarms itself after the release, so a click that never reached the row does not eat a later one", () => {
		const { row, open } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		down(row);
		vi.advanceTimersByTime(500);
		up(row); // the release landed on the row, but no click arrives
		vi.advanceTimersByTime(LONG_PRESS_SWALLOW_MS - 1);
		row.click();
		expect(clicked).not.toHaveBeenCalled(); // still inside the window: that was the release's click
		down(row);
		vi.advanceTimersByTime(500);
		up(row);
		vi.advanceTimersByTime(LONG_PRESS_SWALLOW_MS);
		row.click();
		expect(clicked).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledTimes(2);
	});

	it("the swallow also disarms when the pointer leaves the row after the hold (the release lands on the modal)", () => {
		const { row, open } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		down(row);
		vi.advanceTimersByTime(500);
		row.dispatchEvent(new Event("pointerleave", { bubbles: true }));
		vi.advanceTimersByTime(LONG_PRESS_SWALLOW_MS);
		row.click();
		expect(open).toHaveBeenCalledTimes(1);
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("the next press cancels a pending disarm and starts clean", () => {
		const { row } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		down(row);
		vi.advanceTimersByTime(500);
		up(row);
		down(row); // a quick second press before the window ends
		up(row);
		row.click();
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	// R6: on touch the OS raises contextmenu for the same long press.
	it("a touch hold that fired swallows the OS contextmenu raised for it, so the row menu does not open too", () => {
		const { row, open } = wiredRow();
		const menu = vi.fn();
		row.addEventListener("contextmenu", menu);
		downAs(row, "touch");
		vi.advanceTimersByTime(500);
		const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		row.dispatchEvent(evt);
		expect(open).toHaveBeenCalledTimes(1);
		expect(menu).not.toHaveBeenCalled();
		expect(evt.defaultPrevented).toBe(true);
	});

	it("a touch contextmenu that arrives first still cancels the hold, so only the row menu opens", () => {
		const { row, open } = wiredRow();
		const menu = vi.fn();
		row.addEventListener("contextmenu", menu);
		downAs(row, "touch");
		vi.advanceTimersByTime(300);
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		vi.advanceTimersByTime(2000);
		expect(open).not.toHaveBeenCalled();
		expect(menu).toHaveBeenCalledTimes(1);
	});

	it("a mouse right-click after a fired hold is still the row menu: only touch/pen holds swallow contextmenu", () => {
		const { row } = wiredRow();
		const menu = vi.fn();
		row.addEventListener("contextmenu", menu);
		downAs(row, "mouse");
		vi.advanceTimersByTime(500);
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		expect(menu).toHaveBeenCalledTimes(1);
	});
});
