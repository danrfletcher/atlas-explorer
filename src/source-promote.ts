import { TEPHRA_NOT_RUNNING } from "./source-actions";
import { parentSourceOf, promoteRootPath } from "./promote-offer";
import { parentLabel, promoteConfirmText, promoteRefusalNotice, promotedSourceName, returnConfirmText } from "./promote-name";
import { computeSourceRoots } from "./source-roots";
import type { TephraCallResult } from "./tephra-client";
import type { TephraSnapshot } from "./tephra-connection";

/** What Make its own source / Return to parent need from the live Tephra connection. */
export interface SourcePromoteConnection {
	getSnapshot(): TephraSnapshot;
	call(method: string, params?: unknown): Promise<TephraCallResult>;
	/** Asks for a `source.list` check now. */
	requestCheck(): void;
}

export interface SourcePromoterDeps {
	/** The live connection, or null while the Tephra toggle is off (or on mobile). Never created here. */
	getConnection: () => SourcePromoteConnection | null;
	getVaultPath: () => string | null;
	/** The confirm dialog: true when the user confirmed. Replaced by tests only. */
	confirm: (message: string, confirmLabel: string) => Promise<boolean>;
	notify: (message: string) => void;
}

/** The shape of `source.promote` / `source.unpromote` results (Tephra G12): only what a message needs, read defensively. */
interface PromoteAnswer {
	deferred?: unknown;
	status?: unknown;
}

function answerOf(result: unknown): PromoteAnswer {
	return typeof result === "object" && result !== null ? (result as PromoteAnswer) : {};
}

export const PROMOTE_IN_PROGRESS = "A source change is in progress";

/**
 * PR-12 (G6): Make its own source and Return to parent.
 *
 * - `makeOwnSource(folderPath)`: a folder of the vault or of a source becomes a source of its own. One confirm
 *   (the name that will be used, and where the folder is hidden), then one `source.promote { name, root }`.
 * - `returnToParent(name)`: a promoted source folds back into its parent. One confirm, then `source.unpromote { name }`.
 *
 * Tephra does the work (it moves the units and rewrites the `[[@old:` links in the linking files); Atlas changes
 * nothing of its own and writes no file. Nothing is queued: with Tephra offline nothing is sent and the user is
 * told. A refusal is shown as Tephra's own sentence; a timed-out request is NOT sent again (it may have reached
 * Tephra), and a fresh `source.list` shows what happened. Every view node, fold and manual promotion keeps its
 * path: a promoted folder's contents stay at the same vault path, only their owning source changes.
 */
export class SourcePromoter {
	private busy = false;

	constructor(private readonly deps: SourcePromoterDeps) {}

	isBusy(): boolean {
		return this.busy;
	}

	async makeOwnSource(folderPath: string): Promise<void> {
		const connection = this.liveConnection();
		if (!connection || !this.enter()) return;
		try {
			const snapshot = connection.getSnapshot();
			const roots = computeSourceRoots(snapshot.sources, this.deps.getVaultPath());
			const root = promoteRootPath(folderPath, roots, this.deps.getVaultPath());
			if (root === null) {
				this.deps.notify(`Atlas: couldn't make ${folderPath} its own source: Atlas can't tell which folder on disk it is.`);
				return;
			}
			const name = promotedSourceName(folderPath);
			const parent = parentSourceOf(folderPath, roots);
			if (!(await this.deps.confirm(promoteConfirmText(name, parent), "Make source"))) return;
			// Tephra may have gone while the dialog was open: nothing is queued.
			if (this.deps.getConnection()?.getSnapshot().state !== "online") {
				this.deps.notify(`Atlas: ${TEPHRA_NOT_RUNNING}.`);
				return;
			}
			const result = await connection.call("source.promote", { name, root });
			this.finish("promote", name, parent, result, connection);
		} finally {
			this.busy = false;
		}
	}

	async returnToParent(name: string): Promise<void> {
		const connection = this.liveConnection();
		if (!connection || !this.enter()) return;
		try {
			const roots = computeSourceRoots(connection.getSnapshot().sources, this.deps.getVaultPath());
			const parent = roots.find((root) => root.name === name)?.parent ?? null;
			if (parent === null) return; // not a promoted source (any more): nothing to return
			if (!(await this.deps.confirm(returnConfirmText(name, parent), "Return"))) return;
			if (this.deps.getConnection()?.getSnapshot().state !== "online") {
				this.deps.notify(`Atlas: ${TEPHRA_NOT_RUNNING}.`);
				return;
			}
			const result = await connection.call("source.unpromote", { name });
			this.finish("return", name, parent, result, connection);
		} finally {
			this.busy = false;
		}
	}

	private finish(action: "promote" | "return", name: string, parent: string | null, result: TephraCallResult, connection: SourcePromoteConnection): void {
		if (!result.ok) {
			this.deps.notify(promoteRefusalNotice(action, name, result.error));
			// A timed-out request may have reached Tephra and is NOT sent again; a fresh list shows what happened.
			if (result.error.kind === "timeout") connection.requestCheck();
			return;
		}
		const answer = answerOf(result.result);
		const deferred = typeof answer.deferred === "number" ? answer.deferred : 0;
		const status = typeof answer.status === "string" ? answer.status : "applied";
		if (status !== "applied" || deferred > 0) {
			const left = deferred > 0 ? `${deferred} linking file${deferred === 1 ? "" : "s"} still point${deferred === 1 ? "s" : ""} at the old name` : "some links need a manual fix";
			const done = action === "promote" ? `${name} is its own source` : `${name} is back in ${parentLabel(parent)}`;
			this.deps.notify(`Atlas: ${done}, but ${left} (Tephra's answer: ${status}). Tephra keeps the list of them.`);
		}
		connection.requestCheck(); // the new source list moves the section, the rows and the links
	}

	private enter(): boolean {
		if (this.busy) {
			this.deps.notify(`Atlas: ${PROMOTE_IN_PROGRESS}.`);
			return false;
		}
		this.busy = true;
		return true;
	}

	private liveConnection(): SourcePromoteConnection | null {
		const connection = this.deps.getConnection();
		if (!connection || connection.getSnapshot().state !== "online") {
			this.deps.notify(`Atlas: ${TEPHRA_NOT_RUNNING}.`);
			return null;
		}
		return connection;
	}
}
