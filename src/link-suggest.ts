import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Notice,
	Platform,
	SearchResult,
	TFile,
	TFolder,
	prepareFuzzySearch,
	renderResults,
} from "obsidian";
import type AtlasPlugin from "./main";
import { createInterfaceNote, findInterfaceNote } from "./interface-notes";
import { getFreeBlockDisplayText, getPromotedBlockDisplayText } from "./display-text";
import { parseSuggestQuery, type ParsedSuggestQuery } from "./link-suggest-query";
import { findKnownSource, knownSources, type KnownSource } from "./link-suggest-sources";
import { ensureBlockId, searchInFile, type InFileHit } from "./link-suggest-tephra";
import { NOTES_SOURCE, SOURCES_FOLDER, ownSourceOf } from "./source-links";
import { pathInSource, sourceLinkText, sourceOfVaultPath } from "./source-link-text";

const MAX_SUGGESTIONS = 50;

/** Said when a pick fails: the link was not inserted. */
const NOTHING_INSERTED = "Nothing was inserted.";

/** `pill` is set while the popup searches every source (`[[@*:`), so each row says where it is from. */
interface Pill {
	pill?: string;
}

type ScoredItem =
	| ({ kind: "file"; file: TFile; text: string; match: SearchResult; secondary?: string } & Pill)
	| ({ kind: "folder-unit"; folder: TFolder; text: string; match: SearchResult } & Pill)
	| ({ kind: "free-block"; file: TFile; text: string; match: SearchResult } & Pill)
	| ({ kind: "promoted-block"; file: TFile; subpath: string; text: string; match: SearchResult } & Pill);

type SuggestItem =
	| ScoredItem
	/** G8: a source in the `[[@` list; `all` is the "All sources" row (`[[@*:`). */
	| { kind: "source"; name: string; text: string; all: boolean; missing: boolean }
	/** A row that only says something (no such source, Tephra offline, an error). Picking it inserts nothing. */
	| { kind: "message"; text: string }
	/** G8: something inside a file, found by Tephra's `unit.search` after `#` or `^`. */
	| { kind: "in-file"; file: TFile; unit: string; marker: "#" | "^"; hit: InFileHit; text: string };

/** Lower sorts first. A unit (folder-unit/free-block/promoted-block) only jumps the queue above
 * plain files when its own match is *competitive* with the best file match in this result set —
 * self-calibrating per query rather than a fixed score constant, so a unit that merely matched
 * (e.g. "Kubernetes" weakly matching the query "bets") doesn't bury a strong file match, but a
 * unit that's a genuinely good match (e.g. "Bets" matching "bets") still wins. See decisions.md. */
function kindPriority(item: ScoredItem, bestFileScore: number): number {
	if (item.kind === "file") return 1;
	return item.match.score >= bestFileScore ? 0 : 1;
}

/** A heading as link text: the characters a link can't carry are dropped and runs of space collapse. */
function headingLinkText(text: string): string {
	return text.replace(/[#|^[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * F6 — one blended `[[` suggester covering native files, folder-units, free blocks, and promoted
 * blocks, matched by fuzzy text. Registered normally (public API); winning precedence over
 * Obsidian's own native `[[` popup is a separate step — see `applySuggesterPrecedence` in main.ts
 * and docs/decisions.md for why and how.
 *
 * G8 — with the Tephra toggle on (desktop) it also knows sources: `[[text` searches only the note's own
 * source, `[[@` lists sources, `[[@name:text` / `[[@*:text` search one or all, and `#` / `^` after an
 * `@source:` target or a non-note file search inside that file through Tephra. With the toggle off none
 * of that runs: the popup is the F6 one and Tephra is never called.
 */
export class AtlasLinkSuggest extends EditorSuggest<SuggestItem> {
	/** Counts `getSuggestions` calls while Tephra is on (the stale-reply guard). */
	private run = 0;
	private newest: Promise<SuggestItem[]> = Promise.resolve([]);
	/** The rows the popup is showing, so a failed pick can put a message above them. */
	private shown: SuggestItem[] = [];
	/** A `block.ensure_id` call is in flight: a second pick waits for it instead of asking twice. */
	private picking = false;

	constructor(private plugin: AtlasPlugin) {
		super(plugin.app);
		this.limit = MAX_SUGGESTIONS;
	}

	/** G16: Tephra mode on, on desktop. Everything G8 adds is behind this. */
	private tephraOn(): boolean {
		return this.plugin.settings.tephraEnabled === true && !Platform.isMobile;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!file) return null;
		const line = editor.getLine(cursor.line).slice(0, cursor.ch);
		const match = /\[\[([^[\]]*)$/.exec(line);
		if (!match) return null;
		if (this.isInsideCodeBlock(file, cursor.line)) return null;

		const query = match[1];

		if (this.tephraOn()) {
			if (!this.triggersWithSources(query, file)) return null;
		} else {
			// If `#` or `^` appears before any `|`, this is a heading/block link (or the same for an
			// embed, same `[[`/`![[` path) — step aside so Obsidian's own heading/block suggester gets
			// a turn instead of Atlas fuzzy-matching `File#Heading` against file names and finding
			// nothing. `[[A|alias#x` is unaffected because the `|` comes first (settled call, F4).
			const specialChar = /[#^|]/.exec(query);
			if (specialChar && specialChar[0] !== "|") return null;
		}

		const startCh = cursor.ch - query.length - 2;
		return { start: { line: cursor.line, ch: startCh }, end: cursor, query };
	}

	/**
	 * G8, Tephra on: whether Atlas's popup takes this query.
	 *  - `[[text` and `[[text|alias`: yes, as today.
	 *  - Anything with an `@source:` target, once a `|` follows it or a `#`/`^` sub-search: an alias is
	 *    nobody's to complete, so null.
	 *  - `#`/`^` after a plain target: Obsidian's popup keeps plain *note* targets (null here, as with the
	 *    toggle off); a non-note file (`registry.rs#`) and an `@source:` target are Tephra's search.
	 *  - `[[#`, `[[^` (the note itself), `[[@wh#` (no file yet): null.
	 */
	private triggersWithSources(query: string, file: TFile): boolean {
		const parsed = parseSuggestQuery(query);
		if (parsed.alias && (parsed.mode !== "own" || parsed.marker !== null)) return false;
		if (parsed.marker === null) return true;
		if (parsed.mode === "sources" || parsed.mode === "all") return false;
		if (parsed.query === "") return false;
		if (parsed.mode === "source") return true;
		const target = this.resolveTarget(parsed.query, file.path);
		return target !== null && target.extension.toLowerCase() !== "md";
	}

	/** The file a typed target means from the note at `fromPath`, by the link rule; null when there is none. */
	private resolveTarget(target: string, fromPath: string): TFile | null {
		try {
			return this.plugin.sourceLinks.resolveFile(target, fromPath);
		} catch {
			return null;
		}
	}

	private isInsideCodeBlock(file: TFile, lineNumber: number): boolean {
		const sections = this.plugin.app.metadataCache.getFileCache(file)?.sections;
		if (!sections) return false;
		return sections.some(
			(section) => section.type === "code" && lineNumber >= section.position.start.line && lineNumber <= section.position.end.line
		);
	}

	async getSuggestions(context: EditorSuggestContext): Promise<SuggestItem[]> {
		if (!this.tephraOn()) return this.collect(context.query, this.plugin.app.vault.getFiles(), { units: true });

		// Fast typing: a Tephra reply can land after a newer query's. Whatever order replies arrive in, every
		// call returns the rows of the newest query, so a stale reply never replaces newer results.
		const seq = ++this.run;
		const mine = this.computeWithSources(context);
		this.newest = mine;
		let items = await mine;
		let current = mine;
		while (this.newest !== current) {
			current = this.newest;
			items = await current;
		}
		if (seq === this.run) this.shown = items;
		return items;
	}

	private async computeWithSources(context: EditorSuggestContext): Promise<SuggestItem[]> {
		const parsed = parseSuggestQuery(context.query);
		const fromPath = context.file?.path ?? "";

		if (parsed.marker !== null) {
			if (parsed.mode === "source" || parsed.mode === "own") return this.searchInside(parsed, fromPath);
			return [];
		}
		switch (parsed.mode) {
			case "sources":
				return this.sourceRows(parsed.query);
			case "own": {
				// `[[text|alias`: today's popup searches the whole typed text, so this one does too.
				const own = ownSourceOf(fromPath);
				return this.collect(parsed.alias ? context.query : parsed.query, this.filesOf(own), { units: own.toLowerCase() === NOTES_SOURCE });
			}
			case "source": {
				const typed = parsed.source ?? "";
				const source = findKnownSource(this.knownSources(), typed);
				if (!source) return [{ kind: "message", text: `No source named ${typed}`.trimEnd() }];
				if (source.status === "missing") return []; // E5: nothing to find in a folder that isn't there
				return this.collect(parsed.query, this.filesOf(source.name), { units: source.name.toLowerCase() === NOTES_SOURCE, secondary: true });
			}
			case "all":
				return this.collect(parsed.query, this.filesOf(null), { units: true, pills: true, secondary: true });
		}
	}

	/** Files of one source, or for null of every source. Computed per call from Obsidian's file list: no
	 * index is kept (F1). Files in no source (`Sources/x.md`, `Sources/notes/…`) are in none. */
	private filesOf(source: string | null): TFile[] {
		const wanted = source === null ? null : source.toLowerCase();
		return this.plugin.app.vault.getFiles().filter((file) => {
			const owner = sourceOfVaultPath(file.path);
			return owner !== null && (wanted === null || owner.toLowerCase() === wanted);
		});
	}

	/** Every source the popup can name: Tephra's list while it answers, otherwise what Atlas already linked. */
	private knownSources(): KnownSource[] {
		const snapshot = this.plugin.tephraConnection?.getSnapshot();
		const folder = this.plugin.app.vault.getAbstractFileByPath(SOURCES_FOLDER);
		const folderNames = folder instanceof TFolder ? folder.children.filter((child) => child instanceof TFolder).map((child) => child.name) : [];
		return knownSources({
			online: snapshot && snapshot.state === "online" ? snapshot.sources : null,
			linkedNames: Object.keys(this.plugin.settings.tephraLinks ?? {}),
			folderNames,
		});
	}

	/** `[[@` and `[[@wh`: "All sources" first, then the sources whose name matches; none matching is a message. */
	private sourceRows(filter: string): SuggestItem[] {
		let matching = this.knownSources();
		if (filter !== "") {
			const search = prepareFuzzySearch(filter);
			matching = matching
				.map((source) => ({ source, match: search(source.name) }))
				.filter((entry): entry is { source: KnownSource; match: SearchResult } => entry.match !== null)
				.sort((a, b) => b.match.score - a.match.score)
				.map((entry) => entry.source);
		}
		if (matching.length === 0) return [{ kind: "message", text: `No source named ${filter}`.trimEnd() }];
		const rows: SuggestItem[] = matching.map((source) => ({
			kind: "source",
			name: source.name,
			text: source.status === "missing" ? `${source.name} (missing)` : source.name,
			all: false,
			missing: source.status === "missing",
		}));
		return [{ kind: "source", name: "*", text: "All sources", all: true, missing: false }, ...rows];
	}

	/** The `#` / `^` search inside the file the typed target means, through Tephra (G8). */
	private async searchInside(parsed: ParsedSuggestQuery, fromPath: string): Promise<SuggestItem[]> {
		const marker = parsed.marker;
		if (marker === null) return [];
		const target = parsed.mode === "source" ? `@${parsed.source ?? ""}:${parsed.query}` : parsed.query;
		const file = this.resolveTarget(target, fromPath);
		const source = file ? sourceOfVaultPath(file.path) : null;
		if (!file || source === null) return [{ kind: "message", text: `No file ${parsed.query} to search in` }];
		const unit = `@${source}:${pathInSource(file.path, source)}`;

		const connection = this.plugin.tephraConnection;
		if (!connection || connection.getSnapshot().state !== "online") {
			connection?.requestCheck(); // it may be back already: look again, so the next keystroke can use it
			return [{ kind: "message", text: "Tephra offline" }];
		}
		const result = await searchInFile(connection, unit, marker === "#" ? "headings" : "blocks", parsed.sub, MAX_SUGGESTIONS);
		if (!result.ok) return [{ kind: "message", text: result.message }];
		return result.hits.slice(0, this.limit ?? MAX_SUGGESTIONS).map((hit) => ({ kind: "in-file", file, unit, marker, hit, text: hit.text }));
	}

	/** The F6 search: files, folder-units, free blocks and promoted blocks matched against `query`. */
	private async collect(
		query: string,
		files: readonly TFile[],
		options: { units: boolean; pills?: boolean; secondary?: boolean }
	): Promise<ScoredItem[]> {
		const search = prepareFuzzySearch(query);
		const items: ScoredItem[] = [];
		const { app, plugin } = { app: this.plugin.app, plugin: this.plugin };

		// Native files — every vault file, unfiltered by Atlas's own exclusions, matching what the
		// native `[[` popup would have shown.
		for (const file of files) {
			const match = search(file.basename);
			if (!match) continue;
			const item: ScoredItem = { kind: "file", file, text: file.basename, match };
			if (options.pills || options.secondary) {
				const owner = sourceOfVaultPath(file.path);
				if (options.pills && owner !== null) item.pill = owner;
				if (options.secondary && owner !== null) item.secondary = pathInSource(file.path, owner);
			}
			items.push(item);
		}

		if (options.units) {
			const pill = options.pills ? NOTES_SOURCE : undefined;
			for (const unit of plugin.unitIndex.getUnits()) {
				// PR-1.F1 (G13): an added folder is a module, so it is listed here like any other.
				if (unit.type === "folder-unit" || unit.type === "promoted-folder" || unit.type === "added-folder") {
					const folder = app.vault.getAbstractFileByPath(unit.path);
					if (!(folder instanceof TFolder)) continue;
					const match = search(folder.name);
					if (match) items.push({ kind: "folder-unit", folder, text: folder.name, match, pill });
				} else if (unit.type === "free-block") {
					const file = app.vault.getAbstractFileByPath(unit.path);
					if (!(file instanceof TFile)) continue;
					const [displayText, rawContent] = await Promise.all([
						getFreeBlockDisplayText(app, file, plugin.settings.blockDisplayLength),
						app.vault.cachedRead(file),
					]);
					const match = search(`${displayText}\n${rawContent}`);
					if (match) items.push({ kind: "free-block", file, text: displayText, match, pill });
				} else if (unit.type === "promoted-block") {
					const file = app.vault.getAbstractFileByPath(unit.path);
					if (!(file instanceof TFile)) continue;
					const text = await getPromotedBlockDisplayText(app, file, unit.subpath, plugin.settings.blockDisplayLength);
					const match = search(text);
					if (match) items.push({ kind: "promoted-block", file, subpath: unit.subpath, text, match, pill });
				}
			}
		}

		// A unit only jumps above files when it's a competitive match itself (see kindPriority) —
		// otherwise a competing file (e.g. `Bets/notes-on-bets.md`) could out-score the `Bets`
		// folder-unit for a query like "bets" and nothing would stop it ranking above the folder.
		const bestFileScore = Math.max(-Infinity, ...items.filter((item) => item.kind === "file").map((item) => item.match.score));
		items.sort((a, b) => kindPriority(a, bestFileScore) - kindPriority(b, bestFileScore) || b.match.score - a.match.score);
		return items.slice(0, this.limit);
	}

	renderSuggestion(item: SuggestItem, el: HTMLElement): void {
		el.addClass("atlas-link-suggest-item");
		if (item.kind === "message") {
			el.addClass("atlas-link-suggest-message");
			el.createDiv({ cls: "atlas-link-suggest-title", text: item.text });
			return;
		}
		if (item.kind === "source") {
			if (item.missing) el.addClass("atlas-link-suggest-missing");
			el.createDiv({ cls: "atlas-link-suggest-title", text: item.text });
			if (item.all) el.createDiv({ cls: "atlas-link-suggest-secondary", text: "search every source" });
			return;
		}
		if (item.kind === "in-file") {
			el.createDiv({ cls: "atlas-link-suggest-title", text: item.text });
			const label = item.hit.kind === "heading" ? `h${item.hit.level ?? ""}` : item.hit.symbolKind ?? item.hit.kind;
			const parts = [label, item.hit.place, item.hit.blockId ? `^${item.hit.blockId}` : ""].filter((part) => part !== "");
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: parts.join(" · ") });
			return;
		}
		const titleEl = el.createDiv({ cls: "atlas-link-suggest-title" });
		renderResults(titleEl, item.text, item.match);
		if (item.pill) titleEl.createSpan({ cls: "atlas-link-suggest-pill", text: item.pill });
		if (item.kind === "promoted-block") {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: `in ${item.file.name}` });
		} else if (item.kind === "free-block") {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: "block" });
		} else if (item.kind === "folder-unit") {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: "folder" });
		} else if (item.secondary) {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: item.secondary });
		}
	}

	async selectSuggestion(item: SuggestItem, _evt: MouseEvent | KeyboardEvent): Promise<void> {
		const context = this.context;
		if (!context) return;
		if (item.kind === "message") return; // nothing to insert; the popup stays as it is
		if (item.kind === "source") {
			this.pickSource(item, context);
			return;
		}
		if (item.kind === "in-file") {
			await this.pickInFile(item, context);
			return;
		}

		const { app } = this.plugin;
		const sourcePath = context.file.path;
		let linkText: string;

		switch (item.kind) {
			case "file":
				linkText = this.linkTo(item.file, sourcePath);
				break;
			case "folder-unit": {
				const note = findInterfaceNote(app, item.folder, this.plugin.settings) ?? (await createInterfaceNote(app, item.folder));
				linkText = this.linkTo(note, sourcePath);
				break;
			}
			case "free-block":
				linkText = this.linkTo(item.file, sourcePath, undefined, item.text);
				break;
			case "promoted-block":
				linkText = this.linkTo(item.file, sourcePath, `#${item.subpath}`, item.text);
				break;
		}
		this.insertLink(context, linkText);
	}

	/**
	 * The link to `file` from the note at `sourcePath`. With Tephra off, or for a vault file picked from a
	 * vault note, it is exactly what Obsidian's `generateMarkdownLink` gives (F9). Otherwise the G8 rule
	 * decides the target: `[[Name]]` inside a source, `[[@source:path]]` across sources, and in Q13 fallback
	 * mode the full vault path where a plain name clashes with a file in another source.
	 */
	private linkTo(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
		const { app } = this.plugin;
		const native = () => app.fileManager.generateMarkdownLink(file, sourcePath, subpath, alias);
		if (!this.tephraOn()) return native();
		const picked = sourceLinkText(file, sourcePath, app.vault.getFiles(), { fullPathOnClash: this.plugin.sourceLinks.getMode() === "fallback" });
		if (picked.kind === "same-source" && picked.source?.toLowerCase() === NOTES_SOURCE) return native();
		return `[[${picked.text}${subpath ?? ""}${alias ? `|${alias}` : ""}]]`;
	}

	/** `[[@whoop:` (or `[[@*:`): the typed text becomes the source prefix and the cursor stays inside the
	 * brackets, so the next keystrokes search that source. An auto-closed `]]` is left where it is. */
	private pickSource(item: Extract<SuggestItem, { kind: "source" }>, context: EditorSuggestContext): void {
		const text = `[[@${item.name}:`;
		context.editor.replaceRange(text, context.start, context.end);
		context.editor.setCursor({ line: context.start.line, ch: context.start.ch + text.length });
	}

	/** A heading goes in by its text. A block goes in by its `^id`; one without an ID gets it from Tephra
	 * (`block.ensure_id`: Atlas never writes the file, F3). Any failure inserts nothing and says so in the popup. */
	private async pickInFile(item: Extract<SuggestItem, { kind: "in-file" }>, context: EditorSuggestContext): Promise<void> {
		if (this.picking) return;
		const base = sourceLinkText(item.file, context.file.path, this.plugin.app.vault.getFiles(), {
			fullPathOnClash: this.plugin.sourceLinks.getMode() === "fallback",
		}).text;
		const { hit } = item;
		if (item.marker === "#") {
			const heading = headingLinkText(hit.text);
			if (heading === "") return this.showMessage(`This heading has no text a link can use. ${NOTHING_INSERTED}`);
			this.insertLink(context, `[[${base}#${heading}]]`);
			return;
		}
		if (hit.blockId !== null) {
			this.insertLink(context, `[[${base}#^${hit.blockId}]]`);
			return;
		}
		const connection = this.plugin.tephraConnection;
		if (hit.line === null) return this.showMessage(`This block can't be given an ID. ${NOTHING_INSERTED}`);
		if (!connection || connection.getSnapshot().state !== "online") {
			connection?.requestCheck();
			return this.showMessage("Tephra offline");
		}
		this.picking = true;
		try {
			const result = await ensureBlockId(connection, item.unit, hit.line);
			if (!result.ok) return this.showMessage(result.message);
			if (this.context !== context) return; // the popup moved on while Tephra wrote the ID
			this.insertLink(context, `[[${base}#^${result.id}]]`);
		} finally {
			this.picking = false;
		}
	}

	/** Puts a message row above the current rows and leaves the popup open. Falls back to a notice when
	 * Obsidian's list can't be reached (its internals changed). */
	private showMessage(text: string): void {
		const rows: SuggestItem[] = [{ kind: "message", text }, ...this.shown.filter((row) => row.kind !== "message")];
		const list = (this as unknown as { suggestions?: { setSuggestions?: (items: SuggestItem[]) => void } }).suggestions;
		try {
			if (typeof list?.setSuggestions === "function") {
				list.setSuggestions(rows);
				this.shown = rows;
				return;
			}
		} catch {
			// fall through to the notice
		}
		new Notice(`Atlas: ${text}`);
	}

	private insertLink(context: EditorSuggestContext, linkText: string): void {
		// Obsidian auto-closes the `]]` when the triggering `[[` was typed, sitting just past
		// `context.end` (which only spans up to the query text). Left alone, that produces a
		// leftover `]]` after our own replacement's closing bracket. Consume it if present.
		const lineText = context.editor.getLine(context.end.line);
		const hasAutoClosedBrackets = lineText.slice(context.end.ch, context.end.ch + 2) === "]]";
		const replaceEnd = hasAutoClosedBrackets ? { line: context.end.line, ch: context.end.ch + 2 } : context.end;

		context.editor.replaceRange(linkText, context.start, replaceEnd);
		context.editor.setCursor({ line: context.start.line, ch: context.start.ch + linkText.length });
	}
}
