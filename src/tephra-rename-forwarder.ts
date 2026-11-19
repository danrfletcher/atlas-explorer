import type { TephraCallResult } from "./tephra-client";
import type { QueuedRename, TephraRenameQueue } from "./tephra-rename-queue";

/**
 * Tephra part 2's rename-event intake (`link.rename_event`, on Tephra's `dev`): `{ old_path, new_path }`, two
 * ABSOLUTE paths on disk. Tephra refuses a relative one (`invalid_params`), so Atlas queues the exact vault paths
 * Obsidian reported and prefixes the vault's folder on the way out (`toAbsolutePath`); Tephra resolves the symlink in
 * `Sources/<name>/…` and maps the path to its source by the longest root. A JSON-RPC result is the acknowledgement:
 * `applied`, `partial` (some files left for a retry or a person: Tephra keeps them in its pending fixes, so Atlas drops
 * the entry and tells the user), `already_applied` or `nothing_to_fix`. An error reply means Tephra refused. The error
 * "file changed, try again" is the stale-file refusal (E7), kept for a Tephra that answers it that way.
 */
export const TEPHRA_RENAME_METHOD = "link.rename_event";

/** Tephra's own wording for a file that changed between reading it and rewriting it (E7). Matched case-insensitively. */
export const TEPHRA_STALE_MESSAGE = "file changed, try again";

/** The path Tephra is sent: the vault's own folder (absolute, no trailing slash) plus the vault path, byte for byte. */
export function toAbsolutePath(vaultRoot: string, vaultPath: string): string {
	return `${vaultRoot.replace(/[\\/]+$/, "")}/${vaultPath}`;
}

/** JSON-RPC "method not found": a Tephra without part 2. The queue then waits, whole, for a Tephra that has it. */
const METHOD_NOT_FOUND = -32601;

/** A folder rename fires one event for the folder and one per child; the child events (before or after the
 * folder's own) are dropped when they are exactly the folder's move. Events are held this long before the
 * first send, so a whole burst is in the queue before anything leaves. */
export const RENAME_COALESCE_MS = 50;
/** How long a folder rename stays on record to recognise its children's events as its own. */
export const FOLDER_RENAME_WINDOW_MS = 2000;
/** E7: how many extra times a stale-file reply is retried (a pause between each) before the entry is dropped. */
export const STALE_MAX_RETRIES = 3;
export const STALE_RETRY_DELAY_MS = 1000;

export interface RenameCaller {
	isOnline(): boolean;
	call(method: string, params?: unknown): Promise<TephraCallResult>;
}

export interface RenameScheduler {
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RenameForwarderDeps {
	queue: TephraRenameQueue;
	scheduler: RenameScheduler;
	now(): number;
	/** True while the toggle is on and this is desktop. With it off nothing is queued and nothing is sent. */
	isActive(): boolean;
	/** The live Tephra connection, or null (toggle off). */
	getConnection(): RenameCaller | null;
	/** The vault's absolute folder on disk, or null when the vault isn't on a filesystem (nothing can be sent then). */
	getVaultRoot(): string | null;
	/** A Notice. */
	notify(message: string): void;
	log(message: string, detail?: unknown): void;
}

type SendOutcome = "ack" | "stale" | "rejected" | "unsupported" | "unreachable";

interface FolderRename {
	oldPath: string;
	newPath: string;
	at: number;
}

/** Whether a child's move (`oldPath` → `newPath`) is exactly what moving the folder did to it. */
function isCoveredByFolder(folder: { oldPath: string; newPath: string }, oldPath: string, newPath: string): boolean {
	const oldPrefix = `${folder.oldPath}/`;
	const newPrefix = `${folder.newPath}/`;
	return oldPath.startsWith(oldPrefix) && newPath.startsWith(newPrefix) && oldPath.slice(oldPrefix.length) === newPath.slice(newPrefix.length);
}

/**
 * G11 (PR-10): hands every Obsidian rename to Tephra, in order, with the exact old and new vault paths.
 *
 * Write-ahead: `record()` puts the rename in the on-disk queue before it returns, whether or not Tephra is up, and
 * one drain loop sends the queue head first and removes an entry only once Tephra acknowledges it. So an offline
 * Tephra, a drop mid-send, a crash and a restart all resume from the first unacknowledged entry, and nothing is
 * sent twice after its acknowledgement or skipped. (A call that timed out may have been applied by Tephra and is
 * sent again: delivery is at-least-once.)
 *
 * Atlas never rewrites a link or any file content itself, on any reply (F3): an error reply only means the
 * links stay as they are until Tephra rewrites them.
 *
 * With the toggle off (or on mobile) `record()` does nothing: no queueing, no sending. `dispose()` (plugin unload)
 * stops the timers and leaves the queue file exactly as it is (E8).
 */
export class TephraRenameForwarder {
	private draining: Promise<void> | null = null;
	private drainTimer: unknown = null;
	private inFlightSeq: number | null = null;
	private disposed = false;
	private recentFolders: FolderRename[] = [];
	private attempts = new Map<number, number>();
	private noticed = new Set<number>();
	private unsupportedNoticed = false;
	private waiters = new Set<{ oldPath: string; newPath: string; cb: () => void }>();
	private retryWake: (() => void) | null = null;

	constructor(private readonly deps: RenameForwarderDeps) {}

	/** Reads the queue file (once). Called when the toggle is on at plugin load and when it is turned on. */
	load(): void {
		this.deps.queue.load();
	}

	/** Records one Obsidian rename. Returns whether it was queued (false: toggle off, or a folder's own child event). */
	record(oldPath: string, newPath: string, isFolder: boolean): boolean {
		if (this.disposed || !this.deps.isActive() || oldPath === newPath) return false;
		const { queue } = this.deps;
		queue.load();
		const now = this.deps.now();
		this.recentFolders = this.recentFolders.filter((folder) => now - folder.at <= FOLDER_RENAME_WINDOW_MS);
		// A child event that arrives after its folder's own: the folder's event already says everything.
		if (this.recentFolders.some((folder) => isCoveredByFolder(folder, oldPath, newPath))) return false;
		if (isFolder) {
			// Child events that arrived first (Obsidian may report a child before its folder): fold them in. The one
			// being sent right now stays; Tephra already has it.
			queue.removeWhere((entry) => entry.seq !== this.inFlightSeq && isCoveredByFolder({ oldPath, newPath }, entry.oldPath, entry.newPath));
			this.recentFolders.push({ oldPath, newPath, at: now });
		}
		queue.enqueue(oldPath, newPath);
		this.scheduleDrain();
		return true;
	}

	/** Entries Tephra hasn't acknowledged yet (a copy, oldest first). */
	pending(): readonly QueuedRename[] {
		return [...this.deps.queue.entries()];
	}

	/**
	 * R3-6: calls `cb` once when Tephra has dealt with the rename `oldPath` → `newPath` (acknowledged it, or
	 * answered it with an error and dropped it): graduation waits on this instead of Obsidian's own link rewrite.
	 * Returns a function that stops waiting.
	 */
	whenAcknowledged(oldPath: string, newPath: string, cb: () => void): () => void {
		const waiter = { oldPath, newPath, cb };
		this.waiters.add(waiter);
		return () => void this.waiters.delete(waiter);
	}

	/** A finished Tephra check that found it online, or anything else that may have made sending possible. */
	kick(): void {
		if (this.disposed || !this.deps.isActive() || this.deps.queue.size() === 0) return;
		this.scheduleDrain();
	}

	/** Sends now (skipping the coalescing wait) and resolves when the queue is empty or sending had to stop. */
	async flush(): Promise<void> {
		this.cancelDrainTimer();
		await this.drain();
	}

	/** Plugin unload (E8): stops timers and in-flight bookkeeping; the queue file is not touched. */
	dispose(): void {
		this.disposed = true;
		this.cancelDrainTimer();
		this.waiters.clear();
		this.retryWake?.();
	}

	private scheduleDrain(): void {
		if (this.drainTimer !== null || this.disposed) return;
		this.drainTimer = this.deps.scheduler.setTimeout(() => {
			this.drainTimer = null;
			void this.drain();
		}, RENAME_COALESCE_MS);
	}

	private cancelDrainTimer(): void {
		if (this.drainTimer !== null) this.deps.scheduler.clearTimeout(this.drainTimer);
		this.drainTimer = null;
	}

	private drain(): Promise<void> {
		if (this.draining) return this.draining;
		const run = this.drainLoop().finally(() => {
			if (this.draining === run) this.draining = null;
		});
		this.draining = run;
		return run;
	}

	private async drainLoop(): Promise<void> {
		const { queue } = this.deps;
		while (!this.disposed && this.deps.isActive()) {
			const connection = this.deps.getConnection();
			if (!connection || !connection.isOnline()) return;
			const entry = queue.first();
			if (!entry) return;
			this.inFlightSeq = entry.seq;
			let outcome: SendOutcome;
			try {
				outcome = await this.send(connection, entry);
			} finally {
				this.inFlightSeq = null;
			}
			if (this.disposed) return; // unloaded mid-call: the entry stays and is sent again at the next load
			if (outcome === "ack") {
				this.finish(entry);
			} else if (outcome === "stale") {
				const tries = (this.attempts.get(entry.seq) ?? 0) + 1;
				this.attempts.set(entry.seq, tries);
				this.noticeStale(entry, tries > STALE_MAX_RETRIES);
				if (tries > STALE_MAX_RETRIES) {
					this.finish(entry); // later events are still sent, in order; the links stay as they are
				} else if (!(await this.pause(STALE_RETRY_DELAY_MS))) {
					return;
				}
			} else if (outcome === "rejected") {
				this.finish(entry);
			} else {
				return; // unreachable or unsupported: the entry stays; the next online check kicks sending again
			}
		}
	}

	private finish(entry: QueuedRename): void {
		this.deps.queue.remove(entry.seq);
		this.attempts.delete(entry.seq);
		this.noticed.delete(entry.seq);
		for (const waiter of [...this.waiters]) {
			if (waiter.oldPath !== entry.oldPath || waiter.newPath !== entry.newPath) continue;
			this.waiters.delete(waiter);
			try {
				waiter.cb();
			} catch (error) {
				this.deps.log("[Atlas] a rename acknowledgement listener threw", error);
			}
		}
	}

	private async send(connection: RenameCaller, entry: QueuedRename): Promise<SendOutcome> {
		const root = this.deps.getVaultRoot();
		if (!root) return "unreachable"; // no folder to anchor the paths: the entry stays queued
		let result: TephraCallResult;
		try {
			result = await connection.call(TEPHRA_RENAME_METHOD, { old_path: toAbsolutePath(root, entry.oldPath), new_path: toAbsolutePath(root, entry.newPath) });
		} catch {
			return "unreachable";
		}
		if (result.ok) {
			this.noticePartial(entry, result.result);
			return "ack";
		}
		const { error } = result;
		if (error.kind !== "rpc") return "unreachable"; // no token, timeout, network, HTTP, bad body: Tephra gave no answer
		if (error.message.toLowerCase().includes(TEPHRA_STALE_MESSAGE)) return "stale";
		if (error.code === METHOD_NOT_FOUND) {
			this.noticeUnsupported();
			return "unsupported";
		}
		this.deps.log(`[Atlas] Tephra refused the rename ${entry.oldPath} -> ${entry.newPath}: ${error.message}`);
		this.deps.notify(`Atlas: Tephra refused to follow the rename of "${entry.oldPath}" (${error.message}). Links to it were left as they are.`);
		return "rejected";
	}

	/** E7: logged every time, and one Notice per entry naming the file (the last attempt says Atlas has stopped asking). */
	private noticeStale(entry: QueuedRename, gaveUp: boolean): void {
		this.deps.log(`[Atlas] Tephra: "${TEPHRA_STALE_MESSAGE}" for ${entry.oldPath} -> ${entry.newPath}${gaveUp ? " (giving up)" : ""}`);
		if (gaveUp) {
			this.deps.notify(`Atlas: "${entry.newPath}" kept changing, so Tephra couldn't update the links to it. They were left as they are.`);
		} else if (!this.noticed.has(entry.seq)) {
			this.noticed.add(entry.seq);
			this.deps.notify(`Atlas: "${entry.newPath}" changed while Tephra was updating the links to it. Trying again.`);
		}
	}

	/** A `partial` answer: Tephra rewrote some linking files and kept the rest in its pending fixes. Atlas rewrites nothing. */
	private noticePartial(entry: QueuedRename, reply: unknown): void {
		if (typeof reply !== "object" || reply === null || (reply as { status?: unknown }).status !== "partial") return;
		const deferred = (reply as { deferred?: unknown }).deferred;
		const files = Array.isArray(deferred)
			? deferred.map((d) => (typeof d === "object" && d !== null ? (d as { file?: unknown }).file : undefined)).filter((f): f is string => typeof f === "string")
			: [];
		this.deps.log(`[Atlas] Tephra followed ${entry.oldPath} -> ${entry.newPath} only in part`, deferred);
		const named = files.length > 0 ? `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}` : "";
		this.deps.notify(`Atlas: Tephra couldn't update every link to "${entry.newPath}" yet${named}. It keeps those links to retry; they were left as they are.`);
	}

	private noticeUnsupported(): void {
		if (this.unsupportedNoticed) return;
		this.unsupportedNoticed = true;
		this.deps.notify("Atlas: this Tephra can't follow renames yet. Renames are kept and will be sent once it can.");
	}

	/** Waits `ms`; false when disposed meanwhile. */
	private pause(ms: number): Promise<boolean> {
		return new Promise((resolve) => {
			const handle = this.deps.scheduler.setTimeout(() => {
				this.retryWake = null;
				resolve(!this.disposed);
			}, ms);
			this.retryWake = () => {
				this.deps.scheduler.clearTimeout(handle);
				this.retryWake = null;
				resolve(false);
			};
		});
	}
}
