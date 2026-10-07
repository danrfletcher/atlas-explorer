import { describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { MIN_REFRESH_MINUTES, RefreshEveryTimers, RefreshTimerDeps } from "../../src/api-refresh-timer";
import { ApiSourceConfig, FolderSourceConfig, View, ViewNode } from "../../src/types";

/** G10 (API sources): the refresh-on-view-load and refresh-every-N-minutes toggles, reusing the same
 * scheduler/hook. PR-1 (G2/G4): Folder, CSV and markdown-table sources no longer have those toggles —
 * they refresh on every view load, and never get a timer, even if a legacy saved source still carries
 * the removed fields. Exercises `AtlasExplorerView`'s private `refreshApiSourcesOnViewLoad`/
 * `syncRefreshTimers` directly via the same `(prototype as ...).method.call(fake, ...)` pattern as
 * `explorer-view-sort-truncate-helpers.ts`, since both methods are the actual "hook" and neither is
 * reachable through a public API. */

type ProtoMethods = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as ProtoMethods;

/** A fully fake clock/scheduler — mirrors `tests/unit/refresh-timer.test.ts`'s `FakeClock` so this
 * suite needs zero real elapsed time regardless of how many minutes of "Refresh every X minutes" it
 * exercises. */
class FakeClock implements RefreshTimerDeps {
	private nowMs = 0;
	private nextHandle = 1;
	private timers = new Map<number, { fireAt: number; cb: () => void }>();

	now = (): number => this.nowMs;

	setTimeoutFn = (cb: () => void, ms: number): unknown => {
		const handle = this.nextHandle++;
		this.timers.set(handle, { fireAt: this.nowMs + ms, cb });
		return handle;
	};

	clearTimeoutFn = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	advance(ms: number): void {
		this.nowMs += ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.fireAt <= this.nowMs).sort((a, b) => a[1].fireAt - b[1].fireAt);
			if (due.length === 0) return;
			const [handle, timer] = due[0];
			this.timers.delete(handle);
			timer.cb();
		}
	}

	pendingCount(): number {
		return this.timers.size;
	}
}

function apiSource(overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "https://example.com",
		method: "GET",
		mapping: { idField: "id", labelField: "label" },
		mode: "append",
		refreshOnViewLoad: false,
		...overrides,
	};
}

function folderSource(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		...overrides,
	};
}

/** A legacy saved source (pre-PR-1) can still carry the removed fields in `data.json`; the sanitizer
 * drops them on load, but the explorer's hook must also ignore them if they somehow arrive. */
function withLegacyRefreshFields<T extends object>(source: T, legacy: Record<string, unknown>): T {
	return { ...source, ...legacy } as T;
}

function metaNode(id: string, overrides: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "meta", label: id, children: [], ...overrides };
}

interface Fake {
	plugin: { viewsManager: { getActiveView: () => View } };
	refreshEveryTimers: RefreshEveryTimers;
	collectApiSourceNodes: (...args: unknown[]) => unknown;
	collectFolderSourceNodes: (...args: unknown[]) => unknown;
	collectCsvSourceNodes: (...args: unknown[]) => unknown;
	collectMarkdownTableSourceNodes: (...args: unknown[]) => unknown;
	refreshApiSource: ReturnType<typeof vi.fn>;
	refreshFolderSource: ReturnType<typeof vi.fn>;
	refreshCsvSource: ReturnType<typeof vi.fn>;
	refreshMarkdownTableSource: ReturnType<typeof vi.fn>;
}

function makeFake(view: View, clock: FakeClock): Fake {
	return {
		plugin: { viewsManager: { getActiveView: () => view } },
		refreshEveryTimers: new RefreshEveryTimers(clock),
		collectApiSourceNodes: proto.collectApiSourceNodes,
		collectFolderSourceNodes: proto.collectFolderSourceNodes,
		collectCsvSourceNodes: proto.collectCsvSourceNodes,
		collectMarkdownTableSourceNodes: proto.collectMarkdownTableSourceNodes,
		refreshApiSource: vi.fn(),
		refreshFolderSource: vi.fn(),
		refreshCsvSource: vi.fn(),
		refreshMarkdownTableSource: vi.fn(),
	};
}

function callRefreshOnViewLoad(fake: Fake): void {
	(proto.refreshApiSourcesOnViewLoad as (this: Fake) => void).call(fake);
}

function callSyncRefreshTimers(fake: Fake, view: View): void {
	(proto.syncRefreshTimers as (this: Fake, v: View) => void).call(fake, view);
}

const API_SOURCE: { label: string; build: (overrides?: Record<string, unknown>) => ViewNode } = {
	label: "api",
	build: (overrides = {}) => metaNode("n1", { apiSource: apiSource(overrides as Partial<ApiSourceConfig>) }),
};

describe("G10 — refresh-on-view-load honored for api sources", () => {
	it("fires exactly one refresh when apiSource.refreshOnViewLoad is on", () => {
		const clock = new FakeClock();
		const node = API_SOURCE.build({ refreshOnViewLoad: true });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		expect(fake.refreshApiSource).toHaveBeenCalledTimes(1);
		expect(fake.refreshFolderSource).not.toHaveBeenCalled();
	});

	it("does not refresh when apiSource.refreshOnViewLoad is off", () => {
		const clock = new FakeClock();
		const node = API_SOURCE.build({ refreshOnViewLoad: false });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		expect(fake.refreshApiSource).not.toHaveBeenCalled();
		expect(fake.refreshFolderSource).not.toHaveBeenCalled();
	});
});

describe("G10 — refresh-every-N-minutes honored for api sources, via the same RefreshEveryTimers scheduler", () => {
	const build = API_SOURCE.build;

	it("a never-refreshed apiSource with the toggle on fires one immediate catch-up refresh", () => {
		const clock = new FakeClock();
		const node = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(0);

		expect(fake.refreshApiSource).toHaveBeenCalledTimes(1);
	});

	it("re-syncing the same apiSource interval does not double-fire", () => {
		const clock = new FakeClock();
		const node = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(0);
		callSyncRefreshTimers(fake, view);

		expect(fake.refreshApiSource).toHaveBeenCalledTimes(1);
	});

	it("fires again after the configured interval elapses for apiSource", () => {
		const clock = new FakeClock();
		const node = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(0);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000);

		expect(fake.refreshApiSource).toHaveBeenCalledTimes(2);
	});

	it("toggling refresh-every-N-minutes off stops the apiSource's timer", () => {
		const clock = new FakeClock();
		const onNode = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [onNode] };
		const fake = makeFake(view, clock);
		callSyncRefreshTimers(fake, view);
		clock.advance(0);
		expect(fake.refreshEveryTimers.isScheduled("n1")).toBe(true);

		const offNode = build({ refreshEveryMinutesEnabled: false });
		const offView: View = { id: "v1", name: "Default", inboxMode: "view", root: [offNode] };
		callSyncRefreshTimers(fake, offView);

		expect(fake.refreshEveryTimers.isScheduled("n1")).toBe(false);
	});
});

/** PR-1 (G4): Folder, CSV and markdown-table sources always refresh on view load, with no toggle. */
describe("PR-1 (G4) — folder, CSV and markdown-table sources refresh on every view load, no toggle", () => {
	it("a Folder source refreshes on load even with no refresh field at all", () => {
		const clock = new FakeClock();
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [metaNode("n1", { folderSource: folderSource() })] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		expect(fake.refreshFolderSource).toHaveBeenCalledTimes(1);
	});

	it("an outside-vault Folder source refreshes on load as well", () => {
		const clock = new FakeClock();
		const outside = folderSource({ location: "outside", path: "" });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [metaNode("n1", { folderSource: outside })] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		expect(fake.refreshFolderSource).toHaveBeenCalledTimes(1);
	});

	it("a CSV source and a markdown-table source each refresh on load", () => {
		const clock = new FakeClock();
		const csv = metaNode("c1", {
			csvSource: { type: "csv", path: "a.csv", mapping: { idField: "id", labelField: "label" }, mode: "merge" },
		});
		const md = metaNode("m1", {
			markdownTableSource: {
				type: "markdown-table",
				path: "b.md",
				tableIndex: 0,
				mapping: { idField: "id", labelField: "label" },
				mode: "merge",
			},
		});
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [csv, md] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		expect(fake.refreshCsvSource).toHaveBeenCalledTimes(1);
		expect(fake.refreshMarkdownTableSource).toHaveBeenCalledTimes(1);
	});
});

/** PR-1 (G2): a legacy Folder/CSV/markdown source that still carries the removed refresh fields never
 * gets a timer — `syncRefreshTimers` only ever schedules API sources. */
describe("PR-1 (G2) — folder, CSV and markdown-table sources never get a refresh-every timer", () => {
	const legacy = { refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES, refreshOnViewLoad: true };

	it("a Folder source carrying the legacy fields schedules no timer and fires nothing", () => {
		const clock = new FakeClock();
		const node = metaNode("n1", { folderSource: withLegacyRefreshFields(folderSource(), legacy) });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000 * 3);

		expect(fake.refreshEveryTimers.isScheduled("n1")).toBe(false);
		expect(fake.refreshFolderSource).not.toHaveBeenCalled();
	});

	it("a CSV source carrying the legacy fields schedules no timer", () => {
		const clock = new FakeClock();
		const csv = withLegacyRefreshFields(
			{ type: "csv" as const, path: "a.csv", mapping: { idField: "id", labelField: "label" }, mode: "merge" as const },
			legacy
		);
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [metaNode("c1", { csvSource: csv })] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000 * 3);

		expect(fake.refreshEveryTimers.isScheduled("c1")).toBe(false);
		expect(fake.refreshCsvSource).not.toHaveBeenCalled();
	});

	it("a markdown-table source carrying the legacy fields schedules no timer", () => {
		const clock = new FakeClock();
		const md = withLegacyRefreshFields(
			{
				type: "markdown-table" as const,
				path: "b.md",
				tableIndex: 0,
				mapping: { idField: "id", labelField: "label" },
				mode: "merge" as const,
			},
			legacy
		);
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [metaNode("m1", { markdownTableSource: md })] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000 * 3);

		expect(fake.refreshEveryTimers.isScheduled("m1")).toBe(false);
		expect(fake.refreshMarkdownTableSource).not.toHaveBeenCalled();
	});
});
