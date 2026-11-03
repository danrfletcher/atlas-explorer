/** Shared wiring for the press-hold tests (render-entry hold, press scope, press release). Drives the
 * real `AtlasExplorerView.onOpen()` listeners on the real document/window with fake timers, through the
 * shared header harness. Not a `*.test.ts` file, so vitest's include glob skips it. */
import { vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { SectionHarness } from "../explorer-header-fixtures";

export interface PressInternals {
	leaf: WorkspaceLeaf;
	render: () => Promise<void>;
	renderNow: () => Promise<void>;
	renderNodeList: (nodes: unknown, container: HTMLElement) => Promise<void>;
	refresh: () => void;
	awaitRenderSettled: () => Promise<void>;
	handleDrop: (target: unknown) => void;
	refreshApiSourcesOnViewLoad: () => void;
	openRef: (...args: unknown[]) => Promise<void>;
	registerDomEvent: (el: EventTarget, type: string, cb: (evt: Event) => void, opts?: boolean | AddEventListenerOptions) => void;
	registerEvent: (ref: unknown) => void;
	onOpen: () => Promise<void>;
	onClose: () => Promise<void>;
	dragPayload: unknown;
	inboxDragRowEl: HTMLElement | null;
	bucketDragRowEl: HTMLElement | null;
	bucketListEl: HTMLElement | null;
	pointerGestureActive: boolean;
	plugin: {
		app: { workspace: { on: ReturnType<typeof vi.fn> } };
		unitIndex: { onChange: ReturnType<typeof vi.fn> };
		viewsManager: { onChange: ReturnType<typeof vi.fn> };
	};
}

export interface PressEnv {
	h: SectionHarness;
	ex: PressInternals;
	/** Spy on the render body: counts renders that actually ran, not requests. */
	renderNow: ReturnType<typeof vi.fn>;
	/** The callbacks `onOpen` subscribed to the two change sources, as the real stores would fire them. */
	fireUnitIndexChange: () => void;
	fireViewsChange: (persisted: boolean) => void;
	fireLeafChange: (leaf: unknown) => void;
	teardown: () => void;
}

/** Opens the explorer exactly as Obsidian would (real listeners on the real document/window) and
 * records the change-source subscriptions so a test can fire each render route by name. */
export async function openExplorer(h: SectionHarness): Promise<PressEnv> {
	const ex = h.explorer as unknown as PressInternals;
	const removers: (() => void)[] = [];
	const unitCbs: (() => void)[] = [];
	const viewsCbs: ((persisted: boolean) => void)[] = [];
	const leafHandlers: ((leaf: unknown) => void)[] = [];
	ex.leaf = {} as WorkspaceLeaf;
	ex.registerEvent = vi.fn();
	ex.registerDomEvent = (el, type, cb, opts) => {
		el.addEventListener(type, cb, opts);
		removers.push(() => el.removeEventListener(type, cb, opts));
	};
	ex.plugin.unitIndex.onChange.mockImplementation(((cb: () => void) => {
		unitCbs.push(cb);
		return () => {};
	}) as never);
	ex.plugin.viewsManager.onChange.mockImplementation(((cb: (persisted: boolean) => void) => {
		viewsCbs.push(cb);
		return () => {};
	}) as never);
	ex.plugin.app.workspace.on.mockImplementation(((event: string, cb: (leaf: unknown) => void) => {
		if (event === "active-leaf-change") leafHandlers.push(cb);
		return {};
	}) as never);
	await ex.onOpen();
	return {
		h,
		ex,
		renderNow: vi.spyOn(ex, "renderNow") as unknown as ReturnType<typeof vi.fn>,
		fireUnitIndexChange: () => unitCbs.forEach((cb) => cb()),
		fireViewsChange: (persisted) => viewsCbs.forEach((cb) => cb(persisted)),
		fireLeafChange: (leaf) => leafHandlers.forEach((cb) => cb(leaf)),
		teardown: () => removers.forEach((remove) => remove()),
	};
}

/** Dispatches a pointer event. jsdom has no `PointerEvent`, so it is a `MouseEvent` of that name
 * carrying `buttons` (and `pointerType` where a test needs it). */
export function pointer(
	type: string,
	target: EventTarget,
	init: { buttons?: number; button?: number; pointerType?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}
): void {
	const { pointerType, ...mouse } = init;
	const evt = new MouseEvent(type, { bubbles: true, cancelable: true, ...mouse });
	if (pointerType) Object.defineProperty(evt, "pointerType", { value: pointerType });
	target.dispatchEvent(evt);
}

/** Makes the bucket stub draw `count()` rows, each with a select key, so a test can change what the
 * next render draws mid-press and see it in the DOM afterwards. */
export function drawBucketRows(ex: PressInternals, count: () => number): void {
	ex.renderNodeList = async (_nodes, container) => {
		for (let i = 0; i < count(); i++) {
			const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
			row.dataset.selectKey = `row-${i}`;
		}
	};
}

export const bucketRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".atlas-bucket .atlas-row-unit"));

/** Lets a queued `setTimeout(0)` render run and its promise chain finish. */
export async function flush(env: PressEnv): Promise<void> {
	await vi.advanceTimersByTimeAsync(50);
	await env.ex.awaitRenderSettled();
}
