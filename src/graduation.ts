import { TAbstractFile, TFile, Vault } from "obsidian";
import { collectRootEntries, validateName } from "./name-rules";
import { isInSourcesFolder } from "./sources-path";

/** `<14 digits>-<4 base36>`, the shape of a free block's filename (case-insensitive). */
const ID_LIKE = /^\d{14}-[0-9a-z]{4}$/i;

/** Whether a basename (no extension) looks like a generated block ID, so a rename to it never graduates. */
export function isIdLikeName(basename: string): boolean {
	return ID_LIKE.test(basename);
}

export type RenameClassification = { action: "graduate" } | { action: "ignore"; reason: string };

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

function baseOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1, path.length - ".md".length);
}

/** An empty pool setting, or one that points at the vault root, never graduates anything. */
function isUsablePool(poolFolder: string): boolean {
	return poolFolder !== "" && poolFolder !== "/" && poolFolder !== ".";
}

/** Whether a note's basename starts with a dot, which Obsidian hides (drops from its index). */
function isHiddenName(path: string): boolean {
	return baseOf(path).startsWith(".");
}

/** A `.md` file directly in the pool folder with a real (non-ID) name. */
export function isGraduationCandidate(path: string, poolFolder: string): boolean {
	return isUsablePool(poolFolder) && path.endsWith(".md") && parentOf(path) === poolFolder && !isIdLikeName(baseOf(path));
}

/** Decides whether a vault `rename` event is a pool rename that graduates: a file, `.md` before and
 * after, same parent equal to the pool folder, basename changed, new basename not ID-like. */
export function classifyRename(oldPath: string, newPath: string, isFile: boolean, poolFolder: string): RenameClassification {
	const ignore = (reason: string): RenameClassification => ({ action: "ignore", reason });
	if (!isFile) return ignore("not-a-file");
	if (!isUsablePool(poolFolder)) return ignore("no-pool");
	if (!oldPath.endsWith(".md") || !newPath.endsWith(".md")) return ignore("not-markdown");
	if (parentOf(oldPath) !== parentOf(newPath)) return ignore("moved");
	if (parentOf(newPath) !== poolFolder) return ignore("outside-pool");
	if (baseOf(oldPath) === baseOf(newPath)) return ignore("same-name");
	if (isIdLikeName(baseOf(newPath))) return ignore("id-like");
	return { action: "graduate" };
}

/** Ms to wait after the last `resolved`/`modify` before moving, so Obsidian's link rewrite is done. */
export const SETTLE_MS = 150;
/** Ms after the rename by which a graduation runs even if no `resolved` event ever comes. */
export const FALLBACK_MS = 1500;
export const TOAST_MS = 4000;

export interface Scheduler {
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface GraduationDeps {
	vault: Pick<Vault, "getAbstractFileByPath" | "getRoot">;
	fileManager: { renameFile(file: TAbstractFile, newPath: string): Promise<void> };
	scheduler: Scheduler;
	getPoolFolder(): string;
	getExcludedFolders(): string[];
	/** R3-1: true while the Tephra toggle is on. Then a file under `Sources/` is never a graduation candidate,
	 * and nothing is recorded or forgotten for it. Optional: absent means the toggle is off. */
	skipsSources?(): boolean;
	notify(message: string, durationMs: number): void;
	/** Called after a move Atlas made; shows the "links weren't updated" notice when the Obsidian setting is off. */
	afterMove(): void;
	/** The shared name dialog. Resolves the typed name, or null when dismissed any way but Create. */
	openDialog(options: { title: string; initialValue: string; poolFolder: string; excludedFolders: string[] }): Promise<string | null>;
	/** Called after Atlas moved a hidden file (see `PendingGraduation.hidden`), which Obsidian reports no
	 * rename event for, so placements and promotions can follow it to its new path. */
	onHiddenMove?(oldPath: string, newPath: string): void;
	/** Optional: how a failed step is reported (defaults to `notify`). */
	onError?(message: string, error: unknown): void;
}

/** What Atlas remembers about a pool file that was renamed to a real name and hasn't graduated yet. */
export interface PendingGraduation {
	file: TFile;
	/** The path the file had before the first rename in this chain (Cancel puts it back here). */
	originalPath: string;
	poolFolder: string;
	state: "waiting" | "dialog";
	/** The new name starts with a dot: Obsidian drops such a file from its index about 100 ms after the
	 * rename (a `delete` event, though the file stays on disk), so the record must outlive that and the
	 * dialog opens straight away instead of waiting for the link rewrite. */
	hidden: boolean;
	fallbackTimer?: unknown;
	settleTimer?: unknown;
}

export type RenameOutcome = "swallowed" | "scheduled" | "ignored";

/** Graduates a free block out of the pool when its file is renamed to a real name: waits for
 * Obsidian to finish the triggering rename, then moves it to the vault root through
 * `fileManager.renameFile`. A name that can't be used at the root (a clash, or another shared name
 * rule) goes through the shared name dialog; Cancel puts the file back to its pre-rename name. */
export class GraduationController {
	private pending = new Map<TFile, PendingGraduation>();
	private ownReverts = new Set<string>();
	private dialogChain: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(private deps: GraduationDeps) {}

	getPending(file: TFile): PendingGraduation | undefined {
		return this.pending.get(file);
	}

	pendingCount(): number {
		return this.pending.size;
	}

	/** Test seam: the remembered Atlas reverts (paths). */
	getOwnReverts(): ReadonlySet<string> {
		return this.ownReverts;
	}

	noteOwnRevert(path: string): void {
		this.ownReverts.add(path);
	}

	/** Called from the vault `rename` handler, after the existing rename hooks. Never moves anything
	 * itself: at most it records the file and schedules the move for a later tick. */
	handleRename(file: TAbstractFile, oldPath: string): RenameOutcome {
		if (this.disposed) return "ignored";
		if (this.ownReverts.delete(file.path)) return "swallowed";

		if (this.inSkippedSources(file.path) || this.inSkippedSources(oldPath)) return "ignored";
		const poolFolder = this.deps.getPoolFolder();
		if (!(file instanceof TFile)) return "ignored";
		if (classifyRename(oldPath, file.path, true, poolFolder).action !== "graduate") return "ignored";

		const hidden = isHiddenName(file.path);
		let record = this.pending.get(file);
		if (!record) {
			record = { file, originalPath: oldPath, poolFolder, state: "waiting", hidden };
			this.pending.set(file, record);
		}
		record.hidden = hidden;
		// A dialog is already open for this file: it keeps the original path and acts on the file
		// object, so a further rename needs no new schedule.
		if (record.state === "waiting") this.arm(record, hidden ? 0 : FALLBACK_MS);
		return "scheduled";
	}

	handleDelete(file: TAbstractFile): void {
		if (this.inSkippedSources(file.path)) return;
		// A hidden file is dropped from the index on purpose; its record ends with the dialog.
		if (file instanceof TFile && !this.pending.get(file)?.hidden) this.forget(file);
	}

	private inSkippedSources(path: string): boolean {
		return isInSourcesFolder(path) && this.deps.skipsSources?.() === true;
	}

	/** `metadataCache` `resolved`: the link graph has caught up with whatever the rename touched. */
	handleResolved(): void {
		this.bumpSettle(true);
	}

	/** Any note modified after a rename may be Obsidian rewriting links; push the move back. */
	handleModify(): void {
		this.bumpSettle(false);
	}

	/** Cancels everything pending; nothing moves or reverts afterwards. */
	dispose(): void {
		this.disposed = true;
		for (const record of this.pending.values()) this.clearTimers(record);
		this.pending.clear();
		this.ownReverts.clear();
	}

	private arm(record: PendingGraduation, delayMs: number): void {
		const { scheduler } = this.deps;
		this.clearTimers(record);
		record.fallbackTimer = scheduler.setTimeout(() => this.run(record), delayMs);
	}

	private clearTimers(record: PendingGraduation): void {
		const { scheduler } = this.deps;
		if (record.fallbackTimer !== undefined) scheduler.clearTimeout(record.fallbackTimer);
		if (record.settleTimer !== undefined) scheduler.clearTimeout(record.settleTimer);
		record.fallbackTimer = undefined;
		record.settleTimer = undefined;
	}

	/** `resolved` starts the settle timer; a later `resolved`/`modify` restarts it (only once started). */
	private bumpSettle(start: boolean): void {
		if (this.disposed) return;
		for (const record of this.pending.values()) {
			if (record.state !== "waiting" || record.hidden) continue;
			if (record.settleTimer === undefined && !start) continue;
			if (record.settleTimer !== undefined) this.deps.scheduler.clearTimeout(record.settleTimer);
			record.settleTimer = this.deps.scheduler.setTimeout(() => this.run(record), SETTLE_MS);
		}
	}

	private forget(file: TFile): void {
		const record = this.pending.get(file);
		if (!record) return;
		this.clearTimers(record);
		this.pending.delete(file);
	}

	/** The scheduled graduation: re-checks every precondition, then moves or opens the dialog. */
	private run(record: PendingGraduation): void {
		if (this.disposed || this.pending.get(record.file) !== record || record.state !== "waiting") return;
		this.clearTimers(record);
		const { file } = record;
		const stillThere = record.hidden || this.deps.vault.getAbstractFileByPath(file.path) === file;
		if (!stillThere || this.deps.getPoolFolder() !== record.poolFolder || !isGraduationCandidate(file.path, record.poolFolder)) {
			this.pending.delete(file);
			return;
		}
		if (this.problemWith(file.basename) === null) {
			this.pending.delete(file);
			void this.moveToRoot(file, file.basename, record.hidden);
			return;
		}
		record.state = "dialog";
		this.dialogChain = this.dialogChain.then(() => this.resolveThroughDialog(record)).catch((error) => this.fail("Atlas: couldn't finish naming that note", error));
	}

	/** Why `name` can't be a note at the vault root right now, or null when it can. */
	private problemWith(name: string): string | null {
		const result = validateName(name, {
			root: collectRootEntries(this.deps.vault),
			poolFolder: this.deps.getPoolFolder(),
			excludedFolders: this.deps.getExcludedFolders(),
		});
		return result.valid ? null : result.message;
	}

	/** One dialog at a time: runs after any earlier one has closed, and re-checks the name against
	 * the root as it is by then. */
	private async resolveThroughDialog(record: PendingGraduation): Promise<void> {
		const { file } = record;
		if (this.disposed || this.pending.get(file) !== record) return;
		if (!record.hidden && this.deps.vault.getAbstractFileByPath(file.path) !== file) {
			this.pending.delete(file);
			return;
		}
		if (this.problemWith(file.basename) === null) {
			this.pending.delete(file);
			await this.moveToRoot(file, file.basename, record.hidden);
			return;
		}

		const chosen = await this.deps.openDialog({
			title: "Choose a name for this note",
			initialValue: file.basename,
			poolFolder: this.deps.getPoolFolder(),
			excludedFolders: this.deps.getExcludedFolders(),
		});
		if (this.disposed || this.pending.get(file) !== record) return;
		this.pending.delete(file);
		if (!record.hidden && this.deps.vault.getAbstractFileByPath(file.path) !== file) return; // deleted while the dialog was open
		if (chosen !== null) await this.moveToRoot(file, chosen, record.hidden);
		else await this.revert(file, record.originalPath, record.hidden);
	}

	/** One rename call, straight from wherever the file is now to `<name>.md` at the vault root. */
	private async moveToRoot(file: TFile, name: string, hidden = false): Promise<void> {
		const from = file.path;
		try {
			await this.deps.fileManager.renameFile(file, `${name}.md`);
			if (hidden) this.deps.onHiddenMove?.(from, `${name}.md`);
		} catch (error) {
			this.fail(`Atlas: couldn't move '${name}' out of the pool`, error);
			return;
		}
		this.deps.notify(`Moved '${name}' out of the pool`, TOAST_MS);
		this.deps.afterMove();
	}

	/** Puts the file back to its pre-rename name. The revert is itself a pool rename, so it is
	 * remembered by path just for that event and forgotten straight after it. */
	private async revert(file: TFile, originalPath: string, hidden = false): Promise<void> {
		if (file.path === originalPath) return;
		const from = file.path;
		this.ownReverts.add(originalPath);
		try {
			await this.deps.fileManager.renameFile(file, originalPath);
			if (hidden) this.deps.onHiddenMove?.(from, originalPath);
		} catch (error) {
			this.fail(`Atlas: couldn't put '${file.basename}' back to its old name`, error);
		} finally {
			this.ownReverts.delete(originalPath);
		}
	}

	private fail(message: string, error: unknown): void {
		if (this.deps.onError) this.deps.onError(message, error);
		else this.deps.notify(message, 8000);
		console.error("[Atlas]", message, error);
	}
}
