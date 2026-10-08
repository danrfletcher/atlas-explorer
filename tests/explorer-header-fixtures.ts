/** PR-1.F1: shared builder for the header tests. Drives the real `AtlasExplorerView.render()`, so the
 * bucket and inbox headers, chevrons, titles and their listeners are the shipped ones. Only the
 * bucket's row content, the toolbar and the unit lookups are stubbed. jsdom has no layout, so the
 * section geometry is modelled here from the DOM: a 60-row bucket, a 25-row inbox, and a fixed header
 * height. Not a `*.test.ts` file, so vitest's include glob skips it. */
import { vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { AtlasExplorerView } from "../src/explorer-view";
import { View } from "../src/types";
import { FakeResizeObserver, fileUnits } from "./unit/explorer-view-scroll-helpers";

export const ROW = 28;
export const BUCKET_ROWS = 60;
export const INBOX_ROWS = 25;
export const VIEWPORT_H = 300;

const view: View = { id: "v1", name: "Actionable", inboxMode: "view", root: [] };

export interface ScrollCall {
	top: number;
	behavior: ScrollBehavior;
}

export interface SectionHarness {
	explorer: AtlasExplorerView;
	scrollCalls: ScrollCall[];
	setInboxMode: ReturnType<typeof vi.fn>;
	openAddFileModal: ReturnType<typeof vi.fn>;
	showInboxHeaderMenu: ReturnType<typeof vi.fn>;
	panel: () => HTMLElement;
	body: () => HTMLElement;
	bucketHeader: () => HTMLElement;
	inboxHeader: () => HTMLElement;
	bucketChevron: () => HTMLElement;
	inboxChevron: () => HTMLElement;
	bucketTitle: () => HTMLElement;
	inboxTitle: () => HTMLElement;
	bucketWrap: () => HTMLElement;
	inboxWrap: () => HTMLElement;
	/** Moves the scroll body and fires its `scroll` event, as a trackpad would. */
	scrollTo: (top: number) => void;
	setHeaderHeight: (px: number) => void;
	setViewportHeight: (px: number) => void;
	/** Fires the panel's ResizeObserver, as a size change would. */
	fireResize: () => void;
	render: () => Promise<void>;
	teardown: () => void;
}

interface Saved {
	target: object;
	key: string;
	had: PropertyDescriptor | undefined;
}

/** Installs a property on `target`, remembering what it replaced so `teardown` can put it back. */
function install(saved: Saved[], target: object, key: string, descriptor: PropertyDescriptor): void {
	saved.push({ target, key, had: Object.getOwnPropertyDescriptor(target, key) });
	Object.defineProperty(target, key, { configurable: true, ...descriptor });
}

export function makeSectionHarness(): SectionHarness {
	let headerH = 28;
	let viewH = VIEWPORT_H;
	const scrollCalls: ScrollCall[] = [];
	const saved: Saved[] = [];
	const proto = HTMLElement.prototype;

	const bodyEl = (): HTMLElement | null => document.querySelector<HTMLElement>(".atlas-explorer-scroll");
	const isCollapsed = (sel: string) => document.querySelector(sel)?.classList.contains("is-collapsed") ?? false;

	/** Geometry in scroll-body coordinates (content-space), derived from the rendered DOM. */
	const geometry = () => {
		const bucketContent = isCollapsed(".atlas-bucket > .atlas-meta-children") ? 0 : BUCKET_ROWS * ROW;
		const bucketH = headerH + bucketContent;
		const spacer = document.querySelector<HTMLElement>(".atlas-inbox-spacer");
		const inboxContent = isCollapsed(".atlas-inbox > .atlas-meta-children") ? 0 : parseFloat(spacer?.style.height ?? "0") || 0;
		const inboxH = headerH + inboxContent;
		return { bucketH, inboxTop: bucketH, inboxH, spacerH: inboxContent, scrollHeight: bucketH + inboxH };
	};

	const bodyScrollTop = (): number => {
		const body = bodyEl();
		return body ? (body as HTMLElement & { _scrollTop?: number })._scrollTop ?? 0 : 0;
	};

	/** Natural (un-transformed, un-scrolled) box for an element in the body. */
	const natural = (el: HTMLElement): { top: number; height: number } => {
		const g = geometry();
		if (el.classList.contains("atlas-explorer-scroll")) return { top: 0, height: viewH };
		if (el.classList.contains("atlas-bucket")) return { top: 0, height: g.bucketH };
		if (el.classList.contains("atlas-inbox")) return { top: g.inboxTop, height: g.inboxH };
		if (el.classList.contains("atlas-section-header")) {
			const sectionTop = el.parentElement?.classList.contains("atlas-inbox") ? g.inboxTop : 0;
			return { top: sectionTop, height: headerH };
		}
		if (el.classList.contains("atlas-inbox-spacer")) return { top: g.inboxTop + headerH, height: g.spacerH };
		return { top: 0, height: 0 };
	};

	install(saved, proto, "getBoundingClientRect", {
		value(this: HTMLElement) {
			const box = natural(this);
			const shift = this.closest(".atlas-explorer-scroll") && !this.classList.contains("atlas-explorer-scroll") ? bodyScrollTop() : 0;
			const top = box.top - shift;
			return { top, bottom: top + box.height, height: box.height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
		},
	});
	install(saved, proto, "scrollTop", {
		get(this: HTMLElement & { _scrollTop?: number }) {
			return this.classList.contains("atlas-explorer-scroll") ? this._scrollTop ?? 0 : 0;
		},
		// Like a browser: a position past the end of the content is clamped to the maximum.
		set(this: HTMLElement & { _scrollTop?: number }, v: number) {
			if (!this.classList.contains("atlas-explorer-scroll")) return;
			const max = Math.max(0, geometry().scrollHeight - viewH);
			this._scrollTop = Math.min(max, Math.max(0, v));
		},
	});
	install(saved, proto, "scrollHeight", {
		get(this: HTMLElement) {
			return this.classList.contains("atlas-explorer-scroll") ? geometry().scrollHeight : 0;
		},
	});
	install(saved, proto, "clientHeight", {
		get(this: HTMLElement) {
			return this.classList.contains("atlas-explorer-scroll") ? viewH : 0;
		},
	});
	// Records every programmatic scroll, and applies it instantly (the browser animates; we only need the end state).
	install(saved, proto, "scrollTo", {
		value(this: HTMLElement, opts: ScrollToOptions) {
			scrollCalls.push({ top: opts.top ?? 0, behavior: (opts.behavior as ScrollBehavior) ?? "auto" });
			this.scrollTop = opts.top ?? 0;
			this.dispatchEvent(new Event("scroll"));
		},
	});
	install(saved, window, "requestAnimationFrame", {
		value: (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		},
		writable: true,
	});
	install(saved, window, "matchMedia", {
		value: vi.fn(() => ({ matches: false }) as MediaQueryList),
		writable: true,
	});
	install(saved, globalThis, "ResizeObserver", { value: FakeResizeObserver, writable: true });
	FakeResizeObserver.instances.length = 0;

	const openAddFileModal = vi.fn();
	const showInboxHeaderMenu = vi.fn();
	const setInboxMode = vi.fn();
	const units = fileUnits(INBOX_ROWS);
	const plugin = {
		app: { workspace: { on: vi.fn(() => ({})) }, vault: { getAbstractFileByPath: () => null } },
		unitIndex: { getUnits: () => units, onChange: vi.fn(() => () => {}) },
		viewsManager: {
			getActiveView: () => view,
			getInboxUnits: () => units,
			getDismissedInboxUnits: () => [],
			setInboxMode,
			onChange: vi.fn(() => () => {}),
		},
	};
	const explorer = new AtlasExplorerView({} as WorkspaceLeaf, plugin as never);
	const host = document.createElement("div");
	host.appendChild(document.createElement("div")); // view header
	host.appendChild(document.createElement("div")); // view content
	document.body.appendChild(host);
	(explorer as unknown as { containerEl: HTMLElement }).containerEl = host;

	Object.assign(explorer, {
		renderToolbar: (container: HTMLElement) => container.createDiv({ cls: "atlas-toolbar" }),
		// The 60 bucket rows; their content doesn't matter to the header behaviour under test.
		renderNodeList: async (_nodes: unknown, container: HTMLElement) => {
			for (let i = 0; i < BUCKET_ROWS; i++) container.createDiv({ cls: "atlas-row atlas-row-unit" });
		},
		resolveRef: async (ref: { path: string }) => ({ text: ref.path, icon: "file" }),
		matchesFilter: () => true,
		setPlacementTooltip: vi.fn(),
		updateActiveHighlight: vi.fn(),
		syncRefreshTimers: vi.fn(),
		refreshApiSourcesOnViewLoad: vi.fn(),
		openAddFileModal,
		showInboxHeaderMenu,
	});

	const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
	const panel = () => host.children[1] as HTMLElement;

	return {
		explorer,
		scrollCalls,
		setInboxMode,
		openAddFileModal,
		showInboxHeaderMenu,
		panel,
		body: () => q(".atlas-explorer-scroll"),
		bucketHeader: () => q(".atlas-bucket > .atlas-section-header"),
		inboxHeader: () => q(".atlas-inbox > .atlas-section-header"),
		bucketChevron: () => q(".atlas-bucket > .atlas-section-header > .atlas-chevron"),
		inboxChevron: () => q(".atlas-inbox > .atlas-section-header > .atlas-chevron"),
		bucketTitle: () => q(".atlas-bucket > .atlas-section-header > .atlas-section-title"),
		inboxTitle: () => q(".atlas-inbox > .atlas-section-header > .atlas-section-title"),
		bucketWrap: () => q(".atlas-bucket > .atlas-meta-children"),
		inboxWrap: () => q(".atlas-inbox > .atlas-meta-children"),
		scrollTo: (top: number) => {
			const body = q(".atlas-explorer-scroll");
			body.scrollTop = top;
			body.dispatchEvent(new Event("scroll"));
		},
		setHeaderHeight: (px: number) => {
			headerH = px;
		},
		setViewportHeight: (px: number) => {
			viewH = px;
		},
		fireResize: () => {
			for (const observer of FakeResizeObserver.instances) observer.fire();
		},
		render: async () => {
			await (explorer as unknown as { render: () => Promise<void> }).render();
		},
		teardown: () => {
			document.body.replaceChildren();
			for (const { target, key, had } of saved.reverse()) {
				if (had) Object.defineProperty(target, key, had);
				else delete (target as Record<string, unknown>)[key];
			}
		},
	};
}
