import type { TephraCallResult, TephraError, TephraSource, TephraSourcesResult } from "./tephra-client";

/** G13/G16: the connection checks Tephra this often while the toggle is on. */
export const TEPHRA_CHECK_INTERVAL_MS = 10_000;

/** `off`: the toggle is off (or this is mobile) and nothing runs. `offline`: on, but Tephra didn't answer
 * `source.list` properly. `online`: it did. */
export type TephraConnectionState = "off" | "offline" | "online";

export interface TephraSnapshot {
	state: TephraConnectionState;
	/** Whether at least one check has finished since the connection started. Until then `offline` only
	 * means "not known yet", and the settings tab shows "Checking…" instead of "Tephra isn't running". */
	checked: boolean;
	/** What the last successful `source.list` returned; empty unless `online`. */
	sources: TephraSource[];
	/** Why the last check failed; null unless `offline` after a check. */
	error: TephraError | null;
}

/** The part of `TephraClient` the connection needs. */
export interface TephraConnectionClient {
	listSources(): Promise<TephraSourcesResult>;
	call(method: string, params?: unknown): Promise<TephraCallResult>;
}

/** Starts a repeating timer (every `ms`) and returns a function that stops it. Injectable so tests control time. */
export type ScheduleInterval = (ms: number, tick: () => void) => () => void;

/** A chain of one-shot timeouts rather than a repeating interval timer: the repo's timer fence (F4) keeps those
 * out of `src`. Exactly one timeout is pending at a time, so stopping clears the whole chain. */
const defaultScheduleInterval: ScheduleInterval = (ms, tick) => {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const arm = () => {
		timer = setTimeout(() => {
			if (stopped) return;
			arm(); // re-arm first, so a throwing tick can't end the chain
			tick();
		}, ms);
	};
	arm();
	return () => {
		stopped = true;
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
};

const OFF_SNAPSHOT: TephraSnapshot = { state: "off", checked: false, sources: [], error: null };

/**
 * G13/G16: Tephra's connection state, kept fresh by a `source.list` check every 10 seconds and after any
 * failed call. It exists only between `start()` and `stop()`; with the toggle off nothing here is
 * constructed, so there is no timer and no call.
 *
 * One check runs at a time (a second request while one is in flight joins it). The client can't abort a
 * request, so `stop()` drops the in-flight check's result instead: after `stop()` no state changes and no
 * listener fires, and `isChecking()` is false.
 */
export class TephraConnection {
	private snapshot: TephraSnapshot = OFF_SNAPSHOT;
	private listeners = new Set<(snapshot: TephraSnapshot) => void>();
	private stopTimer: (() => void) | null = null;
	private inFlight: Promise<void> | null = null;
	/** Bumped by `stop()`: a check that started in an earlier run must not write its result. */
	private generation = 0;
	private recheckQueued = false;

	constructor(
		private readonly client: TephraConnectionClient,
		private readonly scheduleInterval: ScheduleInterval = defaultScheduleInterval,
		private readonly intervalMs: number = TEPHRA_CHECK_INTERVAL_MS
	) {}

	getSnapshot(): TephraSnapshot {
		return this.snapshot;
	}

	isRunning(): boolean {
		return this.stopTimer !== null;
	}

	isChecking(): boolean {
		return this.inFlight !== null;
	}

	/** Subscribes to snapshot changes; returns the unsubscribe function. */
	onChange(listener: (snapshot: TephraSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts the timer and the first check. Calling it again while running does nothing (never two timers). */
	start(): void {
		if (this.stopTimer) return;
		this.stopTimer = this.scheduleInterval(this.intervalMs, () => void this.check());
		this.setSnapshot({ state: "offline", checked: false, sources: [], error: null });
		void this.check();
	}

	/** Stops the timer, forgets any check in flight, and goes to `off`. Safe to call when not running. */
	stop(): void {
		this.stopTimer?.();
		this.stopTimer = null;
		this.generation++;
		this.inFlight = null;
		this.recheckQueued = false;
		this.setSnapshot(OFF_SNAPSHOT);
	}

	/** Runs `source.list` now. While a check is already running it joins that one. Resolves when done. */
	check(): Promise<void> {
		if (!this.stopTimer) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		const generation = this.generation;
		const run = this.client.listSources().then(
			(result) => this.finishCheck(generation, result),
			() => this.finishCheck(generation, { ok: false, error: { kind: "network", message: "Tephra is unreachable" } })
		);
		const tracked = run.finally(() => {
			if (this.generation === generation && this.inFlight === tracked) this.inFlight = null;
			if (this.generation === generation && this.recheckQueued) {
				this.recheckQueued = false;
				void this.check();
			}
		});
		this.inFlight = tracked;
		return tracked;
	}

	/** Makes a call through the client; a failure triggers a check, so a dead daemon shows within one call
	 * rather than after the next tick. The check's own `source.list` goes straight to the client. */
	async call(method: string, params?: unknown): Promise<TephraCallResult> {
		const result = await this.client.call(method, params);
		if (!result.ok) this.noteFailedCall();
		return result;
	}

	/** For a caller that made its own request: asks for a check. Ignored when stopped. */
	noteFailedCall(): void {
		if (!this.stopTimer) return;
		if (this.inFlight) {
			// A check that began before this failure may predate it: run one more when it ends.
			this.recheckQueued = true;
			return;
		}
		void this.check();
	}

	private finishCheck(generation: number, result: TephraSourcesResult): void {
		if (generation !== this.generation) return; // stopped (or restarted) while this was in flight
		if (result.ok) this.setSnapshot({ state: "online", checked: true, sources: result.sources, error: null });
		else this.setSnapshot({ state: "offline", checked: true, sources: [], error: result.error });
	}

	private setSnapshot(next: TephraSnapshot): void {
		if (snapshotsEqual(this.snapshot, next)) return;
		this.snapshot = next;
		for (const listener of [...this.listeners]) {
			try {
				listener(next);
			} catch (error) {
				console.error("[Atlas] a Tephra connection listener threw", error);
			}
		}
	}
}

function snapshotsEqual(a: TephraSnapshot, b: TephraSnapshot): boolean {
	if (a === b) return true;
	return a.state === b.state && a.checked === b.checked && a.error?.kind === b.error?.kind && a.error?.message === b.error?.message && sourcesEqual(a.sources, b.sources);
}

function sourcesEqual(a: TephraSource[], b: TephraSource[]): boolean {
	return a.length === b.length && a.every((s, i) => s.name === b[i].name && s.path === b[i].path && s.status === b[i].status);
}
