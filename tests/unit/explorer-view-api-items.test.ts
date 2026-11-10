import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";
import { App, Menu, Notice, Platform } from "obsidian";
import { ApiSourceController } from "../../src/api-source-controller";
import { ClickActionRunner } from "../../src/click-action-runner";
import { ApiItemClickAction, ApiItemState, ApiSourceConfig, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import {
	callRenderApiItemRow,
	callRenderNodeList,
	folderGovernor,
	makeFakeExplorer,
	makeStatusesManager,
	proto,
	realNode,
	rowOrder,
	view,
} from "./explorer-view-sort-truncate-helpers";

// Atlas-18 (G11/G16): the source's own "Run terminal command" calls `executeApiCommand(argv)` with no options. The
// mock records that call and never spawns; a call that carries a `spawnImpl` (the click runner, with the test's own
// stub) goes through the real implementation, so the override's argv/no-shell guarantees are checked for real.
const apiCommand = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../../src/api-command-runner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/api-command-runner")>();
	return {
		...actual,
		executeApiCommand: vi.fn((argv: string[], options?: Parameters<typeof actual.executeApiCommand>[1]) => {
			if (options?.spawnImpl) return actual.executeApiCommand(argv, options);
			apiCommand.calls.push(argv);
			return Promise.resolve({ ok: true });
		}),
	};
});
vi.mock("../../src/status-popup", () => ({ openStatusPickerPopup: vi.fn() }));

// PR-1 R2 fix: the tests below only ever compared two post-fix calls to each other, so a
// regression inside `renderApiItemRow` itself (as opposed to the wiring that reaches it) would
// pass unnoticed. Pin the actual markup against a fixed string instead.
describe("PR-1 R2 — regression: renderApiItemRow markup is pinned against a fixed snapshot", () => {
	it("a normal API row's markup matches the known-good snapshot", () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "My Item", secondary: "extra", explicitStatusId: "doing" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		callRenderApiItemRow(fake, item, container, view, folder, 1, [folder]);

		expect(container.innerHTML).toBe(
			'<div class="atlas-row atlas-row-unit atlas-row-api-item" style="padding-left: 16px;" tabindex="0">' +
				'<div class="atlas-chevron"></div>' +
				'<div class="atlas-icon atlas-status-dot"><div class="atlas-status-dot-circle" style="background-color: rgb(0, 136, 255); color: rgb(0, 136, 255);"></div></div>' +
				'<span class="atlas-row-text">My Item</span>' +
				'<span class="atlas-row-secondary">extra</span>' +
				"</div>"
		);
	});

	it("a 'not found' API row's markup matches the known-good snapshot", () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "Gone", explicitStatusId: "todo", notFound: true, lastSeenAt: "2026-09-25T10:00:00.000Z" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		callRenderApiItemRow(fake, item, container, view, folder, 1, [folder]);

		expect(container.innerHTML).toBe(
			'<div class="atlas-row atlas-row-unit atlas-row-api-item atlas-not-found" style="padding-left: 16px;" tabindex="0">' +
				'<div class="atlas-chevron"></div>' +
				'<div class="atlas-icon atlas-status-dot"><div class="atlas-status-dot-circle" style="background-color: rgb(136, 136, 136); color: rgb(136, 136, 136);"></div></div>' +
				'<span class="atlas-row-text">Gone</span>' +
				'<span class="atlas-row-secondary">not found, last seen 2026-09-25</span>' +
				"</div>"
		);
	});
});

describe("G25 — regression: renderApiItemRow output is unchanged by the merged sort/truncate pass", () => {
	it("row content/icon/click wiring is byte-identical called directly vs. via the merged renderNodeList path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "My Item", secondary: "extra", explicitStatusId: "doing" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
	});

	it("a 'not found' item's last-seen text and icon are unchanged via the merged path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "Gone", explicitStatusId: "todo", notFound: true, lastSeenAt: "2026-09-25T10:00:00.000Z" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
		expect(mergedContainer.textContent).toContain("not found, last seen 2026-09-25");
	});

	it("an item with no explicit status falls back to the fallback 'plug' icon identically via either path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ statusEnabled: false, statusSetId: undefined, sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "No status" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
	});
});

describe("PR-6 R3 fix: a Folder-source-demoted row renders back at its recorded position among real children", () => {
	it("a row demoted from the middle slot re-renders between the two real children that were either side of it", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demoted: ApiItemState = { id: "demoted-b", label: "b", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 1 };
		folder.apiItemState = { "demoted-b": demoted };
		folder.apiItemOrder = ["demoted-b"];
		const realChildren = [realNode("a-real"), realNode("c-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "demoted-b", "c-real"]);
	});

	it("a genuine API row (no folderSourceDeleted marker) still always renders after every real child, unaffected by this fix", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const genuine: ApiItemState = { id: "api-1", label: "Genuine API row" };
		folder.apiItemState = { "api-1": genuine };
		folder.apiItemOrder = ["api-1"];
		const realChildren = [realNode("a-real"), realNode("c-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "c-real", "api-1"]);
	});

	it("a position past the end of the current real children clamps to the end instead of throwing or dropping the row", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demoted: ApiItemState = { id: "demoted-z", label: "z", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 99 };
		folder.apiItemState = { "demoted-z": demoted };
		folder.apiItemOrder = ["demoted-z"];
		const realChildren = [realNode("a-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "demoted-z"]);
	});

	// PR-6 R5 fix: more than one positioned row in the same batch used to come out in reverse
	// (descending-position splice order) relative to each other, reordering a surviving real child
	// between them.
	it("two rows demoted in the same batch render in ascending position order, not reversed around a surviving sibling", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demotedC1: ApiItemState = { id: "demoted-c1", label: "c1", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 1 };
		const demotedC2: ApiItemState = { id: "demoted-c2", label: "c2", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 2 };
		folder.apiItemState = { "demoted-c1": demotedC1, "demoted-c2": demotedC2 };
		folder.apiItemOrder = ["demoted-c1", "demoted-c2"];
		const realChildren = [realNode("c0-real"), realNode("c3-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["c0-real", "demoted-c1", "demoted-c2", "c3-real"]);
	});

	it("two rows demoted sequentially (recording the same position) render in apiItemOrder, not reversed", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demotedC1: ApiItemState = { id: "demoted-c1", label: "c1", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 1 };
		const demotedC2: ApiItemState = { id: "demoted-c2", label: "c2", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 1 };
		folder.apiItemState = { "demoted-c1": demotedC1, "demoted-c2": demotedC2 };
		folder.apiItemOrder = ["demoted-c1", "demoted-c2"];
		const realChildren = [realNode("c0-real"), realNode("c3-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["c0-real", "demoted-c1", "demoted-c2", "c3-real"]);
	});
});

// PR-1 (G11d/G11c/E-b): a sourced unit gets the same filter bypass as an Atlas folder, and a unit's
// rows come from `apiOwner`, not only from a meta node.
describe("PR-1 G11d — the filter bypass shows a sourced unit when one of its rows matches", () => {
	const apiSource = { url: "https://x", method: "GET" as const, mapping: { idField: "id", labelField: "name" }, mode: "merge" as const, refreshOnViewLoad: false };

	it("a unit whose API row matches the filter is handed to renderNode (bypass path)", async () => {
		const sm = makeStatusesManager();
		const sourced = realNode("sourced-unit", {
			ref: { kind: "file", path: "Linear.md" },
			apiSource,
			apiItemState: { "api-1": { id: "api-1", label: "Zed bug", explicitStatusId: "todo" } },
			apiItemOrder: ["api-1"],
		} as Partial<ViewNode>);
		const plain = realNode("plain-unit", { ref: { kind: "file", path: "Other.md" } } as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, {
			filterText: "zed",
			resolveRef: vi.fn((ref: { path: string }) => ({ text: ref.path })),
			apiItemsMatchFilter: proto.apiItemsMatchFilter,
			matchesFilter: proto.matchesFilter,
			pseudoNodeForApiItem: proto.pseudoNodeForApiItem,
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [plain, sourced], container, view, 0, []);
		const shown = Array.from(container.querySelectorAll("[data-id]")).map((el) => (el as HTMLElement).dataset.id);
		expect(shown).toContain("sourced-unit");
	});
});

describe("PR-1 E-b — a unit with neither source nor children draws no row container", () => {
	it("apiItemsMatchFilter is false for a unit with no rows, so it is never bypassed", () => {
		const sm = makeStatusesManager();
		const fake = makeFakeExplorer(sm, { filterText: "zed", apiItemsMatchFilter: proto.apiItemsMatchFilter });
		expect(fake.apiItemsMatchFilter(realNode("bare", { ref: { kind: "file", path: "B.md" } } as Partial<ViewNode>))).toBe(false);
	});
});

describe("PR-1 G11c — a unit with source rows renders them via apiOwner, with no children", () => {
	it("passing a unit as apiOwner draws each of its rows, in apiItemOrder", async () => {
		const sm = makeStatusesManager();
		const unit = realNode("unit-owner", {
			ref: { kind: "file", path: "Linear.md" },
			apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false },
			apiItemState: {
				a: { id: "a", label: "A", explicitStatusId: "todo" },
				b: { id: "b", label: "B", explicitStatusId: "todo" },
			},
			apiItemOrder: ["b", "a"],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		const text = container.textContent ?? "";
		expect(text).toContain("A");
		expect(text).toContain("B");
		expect(text.indexOf("B")).toBeLessThan(text.indexOf("A"));
	});

	it("E-b: a source with zero rows and no children draws no empty container", async () => {
		const sm = makeStatusesManager();
		const unit = realNode("empty-owner", {
			ref: { kind: "file", path: "Empty.md" },
			apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false },
			apiItemState: {},
			apiItemOrder: [],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		expect(container.children).toHaveLength(0);
	});
});

// PR-1 (G11c, T1/T4): a unit whose rows came from a CSV or markdown-table source renders them through
// `apiOwner` exactly as an API unit does — all three source kinds store their rows in `apiItemState`/`apiItemOrder`.
describe("PR-1 G11c — a unit with CSV or markdown-table rows renders them via apiOwner", () => {
	const mapping = { idField: "id", labelField: "name" };
	const sourceKinds: { kind: string; source: Partial<ViewNode> }[] = [
		{ kind: "API", source: { apiSource: { url: "https://x", method: "GET", mapping, mode: "merge", refreshOnViewLoad: false } } },
		{ kind: "CSV", source: { csvSource: { path: "Rows.csv", mapping, mode: "merge", refreshOnViewLoad: false } } },
		{
			kind: "markdown-table",
			source: { markdownTableSource: { path: "Rows.md", tableIndex: 0, mapping, mode: "merge", refreshOnViewLoad: false } },
		},
	];

	it.each(sourceKinds)("a unit holding a $kind source draws each of its rows, in apiItemOrder", async ({ source }) => {
		const sm = makeStatusesManager();
		const unit = realNode("unit-owner", {
			ref: { kind: "file", path: "Rows.md" },
			...source,
			apiItemState: {
				a: { id: "a", label: "Alpha row", explicitStatusId: "todo" },
				b: { id: "b", label: "Bravo row", explicitStatusId: "doing" },
			},
			apiItemOrder: ["b", "a"],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		const text = container.textContent ?? "";
		expect(text).toContain("Alpha row");
		expect(text).toContain("Bravo row");
		expect(text.indexOf("Bravo row")).toBeLessThan(text.indexOf("Alpha row"));
	});

	it.each(sourceKinds)("a unit holding a $kind source with zero rows draws no row container", async ({ source }) => {
		const sm = makeStatusesManager();
		const unit = realNode("empty-unit", {
			ref: { kind: "file", path: "Empty.md" },
			...source,
			apiItemState: {},
			apiItemOrder: [],
		} as Partial<ViewNode>);
		const fake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 0, [], unit);
		expect(container.children).toHaveLength(0);
	});
});

// PR-4 (T1/T5/C30 fix): G20 — API rows have no edge zone at all; the new sorted-drop gating
// (`resolveDropDecision`/`assessDrop`) lives entirely inside `makeDropZone`'s own
// dragover/drop closures (explorer-view.ts), which `renderApiItemRow` never calls, sorted
// folder or not. Drives the real (unstubbed) `renderApiItemRow` and confirms a dragover at the
// row produces today's result: nothing at all (no line, no outline, not draggable).
describe("PR-4 G20 — an API item row takes no edge drops, whether or not its owning folder is sorted", () => {
	it("a real API row rendered under a sorted (A-Z) folder is never draggable and ignores a dragover at its own top/bottom edge", () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		const item: ApiItemState = { id: "api-1", label: "My Item" };

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		callRenderApiItemRow(fake, item, container, view, folder, 1, [folder]);

		const row = container.querySelector(".atlas-row-api-item") as HTMLElement;
		expect(row).toBeTruthy();
		expect(row.getAttribute("draggable")).toBeNull(); // never made draggable, unaffected by sort

		for (const clientY of [5, 50, 95]) {
			row.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }));
		}
		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(container.classList.contains("atlas-sorted-drop-outline")).toBe(false);
		expect(row.classList.contains("atlas-drop-target")).toBe(false);
	});
});


// ---------------------------------------------------------------------------------------------------------------
// Atlas-18 G11/G16: clicking and keyboarding a real rendered API item row. The REAL `renderApiItemRow`,
// `handleApiItemClick`, `runApiSourceCommand`, `openApiItemAttachment` and `runClickAction` run through the
// fake-`this` `.call` pattern. Faked: the vault (`openRef` is a spy), `spawn`, the command registry and `window.open`.
// ---------------------------------------------------------------------------------------------------------------
describe("Atlas-18 G11/G16: an API item row's click and keyboard behaviour", () => {
	const NOTE = { kind: "file", path: "Docker.md" } as const;
	const URI = "obsidian://open?vault=Notes&file=Docker";
	const source = (over: Record<string, unknown> = {}): ApiSourceConfig =>
		({ url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false, ...over }) as ApiSourceConfig;

	let openSpy: MockInstance<typeof window.open>;
	let executeCommandById: ReturnType<typeof vi.fn>;
	let spawnCalls: { executable: string; args: string[]; options: Record<string, unknown> }[];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
		(Platform as { isMobile: boolean }).isMobile = false;
		Notice.reset();
		apiCommand.calls.length = 0;
		openSpy = vi.spyOn(window, "open").mockImplementation(() => ({}) as Window);
	});
	afterEach(() => {
		(Platform as { isMobile: boolean }).isMobile = false;
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function rig(owner: ViewNode) {
		const app = new App();
		executeCommandById = vi.fn((_id: string) => true);
		(app as unknown as { commands: unknown }).commands = { executeCommandById };
		spawnCalls = [];
		const spawnImpl = ((executable: string, args: string[], options: Record<string, unknown>) => {
			spawnCalls.push({ executable, args, options });
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0));
			return child;
		}) as never;
		const fake = makeFakeExplorer(makeStatusesManager()) as unknown as Record<string, unknown>;
		(fake.plugin as { app: App }).app = app;
		// T1: clicks read the owning Folder and the item back from ViewsManager; here that is `owner` itself.
		(fake.plugin as { viewsManager: Record<string, unknown> }).viewsManager.getNode = () => owner;
		Object.assign(fake, {
			clickActionRunner: new ClickActionRunner({ app: app as never, spawnImpl }),
			openRef: vi.fn(async () => {}),
		});
		for (const name of ["handleApiItemClick", "showApiItemMenu", "runApiSourceCommand", "openApiItemAttachment", "runClickAction"]) {
			fake[name] = (...args: unknown[]) => (proto[name] as (...a: unknown[]) => unknown).call(fake, ...args);
		}
		return fake as unknown as { openRef: ReturnType<typeof vi.fn> } & Parameters<typeof callRenderApiItemRow>[0];
	}

	function draw(owner: ViewNode, item: ApiItemState, shared?: ReturnType<typeof rig>) {
		const host = shared ?? rig(owner);
		owner.apiItemState = { ...(owner.apiItemState ?? {}), [item.id]: item };
		owner.apiItemOrder = [item.id];
		const container = document.createElement("div");
		document.body.appendChild(container);
		callRenderApiItemRow(host, item, container, view, owner, 1, [owner]);
		const row = container.querySelector<HTMLElement>(".atlas-row-api-item")!;
		return { host, row, item };
	}

	const apiOwner = (over: Partial<ViewNode> = {}): ViewNode => folderGovernor({ apiSource: source(), ...over });
	const rowItem = (over: Partial<ApiItemState> = {}): ApiItemState => ({ id: "1", label: "Docker 4.34", kind: "placeholder", ...over });
	const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
	const press = (row: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
		const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
		row.dispatchEvent(evt);
		return evt;
	};
	const flushRun = async () => {
		await vi.advanceTimersByTimeAsync(0);
	};
	const OVERRIDES: Record<string, ApiItemClickAction> = {
		uri: { kind: "uri", value: URI },
		command: { kind: "command", value: "app-runner:open-docker" },
		terminal: { kind: "terminal", value: "open -a Docker" },
	};
	function expectNothingRan(host: { openRef: ReturnType<typeof vi.fn> }) {
		expect(openSpy).not.toHaveBeenCalled();
		expect(executeCommandById).not.toHaveBeenCalled();
		expect(spawnCalls).toEqual([]);
		expect(apiCommand.calls).toEqual([]);
		expect(host.openRef).not.toHaveBeenCalled();
	}

	describe("G16: the row is keyboard reachable", () => {
		it("has tabIndex 0, and so is a tab stop like a bucket row", () => {
			const { row } = draw(apiOwner(), rowItem());
			expect(row.tabIndex).toBe(0);
			expect(row.getAttribute("tabindex")).toBe("0");
		});

		it("rows in one list are all tab stops, in DOM (row) order", async () => {
			const owner = apiOwner();
			const a = rowItem({ id: "a", label: "A" });
			const b = rowItem({ id: "b", label: "B" });
			owner.apiItemState = { a, b };
			owner.apiItemOrder = ["a", "b"];
			const host = rig(owner);
			const container = document.createElement("div");
			await callRenderNodeList(Object.assign(host, { renderApiItemRow: proto.renderApiItemRow }) as never, [], container, view, 1, [owner], owner);
			const rows = Array.from(container.querySelectorAll<HTMLElement>(".atlas-row-api-item"));
			expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("A"), expect.stringContaining("B")]);
			expect(rows.every((r) => r.tabIndex === 0)).toBe(true);
		});
	});

	describe("G16/G11: Enter runs the same chain as a click", () => {
		it.each(Object.keys(OVERRIDES))("Enter with a %s override runs it, and does not open the attached note", async (kind) => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES[kind] }));
			const evt = press(row, "Enter");
			await flushRun();
			expect(evt.defaultPrevented).toBe(true);
			expect(host.openRef).not.toHaveBeenCalled();
			if (kind === "uri") expect(openSpy).toHaveBeenCalledExactlyOnceWith(URI);
			if (kind === "command") expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-docker");
			if (kind === "terminal") expect(spawnCalls).toHaveLength(1);
		});

		it("Enter with no override and an Open attachment source opens the attachment", async () => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE }));
			press(row, "Enter");
			await flushRun();
			expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
		});

		it("Enter with no override and an unset source action also opens the attachment (today's default)", async () => {
			const { host, row } = draw(apiOwner({ apiSource: source({ action: undefined, clickAction: undefined }) }), rowItem({ noteRef: NOTE }));
			press(row, "Enter");
			await flushRun();
			expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
		});

		it.each([["shiftKey"], ["metaKey"], ["ctrlKey"], ["altKey"]])("Enter with %s held runs nothing, override or not", async (modifier) => {
			const withOverride = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.uri }));
			press(withOverride.row, "Enter", { [modifier]: true });
			const without = draw(apiOwner(), rowItem({ noteRef: NOTE }));
			press(without.row, "Enter", { [modifier]: true });
			await flushRun();
			expectNothingRan(withOverride.host);
			expect(without.host.openRef).not.toHaveBeenCalled();
		});

		it("a held Enter (key repeat) does not repeat the run", async () => {
			const { row } = draw(apiOwner(), rowItem({ clickAction: OVERRIDES.command }));
			press(row, "Enter", { repeat: true });
			await flushRun();
			expect(executeCommandById).not.toHaveBeenCalled();
		});

		it.each([[" "], ["Delete"], ["F2"], ["Escape"]])("%j does nothing new on an API item row", async (key) => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.uri }));
			const evt = press(row, key);
			await flushRun();
			expect(evt.defaultPrevented).toBe(false);
			expectNothingRan(host);
		});

		it("Enter with an override of None runs nothing and opens nothing, even with a note and a source on Open attachment", async () => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: { kind: "none" } }));
			press(row, "Enter");
			await flushRun();
			expectNothingRan(host);
		});
	});

	describe("G16/E9: the debounce covers a click then Enter on the same row", () => {
		it("click then Enter inside 1 s runs the override once", async () => {
			const { row } = draw(apiOwner(), rowItem({ clickAction: OVERRIDES.command }));
			click(row);
			await flushRun();
			press(row, "Enter");
			await flushRun();
			expect(executeCommandById).toHaveBeenCalledTimes(1);
		});

		it("Enter then click inside 1 s runs once too, and a press 1 s after the start runs again", async () => {
			const { row } = draw(apiOwner(), rowItem({ clickAction: OVERRIDES.command }));
			press(row, "Enter");
			click(row);
			await flushRun();
			expect(executeCommandById).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1000);
			click(row);
			await flushRun();
			expect(executeCommandById).toHaveBeenCalledTimes(2);
		});

		it("two different rows do not debounce each other", async () => {
			const owner = apiOwner();
			const a = draw(owner, rowItem({ id: "a", clickAction: OVERRIDES.command }));
			const b = draw(owner, rowItem({ id: "b", clickAction: OVERRIDES.command }), a.host); // one view, one runner
			click(a.row);
			click(b.row);
			await flushRun();
			expect(executeCommandById).toHaveBeenCalledTimes(2);
		});
	});

	describe("G11: a click follows the precedence chain", () => {
		it.each(Object.keys(OVERRIDES))("a plain click with a %s override runs it and never opens the note", async (kind) => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES[kind] }));
			click(row.querySelector(".atlas-row-text")!);
			await flushRun();
			expect(host.openRef).not.toHaveBeenCalled();
			expect(openSpy.mock.calls.length + executeCommandById.mock.calls.length + spawnCalls.length).toBe(1);
		});

		it("the terminal override reaches the runner as an argv array, never through a shell (F2/F10)", async () => {
			const { row } = draw(apiOwner(), rowItem({ clickAction: { kind: "terminal", value: "echo hi; rm x" } }));
			click(row);
			await flushRun();
			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0].executable).toBe("echo");
			expect(spawnCalls[0].args).toEqual(["hi;", "rm", "x"]);
			expect(Array.isArray(spawnCalls[0].args)).toBe(true);
			expect(spawnCalls[0].options.shell).toBe(false);
		});

		it("a URI override reaches window.open exactly as typed (F10)", async () => {
			const odd = "obsidian://open?vault=My%20Notes&file=a b&x={id}";
			const { row } = draw(apiOwner(), rowItem({ clickAction: { kind: "uri", value: odd } }));
			click(row);
			await flushRun();
			expect(openSpy).toHaveBeenCalledExactlyOnceWith(odd);
		});

		it.each([["open-attachment"], ["run-command"]])("an override of None beats a source set to %s", async (action) => {
			const { host, row } = draw(apiOwner({ apiSource: source({ action, command: "open -a Docker" }) }), rowItem({ noteRef: NOTE, clickAction: { kind: "none" } }));
			click(row);
			await flushRun();
			expectNothingRan(host);
		});

		it("with no override, Open attachment opens noteRef; with no noteRef nothing happens", async () => {
			const withNote = draw(apiOwner(), rowItem({ noteRef: NOTE }));
			click(withNote.row);
			expect(withNote.host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
			const noNote = draw(apiOwner(), rowItem({ id: "2" }));
			click(noNote.row);
			expect(noNote.host.openRef).not.toHaveBeenCalled();
		});

		it("with no override, Run terminal command resolves {field} from the cached row", async () => {
			const owner = apiOwner({
				apiSource: source({ action: "run-command", command: "open -a {path}" }),
				apiCache: { ok: true, fetchedAt: "2026-11-10T00:00:00Z", rows: [{ id: "1", label: "Docker 4.34", extra: { path: "Docker" } }] } as never,
			});
			const { host, row } = draw(owner, rowItem({ noteRef: NOTE }));
			click(row);
			await flushRun();
			expect(apiCommand.calls).toEqual([["open", "-a", "Docker"]]);
			expect(host.openRef).not.toHaveBeenCalled(); // only Open attachment (or unset) ever opens it
		});

		it("with no override, None does nothing, and never opens the attachment", async () => {
			const { host, row } = draw(apiOwner({ apiSource: source({ action: "none" }) }), rowItem({ noteRef: NOTE }));
			click(row);
			press(row, "Enter");
			await flushRun();
			expectNothingRan(host);
		});
	});

	describe("E6/E1/G13 guards: failures are a notice and change nothing", () => {
		it("a not-found merge row takes its override; a terminal override with a {field} placeholder shows the resolve error", async () => {
			const notFound = draw(apiOwner(), rowItem({ notFound: true, lastSeenAt: "2026-11-01T00:00:00Z", clickAction: OVERRIDES.command }));
			click(notFound.row);
			await flushRun();
			expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-docker");

			Notice.reset();
			const placeholder: ApiItemClickAction = { kind: "terminal", value: "open -a {path}" };
			const withField = draw(apiOwner(), rowItem({ id: "2", notFound: true, clickAction: placeholder }));
			click(withField.row);
			await flushRun();
			expect(spawnCalls).toEqual([]);
			expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: Missing value for placeholder: {path}"]);
			expect(withField.item.clickAction).toEqual(placeholder);
		});

		it("a stored command id that no longer exists shows 'Atlas: command not found: <id>' and the setting stays", async () => {
			const { host, row, item } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.command }));
			executeCommandById.mockReturnValue(false);
			click(row);
			await flushRun();
			expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: command not found: app-runner:open-docker"]);
			expect(item.clickAction).toEqual(OVERRIDES.command);
			expect(host.openRef).not.toHaveBeenCalled();
		});

		it("a synced terminal override on mobile shows 'Atlas: terminal actions are desktop only' and stays", async () => {
			(Platform as { isMobile: boolean }).isMobile = true;
			const { row, item } = draw(apiOwner(), rowItem({ clickAction: OVERRIDES.terminal }));
			click(row);
			await flushRun();
			expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: terminal actions are desktop only"]);
			expect(spawnCalls).toEqual([]);
			expect(item.clickAction).toEqual(OVERRIDES.terminal);
		});
	});

	// T1: a refresh replaces the `apiItemState` objects while the drawn row (and its listeners) stays on screen.
	// Real `ViewsManager` and real `ApiSourceController.refresh`; the row is drawn BEFORE the refresh and the
	// override is set AFTER it, so only a click that re-reads the live item can see it.
	describe("T1: a drawn row follows the live item after an API refresh", () => {
		async function drawThenRefresh() {
			const owner = apiOwner({ id: "apps", apiSource: source({ mode: "merge" }) });
			const views = new ViewsManager({} as App, [{ id: view.id, name: "Default", inboxMode: "view", root: [{ ...owner, apiItemState: { "1": rowItem() }, apiItemOrder: ["1"] }] }], view.id, () => {});
			const live = views.getNode(view.id, "apps")!;
			const host = rig(live);
			(host as unknown as { plugin: { viewsManager: unknown } }).plugin.viewsManager = views;
			const container = document.createElement("div");
			document.body.appendChild(container);
			const drawn = live.apiItemState!["1"];
			callRenderApiItemRow(host, drawn, container, view, live, 1, [live]);
			const row = container.querySelector<HTMLElement>(".atlas-row-api-item")!;
			vi.useRealTimers();
			await new ApiSourceController().refresh(views.getNode(view.id, "apps")!, source({ mode: "merge" }), [], () => {}, {
				requestImpl: async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "Docker 4.34" }]) }),
			});
			vi.useFakeTimers();
			expect(views.getNode(view.id, "apps")!.apiItemState!["1"]).not.toBe(drawn); // the refresh really replaced the object
			return { host, row, views };
		}

		it("a click runs an override set after the refresh", async () => {
			const { row, views } = await drawThenRefresh();
			views.setApiItemClickAction(view.id, "apps", "1", OVERRIDES.terminal);
			click(row);
			await flushRun();
			expect(spawnCalls.map((c) => [c.executable, ...c.args])).toEqual([["open", "-a", "Docker"]]);
		});

		it("Enter runs it too, and Clear click action then falls back to the source setting", async () => {
			const { host, row, views } = await drawThenRefresh();
			views.setApiItemClickAction(view.id, "apps", "1", OVERRIDES.uri);
			press(row, "Enter");
			await flushRun();
			expect(openSpy).toHaveBeenCalledExactlyOnceWith(URI);
			views.setApiItemClickAction(view.id, "apps", "1", undefined);
			vi.advanceTimersByTime(1500);
			press(row, "Enter");
			await flushRun();
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(host.openRef).not.toHaveBeenCalled(); // the item has no attachment, so the source layer does nothing
		});

		it("the right-click menu shows Clear click action from the live item", async () => {
			const { row, views } = await drawThenRefresh();
			views.setApiItemClickAction(view.id, "apps", "1", OVERRIDES.uri);
			let built: Menu | undefined;
			const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
				built = this;
			});
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			show.mockRestore();
			expect(built!.titles()).toContain("Clear click action");
		});

		it("a row whose item has since been removed runs nothing", async () => {
			const { host, row, views } = await drawThenRefresh();
			views.setApiItemClickAction(view.id, "apps", "1", OVERRIDES.uri);
			delete views.getNode(view.id, "apps")!.apiItemState!["1"];
			click(row);
			await flushRun();
			expectNothingRan(host);
		});
	});

	describe("E16: an override under a removed source, or on a Table or CSV row, never runs", () => {
		const owners: [string, () => ViewNode][] = [
			["a removed source (static rows left behind)", () => folderGovernor({ apiSource: undefined })],
			["a CSV row", () => folderGovernor({ apiSource: undefined, csvSource: { path: "a.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } as never })],
			["a Table row", () => folderGovernor({ apiSource: undefined, markdownTableSource: { path: "a.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } as never })],
		];
		it.each(owners)("%s: click and Enter run nothing, show no error, and the override is kept", async (_label, makeOwner) => {
			const stored = OVERRIDES.command;
			const { host, row, item } = draw(makeOwner(), rowItem({ clickAction: stored }));
			click(row);
			press(row, "Enter");
			await flushRun();
			expectNothingRan(host);
			expect(Notice.instances).toEqual([]);
			expect(item.clickAction).toEqual(stored);
		});

		it("such a row still opens its attachment as it always did", async () => {
			const { host, row } = draw(folderGovernor({ apiSource: undefined }), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.command }));
			click(row);
			expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
			expect(executeCommandById).not.toHaveBeenCalled();
		});
	});

	describe("F5: other gestures never run the override", () => {
		it.each([["shiftKey"], ["metaKey"], ["ctrlKey"], ["altKey"]])("a %s-click runs nothing, and does not open the attachment either", async (modifier) => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.uri }));
			click(row.querySelector(".atlas-row-text")!, { [modifier]: true });
			await flushRun();
			expectNothingRan(host);
		});

		it("a click on the status dot runs nothing (it opens the status popup)", async () => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, explicitStatusId: "doing", clickAction: OVERRIDES.uri }));
			click(row.querySelector(".atlas-status-dot-circle")!);
			await flushRun();
			expectNothingRan(host);
		});

		it("middle-click and a drag start run nothing", async () => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.uri }));
			row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 }));
			row.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
			row.dispatchEvent(new Event("dragstart", { bubbles: true }));
			await flushRun();
			expectNothingRan(host);
		});

		it("a long press (button held 1.2 s, then released with no click) runs nothing", async () => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE, clickAction: OVERRIDES.uri }));
			row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
			await vi.advanceTimersByTimeAsync(1200);
			row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
			await flushRun();
			expectNothingRan(host);
		});

		it("with no override a modifier-click behaves as it did before (F8)", async () => {
			const { host, row } = draw(apiOwner(), rowItem({ noteRef: NOTE }));
			click(row, { shiftKey: true });
			expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
		});
	});

	// -----------------------------------------------------------------------------------------------------------
	// Atlas-18 G7-G9: the source's Click function sits between the Item override and the source click action.
	// The REAL `renderApiItemRow` and `handleApiItemClick` run, with the real `ClickActionRunner` and the real
	// function compiler. Faked, as above: the vault (`openRef`), `spawn`, the command registry, `window.open`.
	// -----------------------------------------------------------------------------------------------------------
	describe("G9: the Click function layer", () => {
		type Seen = { id: string; label: string; secondary: string | undefined; extra: Record<string, unknown>; keys: string[] };
		const sink = globalThis as unknown as { __clickSeen?: Seen[] };
		beforeEach(() => {
			sink.__clickSeen = [];
		});
		afterEach(() => {
			delete sink.__clickSeen;
		});

		/** A function that records what it was called with, then returns `ret` (JS source for an expression). */
		const fnReturning = (ret: string) =>
			`(item) => { globalThis.__clickSeen.push({ id: item.id, label: item.label, secondary: item.secondary, extra: item.extra, keys: Object.keys(item) }); return ${ret}; }`;
		const calls = () => sink.__clickSeen ?? [];
		const withFunction = (clickFunction: string | undefined, over: Partial<ViewNode> = {}, sourceOver: Record<string, unknown> = {}) =>
			apiOwner({ apiSource: source({ clickFunction, ...sourceOver }), ...over });
		const cache = (...rows: { id: string; label: string; extra?: Record<string, unknown> }[]) => ({ ok: true, fetchedAt: 1, error: null, rows, skippedCount: 0, truncated: false }) as never;
		const PLAN = `(item) => item.extra.path ? { kind: "terminal", argv: ["open", "-a", item.extra.path] } : { kind: "command", id: "app-runner:open-" + item.id }`;
		const noticeTexts = () => Notice.instances.map((n) => n.message);

		describe("what the function returns", () => {
			it("GP8: a row with extra.path spawns `open -a <path>` with no shell, and the note does not open", async () => {
				const owner = withFunction(PLAN, { apiCache: cache({ id: "docker", label: "Docker 4.34", extra: { path: "/Applications/Docker.app" } }) });
				const { host, row } = draw(owner, rowItem({ id: "docker", noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(spawnCalls.map((c) => [c.executable, ...c.args])).toEqual([["open", "-a", "/Applications/Docker.app"]]);
				expect(spawnCalls[0].options.shell).toBe(false);
				expect(executeCommandById).not.toHaveBeenCalled();
				expect(host.openRef).not.toHaveBeenCalled();
				expect(noticeTexts()).toEqual([]);
			});

			it("GP8: a row with no path calls executeCommandById with the id built by the function, and spawns nothing", async () => {
				const owner = withFunction(PLAN, { apiCache: cache({ id: "build-dashboard", label: "Build Dashboard", extra: {} }) });
				const { row } = draw(owner, rowItem({ id: "build-dashboard", label: "Build Dashboard" }));
				click(row);
				await flushRun();
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-build-dashboard");
				expect(spawnCalls).toEqual([]);
			});

			it("a terminal argv goes to the spawner untouched: no tokenizing, no {field} resolution", async () => {
				const owner = withFunction(`(item) => ({ kind: "terminal", argv: ["tool", "{path}", "two words", "a;b"] })`, { apiCache: cache({ id: "1", label: "x", extra: { path: "/p" } }) });
				const { row } = draw(owner, rowItem());
				click(row);
				await flushRun();
				expect(spawnCalls).toHaveLength(1);
				expect(spawnCalls[0].executable).toBe("tool");
				expect(spawnCalls[0].args).toEqual(["{path}", "two words", "a;b"]);
				expect(spawnCalls[0].options.shell).toBe(false);
				expect(apiCommand.calls).toEqual([]); // not the source's static command path
			});

			it("a command result goes to the shared command runner; an unknown id shows the existing notice", async () => {
				const { row } = draw(withFunction(`(item) => ({ kind: "command", id: "nope:missing" })`), rowItem());
				executeCommandById.mockReturnValue(false);
				click(row);
				await flushRun();
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("nope:missing");
				expect(noticeTexts()).toEqual(["Atlas: command not found: nope:missing"]);
			});

			it("a uri result goes to window.open exactly as returned; a null return shows the existing notice", async () => {
				const { row } = draw(withFunction(`(item) => ({ kind: "uri", uri: "obsidian://open?vault=Notes&file=" + item.label })`), rowItem({ label: "Docker" }));
				click(row);
				await flushRun();
				expect(openSpy).toHaveBeenCalledExactlyOnceWith("obsidian://open?vault=Notes&file=Docker");
				expect(noticeTexts()).toEqual([]);

				openSpy.mockReturnValue(null);
				const second = draw(withFunction(`(item) => ({ kind: "uri", uri: "obsidian://x" })`), rowItem({ id: "2" }));
				click(second.row);
				await flushRun();
				expect(noticeTexts()).toEqual(["Atlas: couldn't open URI"]);
			});

			it("a terminal result on mobile shows the desktop-only notice and spawns nothing", async () => {
				(Platform as { isMobile: boolean }).isMobile = true;
				const { row } = draw(withFunction(`(item) => ({ kind: "terminal", argv: ["open"] })`), rowItem());
				click(row);
				await flushRun();
				expect(noticeTexts()).toEqual(["Atlas: terminal actions are desktop only"]);
				expect(spawnCalls).toEqual([]);
			});

			it.each([["open-attachment"], ["none"], ["run-command"]])(
				"{ kind: none } stops everything, even with the source on %s and a note attached",
				async (action) => {
					const owner = withFunction(fnReturning(`({ kind: "none" })`), {}, { action, command: "open -a Docker" });
					const { host, row } = draw(owner, rowItem({ noteRef: NOTE }));
					click(row);
					await flushRun();
					expect(calls()).toHaveLength(1);
					expectNothingRan(host);
					expect(noticeTexts()).toEqual([]);
				}
			);
		});

		describe("falling through to the source click action", () => {
			it.each([["undefined", "undefined"], ["null", "null"]])("a %s return with source Open attachment opens the note", async (_label, ret) => {
				const { host, row } = draw(withFunction(fnReturning(ret)), rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(calls()).toHaveLength(1);
				expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
			});

			it("a function with no return statement falls through too", async () => {
				const { host, row } = draw(withFunction("(item) => {}"), rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
			});

			it("falling through with the source on None runs nothing", async () => {
				const { host, row } = draw(withFunction(fnReturning("undefined"), {}, { action: "none" }), rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(calls()).toHaveLength(1);
				expectNothingRan(host);
			});

			it("falling through with no attachment and the default source action runs nothing", async () => {
				const { host, row } = draw(withFunction(fnReturning("undefined")), rowItem());
				click(row);
				await flushRun();
				expectNothingRan(host);
				expect(noticeTexts()).toEqual([]);
			});

			it("falling through with the source on Run terminal command runs its static command with {field} resolved", async () => {
				const owner = withFunction(
					fnReturning("undefined"),
					{ apiCache: cache({ id: "1", label: "Docker 4.34", extra: { path: "Docker" } }) },
					{ action: "run-command", command: "open -a {path}" }
				);
				const { host, row } = draw(owner, rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(apiCommand.calls).toEqual([["open", "-a", "Docker"]]);
				expect(spawnCalls).toEqual([]);
				expect(host.openRef).not.toHaveBeenCalled();
			});
		});

		describe("every invalid return, and a throw, is a notice and runs nothing (E2, E3)", () => {
			const cases: [string, string, RegExp][] = [
				["an unknown kind", `({ kind: "shell", cmd: "ls" })`, /unknown kind "shell"/],
				["a command with no id", `({ kind: "command" })`, /string "id"/],
				["a command with a numeric id", `({ kind: "command", id: 5 })`, /string "id"/],
				["a uri with no uri", `({ kind: "uri" })`, /string "uri"/],
				["a terminal with a string argv", `({ kind: "terminal", argv: "open -a Docker" })`, /array of strings/],
				["a terminal with an empty argv", `({ kind: "terminal", argv: [] })`, /must not be empty/],
				["E3: a number in argv", `({ kind: "terminal", argv: ["open", 1] })`, /element 1 must be a string/],
				["E3: null in argv", `({ kind: "terminal", argv: [null] })`, /element 0 must be a string/],
				["E3: a nested array in argv", `({ kind: "terminal", argv: ["open", ["-a"]] })`, /element 1 must be a string/],
				["a bare string", `"open -a Docker"`, /not string/],
				["an array", `[{ kind: "none" }]`, /not an array/],
				["a Promise return", `Promise.resolve({ kind: "command", id: "a:b" })`, /synchronous/],
				["a throw", `(() => { throw new Error("boom"); })()`, /threw: boom/],
			];

			it.each(cases)("%s", async (_label, ret, message) => {
				const owner = withFunction(fnReturning(ret), { apiCache: cache({ id: "1", label: "Docker 4.34", extra: { a: 1 } }) });
				const { host, row, item } = draw(owner, rowItem({ noteRef: NOTE, explicitStatusId: "doing" }));
				const stateBefore = JSON.stringify(owner.apiItemState);
				const cacheBefore = JSON.stringify(owner.apiCache);
				expect(() => click(row)).not.toThrow();
				await flushRun();
				expectNothingRan(host); // not even the attachment: an error stops the chain
				expect(noticeTexts()).toHaveLength(1);
				expect(noticeTexts()[0]).toMatch(/^Atlas: Click function/);
				expect(noticeTexts()[0]).toMatch(message);
				expect(JSON.stringify(owner.apiItemState)).toBe(stateBefore);
				expect(JSON.stringify(owner.apiCache)).toBe(cacheBefore);
				expect(item.clickAction).toBeUndefined();
			});

			it("an async function gives the invalid-shape notice and is never called", async () => {
				const owner = withFunction(`async (item) => { globalThis.__clickSeen.push({}); return { kind: "command", id: "a:b" }; }`);
				const { host, row } = draw(owner, rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(calls()).toEqual([]);
				expectNothingRan(host);
				expect(noticeTexts()).toEqual(["Atlas: Click function must be synchronous (it is an async function)"]);
			});

			it("a rejected Promise return is contained: one notice, no unhandled rejection", async () => {
				const seen: unknown[] = [];
				const onUnhandled = (reason: unknown) => seen.push(reason);
				process.on("unhandledRejection", onUnhandled);
				try {
					const { host, row } = draw(withFunction(`(item) => Promise.reject(new Error("late"))`), rowItem({ noteRef: NOTE }));
					click(row);
					await flushRun();
					vi.useRealTimers();
					await new Promise((resolve) => setTimeout(resolve, 10));
					expect(seen).toEqual([]);
					expect(noticeTexts()).toHaveLength(1);
					expectNothingRan(host);
				} finally {
					process.off("unhandledRejection", onUnhandled);
				}
			});

			it("a stored source that no longer compiles (hand-edited data.json) is a notice, not an exception", async () => {
				const { host, row } = draw(withFunction("(item) => {"), rowItem({ noteRef: NOTE }));
				expect(() => click(row)).not.toThrow();
				await flushRun();
				expectNothingRan(host);
				expect(noticeTexts()).toHaveLength(1);
			});
		});

		describe("the item the function receives (E6, E15)", () => {
			it("is { id, label, secondary, extra } and nothing else, with extra from the cached row", async () => {
				const owner = withFunction(fnReturning("undefined"), { apiCache: cache({ id: "1", label: "stale", extra: { path: "/p", n: 2 } }) });
				const { row } = draw(owner, rowItem({ label: "Docker 4.34", secondary: "v4" }));
				click(row);
				await flushRun();
				expect(calls()).toEqual([{ id: "1", label: "Docker 4.34", secondary: "v4", extra: { path: "/p", n: 2 }, keys: ["id", "label", "secondary", "extra"] }]);
			});

			it("E15: with the cache cleared, extra is {} and id/label/secondary come from the stored item state", async () => {
				const owner = withFunction(fnReturning("undefined"), { apiCache: undefined });
				const { row } = draw(owner, rowItem({ id: "7", label: "Seven", secondary: "sub" }));
				click(row);
				await flushRun();
				expect(calls()).toEqual([{ id: "7", label: "Seven", secondary: "sub", extra: {}, keys: ["id", "label", "secondary", "extra"] }]);
			});

			it("E15: secondary is undefined when the stored item has none", async () => {
				const { row } = draw(withFunction(fnReturning("undefined")), rowItem());
				click(row);
				await flushRun();
				expect(calls()[0].secondary).toBeUndefined();
			});

			it("E6: a not-found row gets extra = {}, so item.extra.path is undefined and the plan's function takes the command branch", async () => {
				const owner = withFunction(PLAN, { apiCache: cache({ id: "1", label: "Docker 4.34", extra: { path: "/stale" } }) });
				const { row } = draw(owner, rowItem({ id: "1", notFound: true, lastSeenAt: "2026-11-01T00:00:00Z" }));
				click(row);
				await flushRun();
				expect(spawnCalls).toEqual([]);
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-1");
				expect(noticeTexts()).toEqual([]);
			});

			it("E6: the source's static command still resolves as today for a not-found row when the function falls through", async () => {
				const owner = withFunction(fnReturning("undefined"), {}, { action: "run-command", command: "open -a {path}" });
				const { row } = draw(owner, rowItem({ notFound: true }));
				click(row);
				await flushRun();
				expect(apiCommand.calls).toEqual([]);
				expect(noticeTexts()).toEqual(["Atlas: Missing value for placeholder: {path}"]);
			});

			it("the function cannot change the cache by changing item.extra", async () => {
				const owner = withFunction(`(item) => { item.extra.path = "hacked"; item.label = "x"; return undefined; }`, { apiCache: cache({ id: "1", label: "L", extra: { path: "/p" } }) });
				const { row, item } = draw(owner, rowItem());
				click(row);
				await flushRun();
				expect((owner.apiCache as unknown as { rows: { extra: unknown }[] }).rows[0].extra).toEqual({ path: "/p" });
				expect(item.label).toBe("Docker 4.34");
			});
		});

		describe("precedence", () => {
			it.each(Object.keys(OVERRIDES))("an Item override of %s: the function is not called at all", async (kind) => {
				const owner = withFunction(fnReturning(`({ kind: "command", id: "from:function" })`));
				const { row } = draw(owner, rowItem({ noteRef: NOTE, clickAction: OVERRIDES[kind] }));
				click(row);
				await flushRun();
				expect(calls()).toEqual([]);
				expect(executeCommandById).not.toHaveBeenCalledWith("from:function");
			});

			it("an Item override of None: the function is not called, and nothing runs", async () => {
				const owner = withFunction(fnReturning(`({ kind: "command", id: "from:function" })`));
				const { host, row } = draw(owner, rowItem({ noteRef: NOTE, clickAction: { kind: "none" } }));
				click(row);
				press(row, "Enter");
				await flushRun();
				expect(calls()).toEqual([]);
				expectNothingRan(host);
			});

			it("with no override the function beats the source click action and the attachment", async () => {
				const owner = withFunction(fnReturning(`({ kind: "command", id: "from:function" })`), {}, { action: "run-command", command: "open -a Docker" });
				const { host, row } = draw(owner, rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("from:function");
				expect(apiCommand.calls).toEqual([]);
				expect(host.openRef).not.toHaveBeenCalled();
			});

			it("clearing the override returns the row to the function", async () => {
				const owner = withFunction(fnReturning(`({ kind: "command", id: "from:function" })`));
				const { row, item } = draw(owner, rowItem({ clickAction: OVERRIDES.uri }));
				click(row);
				await flushRun();
				expect(calls()).toEqual([]);
				delete item.clickAction;
				await vi.advanceTimersByTimeAsync(1000);
				click(row);
				await flushRun();
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("from:function");
			});

			it("F8: a source with no Click function takes the path it always did, and the layer is skipped", async () => {
				const { host, row } = draw(withFunction(undefined), rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
				expect(noticeTexts()).toEqual([]);
			});

			it("F8: an empty stored function counts as no function", async () => {
				const { host, row } = draw(withFunction(""), rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
			});
		});

		describe("only API sources get the function", () => {
			const csv = { path: "a.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } as never;
			const table = { path: "a.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } as never;
			it.each([
				["CSV", () => folderGovernor({ apiSource: undefined, csvSource: csv })],
				["Table", () => folderGovernor({ apiSource: undefined, markdownTableSource: table })],
			])("a %s row never calls a function and still opens its attachment as before", async (_label, makeOwner) => {
				const { host, row } = draw(makeOwner(), rowItem({ noteRef: NOTE }));
				click(row);
				await flushRun();
				expect(calls()).toEqual([]);
				expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
				expect(noticeTexts()).toEqual([]);
			});
		});

		describe("E9: the debounce runs before evaluation", () => {
			it("two rapid clicks on the same item call the function once", async () => {
				const { row } = draw(withFunction(fnReturning(`({ kind: "command", id: "a:b" })`)), rowItem());
				click(row);
				await flushRun();
				await vi.advanceTimersByTimeAsync(500);
				click(row);
				await flushRun();
				expect(calls()).toHaveLength(1);
				expect(executeCommandById).toHaveBeenCalledTimes(1);
			});

			it("a click 1 s after the start of the previous one calls it again", async () => {
				const { row } = draw(withFunction(fnReturning(`({ kind: "command", id: "a:b" })`)), rowItem());
				click(row);
				await flushRun();
				await vi.advanceTimersByTimeAsync(1000);
				click(row);
				await flushRun();
				expect(calls()).toHaveLength(2);
				expect(executeCommandById).toHaveBeenCalledTimes(2);
			});

			it("a click then Enter inside 1 s call it once", async () => {
				const { row } = draw(withFunction(fnReturning("undefined")), rowItem());
				click(row);
				press(row, "Enter");
				await flushRun();
				expect(calls()).toHaveLength(1);
			});

			it("the debounce also holds when the function falls through or returns None", async () => {
				const { row } = draw(withFunction(fnReturning(`({ kind: "none" })`)), rowItem({ noteRef: NOTE }));
				click(row);
				click(row);
				await flushRun();
				expect(calls()).toHaveLength(1);
			});

			it("a rapid failing click is not repeated as a second notice", async () => {
				const { row } = draw(withFunction(fnReturning("5")), rowItem());
				click(row);
				click(row);
				await flushRun();
				expect(noticeTexts()).toHaveLength(1);
			});

			it("two different rows do not debounce each other", async () => {
				const owner = withFunction(fnReturning(`({ kind: "command", id: "a:b" })`));
				const a = draw(owner, rowItem({ id: "a" }));
				const b = draw(owner, rowItem({ id: "b" }), a.host);
				click(a.row);
				click(b.row);
				await flushRun();
				expect(calls().map((c) => c.id)).toEqual(["a", "b"]);
			});
		});

		describe("Enter and other gestures", () => {
			it("Enter evaluates the function with the same result as a click", async () => {
				const owner = withFunction(PLAN, { apiCache: cache({ id: "docker", label: "Docker 4.34", extra: { path: "/Applications/Docker.app" } }) });
				const { row } = draw(owner, rowItem({ id: "docker" }));
				const evt = press(row, "Enter");
				await flushRun();
				expect(evt.defaultPrevented).toBe(true);
				expect(spawnCalls.map((c) => [c.executable, ...c.args])).toEqual([["open", "-a", "/Applications/Docker.app"]]);
			});

			it("Enter with an Item override never calls the function", async () => {
				const { row } = draw(withFunction(fnReturning("undefined")), rowItem({ clickAction: OVERRIDES.command }));
				press(row, "Enter");
				await flushRun();
				expect(calls()).toEqual([]);
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-docker");
			});

			it("a held Enter does not repeat the function", async () => {
				const { row } = draw(withFunction(fnReturning("undefined")), rowItem());
				press(row, "Enter", { repeat: true });
				await flushRun();
				expect(calls()).toEqual([]);
			});

			it.each([["shiftKey"], ["metaKey"], ["ctrlKey"], ["altKey"]])("a %s-click does not call the function, and carries on as it did before (opens the attachment)", async (modifier) => {
				const { host, row } = draw(withFunction(fnReturning(`({ kind: "command", id: "a:b" })`)), rowItem({ noteRef: NOTE }));
				click(row.querySelector(".atlas-row-text")!, { [modifier]: true });
				await flushRun();
				expect(calls()).toEqual([]);
				expect(executeCommandById).not.toHaveBeenCalled();
				expect(host.openRef).toHaveBeenCalledExactlyOnceWith(NOTE);
			});

			it("a click on the status dot does not call the function", async () => {
				const { row } = draw(withFunction(fnReturning(`({ kind: "command", id: "a:b" })`)), rowItem({ explicitStatusId: "doing" }));
				click(row.querySelector(".atlas-status-dot-circle")!);
				await flushRun();
				expect(calls()).toEqual([]);
				expect(executeCommandById).not.toHaveBeenCalled();
			});

			it("Enter with a modifier does not call it", async () => {
				const { row } = draw(withFunction(fnReturning("undefined")), rowItem());
				press(row, "Enter", { shiftKey: true });
				await flushRun();
				expect(calls()).toEqual([]);
			});
		});

		describe("GP10: a row a refresh adds works through the function with nothing set per item", () => {
			it.each([["merge"], ["overwrite"]] as const)("%s refresh adds New App, and clicking it runs the function's command", async (mode) => {
				const owner = apiOwner({ id: "apps", apiSource: source({ mode, clickFunction: PLAN }) });
				const views = new ViewsManager({} as App, [{ id: view.id, name: "Default", inboxMode: "view", root: [{ ...owner, apiItemState: { "1": rowItem() }, apiItemOrder: ["1"] }] }], view.id, () => {});
				const host = rig(views.getNode(view.id, "apps")!);
				(host as unknown as { plugin: { viewsManager: unknown } }).plugin.viewsManager = views;

				vi.useRealTimers();
				await new ApiSourceController().refresh(views.getNode(view.id, "apps")!, source({ mode, clickFunction: PLAN }), [], () => {}, {
					requestImpl: async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "Docker 4.34" }, { id: "new-app", name: "New App" }]) }),
				});
				vi.useFakeTimers();

				const live = views.getNode(view.id, "apps")!;
				const added = live.apiItemState!["new-app"];
				expect(added).toBeTruthy();
				expect(added.clickAction).toBeUndefined(); // nothing set by hand

				const container = document.createElement("div");
				document.body.appendChild(container);
				callRenderApiItemRow(host, added, container, view, live, 1, [live]);
				click(container.querySelector<HTMLElement>(".atlas-row-api-item")!);
				await flushRun();
				expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-new-app");
			});
		});
	});
});
