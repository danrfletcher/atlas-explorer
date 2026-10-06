import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveOutsidePath } from "../../src/folder-source-outside";
import { FolderSourceOutsideWatchers } from "../../src/folder-source-outside-watcher";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, ViewNode, unitRefKey } from "../../src/types";

/** PR-2 (G6/G9, GP5): end to end against a real temp folder and the real `fs.watch`. Events are async, so
 * these tests wait on the real debounce (about 1 s) rather than faking timers. Only the rows are
 * asserted, with the same `ViewsManager` the plugin uses. */

const WAIT_MS = 6000;

let dir: string;
let vm: ViewsManager;
let registry: FolderSourceOutsideWatchers;
let rescans: string[];

function ownerNode(): ViewNode {
	const folderSource: FolderSourceConfig = { type: "folder", location: "outside", path: "", showFiles: true, showFolders: true, mode: "merge" };
	return { id: "owner", type: "meta", label: "Invoices", children: [], folderSource };
}

function rowNames(): string[] {
	const owner = vm.getViews()[0].root[0];
	return owner.children.map((c) => (c.ref ? c.ref.path : c.id));
}

function findRow(name: string): ViewNode | undefined {
	return vm.getViews()[0].root[0].children.find((c) => c.ref?.path === name);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-live-"));
	fs.writeFileSync(path.join(dir, "start.pdf"), "x");
	rescans = [];
	vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [ownerNode()] }], "v1", () => {});
	vm.refreshFolderSource("v1", "owner", dir);
	registry = new FolderSourceOutsideWatchers({
		isResolved: (p) => resolveOutsidePath(p),
		onRescan: (nodeId) => {
			rescans.push(nodeId);
			vm.refreshFolderSource("v1", nodeId, dir);
		},
	});
	registry.sync(new Map([["owner", dir]]));
});

afterEach(() => {
	registry.closeAll();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("outside folder live refresh, end to end (GP5)", () => {
	it("a new PDF dropped into the folder appears as a row within about two seconds", async () => {
		const started = Date.now();
		fs.writeFileSync(path.join(dir, "new.pdf"), "x");

		await vi.waitFor(() => expect(rowNames()).toContain("new.pdf"), { timeout: WAIT_MS });
		expect(Date.now() - started).toBeLessThan(3000);
	}, WAIT_MS + 2000);

	it("a rename keeps the same row and follows the new name", async () => {
		fs.writeFileSync(path.join(dir, "old.pdf"), "x");
		await vi.waitFor(() => expect(rowNames()).toContain("old.pdf"), { timeout: WAIT_MS });
		const row = findRow("old.pdf");

		fs.renameSync(path.join(dir, "old.pdf"), path.join(dir, "renamed.pdf"));

		await vi.waitFor(() => expect(rowNames()).toContain("renamed.pdf"), { timeout: WAIT_MS });
		expect(findRow("renamed.pdf")).toBe(row);
		expect(rowNames()).not.toContain("old.pdf");
	}, WAIT_MS * 2 + 2000);

	it("a deleted file is demoted to a merge placeholder, and the row is gone", async () => {
		fs.writeFileSync(path.join(dir, "gone.pdf"), "x");
		await vi.waitFor(() => expect(rowNames()).toContain("gone.pdf"), { timeout: WAIT_MS });

		fs.rmSync(path.join(dir, "gone.pdf"));

		await vi.waitFor(() => expect(rowNames()).not.toContain("gone.pdf"), { timeout: WAIT_MS });
		const owner = vm.getViews()[0].root[0];
		expect(owner.apiItemState?.[unitRefKey({ kind: "file", path: "gone.pdf" })]?.notFound).toBe(true);
	}, WAIT_MS * 2 + 2000);

	it("two sources on the same folder share one watcher and each rescans once for one change", async () => {
		const second: ViewNode = { ...ownerNode(), id: "owner-2" };
		vm.getViews()[0].root.push(second);
		registry.sync(
			new Map([
				["owner", dir],
				["owner-2", dir],
			])
		);
		fs.writeFileSync(path.join(dir, "shared.pdf"), "x");

		await vi.waitFor(() => expect(rescans.length).toBe(2), { timeout: WAIT_MS });
		expect([...rescans].sort()).toEqual(["owner", "owner-2"]);
	}, WAIT_MS + 2000);
});

describe("outside folder live refresh — what must never trigger a rescan", () => {
	it("a change below the direct children (an ancestor of a vault, E7) does not rescan", async () => {
		fs.mkdirSync(path.join(dir, "Vault"));
		await new Promise((resolve) => setTimeout(resolve, 1500));
		rescans.length = 0;
		fs.writeFileSync(path.join(dir, "Vault", "deep.md"), "x");
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(rescans).toEqual([]);
	}, 10000);

	it("editing an existing file fires an event, but the listing is unchanged, so nothing is saved", async () => {
		fs.writeFileSync(path.join(dir, "keep.pdf"), "x");
		await vi.waitFor(() => expect(rowNames()).toContain("keep.pdf"), { timeout: WAIT_MS });
		const persist = vi.fn();
		vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [ownerNode()] }], "v1", persist);
		vm.refreshFolderSource("v1", "owner", dir);
		persist.mockClear();
		rescans.length = 0;

		fs.writeFileSync(path.join(dir, "keep.pdf"), "edited");

		await vi.waitFor(() => expect(rescans).toEqual(["owner"]), { timeout: WAIT_MS });
		expect(persist).not.toHaveBeenCalled();
	}, WAIT_MS + 2000);
});
