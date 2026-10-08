/** PR-1.S1: shared harness for driving the real `AtlasExplorerView.render()` under jsdom. jsdom has no
 * layout, so the scroll body's `scrollTop`/`clientHeight` and the inbox spacer's position are stubbed
 * here, and `ResizeObserver` is a recorder tests can fire by hand. The toolbar and bucket renderers
 * are stubbed (they're covered elsewhere); the inbox, the scroll body and the observer wiring are real.
 * Not a `*.test.ts` file, so vitest's include glob skips it. */
import { vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { Unit, View, unitRefKey, unitToRef } from "../../src/types";

export const testView: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };
export const otherView: View = { id: "v2", name: "Resources", inboxMode: "view", root: [] };

export function fileUnits(count: number): Unit[] {
	return Array.from({ length: count }, (_, i) => ({ type: "file", path: `inbox/${String(i).padStart(5, "0")}.md` }) as unknown as Unit);
}

/** Records every observer so a test can fire the one belonging to the current render. */
export class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];
	observed = new Set<Element>();
	disconnect = vi.fn(() => this.observed.clear());
	constructor(private callback: () => void) {
		FakeResizeObserver.instances.push(this);
	}
	observe(el: Element): void {
		this.observed.add(el);
	}
	fire(): void {
		this.callback();
	}
}

export interface LayoutStub {
	viewportHeight: number;
	/** Height of everything above the inbox list inside the scroll body (the bucket). */
	bucketHeight: number;
}

/** Installs jsdom stand-ins for the layout properties the inbox window reads. Returns a restore fn. */
export function stubLayout(layout: LayoutStub): () => void {
	const proto = HTMLElement.prototype;
	const saved = {
		scrollTop: Object.getOwnPropertyDescriptor(proto, "scrollTop"),
		clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
		rect: Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect"),
		raf: window.requestAnimationFrame,
		ro: (globalThis as { ResizeObserver?: unknown }).ResizeObserver,
	};
	// The body's full length: the bucket above the inbox list, plus the inbox spacer's height.
	const scrollHeightOf = (el: HTMLElement): number => {
		if (!el.classList.contains("atlas-explorer-scroll")) return 0;
		const spacer = el.querySelector<HTMLElement>(".atlas-inbox-spacer");
		return layout.bucketHeight + (spacer ? parseFloat(spacer.style.height) || 0 : 0);
	};
	Object.defineProperty(proto, "scrollTop", {
		configurable: true,
		get(this: HTMLElement & { _scrollTop?: number }) {
			return this._scrollTop ?? 0;
		},
		// Like a browser: a scroll position past the end of the content is clamped to the max.
		set(this: HTMLElement & { _scrollTop?: number }, v: number) {
			const max = Math.max(0, scrollHeightOf(this) - layout.viewportHeight);
			this._scrollTop = Math.min(max, Math.max(0, v));
		},
	});
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return scrollHeightOf(this);
		},
	});
	Object.defineProperty(proto, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("atlas-explorer-scroll") ? layout.viewportHeight : 0;
		},
	});
	Object.defineProperty(proto, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			const body = this.closest(".atlas-explorer-scroll") as (HTMLElement & { _scrollTop?: number }) | null;
			const scrollTop = body?._scrollTop ?? 0;
			// The body's content starts at its top edge; the inbox spacer sits `bucketHeight` below that
			// edge, and both move up with the body's scroll.
			const top = this.classList.contains("atlas-inbox-spacer") ? layout.bucketHeight - scrollTop : 0;
			return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect;
		},
	});
	window.requestAnimationFrame = (cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	};
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
	FakeResizeObserver.instances.length = 0;
	return () => {
		if (saved.scrollTop) Object.defineProperty(proto, "scrollTop", saved.scrollTop);
		if (saved.clientHeight) Object.defineProperty(proto, "clientHeight", saved.clientHeight);
		if (saved.rect) Object.defineProperty(proto, "getBoundingClientRect", saved.rect);
		window.requestAnimationFrame = saved.raf;
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved.ro;
	};
}

export interface Harness {
	explorer: AtlasExplorerView;
	host: HTMLElement;
	/** The `.atlas-explorer` panel (the view-content element the explorer renders into). */
	panel: () => HTMLElement;
	scrollBody: () => HTMLElement;
	/** Inbox rows currently in the DOM, in the order they were drawn. */
	inboxRowKeys: () => string[];
	setActiveView: (view: View) => void;
	setUnits: (units: Unit[]) => void;
	layout: LayoutStub;
}

/** Builds a real explorer with a fake plugin and a host element shaped like Obsidian's (header +
 * view-content). `renderToolbar` stands in for the toolbar, which doesn't matter to the inbox layout. */
export function makeHarness(units: Unit[], layout: LayoutStub = { viewportHeight: 280, bucketHeight: 0 }): Harness {
	let activeView = testView;
	let allUnits = units;
	const plugin = {
		app: { workspace: { on: vi.fn(() => ({})) }, vault: { getAbstractFileByPath: () => null } },
		unitIndex: { getUnits: () => allUnits, onChange: vi.fn(() => () => {}) },
		viewsManager: {
			getActiveView: () => activeView,
			getInboxUnits: () => allUnits,
			getDismissedInboxUnits: () => [],
			onChange: vi.fn(() => () => {}),
		},
	};
	const explorer = new AtlasExplorerView({} as WorkspaceLeaf, plugin as never);
	const host = document.createElement("div");
	host.appendChild(document.createElement("div")); // view header
	host.appendChild(document.createElement("div")); // view content
	// Attached to the document: the inbox's redraw bails out when its spacer is detached, as it would be in Obsidian.
	document.body.appendChild(host);
	(explorer as unknown as { containerEl: HTMLElement }).containerEl = host;

	const stubs: Record<string, unknown> = {
		renderToolbar: (container: HTMLElement) => container.createDiv({ cls: "atlas-toolbar" }),
		renderBucketSection: async (el: HTMLElement) => {
			el.createDiv({ cls: "atlas-node-list" });
		},
		resolveRef: async (ref: { path: string }) => ({ text: ref.path, icon: "file" }),
		matchesFilter: () => true,
		setPlacementTooltip: vi.fn(),
		updateActiveHighlight: vi.fn(),
		syncRefreshTimers: vi.fn(),
		refreshApiSourcesOnViewLoad: vi.fn(),
		buildInboxDragPayload: vi.fn(() => ({ kind: "inbox", refs: [] })),
		queueRender: vi.fn(),
	};
	Object.assign(explorer, stubs);

	const panel = () => host.children[1] as HTMLElement;
	return {
		explorer,
		host,
		panel,
		scrollBody: () => panel().querySelector<HTMLElement>(".atlas-explorer-scroll")!,
		inboxRowKeys: () =>
			Array.from(panel().querySelectorAll<HTMLElement>(".atlas-inbox .atlas-row-virtual")).map((el) => el.dataset.refKey ?? ""),
		setActiveView: (view: View) => {
			activeView = view;
		},
		setUnits: (next: Unit[]) => {
			allUnits = next;
		},
		layout,
	};
}

/** Key of the inbox unit at `index` in `units`, as the window would draw it. */
export function keyAt(units: Unit[], index: number): string {
	return unitRefKey(unitToRef(units[index]));
}
