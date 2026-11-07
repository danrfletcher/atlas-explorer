import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { dotTooltip } from "../../src/api-source-controller";
import type { ApiCache, ViewNode } from "../../src/types";

/** PR-2 R2: the connection dot's tooltip says "N m ago", which changes with the clock alone. The test
 * `setTooltip` stores it as `aria-label` (as Obsidian does), so if it were baked into the pane, an
 * identical render a minute later would look changed and repaint. These drive the real `render()` and the
 * real `renderConnectionDots`; only the bucket's row list is replaced by one row per data-source node. */

const T0 = new Date("2026-11-06T10:00:00Z").getTime();
const MIN = 60_000;

function cache(over: Partial<ApiCache> = {}): ApiCache {
	return { fetchedAt: T0, ok: true, rows: [], skippedCount: 0, truncated: false, ...over } as ApiCache;
}

type Internals = {
	renderNodeList: (...args: unknown[]) => Promise<void>;
	renderConnectionDots: (row: HTMLElement, node: ViewNode) => void;
	lastRenderPainted: boolean | null;
	plugin: { viewsManager: { getNode: (viewId: string, nodeId: string) => ViewNode | null } };
};

let h: SectionHarness;
let ex: Internals;
let node: ViewNode;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
	h = makeSectionHarness({ bucketRows: 0, inboxRows: 2 });
	ex = h.explorer as unknown as Internals;
	node = { id: "n1", type: "meta", label: "Source", children: [], csvSource: {}, apiCache: cache() } as unknown as ViewNode;
	ex.plugin.viewsManager.getNode = (_viewId, nodeId) => (nodeId === node.id ? node : null);
	ex.renderNodeList = async (_nodes, container) => {
		const row = (container as HTMLElement).createDiv({ cls: "atlas-row atlas-row-meta" });
		row.createSpan({ cls: "atlas-row-text", text: node.label });
		ex.renderConnectionDots(row, node);
	};
});

afterEach(() => {
	h.teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const dot = () => h.panel().querySelector<HTMLElement>(".atlas-api-connection-dot")!;

function watch(pane: HTMLElement): { stop: () => MutationRecord[] } {
	const records: MutationRecord[] = [];
	const observer = new MutationObserver((batch) => records.push(...batch));
	observer.observe(pane, { subtree: true, childList: true, attributes: true, characterData: true });
	return {
		stop: () => {
			records.push(...observer.takeRecords());
			observer.disconnect();
			return records;
		},
	};
}

async function renderCountingMutations(): Promise<number> {
	const watcher = watch(h.panel());
	await h.render();
	return watcher.stop().length;
}

describe("PR-2 R2: the clock alone never makes identical output look changed", () => {
	it("the dot carries a real tooltip, and it has no time in it", async () => {
		await h.render();
		expect(dot().getAttribute("aria-label")).toBe("Last refresh ok");
		expect(dot().getAttribute("aria-label")).not.toMatch(/ago|just now/);
	});

	it("a render a minute, an hour and a day later causes zero mutations", async () => {
		await h.render();
		for (const later of [MIN + 1, 61 * MIN, 25 * 60 * MIN]) {
			vi.setSystemTime(T0 + later);
			expect(await renderCountingMutations()).toBe(0);
			expect(ex.lastRenderPainted).toBe(false);
		}
	});

	it("an unchanged refresh (fetchedAt moves on, nothing else) causes zero mutations on the next render", async () => {
		await h.render();
		vi.setSystemTime(T0 + 7 * MIN);
		node.apiCache = cache({ fetchedAt: Date.now() });
		expect(await renderCountingMutations()).toBe(0);
		expect(ex.lastRenderPainted).toBe(false);
	});

	it("hovering shows the time since the refresh, read at hover time, and a render while hovered still skips", async () => {
		await h.render();
		vi.setSystemTime(T0 + 5 * MIN);
		dot().dispatchEvent(new Event("mouseover", { bubbles: true }));
		expect(dot().getAttribute("aria-label")).toBe("Last refresh ok, 5 m ago");

		vi.setSystemTime(T0 + 9 * MIN);
		dot().dispatchEvent(new Event("mouseover", { bubbles: true }));
		expect(dot().getAttribute("aria-label")).toBe("Last refresh ok, 9 m ago");

		expect(await renderCountingMutations()).toBe(0);
		expect(ex.lastRenderPainted).toBe(false);
	});

	it("hovering reads the node's current cache, not the one the pane was built from", async () => {
		await h.render();
		node.apiCache = cache({ ok: false, error: "auth failed", fetchedAt: T0 + MIN, lastSuccessAt: T0 });
		vi.setSystemTime(T0 + 3 * MIN);
		dot().dispatchEvent(new Event("mouseover", { bubbles: true }));
		expect(dot().getAttribute("aria-label")).toBe("auth failed, last updated 3 m ago");
	});

	it("a real change in the dot (ok to failed) still repaints, once", async () => {
		await h.render();
		node.apiCache = cache({ ok: false, error: "auth failed", lastSuccessAt: T0 });
		expect(await renderCountingMutations()).toBeGreaterThan(0);
		expect(ex.lastRenderPainted).toBe(true);
		expect(dot().className).toContain("atlas-api-dot-red");
		expect(dot().getAttribute("aria-label")).toBe("auth failed, has refreshed successfully before");

		expect(await renderCountingMutations()).toBe(0);
	});

	it("a changed error message on a dot that stays red still repaints", async () => {
		node.apiCache = cache({ ok: false, error: "timeout" });
		await h.render();
		node.apiCache = cache({ ok: false, error: "auth failed" });
		await h.render();
		expect(ex.lastRenderPainted).toBe(true);
		expect(dot().getAttribute("aria-label")).toContain("auth failed");
	});
});

describe("dotTooltip", () => {
	it("without a clock it leaves the time out and keeps everything else", () => {
		expect(dotTooltip(cache(), null)).toBe("Last refresh ok");
		expect(dotTooltip(cache({ skippedCount: 2, truncated: true }), null)).toBe(
			"Last refresh ok — 2 item(s) skipped (missing/duplicate id) — Response truncated at 5,000 rows",
		);
		expect(dotTooltip(cache({ ok: false, error: "boom" }), null)).toBe("boom, never refreshed successfully");
		expect(dotTooltip(undefined, null)).toBe("Never refreshed");
		expect(dotTooltip(cache(), null, true)).toBe("Waiting for confirmation to delete rows");
	});

	it("with a clock it is unchanged", () => {
		expect(dotTooltip(cache(), T0 + 3 * 60 * MIN)).toBe("Last refresh ok, 3 h ago");
		expect(dotTooltip(cache(), T0)).toBe("Last refresh ok, just now");
	});
});
