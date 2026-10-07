/** G5b: the floor for "Refresh every [X] minutes" — a value below this, blank, zero or non-numeric is
 * rejected by the modal (`validateRefreshMinutes`) and never reaches a saved `ApiSourceConfig`; a value
 * that reaches one some other way (hand-edited `data.json`) is clamped up here on load instead. */
export const MIN_REFRESH_MINUTES = 5;

/** R2: `RefreshEveryTimers.start` passes `minutes * 60 * 1000` straight to `setTimeout`, which takes a
 * 32-bit signed integer of milliseconds — anything above `2^31 - 1` ms overflows and fires almost
 * immediately instead of after the requested delay, and `fire()` re-arms itself with the same
 * overflowing delay, so an Overwrite Folder with confirmation off would refresh (and delete) back to
 * back forever. Floored to the largest whole-minute value that still fits. */
export const MAX_REFRESH_MINUTES = Math.floor(2147483647 / 60000);

export type RefreshMinutesValidation = { ok: true; minutes: number } | { ok: false; error: string };

/** G5b: validates the modal's raw text-field input for "Refresh every [X] minutes". Blank, zero,
 * non-numeric, below-minimum and above-maximum values are all rejected with an inline message; only a
 * whole number between `MIN_REFRESH_MINUTES` and `MAX_REFRESH_MINUTES` is accepted. */
export function validateRefreshMinutes(raw: string): RefreshMinutesValidation {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, error: `Enter a number of minutes (minimum ${MIN_REFRESH_MINUTES}).` };
	if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Enter a whole number of minutes." };
	const minutes = Number(trimmed);
	if (minutes < MIN_REFRESH_MINUTES) return { ok: false, error: `Minimum is ${MIN_REFRESH_MINUTES} minutes.` };
	if (minutes > MAX_REFRESH_MINUTES) return { ok: false, error: `Maximum is ${MAX_REFRESH_MINUTES} minutes.` };
	return { ok: true, minutes };
}

/** Load-time safety net for a `refreshEveryMinutes` that reached storage outside the valid range some
 * other way (hand-edited `data.json`) — clamped into range rather than rejected outright, so the Folder
 * keeps refreshing (on a timer that can't overflow `setTimeout`) instead of silently losing its timer. */
export function clampRefreshMinutes(minutes: number): number {
	return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, minutes));
}

export interface RefreshTimerDeps {
	now: () => number;
	setTimeoutFn: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn: (handle: unknown) => void;
}

const realDeps: RefreshTimerDeps = {
	now: () => Date.now(),
	setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
	clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RefreshTimerNode {
	id: string;
	enabled: boolean;
	minutes: number;
	/** `node.apiCache?.fetchedAt ?? null` — used only to decide whether this Folder is "stale" enough
	 * to fire one immediate catch-up refresh when it (re)joins `sync()`. */
	lastFetchedAt: number | null;
}

interface Scheduled {
	handle: unknown;
	minutes: number;
}

/**
 * G5b/F3: one interval timer per API source that has "Refresh every X minutes" on (PR-1: Folder, CSV
 * and markdown-table sources never get one), alive only for as
 * long as this instance is told to run one (the caller starts it in the Atlas view's `onOpen` and
 * calls `stopAll()` from `onClose` — nothing here runs, or even exists, once the view is closed; F3's
 * "no scheduler outside the in-plugin toggles").
 *
 * `sync()` is the single entry point, called once on view open and again after every render (a saved
 * config change included) — it's idempotent: a Folder whose interval hasn't changed keeps its existing
 * timer untouched (no reset, no double-fire), one whose interval changed is rescheduled cleanly, and
 * one that's no longer eligible (toggle turned off, source removed/deleted) has its timer stopped.
 *
 * A source that's stale when it joins `sync()` — never refreshed, or longer than its own interval since
 * the last successful fetch — fires exactly one immediate catch-up refresh, then resumes its normal
 * interval from that moment; it never bursts through every tick it missed while the view was closed.
 */
export class RefreshEveryTimers {
	private scheduled = new Map<string, Scheduled>();

	constructor(private deps: RefreshTimerDeps = realDeps) {}

	sync(nodes: RefreshTimerNode[], onDue: (nodeId: string) => void): void {
		const liveIds = new Set(nodes.filter((n) => n.enabled).map((n) => n.id));
		for (const id of [...this.scheduled.keys()]) {
			if (!liveIds.has(id)) this.stop(id);
		}
		for (const node of nodes) {
			if (!node.enabled) continue;
			const minutes = clampRefreshMinutes(node.minutes);
			const existing = this.scheduled.get(node.id);
			if (existing && existing.minutes === minutes) continue;
			if (existing) this.stop(node.id);
			this.start(node.id, minutes, node.lastFetchedAt, onDue);
		}
	}

	private start(nodeId: string, minutes: number, lastFetchedAt: number | null, onDue: (nodeId: string) => void): void {
		const intervalMs = minutes * 60 * 1000;
		const now = this.deps.now();
		const overdue = lastFetchedAt === null || now - lastFetchedAt >= intervalMs;
		const delay = overdue ? 0 : intervalMs - (now - lastFetchedAt);

		const fire = () => {
			onDue(nodeId);
			const handle = this.deps.setTimeoutFn(fire, intervalMs);
			this.scheduled.set(nodeId, { handle, minutes });
		};
		const handle = this.deps.setTimeoutFn(fire, delay);
		this.scheduled.set(nodeId, { handle, minutes });
	}

	stop(nodeId: string): void {
		const existing = this.scheduled.get(nodeId);
		if (!existing) return;
		this.deps.clearTimeoutFn(existing.handle);
		this.scheduled.delete(nodeId);
	}

	stopAll(): void {
		for (const id of [...this.scheduled.keys()]) this.stop(id);
	}

	isScheduled(nodeId: string): boolean {
		return this.scheduled.has(nodeId);
	}
}
