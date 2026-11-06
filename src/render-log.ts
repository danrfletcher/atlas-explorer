import { Debouncer, debounce } from "obsidian";

/**
 * Always-on log of every explorer pane rebuild: what asked for it, when, how long it took and whether
 * the rebuilt output differed from the one before. It exists so the trigger behind a list flash can be
 * named from evidence; it changes no rendering. There is deliberately no setting that switches it off.
 *
 * Privacy: an entry holds exactly four fields (kind, at, durationMs, changed) — no note text, no
 * labels, no paths. It lives in `<plugin dir>/render-log.json`, never in `data.json`, and is written
 * only through the vault adapter (it never touches a note).
 */

export const RENDER_LOG_CAP = 500;
export const RENDER_LOG_FILE = "render-log.json";
/** Quiet period before a changed log is written. Not reset by further renders, so a busy session
 * still writes once per window rather than never. */
export const RENDER_LOG_SAVE_DELAY_MS = 2000;

export const RENDER_TRIGGER_KINDS = [
	"unit-index",
	"views-change",
	"leaf-activate",
	"folder-source-refresh",
	"settings",
	"click",
	"drop",
	"filter",
	"other",
] as const;

export type RenderTriggerKind = (typeof RENDER_TRIGGER_KINDS)[number];

export interface RenderLogEntry {
	kind: RenderTriggerKind;
	/** Epoch ms when the render started. */
	at: number;
	durationMs: number;
	/** Whether the rebuilt pane's output differed from the previous render's (the first render is true). */
	changed: boolean;
}

/** The slice of Obsidian's `DataAdapter` the log uses — a fake adapter in tests implements just this. */
export interface RenderLogAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

/** Returns a clean copy with exactly the four entry fields, or null when `raw` isn't a valid entry. */
function sanitizeEntry(raw: unknown): RenderLogEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { kind, at, durationMs, changed } = raw as Record<string, unknown>;
	if (!(RENDER_TRIGGER_KINDS as readonly unknown[]).includes(kind)) return null;
	if (typeof at !== "number" || !Number.isFinite(at)) return null;
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
	if (typeof changed !== "boolean") return null;
	return { kind: kind as RenderTriggerKind, at, durationMs, changed };
}

export class RenderLog {
	private items: RenderLogEntry[] = [];
	/** Entries exist that the file doesn't have yet. */
	private dirty = false;
	private disposed = false;
	/** Writes run strictly one after another, so overlapping saves can never land out of order. */
	private writeChain: Promise<void> = Promise.resolve();
	private saveDebounced: Debouncer<[], void>;

	constructor(private adapter: RenderLogAdapter, private path: string) {
		this.saveDebounced = debounce(() => void this.write(), RENDER_LOG_SAVE_DELAY_MS, false);
	}

	/** Reads the saved log. A missing, empty or corrupt file starts an empty log (the next save
	 * overwrites it); a file with some bad entries keeps the good ones. Never throws. */
	async load(): Promise<void> {
		let loaded: RenderLogEntry[] = [];
		try {
			if (await this.adapter.exists(this.path)) {
				const parsed: unknown = JSON.parse(await this.adapter.read(this.path));
				if (Array.isArray(parsed)) {
					loaded = parsed.map(sanitizeEntry).filter((e): e is RenderLogEntry => e !== null);
				}
			}
		} catch {
			loaded = [];
		}
		// Anything recorded while the file was being read stays after the older, loaded entries.
		this.items = [...loaded, ...this.items].slice(-RENDER_LOG_CAP);
	}

	/** Appends one entry (oldest first), evicting the oldest beyond the cap, and schedules a save. */
	record(entry: RenderLogEntry): void {
		this.items.push({ kind: entry.kind, at: entry.at, durationMs: entry.durationMs, changed: entry.changed });
		if (this.items.length > RENDER_LOG_CAP) this.items.splice(0, this.items.length - RENDER_LOG_CAP);
		this.dirty = true;
		if (!this.disposed) this.saveDebounced();
	}

	entries(): RenderLogEntry[] {
		return this.items.map((e) => ({ ...e }));
	}

	/** The text written to the file and put on the clipboard: valid JSON, one entry per line. */
	serialize(): string {
		if (this.items.length === 0) return "[]";
		return `[\n${this.items.map((e) => JSON.stringify(e)).join(",\n")}\n]`;
	}

	/** Writes now if anything changed since the last write, dropping the pending debounced save.
	 * Resolves once every queued write has finished. Never rejects. */
	flush(): Promise<void> {
		this.saveDebounced.cancel();
		if (this.dirty) return this.write();
		return this.writeChain;
	}

	/** Final flush for plugin unload; entries recorded afterwards no longer schedule a write. */
	dispose(): Promise<void> {
		this.disposed = true;
		return this.flush();
	}

	private write(): Promise<void> {
		this.writeChain = this.writeChain.then(async () => {
			if (!this.dirty) return;
			this.dirty = false;
			try {
				await this.adapter.write(this.path, this.serialize());
			} catch {
				// A failed write must never break rendering or unload. The entries stay in memory and
				// the next record() (or flush) tries again.
				this.dirty = true;
			}
		});
		return this.writeChain;
	}
}

// --- trigger attribution -----------------------------------------------------------------------

let activeCause: RenderTriggerKind | null = null;

/** Runs `fn` with `kind` named as the cause of any render the explorer queues synchronously inside it
 * (the stores' change callbacks fire inline). The outermost cause wins, so a leaf activation that
 * refreshes sources is logged as `leaf-activate`, not as the refresh it started. */
export function withRenderCause<T>(kind: RenderTriggerKind, fn: () => T): T {
	const outer = activeCause;
	if (outer === null) activeCause = kind;
	try {
		return fn();
	} finally {
		activeCause = outer;
	}
}

/** The cause in effect (the outermost enclosing `withRenderCause`), or `fallback` outside one. */
export function renderCauseOr(fallback: RenderTriggerKind): RenderTriggerKind {
	return activeCause ?? fallback;
}

/** What `observeRender` needs to know about one `render()` call. */
export interface RenderObservation {
	kind: RenderTriggerKind;
	/** Epoch ms when the render started. */
	at: number;
	/** `performance.now()` when the render started. */
	t0: number;
	/** False once a newer render has superseded this one. */
	isCurrent(): boolean;
	/** The pane's output as it stands now. */
	readOutput(): string;
	/** The view's remembered output of its last finished render; updated in place. */
	lastOutput: { last: string | null };
}

/** Records exactly one log entry for `rendering` once it settles — finished, superseded by a newer
 * render, or thrown — and returns a promise that settles the same way `rendering` did. The log is
 * observation only: a failure while logging is swallowed and never replaces the render's result or
 * error. A superseded render logs `changed: false` and leaves the remembered output alone, since the
 * pane then belongs to the newer render. */
export async function observeRender(log: RenderLog, rendering: Promise<void>, obs: RenderObservation): Promise<void> {
	try {
		await rendering;
	} finally {
		try {
			const durationMs = Math.max(0, Math.round(performance.now() - obs.t0));
			let changed = false;
			if (obs.isCurrent()) {
				const output = obs.readOutput();
				changed = output !== obs.lastOutput.last;
				obs.lastOutput.last = output;
			}
			log.record({ kind: obs.kind, at: obs.at, durationMs, changed });
		} catch {
			// Logging must never turn a render result or error into a different one.
		}
	}
}
