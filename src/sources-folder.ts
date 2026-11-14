import { isUsableSourceName, type TephraSource } from "./tephra-client";
import { sourceExcludeEntry } from "./tephra-exclude";
import { SOURCES_FOLDER, sourceLinkPath } from "./sources-path";
import {
	checkSourcesOwnership,
	errorCode,
	lstatOrNull,
	planSourceLinks,
	readSourcesEntries,
	selectTopLevelSources,
	type LinkAction,
	type OwnershipResult,
	type SourcesFs,
	type TopLevelSource,
} from "./sources-links";
import { desiredEntriesForSource, getOwn, mapGitignore, reconcileExcludes, type SkippedGitignoreLine, type ExcludeConfigAccess } from "./source-excludes";
import { ensureGitignoreLine } from "./vault-gitignore";
import type { SourceDeleteClassifier } from "./source-delete-classifier";

/** Read at most this much of a source's `.gitignore`. */
const MAX_GITIGNORE_CHARS = 256_000;

/** Where Atlas keeps what it did outside its own settings, so it can undo exactly that (`data.json`). */
export interface SourcesRecords {
	/** `tephraLinks`: source name -> the folder its `Sources/<name>` link points at. */
	getLinks(): Record<string, string>;
	setLinks(next: Record<string, string>): void;
	/** `tephraExcludes`: source name -> the Excluded files entries Atlas added for it. */
	getExcludes(): Record<string, string[]>;
	setExcludes(next: Record<string, string[]>): void;
	/** Saves `data.json` now (not debounced): a quick reload must not lose a record of a link. */
	save(): Promise<void>;
}

export interface SourcesFolderDeps {
	fs: SourcesFs;
	/** The vault's folder on disk; null when there isn't one (mobile): then nothing here touches a file. */
	getVaultPath: () => string | null;
	isMobile: () => boolean;
	records: SourcesRecords;
	excludeConfig: () => ExcludeConfigAccess | null;
	/** The source's "Show in Obsidian search & graph" (on by default). */
	showsInSearch: (sourceName: string) => boolean;
	classifier: SourceDeleteClassifier;
	notify: (message: string) => void;
	/** Called after Atlas changed Excluded files, so the open settings pane can list the new entries. */
	onExcludesChanged?: () => void;
}

/**
 * G2/R3-1/R3-2/R3-4/E8/E13: keeps one `Sources/<name>` folder link per top-level Tephra source, the vault's
 * `.gitignore` line, and Obsidian's Excluded files in step with Tephra's source list.
 *
 * Everything runs one job at a time (`chain`), so two triggers at once (the toggle turning on and a
 * `graph:changed`) can't both create the same link. Syncs that queue up while one runs collapse into one
 * that uses the newest list. Links are only ever made, replaced or removed through the filesystem (`lstat`,
 * `symlink`, `unlink`, `rmdir`), never through the vault API, and a folder or file that isn't a link Atlas
 * recorded is never touched.
 *
 * `dispose()` (plugin unload) only stops new work: no link, line or Excluded entry is changed (E8). `teardown()`
 * is the toggle's off path and undoes what Atlas did.
 */
export class SourcesFolder {
	private active = false;
	private chain: Promise<void> = Promise.resolve();
	private scheduled: Promise<void> | null = null;
	private latest: TephraSource[] | null = null;
	/** The list the newest `sync()` was asked for; `resync()` reuses it. Cleared when the toggle goes off. */
	private lastSources: TephraSource[] | null = null;
	/** Notices already shown for the current problem, so a 10 s sync doesn't repeat them. */
	private notified = new Set<string>();
	/** `.gitignore` lines left out of Excluded files in the last sync, by source (negations and bad patterns). */
	private skippedLines: Record<string, SkippedGitignoreLine[]> = {};

	constructor(private readonly deps: SourcesFolderDeps) {}

	/** The toggle is on: syncs may run. */
	start(): void {
		this.active = true;
	}

	/** Plugin unload (E8): no further sync starts. A job already running finishes; nothing is undone. */
	dispose(): void {
		this.active = false;
	}

	isActive(): boolean {
		return this.active;
	}

	/** Resolves when every queued sync, record update and teardown has finished (tests, and quitting cleanly). */
	whenIdle(): Promise<void> {
		return this.chain;
	}

	/** `.gitignore` lines Atlas didn't turn into Excluded entries (negations, bad patterns), by source. */
	getSkippedLines(): Record<string, SkippedGitignoreLine[]> {
		return this.skippedLines;
	}

	/**
	 * E13: may Atlas take over `Sources/`? Called before the toggle goes on; nothing is created, moved or
	 * excluded either way. Not needed on mobile (nothing runs there).
	 */
	async checkCanEnable(): Promise<OwnershipResult> {
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath === null || this.deps.isMobile()) return { ok: true };
		try {
			return await checkSourcesOwnership(this.deps.fs, vaultPath, this.deps.records.getLinks());
		} catch (error) {
			return { ok: false, path: SOURCES_FOLDER, reason: `it can't be read (${errorCode(error) ?? "unknown error"})` };
		}
	}

	/**
	 * Makes the links, the `.gitignore` line and the Excluded entries match `sources` (Tephra's list). Resolves
	 * when the sync that includes this request has finished. Never rejects.
	 */
	sync(sources: TephraSource[]): Promise<void> {
		if (!this.active || this.deps.isMobile()) return Promise.resolve();
		this.latest = sources;
		this.lastSources = sources;
		if (!this.scheduled) {
			const job = this.enqueue(async () => {
				this.scheduled = null;
				const list = this.latest;
				this.latest = null;
				if (list && this.active) await this.runSync(list);
			});
			this.scheduled = job;
		}
		return this.scheduled;
	}

	/**
	 * The settings tab changed a source's "Show in Obsidian search & graph": runs a sync with the source list of
	 * the last one, so the change goes through the same job chain as every other change to Excluded files and
	 * its tracking record. The setting is read when the reconcile runs, never earlier, so a toggle flipped
	 * while a sync is mid-flight is picked up by the sync that follows it and can't leave an entry the record
	 * doesn't know about. Does nothing until a first sync has run (that one reads the setting itself).
	 *
	 * Obsidian's Excluded files only hides paths from search, the Quick Switcher and the graph: it doesn't
	 * remove files from the vault, so no delete events follow and none are registered as expected (R3-4).
	 */
	resync(): Promise<void> {
		return this.lastSources === null ? Promise.resolve() : this.sync(this.lastSources);
	}

	/**
	 * The toggle's off path (G16/R3-3): unlinks every `Sources/<name>` Atlas made, through the filesystem,
	 * only when `lstat` says it is a symlink; removes `Sources/` when it is empty; removes every Excluded
	 * entry Atlas added. The `.gitignore` line stays. Rejects after doing everything it can when a link
	 * couldn't be removed, so the caller reports it; the records of links that are still there are kept.
	 */
	teardown(): Promise<void> {
		this.active = false;
		this.latest = null;
		this.lastSources = null;
		return this.enqueue(async () => {
			const vaultPath = this.deps.getVaultPath();
			if (vaultPath === null || this.deps.isMobile()) return;
			const { fs, classifier, records } = this.deps;
			const dir = `${vaultPath}/${SOURCES_FOLDER}`;
			const links = { ...records.getLinks() };
			const failures: string[] = [];

			for (const name of Object.keys(links)) {
				if (!isUsableSourceName(name)) {
					delete links[name]; // never a path outside `Sources/`
					continue;
				}
				const path = `${dir}/${name}`;
				try {
					const stat = await lstatOrNull(fs, path);
					if (stat === null || !stat.isSymbolicLink()) {
						delete links[name]; // gone, or replaced by something that isn't ours: nothing to remove
						continue;
					}
					classifier.expectPrefix(sourceLinkPath(name)); // registered before the unlink, so its deletes are expected
					await fs.unlink(path);
					delete links[name];
				} catch (error) {
					failures.push(`${name} (${errorCode(error) ?? String(error)})`);
				}
			}

			try {
				const stat = await lstatOrNull(fs, dir);
				if (stat !== null && stat.isDirectory() && !stat.isSymbolicLink() && (await fs.readdir(dir)).length === 0) {
					classifier.expectPrefix(SOURCES_FOLDER);
					await fs.rmdir(dir);
				}
			} catch (error) {
				const code = errorCode(error);
				if (code !== "ENOTEMPTY" && code !== "ENOENT") failures.push(`${SOURCES_FOLDER} (${code ?? String(error)})`);
			}

			const config = this.deps.excludeConfig();
			if (config) {
				const result = reconcileExcludes(config, { desired: {}, tracked: records.getExcludes(), removeStale: true });
				records.setExcludes(result.tracked);
				if (result.added.length + result.removed.length > 0) this.deps.onExcludesChanged?.();
			}
			records.setLinks(links);
			this.notified.clear();
			this.skippedLines = {};
			await records.save();
			if (failures.length > 0) throw new Error(`couldn't remove ${failures.join(", ")}`);
		});
	}

	private enqueue(job: () => Promise<void>): Promise<void> {
		const run = this.chain.then(job, job).catch((error) => {
			console.error("[Atlas] Sources folder job failed", error);
		});
		this.chain = run;
		return run;
	}

	private notifyOnce(key: string, message: string): void {
		if (this.notified.has(key)) return;
		this.notified.add(key);
		this.deps.notify(message);
	}

	private async runSync(sources: TephraSource[]): Promise<void> {
		const vaultPath = this.deps.getVaultPath();
		if (vaultPath === null) return;
		const { fs, records, classifier } = this.deps;
		const dir = `${vaultPath}/${SOURCES_FOLDER}`;

		const { linked, skipped } = selectTopLevelSources(sources, vaultPath);
		for (const entry of skipped) console.debug(`[Atlas] source "${entry.name}" gets no ${SOURCES_FOLDER}/ link: ${entry.reason}`);
		classifier.setMissingSources(sources.filter((s) => s.status === "missing").map((s) => s.name));

		const stat = await lstatOrNull(fs, dir);
		if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) {
			this.notifyOnce("sources-not-a-folder", `Atlas: "${SOURCES_FOLDER}" in your vault isn't a folder Atlas owns, so no source links were made. Move or rename it.`);
			return;
		}
		this.notified.delete("sources-not-a-folder");

		const links = { ...records.getLinks() };
		const entries = stat === null ? new Map() : await readSourcesEntries(fs, dir);
		const actions = planSourceLinks({ wanted: linked, entries, recorded: links });
		const skippedNames = new Set(actions.filter((a) => a.type === "skip").map((a) => a.name));
		const willBeLinked = linked.filter((source) => !skippedNames.has(source.name));

		try {
			await ensureGitignoreLine(fs, vaultPath);
		} catch (error) {
			console.error("[Atlas] couldn't update the vault's .gitignore", error);
			this.notifyOnce("gitignore-failed", `Atlas: couldn't add "${SOURCES_FOLDER}/" to the vault's .gitignore (${errorCode(error) ?? "unknown error"}).`);
		}

		// Excluded entries go in BEFORE a link exists, so Obsidian never scans a `target/` it was told to skip.
		await this.reconcileExcludes(sources, willBeLinked, false);
		const linksChanged = await this.applyActions(actions, dir, links);
		await this.reconcileExcludes(sources, willBeLinked, true);

		if (linksChanged) {
			records.setLinks(links);
			await records.save();
		}
		const stillSkipped = new Set([...skippedNames].map((name) => `skip:${name}`));
		for (const key of [...this.notified]) if (key.startsWith("skip:") && !stillSkipped.has(key)) this.notified.delete(key);
	}

	private async applyActions(actions: LinkAction[], dir: string, links: Record<string, string>): Promise<boolean> {
		const { fs, classifier } = this.deps;
		let changed = false;
		let dirReady = false;
		const ensureDir = async () => {
			if (dirReady) return;
			try {
				await fs.mkdir(dir);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			dirReady = true;
		};

		for (const action of actions) {
			const path = `${dir}/${action.name}`;
			try {
				switch (action.type) {
					case "create": {
						await ensureDir();
						await fs.symlink(action.target, path);
						links[action.name] = action.target;
						changed = true;
						break;
					}
					case "replace": {
						const stat = await lstatOrNull(fs, path);
						if (stat === null || !stat.isSymbolicLink()) break; // changed under us; the next sync plans it again
						classifier.expectPrefix(sourceLinkPath(action.name));
						await fs.unlink(path);
						delete links[action.name];
						changed = true;
						await fs.symlink(action.target, path);
						links[action.name] = action.target;
						break;
					}
					case "remove": {
						const stat = await lstatOrNull(fs, path);
						if (stat !== null && stat.isSymbolicLink()) {
							classifier.expectPrefix(sourceLinkPath(action.name));
							await fs.unlink(path);
						}
						delete links[action.name];
						changed = true;
						break;
					}
					case "adopt":
						links[action.name] = action.target;
						changed = true;
						break;
					case "forget":
						delete links[action.name];
						changed = true;
						break;
					case "skip":
						this.notifyOnce(
							`skip:${action.name}`,
							action.reason === "clash"
								? `Atlas: "${SOURCES_FOLDER}/${action.name}" already exists and isn't a link Atlas made, so source "${action.name}" isn't linked. The other sources are.`
								: `Atlas: "${SOURCES_FOLDER}/${action.name}" is a link Atlas didn't make and points somewhere else, so source "${action.name}" isn't linked.`
						);
						break;
				}
			} catch (error) {
				console.error(`[Atlas] couldn't ${action.type} the ${SOURCES_FOLDER}/${action.name} link`, error);
				this.notifyOnce(`fail:${action.type}:${action.name}`, `Atlas: couldn't ${action.type} the link for source "${action.name}" (${errorCode(error) ?? "unknown error"}).`);
			}
		}
		return changed;
	}

	private async readGitignore(source: TopLevelSource): Promise<string | null | undefined> {
		const { fs } = this.deps;
		try {
			return (await fs.readFile(`${source.root}/.gitignore`, "utf8")).slice(0, MAX_GITIGNORE_CHARS);
		} catch (error) {
			// No `.gitignore` in a folder that is there: no entries beyond `.git/`. A folder that isn't there
			// (unplugged drive) or can't be read: unknown, so what Atlas added for it stays.
			if (errorCode(error) === "ENOENT" && (await lstatOrNull(fs, source.root).catch(() => null)) !== null) return null;
			return undefined;
		}
	}

	private async reconcileExcludes(all: TephraSource[], linked: TopLevelSource[], removeStale: boolean): Promise<void> {
		const config = this.deps.excludeConfig();
		if (config === null) return;
		const tracked = this.deps.records.getExcludes();
		const desired: Record<string, string[]> = {};
		const skippedLines: Record<string, SkippedGitignoreLine[]> = {};

		for (const source of linked) {
			const text = await this.readGitignore(source);
			const showInSearch = this.deps.showsInSearch(source.name);
			if (text === undefined) {
				// Unknown right now: keep what Atlas added from the `.gitignore`, and make sure `.git/` is covered.
				// The whole-source entry isn't from the `.gitignore`: it follows the setting even now.
				const base = desiredEntriesForSource(source.name, null, showInSearch).entries;
				const wholeSource = sourceExcludeEntry(source.name);
				const kept = (getOwn(tracked, source.name) ?? []).filter((entry) => entry !== wholeSource);
				desired[source.name] = [...new Set([...kept, ...base])];
				skippedLines[source.name] = this.skippedLines[source.name] ?? [];
				continue;
			}
			const mapping = desiredEntriesForSource(source.name, text, showInSearch);
			desired[source.name] = mapping.entries;
			skippedLines[source.name] = mapping.skipped;
		}
		// "Show in search" off covers the whole source, linked or not (a nested source has no folder of its own).
		for (const source of all) {
			if (source.name === "notes" || getOwn(desired, source.name) !== undefined) continue;
			if (!this.deps.showsInSearch(source.name)) desired[source.name] = [sourceExcludeEntry(source.name)];
		}

		const result = reconcileExcludes(config, { desired, tracked, removeStale });
		this.deps.records.setExcludes(result.tracked);
		if (removeStale) this.skippedLines = skippedLines;
		if (result.added.length + result.removed.length > 0) {
			await this.deps.records.save();
			this.deps.onExcludesChanged?.();
		}
	}
}

/** Re-exported for the PR's own tests: how a `.gitignore` text maps without any filesystem. */
export { mapGitignore };
