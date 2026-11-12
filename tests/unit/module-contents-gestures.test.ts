import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "../../src/long-press";

// atlas-17 PR-3 (G2): the long-press gesture, driven through the real `wireModuleRow` so the timer,
// the click swallow and the open call are the ones the explorer uses. (PR-2's
// module-contents-long-press.test.ts covers `attachLongPress` directly; this file covers the row.)

// The Obsidian mock DOM has no `hasClass` (the real API does); wireModuleRow calls it.
if (!(HTMLElement.prototype as { hasClass?: unknown }).hasClass) {
	(HTMLElement.prototype as unknown as { hasClass: (cls: string) => boolean }).hasClass = function (cls: string) {
		return this.classList.contains(cls);
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

const pointer = (el: Element, type: string, x = 10, y = 10, button = 0) =>
	el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }));

function wiredRow(opts: { statusDot?: boolean } = {}) {
	const open = vi.fn();
	const row = document.body.appendChild(document.createElement("div"));
	row.className = "atlas-row";
	const icon = row.appendChild(document.createElement("span"));
	icon.className = opts.statusDot ? "atlas-icon atlas-status-dot" : "atlas-icon";
	const stub = { openModuleContentsModal: open, dragPayload: null } as Record<string, unknown>;
	(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>).wireModuleRow.call(stub, row, icon, "Projects");
	return { row, icon, open };
}

describe("G2 long-press on a module row opens Module Contents after 500 ms", () => {
	it("fires exactly at the threshold, with the row's folder path", () => {
		const { row, open } = wiredRow();
		pointer(row, "pointerdown");
		vi.advanceTimersByTime(LONG_PRESS_MS - 1);
		expect(open).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(open).toHaveBeenCalledExactlyOnceWith("Projects");
	});

	// Every way a hold can be interrupted before 500 ms. Each must leave the timer cleared so that
	// waiting well past the threshold still opens nothing.
	const interruptions: [string, (row: HTMLElement) => void][] = [
		["pointerup at 499 ms", (row) => { vi.advanceTimersByTime(499); pointer(row, "pointerup"); }],
		["pointerup at once", (row) => pointer(row, "pointerup")],
		["pointercancel", (row) => pointer(row, "pointercancel")],
		["pointer leaving the row", (row) => pointer(row, "pointerleave")],
		["a move one pixel past the slop", (row) => pointer(row, "pointermove", 10 + LONG_PRESS_SLOP_PX + 1, 10)],
		["a diagonal move past the slop", (row) => pointer(row, "pointermove", 14, 14)],
		["a native drag starting", (row) => pointer(row, "dragstart")],
		["a right-click", (row) => pointer(row, "contextmenu", 10, 10, 2)],
	];
	it.each(interruptions)("%s cancels the timer: nothing opens, even much later", (_name, interrupt) => {
		const { row, open } = wiredRow();
		pointer(row, "pointerdown");
		interrupt(row);
		vi.advanceTimersByTime(5000);
		expect(open).not.toHaveBeenCalled();
	});

	it("a move within the slop (exactly 5 px) keeps the timer", () => {
		const { row, open } = wiredRow();
		pointer(row, "pointerdown", 10, 10);
		pointer(row, "pointermove", 13, 14); // 3-4-5
		vi.advanceTimersByTime(LONG_PRESS_MS);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("a secondary-button press never starts a hold", () => {
		const { row, open } = wiredRow();
		pointer(row, "pointerdown", 10, 10, 2);
		vi.advanceTimersByTime(5000);
		expect(open).not.toHaveBeenCalled();
	});

	it("an interrupted hold behaves as a normal click: the row's own click handler runs", () => {
		const { row, open } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		pointer(row, "pointerdown");
		vi.advanceTimersByTime(200);
		pointer(row, "pointerup");
		row.click();
		expect(clicked).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
	});

	it("a completed hold swallows the release click: no selection, no open-note", () => {
		const { row, open } = wiredRow();
		const clicked = vi.fn();
		row.addEventListener("click", clicked);
		pointer(row, "pointerdown");
		vi.advanceTimersByTime(LONG_PRESS_MS);
		pointer(row, "pointerup");
		row.click();
		expect(open).toHaveBeenCalledTimes(1);
		expect(clicked).not.toHaveBeenCalled();
		// ...but only that one click: the next, separate click goes through.
		row.click();
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("holding on a governed module's status dot opens contents and does not also change its status", () => {
		const { icon, open } = wiredRow({ statusDot: true });
		const dotClick = vi.fn(); // renderRowIcon's click: opens the status popup
		icon.addEventListener("click", dotClick);
		pointer(icon, "pointerdown");
		vi.advanceTimersByTime(LONG_PRESS_MS);
		pointer(icon, "pointerup");
		icon.click();
		expect(open).toHaveBeenCalledExactlyOnceWith("Projects");
		expect(dotClick).not.toHaveBeenCalled();
	});

	it("a plain click on a governed module's status dot still changes its status", () => {
		const { icon, open } = wiredRow({ statusDot: true });
		const dotClick = vi.fn();
		icon.addEventListener("click", dotClick);
		pointer(icon, "pointerdown");
		vi.advanceTimersByTime(100);
		pointer(icon, "pointerup");
		icon.click();
		expect(dotClick).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
	});

	it("a press on the row's chevron or action button belongs to that control and starts no hold", () => {
		const { row, open } = wiredRow();
		for (const cls of ["atlas-chevron", "atlas-row-action"]) {
			const control = row.appendChild(document.createElement("span"));
			control.className = cls;
			pointer(control, "pointerdown");
		}
		vi.advanceTimersByTime(5000);
		expect(open).not.toHaveBeenCalled();
	});
});
