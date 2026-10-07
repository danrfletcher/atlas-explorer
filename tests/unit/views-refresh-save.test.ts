import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, ViewNode } from "../../src/types";

/** PR-2 (F2): `refreshFolderSource` saves only when the children or placeholders actually changed.
 * Every view load and every live event runs through it, so an unchanged source must cost no write. */

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-refresh-save-"));
	fs.writeFileSync(path.join(dir, "a.pdf"), "x");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function setup(mode: "merge" | "append" | "overwrite" = "merge") {
	const persist = vi.fn();
	const onChange = vi.fn();
	const folderSource: FolderSourceConfig = { type: "folder", location: "outside", path: "", showFiles: true, showFolders: true, mode };
	const owner: ViewNode = { id: "owner", type: "meta", label: "Invoices", children: [], folderSource };
	const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", persist);
	vm.onChange(onChange);
	return { vm, persist, onChange };
}

describe("refreshFolderSource saves only on a real change (F2)", () => {
	it("first listing saves once, then an unchanged listing saves nothing", () => {
		const { vm, persist, onChange } = setup();

		vm.refreshFolderSource("v1", "owner", dir);
		expect(persist).toHaveBeenCalledTimes(1);

		persist.mockClear();
		onChange.mockClear();
		vm.refreshFolderSource("v1", "owner", dir);
		vm.refreshFolderSource("v1", "owner", dir);
		expect(persist).not.toHaveBeenCalled();
		// Still re-renders on every refresh, so an unchanged source is never stale on screen.
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("a new file saves once", () => {
		const { vm, persist } = setup();
		vm.refreshFolderSource("v1", "owner", dir);
		persist.mockClear();

		fs.writeFileSync(path.join(dir, "new.pdf"), "x");
		vm.refreshFolderSource("v1", "owner", dir);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("a deleted file saves once, because its placeholder changed", () => {
		const { vm, persist } = setup("merge");
		vm.refreshFolderSource("v1", "owner", dir);
		persist.mockClear();

		fs.rmSync(path.join(dir, "a.pdf"));
		vm.refreshFolderSource("v1", "owner", dir);
		expect(persist).toHaveBeenCalledTimes(1);
		persist.mockClear();

		vm.refreshFolderSource("v1", "owner", dir);
		expect(persist).not.toHaveBeenCalled();
	});

	it("an unresolved path changes nothing and saves nothing", () => {
		const { vm, persist } = setup();
		vm.refreshFolderSource("v1", "owner", dir);
		persist.mockClear();

		vm.refreshFolderSource("v1", "owner", path.join(dir, "gone"));
		expect(persist).not.toHaveBeenCalled();
	});
});
