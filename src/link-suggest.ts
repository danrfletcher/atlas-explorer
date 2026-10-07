import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	SearchResult,
	TFile,
	TFolder,
	prepareFuzzySearch,
	renderResults,
} from "obsidian";
import type AtlasPlugin from "./main";
import { createInterfaceNote, findInterfaceNote } from "./interface-notes";
import { getFreeBlockDisplayText, getPromotedBlockDisplayText } from "./display-text";

const MAX_SUGGESTIONS = 50;

type SuggestItem =
	| { kind: "file"; file: TFile; text: string; match: SearchResult }
	| { kind: "folder-unit"; folder: TFolder; text: string; match: SearchResult }
	| { kind: "free-block"; file: TFile; text: string; match: SearchResult }
	| { kind: "promoted-block"; file: TFile; subpath: string; text: string; match: SearchResult };

/** Lower sorts first. A unit (folder-unit/free-block/promoted-block) only jumps the queue above
 * plain files when its own match is *competitive* with the best file match in this result set —
 * self-calibrating per query rather than a fixed score constant, so a unit that merely matched
 * (e.g. "Kubernetes" weakly matching the query "bets") doesn't bury a strong file match, but a
 * unit that's a genuinely good match (e.g. "Bets" matching "bets") still wins. See decisions.md. */
function kindPriority(item: SuggestItem, bestFileScore: number): number {
	if (item.kind === "file") return 1;
	return item.match.score >= bestFileScore ? 0 : 1;
}

/**
 * F6 — one blended `[[` suggester covering native files, folder-units, free blocks, and promoted
 * blocks, matched by fuzzy text. Registered normally (public API); winning precedence over
 * Obsidian's own native `[[` popup is a separate step — see `applySuggesterPrecedence` in main.ts
 * and docs/decisions.md for why and how.
 */
export class AtlasLinkSuggest extends EditorSuggest<SuggestItem> {
	constructor(private plugin: AtlasPlugin) {
		super(plugin.app);
		this.limit = MAX_SUGGESTIONS;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!file) return null;
		const line = editor.getLine(cursor.line).slice(0, cursor.ch);
		const match = /\[\[([^[\]]*)$/.exec(line);
		if (!match) return null;
		if (this.isInsideCodeBlock(file, cursor.line)) return null;

		const query = match[1];
		const startCh = cursor.ch - query.length - 2;
		return { start: { line: cursor.line, ch: startCh }, end: cursor, query };
	}

	private isInsideCodeBlock(file: TFile, lineNumber: number): boolean {
		const sections = this.plugin.app.metadataCache.getFileCache(file)?.sections;
		if (!sections) return false;
		return sections.some(
			(section) => section.type === "code" && lineNumber >= section.position.start.line && lineNumber <= section.position.end.line
		);
	}

	async getSuggestions(context: EditorSuggestContext): Promise<SuggestItem[]> {
		const search = prepareFuzzySearch(context.query);
		const items: SuggestItem[] = [];
		const { app, plugin } = { app: this.plugin.app, plugin: this.plugin };

		// Native files — every vault file, unfiltered by Atlas's own exclusions, matching what the
		// native `[[` popup would have shown.
		for (const file of app.vault.getFiles()) {
			const match = search(file.basename);
			if (match) items.push({ kind: "file", file, text: file.basename, match });
		}

		for (const unit of plugin.unitIndex.getUnits()) {
			// PR-1.F1 (G13): an added folder is a module, so it is listed here like any other.
			if (unit.type === "folder-unit" || unit.type === "promoted-folder" || unit.type === "added-folder") {
				const folder = app.vault.getAbstractFileByPath(unit.path);
				if (!(folder instanceof TFolder)) continue;
				const match = search(folder.name);
				if (match) items.push({ kind: "folder-unit", folder, text: folder.name, match });
			} else if (unit.type === "free-block") {
				const file = app.vault.getAbstractFileByPath(unit.path);
				if (!(file instanceof TFile)) continue;
				const [displayText, rawContent] = await Promise.all([
					getFreeBlockDisplayText(app, file, plugin.settings.blockDisplayLength),
					app.vault.cachedRead(file),
				]);
				const match = search(`${displayText}\n${rawContent}`);
				if (match) items.push({ kind: "free-block", file, text: displayText, match });
			} else if (unit.type === "promoted-block") {
				const file = app.vault.getAbstractFileByPath(unit.path);
				if (!(file instanceof TFile)) continue;
				const text = await getPromotedBlockDisplayText(app, file, unit.subpath, plugin.settings.blockDisplayLength);
				const match = search(text);
				if (match) items.push({ kind: "promoted-block", file, subpath: unit.subpath, text, match });
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
		const titleEl = el.createDiv({ cls: "atlas-link-suggest-title" });
		renderResults(titleEl, item.text, item.match);
		if (item.kind === "promoted-block") {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: `in ${item.file.name}` });
		} else if (item.kind === "free-block") {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: "block" });
		} else if (item.kind === "folder-unit") {
			el.createDiv({ cls: "atlas-link-suggest-secondary", text: "folder" });
		}
	}

	async selectSuggestion(item: SuggestItem, _evt: MouseEvent | KeyboardEvent): Promise<void> {
		const context = this.context;
		if (!context) return;
		const { app } = this.plugin;
		const sourcePath = context.file.path;
		let linkText: string;

		switch (item.kind) {
			case "file":
				linkText = app.fileManager.generateMarkdownLink(item.file, sourcePath);
				break;
			case "folder-unit": {
				const note = findInterfaceNote(app, item.folder, this.plugin.settings) ?? (await createInterfaceNote(app, item.folder));
				linkText = app.fileManager.generateMarkdownLink(note, sourcePath);
				break;
			}
			case "free-block":
				linkText = app.fileManager.generateMarkdownLink(item.file, sourcePath, undefined, item.text);
				break;
			case "promoted-block":
				linkText = app.fileManager.generateMarkdownLink(item.file, sourcePath, `#${item.subpath}`, item.text);
				break;
		}

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
