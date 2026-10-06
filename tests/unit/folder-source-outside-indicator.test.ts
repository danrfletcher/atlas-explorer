import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AtlasExplorerView } from "../../src/explorer-view";
import { resolveOutsidePath } from "../../src/folder-source-outside";
import { View, ViewNode } from "../../src/types";
import { meta } from "../integration/create-from-meta-fixtures";

/** Mirrors exactly what `renderNode` computes for the explorer row's dot class (`src/explorer-view.ts`,
 * the `node.folderSource?.location === "outside"` block) — kept as its own tiny helper here rather than
 * duplicating a full `renderNode` DOM harness, since the dot's entire contract is "this one boolean,
 * recomputed fresh". */
function dotClassFor(outsidePath: string): "green" | "red" {
	return resolveOutsidePath(outsidePath) ? "green" : "red";
}

const proto = AtlasExplorerView.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function folderMeta(id: string, folderSource: Partial<ViewNode["folderSource"]> & { location: "inside" | "outside" }, children: ViewNode[] = []): ViewNode {
	const node = meta(id, "Folder");
	node.children = children;
	node.folderSource = {
		path: "",
		showFiles: true,
		showFolders: true,
		refreshOnViewLoad: false,
		...folderSource,
	};
	return node;
}

describe("G11/F10 — recheck-on-load rule: Outside-Vault's check is unconditional, independent of the refreshOnViewLoad toggle", () => {
	it("an Outside-Vault source with refreshOnViewLoad OFF is still refreshed on view load", () => {
		const outside = folderMeta("outside-off", { location: "outside", refreshOnViewLoad: false });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [outside] };
		const refreshFolderSource = vi.fn();
		const fake = {
			plugin: { viewsManager: { getActiveView: () => view } },
			collectApiSourceNodes: proto.collectApiSourceNodes,
			collectFolderSourceNodes: proto.collectFolderSourceNodes,
			collectCsvSourceNodes: proto.collectCsvSourceNodes,
			collectMarkdownTableSourceNodes: proto.collectMarkdownTableSourceNodes,
			refreshApiSource: vi.fn(),
			refreshFolderSource,
			refreshCsvSource: vi.fn(),
			refreshMarkdownTableSource: vi.fn(),
		};

		proto.refreshApiSourcesOnViewLoad.call(fake);

		expect(refreshFolderSource).toHaveBeenCalledWith(view, outside);
	});

	it("an Inside-Vault source is refreshed on view load with no toggle (PR-1 G4: the toggle is gone)", () => {
		const inside = folderMeta("inside-off", { location: "inside" });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [inside] };
		const refreshFolderSource = vi.fn();
		const fake = {
			plugin: { viewsManager: { getActiveView: () => view } },
			collectApiSourceNodes: proto.collectApiSourceNodes,
			collectFolderSourceNodes: proto.collectFolderSourceNodes,
			collectCsvSourceNodes: proto.collectCsvSourceNodes,
			collectMarkdownTableSourceNodes: proto.collectMarkdownTableSourceNodes,
			refreshApiSource: vi.fn(),
			refreshFolderSource,
			refreshCsvSource: vi.fn(),
			refreshMarkdownTableSource: vi.fn(),
		};

		proto.refreshApiSourcesOnViewLoad.call(fake);

		expect(refreshFolderSource).toHaveBeenCalledWith(view, inside);
	});

	it("an Inside-Vault source is refreshed on view load regardless of any legacy refreshOnViewLoad value", () => {
		const inside = folderMeta("inside-on", { location: "inside", refreshOnViewLoad: true } as never);
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [inside] };
		const refreshFolderSource = vi.fn();
		const fake = {
			plugin: { viewsManager: { getActiveView: () => view } },
			collectApiSourceNodes: proto.collectApiSourceNodes,
			collectFolderSourceNodes: proto.collectFolderSourceNodes,
			collectCsvSourceNodes: proto.collectCsvSourceNodes,
			collectMarkdownTableSourceNodes: proto.collectMarkdownTableSourceNodes,
			refreshApiSource: vi.fn(),
			refreshFolderSource,
			refreshCsvSource: vi.fn(),
			refreshMarkdownTableSource: vi.fn(),
		};

		proto.refreshApiSourcesOnViewLoad.call(fake);

		expect(refreshFolderSource).toHaveBeenCalledWith(view, inside);
	});
});

describe("G11/F10 — recheck-on-focus-regain rule", () => {
	it("refreshOutsideFolderSourcesOnFocus refreshes every Outside-Vault source in the active view", () => {
		const outsideA = folderMeta("outside-a", { location: "outside" });
		const outsideB = folderMeta("outside-b", { location: "outside" });
		const inside = folderMeta("inside", { location: "inside" });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [outsideA, inside, outsideB] };
		const refreshFolderSource = vi.fn();
		const fake = {
			plugin: { viewsManager: { getActiveView: () => view } },
			collectFolderSourceNodes: proto.collectFolderSourceNodes,
			refreshFolderSource,
		};

		proto.refreshOutsideFolderSourcesOnFocus.call(fake);

		expect(refreshFolderSource).toHaveBeenCalledTimes(2);
		expect(refreshFolderSource).toHaveBeenCalledWith(view, outsideA);
		expect(refreshFolderSource).toHaveBeenCalledWith(view, outsideB);
		expect(refreshFolderSource).not.toHaveBeenCalledWith(view, inside);
	});

	it("onOpen wires the window 'focus' event to refreshOutsideFolderSourcesOnFocus (not any other event)", async () => {
		const registerDomEvent = vi.fn();
		const refreshOutsideFolderSourcesOnFocus = vi.fn();
		const fake = {
			unsubscribers: [],
			plugin: {
				unitIndex: { onChange: vi.fn() },
				viewsManager: { onChange: vi.fn() },
				app: { workspace: { on: vi.fn() } },
			},
			queueRender: vi.fn(),
			updateActiveHighlight: vi.fn(),
			viewLoadTrigger: { activate: () => false, deactivate: vi.fn() },
			leaf: {},
			registerEvent: vi.fn(),
			registerDomEvent,
			refreshApiSourcesOnViewLoad: vi.fn(),
			refreshOutsideFolderSourcesOnFocus,
			render: vi.fn(),
		};

		await proto.onOpen.call(fake);

		const focusCall = registerDomEvent.mock.calls.find((call) => call[0] === window && call[1] === "focus");
		expect(focusCall).toBeTruthy();
		focusCall![2]();
		expect(refreshOutsideFolderSourcesOnFocus).toHaveBeenCalledTimes(1);
	});
});

describe("G11/F10 — no-background-timer rule (indicator-adjacent spot check; full static sweep lives in the F10 fence test)", () => {
	const root = join(__dirname, "../..");
	const read = (rel: string) => readFileSync(join(root, rel), "utf8");
	const TIMER_CONSTRUCT = /\b(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|FileSystemWatcher|fs\.watch)\b/;

	it("the indicator-rendering code in explorer-view.ts's renderNode has no timer/poll construct", () => {
		const src = read("src/explorer-view.ts");
		const start = src.indexOf('if (node.folderSource?.location === "outside") {');
		expect(start).toBeGreaterThanOrEqual(0);
		const end = src.indexOf("\n\t\t\t}", start);
		expect(end).toBeGreaterThan(start);
		expect(src.slice(start, end)).not.toMatch(TIMER_CONSTRUCT);
	});

	it("the indicator-rendering code in api-source-modal.ts's renderOutsidePathField has no timer/poll construct", () => {
		const src = read("src/api-source-modal.ts");
		const start = src.indexOf("private renderOutsidePathField(contentEl: HTMLElement): void {");
		expect(start).toBeGreaterThanOrEqual(0);
		const end = src.indexOf("\n\t}", start);
		expect(end).toBeGreaterThan(start);
		expect(src.slice(start, end)).not.toMatch(TIMER_CONSTRUCT);
	});
});

describe("G6/G11 — red/green state-transition rule: the explorer row's dot recomputes fresh against the real filesystem, no cached state", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-indicator-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("a ViewNode carries no cached connection field at all — the dot is never anything but a live recompute", () => {
		const outsideNode = folderMeta("outside-x", { location: "outside" });
		expect(outsideNode).not.toHaveProperty("connectionResolved");
		expect(outsideNode).not.toHaveProperty("isConnected");
		expect(outsideNode).not.toHaveProperty("outsideConnected");
	});

	it("transitions green -> red -> green as the same path is removed and recreated on disk, with no call needed beyond re-checking", () => {
		expect(dotClassFor(tmpDir)).toBe("green");

		fs.rmSync(tmpDir, { recursive: true, force: true });
		expect(dotClassFor(tmpDir)).toBe("red");

		fs.mkdirSync(tmpDir);
		expect(dotClassFor(tmpDir)).toBe("green");
	});

	it("an empty/never-configured path renders red, same as any other unresolved path", () => {
		expect(dotClassFor("")).toBe("red");
	});
});
