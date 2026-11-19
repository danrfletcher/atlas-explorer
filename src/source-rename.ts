import type { App } from "obsidian";
import { openNameDialog } from "./name-dialog";
import { SOURCES_FOLDER } from "./sources-path";
import { VAULT_SOURCE_NAME, errorCode, type SourcesFs } from "./sources-links";
import { TEPHRA_NOT_RUNNING } from "./source-actions";
import { renameRefusalText, validateSourceName } from "./source-name-rules";
import type { TephraCallResult } from "./tephra-client";
import type { TephraSnapshot } from "./tephra-connection";
import type { SwapSourceResult } from "./sources-folder";

/** What a rename needs from the live Tephra connection. */
export interface SourceRenameConnection {
	getSnapshot(): TephraSnapshot;
	call(method: string, params?: unknown): Promise<TephraCallResult>;
	/** Asks for a `source.list` check now. */
	requestCheck(): void;
}

export interface SourceRenamerDeps {
	app: App;
	/** The live connection, or null while the Tephra toggle is off (or on mobile). Never created here. */
	getConnection: () => SourceRenameConnection | null;
	getVaultPath: () => string | null;
	fs: Pick<SourcesFs, "lstat" | "readdir">;
	/** Step 4: the `Sources/<old>` -> `Sources/<new>` link swap. Never throws. */
	swapSource: (oldName: string, newName: string, sourceRoot: string | null) => Promise<SwapSourceResult>;
	/** Step 3 (R3-4): rewrites every path-keyed record Atlas holds. Runs only after Tephra has acknowledged. */
	remap: (oldName: string, newName: string) => void | Promise<void>;
	/** Before the swap: writes pending editor saves of tabs open on `Sources/<old>/…`. Returns the function that
	 * reopens them at `Sources/<new>/…` once the swap has gone through. */
	prepareTabs: (oldName: string, newName: string) => Promise<() => void>;
	/** Step 5: the Inbox re-render (and any per-section UI state, such as a collapsed section, moves with the name). */
	afterRename: (oldName: string, newName: string) => void;
	notify: (message: string) => void;
	/** The name dialog; replaced by tests only. */
	openNameDialog?: typeof openNameDialog;
	now?: () => number;
}

/** A frame for a rename this recently handled is not handled again (the push that follows Atlas's own call). */
const HANDLED_MEMORY_MS = 60_000;

export const RENAME_IN_PROGRESS = "Rename in progress";

/** The shape of `source.rename`'s result (Tephra G13): only what a message needs, read defensively. */
interface RenameAnswer {
	files_changed?: unknown;
	deferred?: unknown;
	status?: unknown;
}

function answerText(result: unknown): RenameAnswer {
	return typeof result === "object" && result !== null ? (result as RenameAnswer) : {};
}

/**
 * PR-11 (G4): Rename source. One class for both ways a rename reaches Atlas, so the same remap and swap run for each:
 *
 * - `rename(name)`: the user's, from the Inbox section header. Dialog, then one `source.rename { name, new_name }`.
 * - `onRenamed(old, new)`: Tephra announced a rename (`graph:changed` with `sources_changed` kind `renamed`) that
 *   somebody else made (`tephractl`). No request, no dialog: straight to the remap.
 *
 * The order is fixed: Tephra's call, Tephra's acknowledgement, the Atlas remap (R3-4), the link swap, the re-render.
 * The remap never runs before the acknowledgement (R3-6). A refusal or a failed call changes nothing in Atlas. If the
 * swap fails after the acknowledgement Atlas keeps the remapped state and says so: the `Sources/` reconcile
 * (on `graph:changed` or focus) then creates `Sources/<new>` and removes `Sources/<old>`, so Tephra's list wins.
 *
 * Atlas never writes a file's content here (F3): Tephra rewrites the `[[@old:` links. Nothing goes through
 * `vault.modify`/`vault.process`/`fileManager.renameFile`/`vault.delete`/`vault.trash`.
 */
export class SourceRenamer {
	/** A rename (either way) is being carried out. A second one is refused. */
	private busy = false;
	/** The user's rename request while it runs, so a rename Tephra announces meanwhile can wait for it. */
	private inFlight: Promise<void> | null = null;
	/** `old\0new` -> when it was handled, so the push that follows our own call isn't run a second time. */
	private handled = new Map<string, number>();
	/** Everything after the acknowledgement runs one at a time. */
	private chain: Promise<void> = Promise.resolve();
	/** The plugin was unloaded (E8): nothing that follows touches Atlas's state, the disk or the UI. */
	private disposed = false;
	private readonly now: () => number;

	constructor(private readonly deps: SourceRenamerDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	/**
	 * Plugin unload in the middle of a rename (E8). Nothing is rolled back and nothing is cleaned up: Tephra keeps the
	 * rename it already made, and a remap already written stays. What has not started yet does not start: no remap, no
	 * swap, no tab reopening, no re-render, no new rename. The dead instance writing `data.json` after a reload could
	 * overwrite the new instance's state, so it doesn't. The next load reconciles to Tephra's source list (G2): it
	 * creates `Sources/<new>` and removes `Sources/<old>`, and any view entry still on the old path shows as missing
	 * (R3-4) and is never deleted.
	 */
	dispose(): void {
		this.disposed = true;
	}

	/** Whether a rename is in flight (the menu doesn't use it; a second `rename` says so itself). */
	isBusy(): boolean {
		return this.busy;
	}

	/** G4: "Rename" on a source's section header. */
	async rename(oldName: string): Promise<void> {
		if (this.disposed || oldName === VAULT_SOURCE_NAME) return; // the vault is never renamed from here
		const connection = this.liveConnection();
		if (!connection) return;
		if (this.busy) {
			this.deps.notify(`Atlas: ${RENAME_IN_PROGRESS}.`);
			return;
		}
		let sourcesEntries: string[];
		try {
			sourcesEntries = await this.sourcesEntries();
		} catch (error) {
			this.deps.notify(`Atlas: couldn't read ${SOURCES_FOLDER}/ (${errorCode(error) ?? "unknown error"}), so nothing was renamed.`);
			return;
		}
		const open = this.deps.openNameDialog ?? openNameDialog;
		await open(this.deps.app, {
			title: "Rename source",
			confirmLabel: "Rename",
			initialValue: oldName,
			// Read on every keystroke, so a source added elsewhere while the dialog is open is caught.
			validate: (name) =>
				validateSourceName(name, { registered: connection.getSnapshot().sources.map((s) => s.name), sourcesEntries, renaming: oldName }),
			onSubmit: (name) => this.submit(connection, oldName, name),
		});
	}

	/** Tephra announced a rename that Atlas didn't ask for. Ignored when it is the echo of one Atlas ran itself. */
	onRenamed(oldName: string, newName: string): void {
		if (this.disposed || oldName === newName || oldName === VAULT_SOURCE_NAME || newName === VAULT_SOURCE_NAME) return;
		if (this.wasHandled(oldName, newName)) return;
		// A rename of the user's own may be in flight: this one waits for it (its echo was marked handled above).
		const wait = this.inFlight ?? Promise.resolve();
		this.chain = this.chain
			.then(() => wait)
			.then(() => this.finishLater(oldName, newName))
			.catch((error) => console.error("[Atlas] couldn't carry out a source rename Tephra announced", error));
	}

	/** Resolves when every rename queued so far has finished (tests). */
	async settled(): Promise<void> {
		await this.chain;
	}

	private async finishLater(oldName: string, newName: string): Promise<void> {
		if (this.disposed || this.busy || this.wasHandled(oldName, newName)) return;
		this.busy = true;
		try {
			this.markHandled(oldName, newName);
			await this.finish(oldName, newName, this.sourceRoot(oldName, newName));
		} finally {
			this.busy = false;
		}
	}

	/** Tephra answered and is online, or a notice says it isn't (and nothing goes any further). */
	private liveConnection(): SourceRenameConnection | null {
		const connection = this.deps.getConnection();
		if (!connection || connection.getSnapshot().state !== "online") {
			this.deps.notify(`Atlas: ${TEPHRA_NOT_RUNNING}.`);
			return null;
		}
		return connection;
	}

	private async sourcesEntries(): Promise<string[]> {
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath === null) return [];
		try {
			return await this.deps.fs.readdir(`${vaultPath}/${SOURCES_FOLDER}`);
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
			throw error;
		}
	}

	private sourceRoot(oldName: string, newName: string): string | null {
		const sources = this.deps.getConnection()?.getSnapshot().sources ?? [];
		const found = sources.find((source) => source.name === newName) ?? sources.find((source) => source.name === oldName);
		return found && found.path !== "" ? found.path : null;
	}

	private wasHandled(oldName: string, newName: string): boolean {
		const at = this.handled.get(`${oldName}\0${newName}`);
		return at !== undefined && this.now() - at < HANDLED_MEMORY_MS;
	}

	private markHandled(oldName: string, newName: string): void {
		const now = this.now();
		for (const [key, at] of this.handled) if (now - at >= HANDLED_MEMORY_MS) this.handled.delete(key);
		this.handled.set(`${oldName}\0${newName}`, now);
	}

	/**
	 * The dialog's confirm. Resolves a reason to keep the dialog open (Tephra's own sentence, word for word), or null
	 * when it is done with. The typed name is unchanged: nothing is sent and nothing changes.
	 */
	private async submit(connection: SourceRenameConnection, oldName: string, newName: string): Promise<string | null> {
		if (newName === oldName) return null;
		if (this.busy) return RENAME_IN_PROGRESS; // a second confirm while one is in flight sends nothing
		this.busy = true;
		const run = this.requestRename(connection, oldName, newName);
		this.inFlight = run.then(
			() => undefined,
			() => undefined
		);
		try {
			return await run;
		} finally {
			this.busy = false;
			this.inFlight = null;
		}
	}

	private async requestRename(connection: SourceRenameConnection, oldName: string, newName: string): Promise<string | null> {
		// Checked at the moment of confirming, with `lstat` (it sees a link, even a dangling one), so an entry that
		// appeared while the dialog was open stops the request. A case-only change is Tephra's call: on a
		// case-insensitive disk `Sources/Whoop` is the source's own link.
		const caseOnly = oldName.toLowerCase() === newName.toLowerCase();
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath !== null && !caseOnly) {
			try {
				await this.deps.fs.lstat(`${vaultPath}/${SOURCES_FOLDER}/${newName}`);
				return `${SOURCES_FOLDER}/${newName} already exists in the vault`;
			} catch (error) {
				// ENAMETOOLONG: no such entry can exist, so the name goes to Tephra, whose reason for a too-long name shows.
				const code = errorCode(error);
				if (code !== "ENOENT" && code !== "ENAMETOOLONG") return `Couldn't check ${SOURCES_FOLDER}/${newName} (${code ?? "unknown error"})`;
			}
		}
		// Marked before the request: Tephra's push can reach Atlas before the answer does.
		this.markHandled(oldName, newName);
		const result = await connection.call("source.rename", { name: oldName, new_name: newName });
		if (!result.ok) {
			this.handled.delete(`${oldName}\0${newName}`);
			const reason = renameRefusalText(result.error);
			this.deps.notify(`Atlas: couldn't rename ${oldName}: ${reason}`);
			if (result.error.kind === "timeout") {
				// The request may have reached Tephra, and it is NOT sent again. A fresh `source.list` shows what happened.
				connection.requestCheck();
				return null;
			}
			return reason;
		}
		const answer = answerText(result.result);
		await this.finish(oldName, newName, this.sourceRoot(oldName, newName));
		this.tellAboutPartial(newName, answer);
		return null;
	}

	/** Tephra's `status` is `applied`, `partial` or `needs_manual_fix`: anything but `applied` is told, never hidden. */
	private tellAboutPartial(newName: string, answer: RenameAnswer): void {
		const deferred = typeof answer.deferred === "number" ? answer.deferred : 0;
		const status = typeof answer.status === "string" ? answer.status : "applied";
		if (status === "applied" && deferred === 0) return;
		const left = deferred > 0 ? `${deferred} linking file${deferred === 1 ? "" : "s"} still point${deferred === 1 ? "s" : ""} at the old name` : "some links need a manual fix";
		this.deps.notify(`Atlas: ${newName} was renamed, but ${left} (Tephra's answer: ${status}). Tephra keeps the list of them.`);
	}

	/** Steps 3 to 5, after Tephra has acknowledged (or announced) the rename. */
	private async finish(oldName: string, newName: string, sourceRoot: string | null): Promise<void> {
		if (this.disposed) return; // E8: Tephra's answer reached an unloaded plugin
		let reopen: () => void = () => undefined;
		try {
			reopen = await this.deps.prepareTabs(oldName, newName);
		} catch (error) {
			console.error("[Atlas] couldn't flush the tabs open on the renamed source", error);
		}
		if (this.disposed) return; // E8: unloaded while the tabs were being saved; the next load reconciles
		try {
			await this.deps.remap(oldName, newName);
		} catch (error) {
			// The in-memory remap is done even if the write failed (it runs before the flush); the swap still goes ahead.
			console.error("[Atlas] couldn't save the remapped source paths", error);
		}
		if (this.disposed) return; // E8: unloaded during the remap's write; what was written stays, the swap does not start
		const swap = await this.deps.swapSource(oldName, newName, sourceRoot);
		if (this.disposed) return; // E8: no notice, tab reopening or re-render from an unloaded plugin
		if (swap.outcome === "failed") {
			const why = swap.code ? ` (${swap.code})` : "";
			this.deps.notify(
				`Atlas: ${oldName} is now ${newName} in Tephra, but Atlas couldn't move ${SOURCES_FOLDER}/${oldName} to ${SOURCES_FOLDER}/${newName}${why}. It will be fixed the next time Atlas checks Tephra.`
			);
		} else if (swap.outcome !== "skipped") {
			reopen(); // a swap that didn't run (mobile, toggle off) leaves the old link, so the tabs on it are still right
		}
		this.deps.afterRename(oldName, newName);
		this.deps.getConnection()?.requestCheck();
	}
}
