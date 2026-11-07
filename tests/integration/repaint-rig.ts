/** PR-2: counts the real repaints of the Atlas pane for a vault action. The real `AtlasExplorerView`
 * (its `onOpen` subscriptions, `queueRender`, `render()` and the staged compare/swap) runs against the real
 * `ViewsManager` and a real or stand-in unit index; only the toolbar and the bucket's row content are
 * replaced, and the bucket draws one plain row per view node so a node added by a folder-source refresh
 * shows up in the pane's markup. Not a `*.test.ts` file, so vitest's include glob skips it.
 *
 * A "repaint" is one replacement of the pane's children (a `childList` mutation on the pane that adds
 * nodes). Call it with fake timers on: `queueRender` waits on a `setTimeout(0)`. */
import { vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import type { AtlasSettings } from "../../src/settings";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import type { ViewNode } from "../../src/types";
import type { ViewsManager } from "../../src/views";

/** What the explorer asks of the unit index. The real `UnitIndex` satisfies it. */
export interface RigUnitIndex {
	getUnits(): unknown[];
	onChange(cb: () => void): () => void;
	isDismissed(...args: unknown[]): boolean;
	isLinkOnlyInNoAutoPromoteFolder(...args: unknown[]): boolean;
}

export interface RepaintRig {
	h: SectionHarness;
	/** Repaints since the rig opened (or since the last `resetPaints()`). */
	paints(): number;
	resetPaints(): void;
	/** Lets queued renders run and finish. */
	settle(): Promise<void>;
	/** The text of the rows in the bucket, in order. */
	bucketRowTexts(): string[];
	/** The ref keys of the inbox rows drawn, in order. */
	inboxRowKeys(): string[];
	/** The visible text of the inbox rows, in order. */
	inboxRowTexts(): string[];
	close(): void;
}

type Internals = {
	leaf: WorkspaceLeaf;
	plugin: { unitIndex: unknown; viewsManager: unknown; app: { workspace: { on: unknown } } };
	registerEvent: (ref: unknown) => void;
	registerDomEvent: (el: EventTarget, type: string, cb: (evt: Event) => void, opts?: boolean | AddEventListenerOptions) => void;
	renderNodeList: (nodes: ViewNode[], container: HTMLElement) => Promise<void>;
	resolveRef: (ref: unknown) => Promise<unknown>;
	onOpen: () => Promise<void>;
	awaitRenderSettled: () => Promise<void>;
};

/** `realLabels` (with `app` and `settings`) puts back the explorer's own `resolveRef`, so row labels come
 * from the real file content through `resolveUnit` instead of the harness's label map. */
export async function openRepaintRig(parts: {
	unitIndex: RigUnitIndex;
	viewsManager: ViewsManager;
	realLabels?: { app: App; settings: AtlasSettings };
}): Promise<RepaintRig> {
	const h = makeSectionHarness({ bucketRows: 0, inboxRows: 0 });
	const ex = h.explorer as unknown as Internals;
	Object.assign(ex.plugin, { unitIndex: parts.unitIndex, viewsManager: parts.viewsManager });

	if (parts.realLabels) {
		Object.assign(ex.plugin, { app: parts.realLabels.app, settings: parts.realLabels.settings });
		ex.resolveRef = (AtlasExplorerView.prototype as unknown as { resolveRef: Internals["resolveRef"] }).resolveRef;
	}
	ex.leaf = {} as WorkspaceLeaf;
	ex.registerEvent = vi.fn();
	const removers: (() => void)[] = [];
	ex.registerDomEvent = (el, type, cb, opts) => {
		el.addEventListener(type, cb, opts);
		removers.push(() => el.removeEventListener(type, cb, opts));
	};
	ex.plugin.app.workspace.on = vi.fn(() => ({}));
	ex.renderNodeList = async (nodes, container) => {
		const draw = (list: ViewNode[]): void => {
			for (const node of list) {
				const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
				row.dataset.selectKey = node.id;
				row.createSpan({ cls: "atlas-row-text", text: node.ref?.path ?? node.label ?? "" });
				draw(node.children);
			}
		};
		draw(nodes);
	};
	await ex.onOpen();
	await ex.awaitRenderSettled();

	const isPaint = (r: MutationRecord): boolean => r.target === h.panel() && r.type === "childList" && r.addedNodes.length > 0;
	let paints = 0;
	const observer = new MutationObserver((batch) => {
		paints += batch.filter(isPaint).length;
	});
	observer.observe(h.panel(), { childList: true });

	return {
		h,
		paints: () => {
			paints += observer.takeRecords().filter(isPaint).length;
			return paints;
		},
		resetPaints: () => {
			observer.takeRecords();
			paints = 0;
		},
		settle: async () => {
			await vi.advanceTimersByTimeAsync(2500); // past the folder refresh's debounce and max wait
			await ex.awaitRenderSettled();
		},
		bucketRowTexts: () => Array.from(h.panel().querySelectorAll(".atlas-bucket .atlas-row-text")).map((el) => el.textContent ?? ""),
		inboxRowKeys: () => Array.from(h.panel().querySelectorAll<HTMLElement>(".atlas-inbox .atlas-row-virtual")).map((el) => el.dataset.refKey ?? ""),
		inboxRowTexts: () => Array.from(h.panel().querySelectorAll(".atlas-inbox .atlas-row-virtual .atlas-row-text")).map((el) => el.textContent ?? ""),
		close: () => {
			observer.disconnect();
			for (const remove of removers) remove();
			h.teardown();
		},
	};
}
