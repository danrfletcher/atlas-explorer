/** PR-1 (G5): trailing debounce for live Inside-Vault Folder refreshes. A burst of vault events for one
 * source (a bulk move of 500 files, a save that renames twice) collapses into one refresh that fires
 * 300 ms after the last event, but never later than 2 s after the first — so a continuous stream still
 * refreshes at least every 2 s instead of starving the source forever. */
export const FOLDER_LIVE_REFRESH_DEBOUNCE_MS = 300;
export const FOLDER_LIVE_REFRESH_MAX_WAIT_MS = 2000;

export interface FolderLiveRefreshTimers {
	setTimeoutFn: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn: (handle: unknown) => void;
}

const realTimers: FolderLiveRefreshTimers = {
	setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
	clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Pending {
	debounce: unknown;
	maxWait: unknown;
}

/** One instance per plugin (not per Atlas leaf), so two open leaves never mean two refreshes of the
 * same source. Keyed by source node id: two sources on the same folder are two nodes, so each gets
 * exactly one refresh (E4). PR-2 reuses it for outside-folder watchers, keyed by folder path instead,
 * with a longer quiet period (`debounceMs`). */
export class FolderLiveRefresh {
	private pending = new Map<string, Pending>();

	constructor(
		private onDue: (nodeId: string) => void,
		private timers: FolderLiveRefreshTimers = realTimers,
		private debounceMs: number = FOLDER_LIVE_REFRESH_DEBOUNCE_MS
	) {}

	schedule(nodeId: string): void {
		const existing = this.pending.get(nodeId);
		if (existing) this.timers.clearTimeoutFn(existing.debounce);
		const entry: Pending = existing ?? {
			debounce: undefined,
			maxWait: this.timers.setTimeoutFn(() => this.fire(nodeId), FOLDER_LIVE_REFRESH_MAX_WAIT_MS),
		};
		entry.debounce = this.timers.setTimeoutFn(() => this.fire(nodeId), this.debounceMs);
		this.pending.set(nodeId, entry);
	}

	/** Drops one key's pending refresh without firing it. A key with nothing pending is a no-op. */
	cancel(nodeId: string): void {
		const entry = this.pending.get(nodeId);
		if (!entry) return;
		this.timers.clearTimeoutFn(entry.debounce);
		this.timers.clearTimeoutFn(entry.maxWait);
		this.pending.delete(nodeId);
	}

	/** Drops every pending refresh without firing it — called from `onunload`, so nothing runs after
	 * the plugin is gone. */
	cancelAll(): void {
		for (const entry of this.pending.values()) {
			this.timers.clearTimeoutFn(entry.debounce);
			this.timers.clearTimeoutFn(entry.maxWait);
		}
		this.pending.clear();
	}

	private fire(nodeId: string): void {
		const entry = this.pending.get(nodeId);
		if (!entry) return;
		this.timers.clearTimeoutFn(entry.debounce);
		this.timers.clearTimeoutFn(entry.maxWait);
		this.pending.delete(nodeId);
		this.onDue(nodeId);
	}
}
