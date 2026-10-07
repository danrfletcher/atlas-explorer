import { App } from "obsidian";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ViewsManager } from "../../src/views";
import { View, ViewNode } from "../../src/types";

/** PR-1 (R1): an unchanged Outside-Vault refresh must still notify change listeners so the explorer
 * re-renders (unplugged drive, reconnected drive with the same contents), while writing nothing. */
describe("PR-1 (R1): refreshFolderSource notifies listeners without writing when nothing changed", () => {
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

	it("a refresh that finds the same contents writes nothing but still notifies", () => {
		const { viewsManager, persist, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", dir);
		persist.mockClear();
		listener.mockClear();

		viewsManager.refreshFolderSource("v1", "src", dir);

		expect(persist).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("an unplugged drive writes nothing but still notifies, so the explorer re-renders its state", () => {
		const { viewsManager, persist, listener } = setup();
		viewsManager.refreshFolderSource("v1", "src", dir);
		persist.mockClear();
		listener.mockClear();

		viewsManager.refreshFolderSource("v1", "src", path.join(dir, "not-plugged-in"));

		expect(persist).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(viewsManager.getNode("v1", "src")?.children.map((child) => child.ref?.path)).toEqual(["a.md"]);
	});
});
