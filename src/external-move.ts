import { TAbstractFile, TFolder } from "obsidian";

/** PR-1.S1 (T1): how long a deleted path stays eligible to pair with a later `create` of the same
 * name and kind as an external move (e.g. a shell `mv`), which Obsidian reports as delete+create
 * instead of firing `rename`. Long enough for the vault's own rescan to emit both events for a move;
 * short enough that an unrelated file recreated under the same name well afterwards isn't mistaken
 * for one. */
export const EXTERNAL_MOVE_WINDOW_MS = 2000;

export interface ExternalMoveTimers {
	setTimeoutFn: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn: (handle: unknown) => void;
}

const realTimers: ExternalMoveTimers = {
	setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
	clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingDelete {
	path: string;
	name: string;
	isFolder: boolean;
	timer: unknown;
}

/** Pairs a vault `delete` with a later `create` of the same name and kind at a different path, so
 * `main.ts` can replay its rename-reconciliation (rewriting manual promotions, dismissed/added refs
 * and every view's node tree) for a move Obsidian never reports as a `rename`. Matched only by name,
 * kind and a different path — not by content — so this only ever misfires by treating an unrelated
 * same-named create soon after a delete as a move, never the reverse. One instance per plugin load;
 * `cancelAll` disposes it with the plugin. */
export class ExternalMoveDetector {
	private pending: PendingDelete[] = [];

	constructor(private timers: ExternalMoveTimers = realTimers, private windowMs: number = EXTERNAL_MOVE_WINDOW_MS) {}

	onDelete(file: TAbstractFile): void {
		const record: PendingDelete = {
			path: file.path,
			name: file.name,
			isFolder: file instanceof TFolder,
			timer: undefined,
		};
		record.timer = this.timers.setTimeoutFn(() => this.forget(record), this.windowMs);
		this.pending.push(record);
	}

	/** Returns the path `file` was deleted from if a pending delete matches it, consuming the match so
	 * it pairs at most once; otherwise null. */
	matchCreate(file: TAbstractFile): string | null {
		const index = this.pending.findIndex(
			(record) => record.name === file.name && record.isFolder === file instanceof TFolder && record.path !== file.path
		);
		if (index === -1) return null;
		const [record] = this.pending.splice(index, 1);
		this.timers.clearTimeoutFn(record.timer);
		return record.path;
	}

	private forget(record: PendingDelete): void {
		this.pending = this.pending.filter((pending) => pending !== record);
	}

	/** Drops every pending delete without matching it — called from the plugin's `onunload`, so nothing
	 * fires after the plugin is gone. */
	cancelAll(): void {
		for (const record of this.pending) this.timers.clearTimeoutFn(record.timer);
		this.pending = [];
	}
}
