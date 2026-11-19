import { fetchAllEdges, type TephraCaller, type TephraEdge } from "./tephra-backlinks";

/** Injectable timer, as in `TephraConnection`: starts one and returns its cancel function. */
export type ScheduleTimer = (ms: number, onTimeout: () => void) => () => void;

const defaultSchedule: ScheduleTimer = (ms, onTimeout) => {
	const timer = setTimeout(onTimeout, ms);
	return () => clearTimeout(timer);
};

/** A burst of `graph:changed` notifications waits this long after the last one before one refresh (E6/G12). */
export const GRAPH_SYNC_DEBOUNCE_MS = 300;
/** ...but a stream that never pauses still refreshes at least this often. */
export const GRAPH_SYNC_MAX_WAIT_MS = 2000;

/** The part of `TephraConnection` this reads. */
export interface GraphSyncConnection extends TephraCaller {
	onGraphChanged(listener: () => void): () => void;
	onChange(listener: (snapshot: { state: string }) => void): () => void;
}

export interface TephraGraphSyncDeps {
	/** Hands Tephra's latest edges to the unit index (it recomputes promotions). True when the promoted set changed. */
	setEdges: (edges: readonly TephraEdge[]) => boolean;
	/** Forgets them (toggle off). */
	clearEdges: () => boolean;
	/** After every refresh attempt, good or not, and after a clear: the Backlinks section re-reads the active file. */
	afterRefresh: (promotionsChanged: boolean) => void;
	scheduleTimeout?: ScheduleTimer;
	debounceMs?: number;
	maxWaitMs?: number;
}

/**
 * G12 (Atlas's half of "graph:changed recomputes promotions"). Keeps the unit index's non-note edge set, which is
 * only ever Tephra's last answer to `graph.get_edges`, held in memory. One fetch each time Tephra becomes reachable (first answer, or back after a drop),
 * and one per burst of `graph:changed` notifications: a trailing debounce, so 50 notifications within a second
 * make one `graph.get_edges` call and one `computePromotions`. A failed call keeps the previous answer (the
 * promotions don't flicker when Tephra drops); nothing is written anywhere.
 *
 * What the daemon really pushes today is stated by the caller's tests with a stand-in frame; this class only
 * knows the notification arrived.
 */
export class TephraGraphSync {
	private connection: GraphSyncConnection | null = null;
	private unsubscribers: Array<() => void> = [];
	private cancelDebounce: (() => void) | null = null;
	private cancelMaxWait: (() => void) | null = null;
	/** Bumped by `unbind()`: a fetch that began before it must not write. */
	private generation = 0;
	private online = false;
	private readonly schedule: ScheduleTimer;
	private readonly debounceMs: number;
	private readonly maxWaitMs: number;

	constructor(private readonly deps: TephraGraphSyncDeps) {
		this.schedule = deps.scheduleTimeout ?? defaultSchedule;
		this.debounceMs = deps.debounceMs ?? GRAPH_SYNC_DEBOUNCE_MS;
		this.maxWaitMs = deps.maxWaitMs ?? GRAPH_SYNC_MAX_WAIT_MS;
	}

	/** Starts following a connection (a previous one is dropped first). */
	bind(connection: GraphSyncConnection): void {
		this.unbind(false);
		this.connection = connection;
		this.unsubscribers = [
			connection.onGraphChanged(() => this.notePush()),
			connection.onChange((snapshot) => {
				const wasOnline = this.online;
				this.online = snapshot.state === "online";
				if (this.online && !wasOnline) this.requestNow(); // first answer, or back after a drop: pushes may have been missed
			
			}),
		];
	}

	/** Stops following and, when `clear`, forgets the edge set (toggle off). Safe to call when not bound. */
	unbind(clear = true): void {
		this.generation++;
		this.cancelTimers();
		for (const off of this.unsubscribers) off();
		this.unsubscribers = [];
		this.connection = null;
		this.online = false;
		if (clear) {
			this.deps.afterRefresh(this.deps.clearEdges());
		}
	}

	/** One `graph:changed`: restarts the quiet-period timer; a max-wait timer bounds a stream that never pauses. */
	private notePush(): void {
		if (!this.connection) return;
		this.cancelDebounce?.();
		this.cancelDebounce = this.schedule(this.debounceMs, () => this.requestNow());
		this.cancelMaxWait ??= this.schedule(this.maxWaitMs, () => this.requestNow());
	}

	private cancelTimers(): void {
		this.cancelDebounce?.();
		this.cancelDebounce = null;
		this.cancelMaxWait?.();
		this.cancelMaxWait = null;
	}

	/** Fetches now. The latest call wins: an older answer arriving later is dropped. */
	requestNow(): Promise<void> {
		this.cancelTimers();
		const connection = this.connection;
		if (!connection) return Promise.resolve();
		const generation = ++this.generation;
		return fetchAllEdges(connection).then((edges) => {
			if (generation !== this.generation) return; // a newer fetch started, or we were unbound
			// null: Tephra failed; keep what we had
			this.deps.afterRefresh(edges !== null && this.deps.setEdges(edges));
		});
	}
}
