/** How long a pointer must be held on a module row before Module Contents opens. */
export const LONG_PRESS_MS = 500;

/** How far (px, straight-line) the pointer may wander during the hold before it counts as a drag or a
 * scroll rather than a press, cancelling the timer. */
export const LONG_PRESS_SLOP_PX = 6;

export interface LongPressTimers {
	setTimeoutFn: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn: (handle: unknown) => void;
}

const realTimers: LongPressTimers = {
	setTimeoutFn: (cb, ms) => window.setTimeout(cb, ms),
	clearTimeoutFn: (handle) => window.clearTimeout(handle as number),
};

/** Elements inside a row that own their own click (remove button, chevron): a hold on one is theirs. */
const IGNORED_TARGETS = ".atlas-row-action, .atlas-chevron";

/** Wires a 500 ms press-and-hold on `el` (mouse, touch or pen; primary button only) and calls
 * `onLongPress` when it completes. The hold is cancelled by: release before the threshold, the pointer
 * moving more than `LONG_PRESS_SLOP_PX` from where it went down, a pointer cancel/leave, a native drag
 * starting, or a `contextmenu` (so the long press never collides with the right-click menu).
 *
 * Once a long press has fired, the click the browser sends on release is swallowed (capture phase, so
 * neither the row's selection/open handlers nor a status dot's own click see it). A hold that is
 * released early never fires, so its click runs as normal. Returns a function that removes every
 * listener and clears a pending timer. */
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

	const cancel = () => {
		if (timer === undefined) return;
		timers.clearTimeoutFn(timer);
		timer = undefined;
	};
	const onDown = (evt: MouseEvent) => {
		swallowClick = false; // a fresh press: whatever the last one left behind is stale
		cancel();
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
	const onClickCapture = (evt: Event) => {
		if (!swallowClick) return;
		swallowClick = false;
		evt.stopPropagation();
		evt.preventDefault();
	};

	el.addEventListener("pointerdown", onDown);
	el.addEventListener("pointermove", onMove);
	el.addEventListener("pointerup", cancel);
	el.addEventListener("pointercancel", cancel);
	el.addEventListener("pointerleave", cancel);
	el.addEventListener("dragstart", cancel);
	el.addEventListener("contextmenu", cancel);
	el.addEventListener("click", onClickCapture, true);
	return () => {
		cancel();
		el.removeEventListener("pointerdown", onDown);
		el.removeEventListener("pointermove", onMove);
		el.removeEventListener("pointerup", cancel);
		el.removeEventListener("pointercancel", cancel);
		el.removeEventListener("pointerleave", cancel);
		el.removeEventListener("dragstart", cancel);
		el.removeEventListener("contextmenu", cancel);
		el.removeEventListener("click", onClickCapture, true);
	};
}
