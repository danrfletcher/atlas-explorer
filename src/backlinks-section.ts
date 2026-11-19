import type { App } from "obsidian";
import { TFile } from "obsidian";
import { chooseOpener, openSourceFile, registeredExtensions } from "./source-open";
import { fetchBacklinkRows, isIndexedNote, type BacklinkRow, type BacklinksResult, type TephraCaller } from "./tephra-backlinks";

/** The heading of the section (G10). */
export const TEPHRA_SECTION_TITLE = "Also linked from (Tephra)";
export const TEPHRA_SECTION_CLASS = "atlas-tephra-backlinks";
const ROW_CLASS = "atlas-tephra-backlink-row";
/** Obsidian's core Backlinks view type, and the element inside it the section is appended to. */
export const BACKLINK_VIEW_TYPE = "backlink";
const BACKLINK_PANE_SELECTOR = ".backlink-pane";
/** The fallback pane (G10) and its leaf type. */
export const ATLAS_LINKS_VIEW_TYPE = "atlas-links";

export type BacklinksMode = "backlinks" | "pane";

export interface BacklinksSectionDeps {
	app: App;
	/** Tephra toggle on and not mobile. With it off nothing renders, nothing is called and everything we added is removed. */
	isEnabled: () => boolean;
	/** The live connection, or null. Its `getSnapshot().sources` names the sources Atlas knows. */
	getConnection: () => (TephraCaller & { getSnapshot(): { sources: ReadonlyArray<{ name: string }> } }) | null;
	/** Q13 fallback mode (PR-1): Obsidian's own Backlinks can't list a cross-source note-to-note link. */
	includeCrossSourceNotes: () => boolean;
	/** Opens a row (never creates a file). */
	open: (path: string, line: number | null, newTab: boolean) => void;
}

interface Host {
	el: HTMLElement;
	kind: "backlinks" | "pane";
}

/** What a view in the pane leaf must offer. `AtlasLinksView` does. */
interface HasContentEl {
	contentEl?: HTMLElement;
}

/**
 * G10: "Also linked from (Tephra)". Shows links to the active file that Obsidian's own index can't see (a code
 * comment, a PDF, an Office file), from `graph.get_backlinks`, as `path:line` rows.
 *
 * Where: at the bottom of the core Backlinks panel (view type `backlink`, the element `.backlink-pane`). If no
 * such leaf is open or its DOM isn't the expected shape, the same list goes in the Atlas Links pane, which is
 * always registered. The choice is logged once at debug level. Both can be present at once; each is a "host".
 *
 * Nothing here writes a file or a setting, and Obsidian's own link store, `getBacklinksForFile` and graph are
 * untouched: the only Obsidian internals read are the `backlink` leaf's `containerEl` and the `.backlink-pane`
 * element inside it.
 *
 * One request at a time matters: each `refresh()` takes a token, and only the latest token's answer renders, so
 * a slow answer for a file the user already left never shows under the new one.
 */
export class TephraBacklinksSection {
	private token = 0;
	private inFlightPath: string | null = null;
	private lastPath: string | null = null;
	private last: BacklinksResult | null = null;
	private loggedMode = false;
	/** One section element per host, so a re-render reuses it instead of adding another. */
	private readonly sections = new Map<HTMLElement, HTMLElement>();
	private readonly observers = new Map<HTMLElement, MutationObserver>();

	constructor(private readonly deps: BacklinksSectionDeps) {}

	/** Which host a render would use right now. */
	getMode(): BacklinksMode {
		return this.findBacklinkPanes().length > 0 ? "backlinks" : "pane";
	}

	/**
	 * Re-reads the list for the active file. Without `force`, a call for the file already shown (or already being
	 * fetched) doesn't ask Tephra again: it only makes sure every host has the section (a Backlinks panel that
	 * was just opened). `force` is for a change in the graph or the toggle.
	 */
	refresh(force = false): void {
		if (!this.deps.isEnabled()) {
			this.detach();
			return;
		}
		const connection = this.deps.getConnection();
		const file = this.deps.app.workspace.getActiveFile();
		if (!connection || !file) {
			this.token++; // anything in flight is for a file that is no longer the active one
			this.inFlightPath = null;
			this.lastPath = null;
			this.last = null;
			this.apply(null);
			return;
		}
		this.logModeOnce();
		if (!force && file.path === this.lastPath && this.last !== null && this.inFlightPath === null) {
			this.apply(this.last);
			return;
		}
		if (!force && file.path === this.inFlightPath) return;
		const token = ++this.token;
		const path = file.path;
		this.inFlightPath = path;
		const knownSources = new Set(connection.getSnapshot().sources.map((source) => source.name));
		void fetchBacklinkRows(connection, path, {
			knownSources,
			fileExists: (p) => this.deps.app.vault.getAbstractFileByPath(p) instanceof TFile,
			hasFileCache: (p) => {
				const f = this.deps.app.vault.getAbstractFileByPath(p);
				return f instanceof TFile && isIndexedNote(f, this.deps.app.metadataCache.getFileCache(f));
			},
			includeCrossSourceNotes: this.deps.includeCrossSourceNotes(),
		}).then((result) => {
			if (token !== this.token) return; // a newer request started, or the toggle went off
			this.inFlightPath = null;
			this.lastPath = path;
			this.last = result;
			this.apply(result);
		});
	}

	/** Toggle off, unload: invalidates anything in flight and removes every element this added. */
	detach(): void {
		this.token++;
		this.inFlightPath = null;
		this.lastPath = null;
		this.last = null;
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
		for (const section of this.sections.values()) section.remove();
		this.sections.clear();
		// Anything left in a host (a section from an earlier instance of the plugin, say) goes too.
		for (const host of this.hosts()) removeSections(host.el);
	}

	private logModeOnce(): void {
		if (this.loggedMode) return;
		this.loggedMode = true;
		console.debug(
			this.getMode() === "backlinks"
				? `[Atlas] Tephra links: extending the Backlinks panel (${BACKLINK_VIEW_TYPE} view, ${BACKLINK_PANE_SELECTOR}).`
				: "[Atlas] Tephra links: no Backlinks panel found (no `backlink` leaf, or no .backlink-pane in it); using the Atlas Links pane."
		);
	}

	private findBacklinkPanes(): HTMLElement[] {
		const panes: HTMLElement[] = [];
		for (const leaf of this.deps.app.workspace.getLeavesOfType(BACKLINK_VIEW_TYPE)) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement } | undefined)?.containerEl;
			const pane = root?.querySelector(BACKLINK_PANE_SELECTOR);
			if (pane instanceof HTMLElement) panes.push(pane);
		}
		return panes;
	}

	private hosts(): Host[] {
		const hosts: Host[] = this.findBacklinkPanes().map((el) => ({ el, kind: "backlinks" as const }));
		for (const leaf of this.deps.app.workspace.getLeavesOfType(ATLAS_LINKS_VIEW_TYPE)) {
			const el = (leaf.view as unknown as HasContentEl | undefined)?.contentEl;
			if (el instanceof HTMLElement) hosts.push({ el, kind: "pane" });
		}
		return hosts;
	}

	/** Puts `result` into every host: `null` or an empty list removes the section from the Backlinks panel (there
	 * is nothing to add; the pane says so); a failed call leaves the heading with nothing under it. */
	private apply(result: BacklinksResult | null): void {
		const live = new Set<HTMLElement>();
		for (const host of this.hosts()) {
			live.add(host.el);
			const emptyOk = result === null || (result.ok && result.rows.length === 0);
			if (host.kind === "backlinks" && emptyOk) {
				this.drop(host.el);
				continue;
			}
			const section = this.sectionFor(host);
			fillSection(section, result, host.kind === "pane", (path, line, newTab) => this.deps.open(path, line, newTab));
			this.keepLast(host.el, section);
		}
		for (const el of [...this.sections.keys()]) if (!live.has(el)) this.drop(el); // a closed panel
	}

	private drop(host: HTMLElement): void {
		this.observers.get(host)?.disconnect();
		this.observers.delete(host);
		this.sections.get(host)?.remove();
		this.sections.delete(host);
		removeSections(host);
	}

	/** The one section element of a host: ours if we have one, else a new one; any other copy is removed. */
	private sectionFor(host: Host): HTMLElement {
		let section = this.sections.get(host.el);
		if (!section || !section.isConnected || section.parentElement !== host.el) {
			section = document.createElement("div");
			section.className = TEPHRA_SECTION_CLASS;
			this.sections.set(host.el, section);
		}
		removeSections(host.el, section);
		return section;
	}

	/** Appends the section as the last child of a Backlinks panel and keeps it there if Obsidian re-renders the
	 * panel's own children. Re-attaching moves the same element, so there is never a second one. */
	private keepLast(host: HTMLElement, section: HTMLElement): void {
		if (host.lastElementChild !== section) host.appendChild(section);
		if (this.observers.has(host) || typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(() => {
			const mine = this.sections.get(host);
			if (!mine || !host.isConnected) return;
			if (host.lastElementChild !== mine) host.appendChild(mine); // ends the cycle: now last
		});
		observer.observe(host, { childList: true });
		this.observers.set(host, observer);
	}
}

/** Removes every `.atlas-tephra-backlinks` child of `host` except `keep`. */
function removeSections(host: HTMLElement, keep?: HTMLElement): void {
	for (const child of Array.from(host.children)) {
		if (child !== keep && child.classList.contains(TEPHRA_SECTION_CLASS)) child.remove();
	}
}

function rowLabel(row: BacklinkRow): string {
	return row.line === null ? row.path : `${row.path}:${row.line}`;
}

/** Draws the heading and rows. `result === null` is the no-file / not-ready state; a `{ ok: false }` result keeps
 * the heading and shows nothing under it (PR-9 owns the offline wording). Rows are delegated: one listener for
 * click, one for middle-click, none per row. */
function fillSection(section: HTMLElement, result: BacklinksResult | null, isPane: boolean, open: (path: string, line: number | null, newTab: boolean) => void): void {
	const title = document.createElement("div");
	title.className = "atlas-tephra-backlinks-title";
	title.textContent = TEPHRA_SECTION_TITLE;
	const body = document.createElement("div");
	body.className = "atlas-tephra-backlinks-rows";
	if (result?.ok) {
		const fragment = document.createDocumentFragment();
		for (const row of result.rows) {
			const el = document.createElement("div");
			el.className = ROW_CLASS;
			el.tabIndex = 0;
			el.setAttribute("role", "link");
			el.dataset.path = row.path;
			if (row.line !== null) el.dataset.line = String(row.line);
			el.textContent = rowLabel(row);
			fragment.appendChild(el);
		}
		body.appendChild(fragment);
		if (result.rows.length === 0 && isPane) {
			const empty = document.createElement("div");
			empty.className = "atlas-tephra-backlinks-empty";
			empty.textContent = "No links from code, PDF or Office files.";
			body.appendChild(empty);
		}
	}
	section.replaceChildren(title, body);
	bindRowEvents(section, open);
}

const BOUND = new WeakSet<HTMLElement>();

function bindRowEvents(section: HTMLElement, open: (path: string, line: number | null, newTab: boolean) => void): void {
	if (BOUND.has(section)) return;
	BOUND.add(section);
	const rowOf = (evt: Event): { path: string; line: number | null } | null => {
		const el = evt.target instanceof Element ? evt.target.closest(`.${ROW_CLASS}`) : null;
		if (!(el instanceof HTMLElement) || !el.dataset.path) return null;
		const line = el.dataset.line === undefined ? null : Number(el.dataset.line);
		return { path: el.dataset.path, line };
	};
	section.addEventListener("click", (evt) => {
		const row = rowOf(evt);
		if (row) open(row.path, row.line, evt.ctrlKey || evt.metaKey);
	});
	// Middle-click: a new tab. `mousedown` is guarded so the browser doesn't start middle-button autoscroll.
	section.addEventListener("mousedown", (evt) => {
		if (evt.button === 1 && rowOf(evt)) evt.preventDefault();
	});
	section.addEventListener("auxclick", (evt) => {
		if (evt.button !== 1) return;
		const row = rowOf(evt);
		if (row) {
			evt.preventDefault();
			open(row.path, row.line, true);
		}
	});
	section.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter") return;
		const row = rowOf(evt);
		if (row) open(row.path, row.line, evt.ctrlKey || evt.metaKey);
	});
}

/** G10: opens `path` at 1-based `line` (Obsidian's `eState.line` is 0-based). A file Obsidian has a view for opens
 * in a tab at that line; any other file goes to its default app by the existing source opener (the line is then
 * lost). It goes through `openFile`, never `openLinkText`: Obsidian's resolver can't resolve a path that runs
 * through a `Sources/<name>` folder link and would create a new note there (see `openSourceBlock`). Never writes
 * and never creates a file; a path that isn't a vault file does nothing. Returns false when nothing was opened. */
export async function openBacklinkRow(app: App, path: string, line: number | null, newTab: boolean): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	if (chooseOpener(file, registeredExtensions(app)) !== "obsidian") return (await openSourceFile(app, file, newTab)) !== null;
	try {
		await app.workspace.getLeaf(newTab).openFile(file, line === null ? undefined : { eState: { line: Math.max(0, line - 1) } });
		return true;
	} catch (error) {
		console.error(`[Atlas] Could not open "${path}"`, error);
		return false;
	}
}
