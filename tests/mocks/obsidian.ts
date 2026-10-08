/** Hand-written stand-in for the `obsidian` package (vitest aliases it here): just enough of the
 * vault model, `Modal` (with a real jsdom DOM), `Notice` (recordable), `Setting` and `debounce`. */

// --- Obsidian's HTMLElement helpers -------------------------------------------------------------
interface CreateOpts {
	text?: string;
	cls?: string;
	type?: string;
	attr?: Record<string, string>;
}

declare global {
	interface HTMLElement {
		createEl<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: CreateOpts | string): HTMLElementTagNameMap[K];
		createDiv(opts?: CreateOpts | string): HTMLDivElement;
		createSpan(opts?: CreateOpts | string): HTMLSpanElement;
		empty(): void;
		setText(text: string): void;
		addClass(...cls: string[]): void;
		removeClass(...cls: string[]): void;
		toggleClass(cls: string, on: boolean): void;
		setAttr(name: string, value: string): void;
	}
}

function make(parent: HTMLElement, tag: string, opts?: CreateOpts | string): HTMLElement {
	const o: CreateOpts = typeof opts === "string" ? { cls: opts } : opts ?? {};
	const el = document.createElement(tag);
	if (o.cls) el.className = o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.type) el.setAttribute("type", o.type);
	for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
	parent.appendChild(el);
	return el;
}

const proto = HTMLElement.prototype;
proto.createEl = function (tag: string, opts?: CreateOpts | string) {
	return make(this, tag, opts) as never;
};
proto.createDiv = function (opts?: CreateOpts | string) {
	return make(this, "div", opts) as HTMLDivElement;
};
proto.createSpan = function (opts?: CreateOpts | string) {
	return make(this, "span", opts) as HTMLSpanElement;
};
proto.empty = function () {
	this.replaceChildren();
};
proto.setText = function (text: string) {
	this.textContent = text;
};
proto.addClass = function (...cls: string[]) {
	this.classList.add(...cls);
};
proto.removeClass = function (...cls: string[]) {
	this.classList.remove(...cls);
};
proto.toggleClass = function (cls: string, on: boolean) {
	this.classList.toggle(cls, on);
};
proto.setAttr = function (name: string, value: string) {
	this.setAttribute(name, value);
};

// --- Vault model --------------------------------------------------------------------------------
export class TAbstractFile {
	path = "";
	name = "";
	parent: TFolder | null = null;
	vault!: Vault;
}

export class TFile extends TAbstractFile {
	extension = "md";
	stat = { ctime: 0, mtime: 0, size: 0 };
	get basename(): string {
		return this.name.slice(0, this.name.length - this.extension.length - 1);
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/";
	}
}

type VaultEvent = "create" | "delete" | "rename" | "modify";

/** In-memory vault. Every mutating call is recorded in `calls` so tests can assert "no disk API". */
export class Vault {
	private root = new TFolder();
	private entries = new Map<string, TAbstractFile>();
	private listeners = new Map<VaultEvent, Set<(...args: any[]) => void>>();
	calls: string[] = [];

	constructor() {
		this.root.path = "/";
		this.root.name = "";
		this.root.vault = this;
	}

	getRoot(): TFolder {
		return this.root;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.entries.get(path) ?? null;
	}

	getFiles(): TFile[] {
		return [...this.entries.values()].filter((e): e is TFile => e instanceof TFile);
	}

	/** Every loaded entry, the vault root included, as Obsidian's `getAllLoadedFiles` does. */
	getAllLoadedFiles(): TAbstractFile[] {
		return [this.root, ...this.entries.values()];
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === "md");
	}

	on(name: VaultEvent, cb: (...args: any[]) => void): { name: VaultEvent; cb: (...args: any[]) => void } {
		if (!this.listeners.has(name)) this.listeners.set(name, new Set());
		this.listeners.get(name)!.add(cb);
		return { name, cb };
	}

	private emit(name: VaultEvent, ...args: unknown[]): void {
		for (const cb of this.listeners.get(name) ?? []) cb(...args);
	}

	private link(entry: TAbstractFile, path: string): void {
		const slash = path.lastIndexOf("/");
		const parent = slash === -1 ? this.root : (this.entries.get(path.slice(0, slash)) as TFolder);
		entry.path = path;
		entry.name = path.slice(slash + 1);
		entry.parent = parent;
		entry.vault = this;
		parent.children.push(entry);
		this.entries.set(path, entry);
	}

	private unlink(entry: TAbstractFile): void {
		entry.parent!.children = entry.parent!.children.filter((c) => c !== entry);
		this.entries.delete(entry.path);
	}

	/** Test seeding: adds without recording a call or emitting an event. */
	seedFile(path: string): TFile {
		const file = new TFile();
		file.extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
		this.link(file, path);
		return file;
	}

	seedFolder(path: string): TFolder {
		const folder = new TFolder();
		this.link(folder, path);
		return folder;
	}

	/** Content written through `create`, by path. */
	contents = new Map<string, string>();

	async create(path: string, data: string): Promise<TFile> {
		this.calls.push("create");
		if (this.entries.has(path)) throw new Error("File already exists.");
		const file = this.seedFile(path);
		this.contents.set(path, data);
		this.emit("create", file);
		return file;
	}

	async createFolder(path: string): Promise<TFolder> {
		this.calls.push("createFolder");
		const folder = this.seedFolder(path);
		this.emit("create", folder);
		return folder;
	}

	async modify(file: TFile, data: string): Promise<void> {
		this.calls.push("modify");
		this.contents.set(file.path, data);
		this.emit("modify", file);
	}

	async read(file: TFile): Promise<string> {
		this.calls.push("read");
		if (!this.contents.has(file.path)) throw new Error(`ENOENT: no such file, read '${file.path}'`);
		return this.contents.get(file.path)!;
	}

	async cachedRead(file: TFile): Promise<string> {
		this.calls.push("cachedRead");
		return this.read(file);
	}

	/** Like Obsidian 1.13.7: deleting a folder without `force` throws EISDIR, and the folder stays. */
	async delete(entry: TAbstractFile, force?: boolean): Promise<void> {
		this.calls.push("delete");
		if (entry instanceof TFolder && !force) throw new Error("Path is a directory: rm returned EISDIR");
		this.unlink(entry);
		this.emit("delete", entry);
	}

	async rename(entry: TAbstractFile, newPath: string): Promise<void> {
		this.calls.push("rename");
		if (this.entries.has(newPath)) throw new Error("Destination file already exists!");
		const oldPath = entry.path;
		this.unlink(entry);
		this.link(entry, newPath);
		this.emit("rename", entry, oldPath);
	}

	/** Plain vault config (`alwaysUpdateLinks`, ...). */
	config: Record<string, unknown> = {};
	getConfig(key: string): unknown {
		return this.config[key];
	}
}

export class MetadataCache {
	private listeners = new Set<() => void>();
	getFileCache(_file: TFile): null {
		return null;
	}
	getFirstLinkpathDest(_link: string, _from: string): null {
		return null;
	}
	on(name: string, cb: () => void): { name: string; cb: () => void } {
		if (name === "resolved") this.listeners.add(cb);
		return { name, cb };
	}
	/** Test helper: what Obsidian does once the link graph has re-resolved. */
	trigger(name: "resolved"): void {
		if (name === "resolved") for (const cb of this.listeners) cb();
	}
}

export class FileManager {
	constructor(private vault: Vault) {}
	async renameFile(entry: TAbstractFile, newPath: string): Promise<void> {
		this.vault.calls.push("fileManager.renameFile");
		await this.vault.rename(entry, newPath);
	}
}

export class App {
	vault = new Vault();
	metadataCache = new MetadataCache();
	fileManager = new FileManager(this.vault);
	workspace = { onLayoutReady: (cb: () => void) => cb(), getLeavesOfType: () => [] as unknown[] };
}

// --- UI -----------------------------------------------------------------------------------------
/** Recordable `Notice`: every construction is pushed to `Notice.instances`. */
export class Notice {
	static instances: Notice[] = [];
	static reset(): void {
		Notice.instances = [];
	}
	constructor(public message: string, public duration?: number) {
		Notice.instances.push(this);
	}
	hide(): void {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
}

export class Scope {}

/** Modal with a real jsdom DOM: `open()` attaches `containerEl` to `document.body`. */
export class Modal {
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	scope = new Scope();

	constructor(public app: App) {
		this.containerEl = document.createElement("div");
		this.containerEl.className = "modal-container";
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		this.modalEl.createDiv({ cls: "modal-close-button" }).addEventListener("click", () => this.close());
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}

	open(): void {
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}

	close(): void {
		if (!this.containerEl.isConnected) return;
		this.containerEl.remove();
		this.onClose();
	}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	onOpen(): void {}
	onClose(): void {}
}

/** Prompt-style suggest modal: its placeholder is the search box label (the title is not rendered). */
export class SuggestModal<T> extends Modal {
	placeholder = "";
	setPlaceholder(placeholder: string): void {
		this.placeholder = placeholder;
	}
}

/** Fuzzy suggest modal: `getSuggestions` matches the query against `getItemText` (a plain substring
 * match, case-insensitive, standing in for Obsidian's fuzzy scorer), returning matches in item order. */
export class FuzzySuggestModal<T> extends SuggestModal<T> {
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	getSuggestions(query: string): { item: T; match: { score: number; matches: [] } }[] {
		const needle = query.trim().toLowerCase();
		return this.getItems()
			.filter((item) => this.getItemText(item).toLowerCase().includes(needle))
			.map((item) => ({ item, match: { score: 0, matches: [] } }));
	}
	renderSuggestion(_match: unknown, _el: HTMLElement): void {}
	onChooseItem(_item: T, _evt: unknown): void {}
	onChooseSuggestion(match: { item: T }, evt: unknown): void {
		this.onChooseItem(match.item, evt);
		this.close();
	}
}
export class ItemView {}
export class MenuItem {
	title = "";
	icon = "";
	clickHandler: (() => void) | null = null;
	setTitle(title: string): this {
		this.title = title;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	onClick(cb: () => void): this {
		this.clickHandler = cb;
		return this;
	}
}

/** Recording `Menu`: `titles()` lists the item titles in order (separators excluded). */
export class Menu {
	items: MenuItem[] = [];
	separators = 0;
	addItem(cb: (item: MenuItem) => void): this {
		const item = new MenuItem();
		cb(item);
		this.items.push(item);
		return this;
	}
	addSeparator(): this {
		this.separators++;
		return this;
	}
	showAtMouseEvent(_evt: MouseEvent): void {}
	/** Every menu shown through `showAtPosition`, newest last (a chooser popped from an item). */
	static shownAtPosition: Menu[] = [];
	showAtPosition(_position: { x: number; y: number }): void {
		Menu.shownAtPosition.push(this);
	}
	titles(): string[] {
		return this.items.map((item) => item.title);
	}
}
export class Plugin {}
export class PluginSettingTab {}
/** Minimal stand-in for Obsidian's `EditorSuggest` — just enough for `AtlasLinkSuggest` (and any
 * other test that merely needs to import `src/main.ts`) to extend it; no test here exercises the
 * actual suggester popup. */
export class EditorSuggest<T> {
	limit?: number;
	constructor(public app: App) {}
	open(): void {}
	close(): void {}
}
export function prepareFuzzySearch(_query: string): (text: string) => { score: number; matches: unknown[] } | null {
	return () => null;
}
export function renderResults(_el: HTMLElement, _text: string, _match: unknown): void {}
export class WorkspaceLeaf {}
export class TextComponent {}
export class ToggleComponent {}
export class Setting {
	constructor(public containerEl: HTMLElement) {}
}

export const Platform = { isMobile: false, isDesktop: true };

export function setIcon(_el: HTMLElement, _icon: string): void {}
export function setTooltip(_el: HTMLElement, _tip: string): void {}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 0, resetTimer = false) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastArgs: A | undefined;
	const run = () => {
		timer = undefined;
		if (lastArgs) fn(...lastArgs);
	};
	const debounced = (...args: A) => {
		lastArgs = args;
		if (timer !== undefined && !resetTimer) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(run, wait);
	};
	debounced.run = () => {
		if (timer !== undefined) clearTimeout(timer);
		run();
	};
	debounced.cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	return debounced;
}
