import { App } from "obsidian";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ViewsManager } from "../../src/views";
import { View, ViewNode } from "../../src/types";

/** PR-2 (S3, narrowing PR-1 R1): an Outside-Vault refresh that finds the same contents and the same
 * connection state notifies nobody and writes nothing. The one change it notifies for without a write
 * is the drive being unplugged or reconnected (whether the path resolves), which the explorer shows. */
describe("PR-2 (S3): refreshFolderSource notifies only when something changed", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-"));
		fs.writeFileSync(path.join(dir, "a.md"), "");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function setup() {
		const source: ViewNode = {
			id: "src",
			type: "meta",
			label: "src",
			children: [],
			folderSource: { location: "outside", path: "", showFiles: true, showFolders: true },
		};
		const view: View = { id: "v1", name: "v1", root: [source], inboxMode: "view" };
		const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;
		const persist = vi.fn();
		const viewsManager = new ViewsManager(app, [view], "v1", persist);
		const listener = vi.fn();
		viewsManager.onChange(listener);
		return { viewsManager, persist, listener };
	}

	it("a first refresh that adds children persists and notifies once", () => {
		const { viewsManager, persist, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", dir);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("a refresh that finds the same contents and the same connection writes nothing and does not notify", () => {
		const { viewsManager, persist, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", dir);
		persist.mockClear();
		listener.mockClear();

		viewsManager.refreshFolderSource("v1", "src", dir);
		viewsManager.refreshFolderSource("v1", "src", dir);

		expect(persist).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
	});

	it("an unplugged drive writes nothing but notifies once, so the explorer repaints its connection state", () => {
		const { viewsManager, persist, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", dir);
		persist.mockClear();
		listener.mockClear();

		const gone = path.join(dir, "not-plugged-in");
		viewsManager.refreshFolderSource("v1", "src", gone);

		expect(persist).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(viewsManager.getNode("v1", "src")?.children.map((child) => child.ref?.path)).toEqual(["a.md"]);

		// Still unplugged: nothing about the connection moved, so nobody is told again.
		viewsManager.refreshFolderSource("v1", "src", gone);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("a reconnected drive with the same contents notifies once (resolved state flipped back)", () => {
		const { viewsManager, persist, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", dir);
		viewsManager.refreshFolderSource("v1", "src", path.join(dir, "not-plugged-in"));
		persist.mockClear();
		listener.mockClear();

		viewsManager.refreshFolderSource("v1", "src", dir);

		expect(persist).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("a source first seen unplugged notifies once, because the pane has not been told yet", () => {
		const { viewsManager, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", path.join(dir, "not-plugged-in"));
		expect(listener).toHaveBeenCalledTimes(1);
		viewsManager.refreshFolderSource("v1", "src", path.join(dir, "not-plugged-in"));
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
