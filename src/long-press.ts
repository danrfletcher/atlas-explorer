/** How long a pointer must be held on a module row before Module Contents opens. */
export const LONG_PRESS_MS = 500;

/** How far (px, straight-line) the pointer may wander during the hold before it counts as a drag or a
 * scroll rather than a press, cancelling the timer. */
export const LONG_PRESS_SLOP_PX = 5;

export interface LongPressTimers {
	setTimeoutFn: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn: (handle: unknown) => void;
}

const realTimers: LongPressTimers = {
	setTimeoutFn: (cb, ms) => window.setTimeout(cb, ms),
	clearTimeoutFn: (handle) => window.clearTimeout(handle as number),
};

/** How long after the release of a completed long press the swallow of its click stays armed. The click
 * arrives right after the release; if it never reaches this element (the release landed on the modal that
 * just opened) the swallow must not linger and eat an unrelated click later. */
export const LONG_PRESS_SWALLOW_MS = 250;

/** Elements inside a row that own their own click (remove button, chevron): a hold on one is theirs. */
const IGNORED_TARGETS = ".atlas-row-action, .atlas-chevron";

/** Wires a 500 ms press-and-hold on `el` (mouse, touch or pen; primary button only) and calls
 * `onLongPress` when it completes. The hold is cancelled by: release before the threshold, the pointer
 * moving more than `LONG_PRESS_SLOP_PX` from where it went down, a pointer cancel/leave, a native drag
 * starting, or a `contextmenu` (so the long press never collides with the right-click menu).
 *
 * Once a long press has fired, the click the browser sends on release is swallowed: a capture listener
 * on the row calls `stopImmediatePropagation`, so no other listener on the row (selection/open handlers,
 * a status dot's own click) runs, whether the click targets the row itself or a child. The swallow
 * disarms itself `LONG_PRESS_SWALLOW_MS` after the release (or after the pointer leaves or is cancelled), or at the next press, so a click that never
 * reaches the row leaves nothing armed. A touch or pen hold that has fired also swallows the
 * `contextmenu` the OS raises for the same long press, so the row menu does not open over the modal.
 * A hold that is released early never fires, so its click runs as normal. Returns a function that
 * removes every listener and clears a pending timer. */
export function attachLongPress(
	el: HTMLElement,
	onLongPress: () => void,
	timers: LongPressTimers = realTimers,
	holdMs: number = LONG_PRESS_MS,
	slopPx: number = LONG_PRESS_SLOP_PX
): () => void {
	let timer: unknown;
	let startX = 0;
	let startY = 0;
	let swallowClick = false;
	let swallowTimer: unknown;
	let touchLike = false;

	const clearSwallowTimer = () => {
		if (swallowTimer === undefined) return;
		timers.clearTimeoutFn(swallowTimer);
		swallowTimer = undefined;
	};
	const cancel = () => {
		if (timer === undefined) return;
		timers.clearTimeoutFn(timer);
		timer = undefined;
	};
	const onDown = (evt: MouseEvent) => {
		swallowClick = false; // a fresh press: whatever the last one left behind is stale
		clearSwallowTimer();
		cancel();
		touchLike = (evt as PointerEvent).pointerType === "touch" || (evt as PointerEvent).pointerType === "pen";
		if (evt.button !== 0) return;
		if (evt.target instanceof Element && evt.target.closest(IGNORED_TARGETS)) return;
		startX = evt.clientX;
		startY = evt.clientY;
		timer = timers.setTimeoutFn(() => {
			timer = undefined;
			swallowClick = true;
			onLongPress();
		}, holdMs);
	};
	const onMove = (evt: MouseEvent) => {
		if (timer === undefined) return;
		if (Math.hypot(evt.clientX - startX, evt.clientY - startY) > slopPx) cancel();
	};
	// The hold is over (released, cancelled, or the pointer left the row, e.g. onto the modal that just
	// opened): a click for it, if one comes at all, comes right away.
	const onEnd = () => {
		cancel();
		if (!swallowClick) return;
		clearSwallowTimer();
		swallowTimer = timers.setTimeoutFn(() => {
			swallowTimer = undefined;
			swallowClick = false;
		}, LONG_PRESS_SWALLOW_MS);
	};
	const onClickCapture = (evt: Event) => {
		if (!swallowClick) return;
		swallowClick = false;
		clearSwallowTimer();
		evt.stopImmediatePropagation();
		evt.preventDefault();
	};
	const onContextMenuCapture = (evt: Event) => {
		if (swallowClick && touchLike) {
			// The OS long-press menu for the hold that already opened Module Contents.
			evt.stopImmediatePropagation();
			evt.preventDefault();
			return;
		}
		cancel();
	};

	el.addEventListener("pointerdown", onDown);
	el.addEventListener("pointermove", onMove);
	el.addEventListener("pointerup", onEnd);
	el.addEventListener("pointercancel", onEnd);
	el.addEventListener("pointerleave", onEnd);
	el.addEventListener("dragstart", cancel);
	el.addEventListener("contextmenu", onContextMenuCapture, true);
	el.addEventListener("click", onClickCapture, true);
	return () => {
		cancel();
		clearSwallowTimer();
		el.removeEventListener("pointerdown", onDown);
		el.removeEventListener("pointermove", onMove);
		el.removeEventListener("pointerup", onEnd);
		el.removeEventListener("pointercancel", onEnd);
		el.removeEventListener("pointerleave", onEnd);
		el.removeEventListener("dragstart", cancel);
		el.removeEventListener("contextmenu", onContextMenuCapture, true);
		el.removeEventListener("click", onClickCapture, true);
	};
}
