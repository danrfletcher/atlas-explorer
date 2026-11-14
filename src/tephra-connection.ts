import type { ScheduleTimeout } from "./api-http";
import type { TephraCallResult, TephraError, TephraPushHandlers, TephraPushResult, TephraSocketHandle, TephraSource, TephraSourcesResult } from "./tephra-client";

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
	/** Opens the `graph:changed` push channel. Absent on a client without one: the connection then polls only. */
	openPush?(handlers: TephraPushHandlers): Promise<TephraPushResult>;
}

/** Timing of the push channel; injectable so tests control time. */
export interface TephraPushOptions {
	scheduleTimeout?: ScheduleTimeout;
	/** A burst of `graph:changed` notifications asks for at most one check per this long (the last one is kept). */
	cooldownMs?: number;
	/** The wait before the first reconnect; it doubles per failed attempt up to `reconnectMaxMs`. */
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
}

/** E6 (Atlas's half): a push triggers a check at once, then at most one more per second while a burst lasts. */
export const TEPHRA_PUSH_COOLDOWN_MS = 1000;
export const TEPHRA_PUSH_RECONNECT_BASE_MS = 1000;
export const TEPHRA_PUSH_RECONNECT_MAX_MS = 30_000;

const defaultScheduleTimeout: ScheduleTimeout = (ms, onTimeout) => {
	const timer = setTimeout(onTimeout, ms);
	return () => clearTimeout(timer);
};

/** Whether a pushed message is a `graph:changed` notification: a JSON-RPC notification (no `id`) with that
 * method. Anything else on the channel, including malformed text, is ignored. */
export function isGraphChangedMessage(text: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const message = parsed as Record<string, unknown>;
	return message.method === "graph:changed" && !("id" in message);
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
 * It also holds the push channel (`graph:changed`), when the client has one: each notification asks for a
 * check, so whatever Tephra announces shows within a second or two instead of at the next 10 s tick (E6,
 * Atlas's half: within 5 s of the push). Tephra dev b04c1cf announces no source register/unregister, so those
 * are seen at the 10 s tick (within 12 s) or on a focus check (within 2 s); that is the bound this meets, and
 * the 5 s bound for them needs a Tephra change, tracked on the Tephra side. The channel is an extra: if it
 * can't open or drops, the timer, the focus check and the failed-call check carry on, and it reconnects
 * with a growing wait. A reconnect also asks for a check, since pushes may have been missed in between.
 *
 * One check runs at a time (a second request while one is in flight joins it). The client can't abort a
 * request, so `stop()` drops the in-flight check's result instead: after `stop()` no state changes and no
 * listener fires, and `isChecking()` is false.
 */
export class TephraConnection {
	private snapshot: TephraSnapshot = OFF_SNAPSHOT;
	private listeners = new Set<(snapshot: TephraSnapshot) => void>();
	private checkListeners = new Set<(snapshot: TephraSnapshot) => void>();
	private stopTimer: (() => void) | null = null;
	private inFlight: Promise<void> | null = null;
	/** Bumped by `stop()`: a check that started in an earlier run must not write its result. */
	private generation = 0;
	private recheckQueued = false;

	private readonly scheduleTimeout: ScheduleTimeout;
	private readonly cooldownMs: number;
	private readonly reconnectBaseMs: number;
	private readonly reconnectMaxMs: number;
	/** The open push channel, and the attempt that opened it (a close from an older attempt is ignored). */
	private pushHandle: TephraSocketHandle | null = null;
	private pushSession: object | null = null;
	private pushConnecting = false;
	private pushFailures = 0;
	private cancelPushRetry: (() => void) | null = null;
	private cancelPushCooldown: (() => void) | null = null;
	private pushPending = false;

	constructor(
		private readonly client: TephraConnectionClient,
		private readonly scheduleInterval: ScheduleInterval = defaultScheduleInterval,
		private readonly intervalMs: number = TEPHRA_CHECK_INTERVAL_MS,
		pushOptions: TephraPushOptions = {}
	) {
		this.scheduleTimeout = pushOptions.scheduleTimeout ?? defaultScheduleTimeout;
		this.cooldownMs = pushOptions.cooldownMs ?? TEPHRA_PUSH_COOLDOWN_MS;
		this.reconnectBaseMs = pushOptions.reconnectBaseMs ?? TEPHRA_PUSH_RECONNECT_BASE_MS;
		this.reconnectMaxMs = pushOptions.reconnectMaxMs ?? TEPHRA_PUSH_RECONNECT_MAX_MS;
	}

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

	/** Subscribes to every finished check, whether or not it changed the snapshot (a `.gitignore` edit changes
	 * nothing `source.list` returns, yet `Sources/` work still has to look again). Not called after `stop()`. */
	onCheck(listener: (snapshot: TephraSnapshot) => void): () => void {
		this.checkListeners.add(listener);
		return () => this.checkListeners.delete(listener);
	}

	/** A `graph:changed` notification, or Obsidian regaining focus: asks for a check now. */
	requestCheck(): void {
		this.noteFailedCall();
	}

	/** Starts the timer and the first check. Calling it again while running does nothing (never two timers). */
	start(): void {
		if (this.stopTimer) return;
		this.stopTimer = this.scheduleInterval(this.intervalMs, () => void this.check());
		this.setSnapshot({ state: "offline", checked: false, sources: [], error: null });
		void this.check();
		void this.startPush();
	}

	/** Stops the timer, forgets any check in flight, and goes to `off`. Safe to call when not running. */
	stop(): void {
		this.stopTimer?.();
		this.stopTimer = null;
		this.generation++;
		this.inFlight = null;
		this.recheckQueued = false;
		this.stopPush();
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

	/** One `graph:changed` push: asks for a check, but a burst of them is held to one check per cooldown. */
	private onPushText(generation: number, text: string): void {
		if (generation !== this.generation || !isGraphChangedMessage(text)) return;
		if (this.cancelPushCooldown) {
			this.pushPending = true; // inside the cooldown: remembered, and run when it ends
			return;
		}
		this.requestCheck();
		this.cancelPushCooldown = this.scheduleTimeout(this.cooldownMs, () => {
			this.cancelPushCooldown = null;
			if (this.pushPending) {
				this.pushPending = false;
				this.requestCheck();
			}
		});
	}

	private async startPush(): Promise<void> {
		const client = this.client;
		if (!client.openPush || !this.stopTimer || this.pushHandle || this.pushConnecting || this.cancelPushRetry) return;
		const generation = this.generation;
		const session = {};
		let closedEarly = false;
		this.pushConnecting = true;
		let result: TephraPushResult;
		try {
			result = await client.openPush({
				onText: (text) => {
					if (this.pushSession === session) this.onPushText(generation, text);
				},
				onClose: () => {
					if (this.pushSession === session) this.pushLost(generation);
					else closedEarly = true;
				},
			});
		} catch {
			result = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };
		}
		if (generation !== this.generation) {
			if (result.ok) result.handle.close(); // stopped (or restarted) while it was opening
			return;
		}
		this.pushConnecting = false;
		if (!result.ok || closedEarly) {
			if (result.ok) result.handle.close();
			this.scheduleReconnect(generation);
			return;
		}
		this.pushHandle = result.handle;
		this.pushSession = session;
		this.pushFailures = 0;
		this.requestCheck(); // anything pushed while there was no channel was missed
	}

	private pushLost(generation: number): void {
		if (generation !== this.generation) return;
		this.pushHandle = null;
		this.pushSession = null;
		this.scheduleReconnect(generation);
	}

	private scheduleReconnect(generation: number): void {
		if (generation !== this.generation || this.cancelPushRetry) return;
		const wait = Math.min(this.reconnectBaseMs * 2 ** this.pushFailures, this.reconnectMaxMs);
		this.pushFailures++;
		this.cancelPushRetry = this.scheduleTimeout(wait, () => {
			this.cancelPushRetry = null;
			void this.startPush();
		});
	}

	private stopPush(): void {
		this.cancelPushRetry?.();
		this.cancelPushRetry = null;
		this.cancelPushCooldown?.();
		this.cancelPushCooldown = null;
		this.pushPending = false;
		this.pushFailures = 0;
		this.pushConnecting = false;
		this.pushSession = null;
		const handle = this.pushHandle;
		this.pushHandle = null;
		handle?.close();
	}

	private finishCheck(generation: number, result: TephraSourcesResult): void {
		if (generation !== this.generation) return; // stopped (or restarted) while this was in flight
		if (result.ok) this.setSnapshot({ state: "online", checked: true, sources: result.sources, error: null });
		else this.setSnapshot({ state: "offline", checked: true, sources: [], error: result.error });
		if (result.ok) void this.startPush(); // Tephra answered: if the channel isn't up and no retry is waiting, try now
		for (const listener of [...this.checkListeners]) {
			try {
				listener(this.snapshot);
			} catch (error) {
				console.error("[Atlas] a Tephra check listener threw", error);
			}
		}
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
