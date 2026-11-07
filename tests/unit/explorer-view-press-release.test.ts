import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { bucketRows, drawBucketRows, flush, openExplorer, pointer, PressEnv } from "./explorer-view-press-helpers";

/** Atlas #16 PR-1 (E1, E2, E8, F1): how a held press ends. Each path releases the held render once;
 * with a context menu open the press is not released yet. Real `onOpen` listeners, fake timers. */

let h: SectionHarness;
let env: PressEnv;
let row: HTMLElement;
let rowCount: number;

beforeEach(async () => {
	vi.useFakeTimers();
	rowCount = 1;
	h = makeSectionHarness({ bucketRows: 1, inboxRows: 1 });
	env = await openExplorer(h);
	drawBucketRows(env.ex, () => rowCount);
	await env.ex.render();
	env.renderNow.mockClear();
	row = bucketRows()[0];
});

afterEach(() => {
	env.teardown();
	h.teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Presses the row and requests a render, which must stay held. */
async function pressAndRequest(init: Parameters<typeof pointer>[2] = { buttons: 1 }): Promise<void> {
	pointer("pointerdown", row, init);
	env.ex.refresh();
	await vi.advanceTimersByTimeAsync(50);
	expect(env.renderNow).not.toHaveBeenCalled();
}

/** Obsidian's context menu: a `.menu` element appended straight to the body. */
function openMenu(): HTMLElement {
	return document.body.appendChild(Object.assign(document.createElement("div"), { className: "menu" }));
}

describe("Atlas #16 — release paths", () => {
	it("pointerup releases the held render once", async () => {
		await pressAndRequest();
		pointer("pointerup", row);
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("dragend releases the held render once", async () => {
		await pressAndRequest();
		window.dispatchEvent(new Event("dragend"));
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("E1: pointerup never arrives — the next pointermove with no button held releases it", async () => {
		await pressAndRequest();
		pointer("pointermove", document.body, { buttons: 1 }); // still held down: nothing yet
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();

		pointer("pointermove", document.body, { buttons: 0 });
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a touch pointercancel (a scroll took over) releases it; a mouse pointercancel (drag start) does not", async () => {
		await pressAndRequest();
		pointer("pointercancel", row, { pointerType: "mouse" });
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();

		pointer("pointercancel", row, { pointerType: "touch" });
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("several release events for one press (pointerup, pointermove, dragend) give one render", async () => {
		await pressAndRequest();
		pointer("pointerup", row);
		pointer("pointermove", document.body, { buttons: 0 });
		window.dispatchEvent(new Event("dragend"));
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1); // dragend's own backstop repaint merges with it
	});
});

describe("Atlas #16 (E2) — a drag that starts while a render is held", () => {
	it("keeps its drag state through the hold, and the held render and the drop's repaint merge into one after dragend", async () => {
		const inboxRow = document.querySelector<HTMLElement>(".atlas-inbox .atlas-row-unit")!;
		expect(inboxRow).not.toBeNull();
		pointer("pointerdown", inboxRow, { buttons: 1 });
		env.fireUnitIndexChange(); // a background change while the press is down
		inboxRow.dispatchEvent(new Event("dragstart", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(50);
		expect(env.ex.dragPayload).not.toBeNull();
		expect(env.ex.inboxDragRowEl).toBe(inboxRow);
		expect(env.renderNow).not.toHaveBeenCalled();

		// The drop's own repaint (the real `handleDrop`) waits for the end of the drag too.
		env.ex.handleDrop({ kind: "inbox-area" });
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();
		expect(inboxRow.isConnected).toBe(true);
		expect(env.ex.inboxDragRowEl).toBe(inboxRow);

		window.dispatchEvent(new Event("dragend"));
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a bucket row's drag survives too, and the list updates after dragend", async () => {
		pointer("pointerdown", row, { buttons: 1 });
		row.dispatchEvent(new Event("dragstart", { bubbles: true }));
		env.ex.bucketDragRowEl = row; // what the real bucket row's dragstart handler records
		rowCount = 4;
		env.fireViewsChange(true);
		await vi.advanceTimersByTimeAsync(50);
		expect(env.ex.bucketDragRowEl).toBe(row);
		expect(env.renderNow).not.toHaveBeenCalled();

		window.dispatchEvent(new Event("dragend"));
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
		expect(bucketRows()).toHaveLength(4);
	});
});

describe("Atlas #16 (E8) — right-click keeps the hold while the context menu is open", () => {
	it("menu open: contextmenu, pointerup and menu-open pointermoves release nothing; closing it and moving does, once", async () => {
		await pressAndRequest({ buttons: 2, button: 2 });
		pointer("contextmenu", row, { buttons: 2, button: 2 });
		const menu = openMenu(); // the row's own handler opens it right after the capture listener
		pointer("pointerup", row, { button: 2 });
		pointer("pointermove", document.body, { buttons: 0 });
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();
		expect(row.isConnected).toBe(true);

		menu.remove(); // dismissed
		pointer("pointermove", document.body, { buttons: 0 });
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("menu closed (a row with no menu): pointerup after contextmenu releases at once", async () => {
		await pressAndRequest({ buttons: 2, button: 2 });
		pointer("contextmenu", row, { buttons: 2, button: 2 });
		pointer("pointerup", row, { button: 2 });
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a press on a menu item ends the right-click press, so the item's own action is never left waiting", async () => {
		await pressAndRequest({ buttons: 2, button: 2 });
		pointer("contextmenu", row, { buttons: 2, button: 2 });
		const menu = openMenu();
		const item = menu.appendChild(document.createElement("div"));
		pointer("pointerdown", item, { buttons: 1 });
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a context menu left open from an earlier press does not hold a later plain click", async () => {
		pointer("pointerdown", row, { buttons: 2, button: 2 });
		pointer("contextmenu", row, { buttons: 2, button: 2 });
		openMenu();
		pointer("pointerdown", row, { buttons: 1 }); // a new press resets the context-menu mark
		env.ex.refresh();
		pointer("pointerup", row);
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});
});

describe("Atlas #16 (F1) — shift, Cmd/Ctrl and middle presses share the same hold", () => {
	const presses: [string, Parameters<typeof pointer>[2]][] = [
		["shift-click", { buttons: 1, shiftKey: true }],
		["Cmd-click", { buttons: 1, metaKey: true }],
		["Ctrl-click", { buttons: 1, ctrlKey: true }],
		["middle-click", { buttons: 4, button: 1 }],
	];
	for (const [name, init] of presses) {
		it(`${name}: held until release, then one render`, async () => {
			await pressAndRequest(init);
			pointer("pointerup", row, { button: init?.button });
			await flush(env);
			expect(env.renderNow).toHaveBeenCalledTimes(1);
		});
	}
});

describe("Atlas #16 — closing the view during a press", () => {
	it("leaves no held render to fire on the closed view, and settles what was awaiting it", async () => {
		pointer("pointerdown", row, { buttons: 1 });
		const pending = env.ex.render();
		const settled = env.ex.awaitRenderSettled();
		env.fireUnitIndexChange();
		await env.ex.onClose();
		await Promise.all([pending, settled]); // neither hangs

		pointer("pointerup", row);
		pointer("pointermove", document.body, { buttons: 0 });
		await vi.advanceTimersByTimeAsync(100);
		expect(env.renderNow).not.toHaveBeenCalled();
	});

	it("a release timer already queued does not render on the closed view", async () => {
		await pressAndRequest();
		pointer("pointerup", row); // queues the render for the next tick
		await env.ex.onClose();
		await vi.advanceTimersByTimeAsync(100);
		expect(env.renderNow).not.toHaveBeenCalled();
	});
});
