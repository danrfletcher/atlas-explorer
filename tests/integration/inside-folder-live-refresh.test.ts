import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AtlasPlugin from "../../src/main";
import { FolderLiveRefresh } from "../../src/folder-live-refresh";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, View, ViewNode } from "../../src/types";

/** PR-1 (G5, E1, E2, E4-E6): the live trigger for Inside-Vault Folder sources. Drives the real
 * `AtlasPlugin` vault handlers against a real `ViewsManager` and a fake vault, with fake timers only —
 * no real elapsed time. */

/** Keeps each parent folder's `children` in step with the entries, as Obsidian's vault does, so a
 * refresh's folder listing always matches the events the test has fired. */
class FakeVault {
	private entries = new Map<string, TAbstractFile>();

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.entries.get(path) ?? null;
	}

	put(entry: TAbstractFile): void {
		this.entries.set(entry.path, entry);
		const parent = this.parentFolder(entry.path);
		if (parent && !parent.children.some((child) => child.path === entry.path)) parent.children.push(entry);
	}

	remove(path: string): void {
		this.entries.delete(path);
		const parent = this.parentFolder(path);
		if (parent) parent.children = parent.children.filter((child) => child.path !== path);
	}

	private parentFolder(path: string): TFolder | null {
		const slash = path.lastIndexOf("/");
		const parent = this.entries.get(slash === -1 ? "" : path.slice(0, slash));
		return parent instanceof TFolder ? parent : null;
	}
}

function fileAt(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	return file;
}

function folderAt(path: string, children: TAbstractFile[] = []): TFolder {
	const folder = new TFolder();
	folder.path = path;
	folder.name = path.split("/").pop() ?? path;
	folder.children = children;
	return folder;
}

function sourceNode(id: string, path: string, overrides: Partial<FolderSourceConfig> = {}): ViewNode {
	return {
		id,
		type: "meta",
		label: id,
		children: [],
		folderSource: { location: "inside", path, showFiles: true, showFolders: true, ...overrides },
	};
}

/** The source's state with generated ids and wall-clock stamps stripped, so two independently built
 * trees compare equal. */
function snapshot(node: ViewNode | null): string {
	return JSON.stringify(node, (key, value) =>
		key === "id" || key === "folderSourceOwnerId" || key === "lastSeenAt" ? undefined : value
	);
}

interface Harness {
	plugin: AtlasPlugin;
	vault: FakeVault;
	viewsManager: ViewsManager;
	refreshSpy: ReturnType<typeof vi.spyOn>;
	renameSpy: ReturnType<typeof vi.spyOn>;
	graduation: { handleModify: ReturnType<typeof vi.fn> };
}

function setup(root: ViewNode[], entries: TAbstractFile[] = [], leafCount = 0): Harness {
	const vault = new FakeVault();
	for (const entry of entries) vault.put(entry);
	const leaves = Array.from({ length: leafCount }, () => ({ view: {} }));
	const app = { vault, workspace: { getLeavesOfType: () => leaves } } as unknown as App;
	const view: View = { id: "v1", name: "v1", root, inboxMode: "view" };
	const viewsManager = new ViewsManager(app, [view], "v1", () => {});

	const graduation = { handleDelete: vi.fn(), handleRename: vi.fn(), handleModify: vi.fn(), dispose: vi.fn() };
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	Object.assign(plugin, {
		app,
		viewsManager,
		settings: { ...DEFAULT_SETTINGS, noAutoPromoteFolders: [] },
		unitIndex: { onVaultCreate: vi.fn(), onVaultDelete: vi.fn(), onVaultRename: () => false },
		graduation,
		onModuleFolderRename: () => false,
		persistDebounced: Object.assign(vi.fn(), { run: vi.fn() }),
	});
	plugin.folderLiveRefresh = new FolderLiveRefresh((nodeId) =>
		(plugin as unknown as { refreshInsideFolderSource(id: string): void }).refreshInsideFolderSource(nodeId)
	);
	const refreshSpy = vi.spyOn(viewsManager, "refreshFolderSource");
	const renameSpy = vi.spyOn(viewsManager, "onVaultRename");
	return { plugin, vault, viewsManager, refreshSpy, renameSpy, graduation };
}

/** Lets the debounce (300 ms) and max-wait (2000 ms) timers run to completion. */
function settle(): void {
	vi.advanceTimersByTime(2000);
}

function refreshedNodeIds(refreshSpy: ReturnType<typeof vi.spyOn>): string[] {
	return refreshSpy.mock.calls.map((call) => call[1] as string);
}

describe("PR-1 (G5): inside-vault live trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("which events trigger a refresh", () => {
		const clients = () => folderAt("Projects/Clients");

		it("a file created directly in the source folder refreshes it", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
		});

		it("a file deleted directly from the source folder refreshes it", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultDeleteEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
		});

		it("a rename whose old path is a direct child refreshes it", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultRenameEvent(fileAt("Projects/Clients/Hartley Haulage.md"), "Projects/Clients/Hartley.md");
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
		});

		it("a rename whose new path is a direct child refreshes it (a move in)", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultRenameEvent(fileAt("Projects/Clients/Hartley.md"), "Archive/Hartley.md");
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
		});

		it("a grandchild, a sibling and an unrelated folder do not trigger", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Deep/Grand.md"));
			plugin.onVaultCreateEvent(fileAt("Projects/Other.md"));
			plugin.onVaultDeleteEvent(fileAt("Unrelated/Note.md"));
			plugin.onVaultRenameEvent(fileAt("Projects/Other/Moved.md"), "Elsewhere/Moved.md");
			settle();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("the match is case-sensitive, like isExcluded", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultCreateEvent(fileAt("projects/clients/Lower.md"));
			settle();
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		it("a content edit (modify) of a child does not trigger a refresh", () => {
			const { plugin, refreshSpy, graduation } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultModifyEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();
			expect(graduation.handleModify).toHaveBeenCalledTimes(1);
			expect(refreshSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("the refresh is queued after viewsManager.onVaultRename, never inline", () => {
			const { plugin, refreshSpy, renameSpy } = setup([sourceNode("src", "Projects/Clients")], [clients()]);
			plugin.onVaultRenameEvent(fileAt("Projects/Clients/New.md"), "Projects/Clients/Old.md");
			expect(refreshSpy).not.toHaveBeenCalled();
			settle();
			expect(renameSpy).toHaveBeenCalledTimes(1);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(renameSpy.mock.invocationCallOrder[0]).toBeLessThan(refreshSpy.mock.invocationCallOrder[0]);
		});
	});

	describe("batching (debounce and maximum wait)", () => {
		it("fires 300 ms after the last event, not before", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [folderAt("Projects/Clients")]);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/A.md"));
			vi.advanceTimersByTime(299);
			expect(refreshSpy).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		it("a continuous stream still refreshes at the 2 s maximum wait", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [folderAt("Projects/Clients")]);
			for (let i = 0; i < 20; i++) {
				plugin.onVaultCreateEvent(fileAt(`Projects/Clients/Stream${i}.md`));
				vi.advanceTimersByTime(100);
			}
			// 20 events at 100 ms spacing never leave a 300 ms gap, so only the 2 s cap can fire.
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(5000);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		it("E5: a bulk move of 500 files into the source folder refreshes once, not 500 times", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [folderAt("Projects/Clients")]);
			for (let i = 0; i < 500; i++) plugin.onVaultRenameEvent(fileAt(`Projects/Clients/Bulk${i}.md`), `Inbox/Bulk${i}.md`);
			settle();
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("which sources a trigger reaches", () => {
		it("E4: two sources on the same folder are each refreshed once by one vault change", () => {
			const { plugin, refreshSpy } = setup(
				[sourceNode("src1", "Projects/Clients"), sourceNode("src2", "Projects/Clients")],
				[folderAt("Projects/Clients")]
			);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy).sort()).toEqual(["src1", "src2"]);
		});

		it("E6: nested sources A and A/B each refresh only for their own direct children", () => {
			const { plugin, refreshSpy } = setup(
				[sourceNode("a", "A"), sourceNode("b", "A/B")],
				[folderAt("A", [folderAt("A/B")]), folderAt("A/B")]
			);
			plugin.onVaultCreateEvent(fileAt("A/B/x.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["b"]);

			plugin.onVaultCreateEvent(fileAt("A/y.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["b", "a"]);
		});

		it("the live trigger is limited to the active view, like every other source refresh", () => {
			const { plugin, refreshSpy, viewsManager } = setup([sourceNode("src", "Projects/Clients")], [folderAt("Projects/Clients")]);
			const ids = viewsManager.getInsideFolderSourceNodeIds("missing-view", new Set(["Projects/Clients"]));
			expect(ids).toEqual([]);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
		});

		it("with two Atlas leaves open, one vault change refreshes a source once", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [folderAt("Projects/Clients")], 2);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("edge cases", () => {
		it("E1: after the source folder is renamed, the trigger follows the new path", () => {
			const { plugin, refreshSpy, viewsManager } = setup(
				[sourceNode("src", "Projects/Clients")],
				[folderAt("Projects/Clients2", [fileAt("Projects/Clients2/Old.md")])]
			);
			plugin.onVaultRenameEvent(folderAt("Projects/Clients2"), "Projects/Clients");
			settle();
			expect(viewsManager.getNode("v1", "src")?.folderSource?.path).toBe("Projects/Clients2");
			expect(refreshSpy).not.toHaveBeenCalled();

			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Stale.md"));
			settle();
			expect(refreshSpy).not.toHaveBeenCalled();

			plugin.onVaultCreateEvent(fileAt("Projects/Clients2/New.md"));
			settle();
			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
		});

		it("E2: deleting the source folder refreshes exactly once, with no repeat", () => {
			const child = fileAt("Projects/Clients/Hartley.md");
			const { plugin, refreshSpy, vault, viewsManager } = setup(
				[sourceNode("src", "Projects/Clients")],
				[folderAt("Projects/Clients", [child])]
			);
			viewsManager.refreshFolderSource("v1", "src");
			refreshSpy.mockClear();

			vault.remove("Projects/Clients/Hartley.md");
			plugin.onVaultDeleteEvent(child);
			vault.remove("Projects/Clients");
			plugin.onVaultDeleteEvent(folderAt("Projects/Clients"));
			settle();
			vi.advanceTimersByTime(60_000);

			expect(refreshedNodeIds(refreshSpy)).toEqual(["src"]);
			expect(viewsManager.getNode("v1", "src")).not.toBeNull();
		});

		it("unloading the plugin cancels pending debounce timers: nothing fires after onunload", () => {
			const { plugin, refreshSpy } = setup([sourceNode("src", "Projects/Clients")], [folderAt("Projects/Clients")]);
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Hartley.md"));
			plugin.onunload();
			settle();
			expect(refreshSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("move-out of the source folder", () => {
		/** The state a source is in after its first refresh, with `Old.md` as a managed row. */
		function populated(mode: "merge" | "append" | "overwrite") {
			const old = fileAt("Projects/Clients/Old.md");
			const harness = setup(
				[sourceNode("src", "Projects/Clients", { mode })],
				[folderAt("Projects/Clients", [old])]
			);
			harness.viewsManager.refreshFolderSource("v1", "src");
			harness.refreshSpy.mockClear();
			return { ...harness, old };
		}

		for (const mode of ["merge", "append", "overwrite"] as const) {
			it(`${mode}: a file moved out leaves the source exactly as a delete does`, () => {
				const deleted = populated(mode);
				deleted.vault.remove("Projects/Clients/Old.md");
				deleted.plugin.onVaultDeleteEvent(deleted.old);
				settle();
				const afterDelete = snapshot(deleted.viewsManager.getNode("v1", "src"));

				const movedOut = populated(mode);
				movedOut.vault.remove("Projects/Clients/Old.md");
				movedOut.plugin.onVaultRenameEvent(fileAt("Archive/Old.md"), "Projects/Clients/Old.md");
				settle();
				const afterMoveOut = snapshot(movedOut.viewsManager.getNode("v1", "src"));

				expect(afterMoveOut).toBe(afterDelete);
			});
		}

		it("R2: renaming the source folder keeps a child's row when the child's event arrives first", () => {
			const { plugin, vault, viewsManager, refreshSpy, old } = populated("merge");
			const source = viewsManager.getNode("v1", "src");
			const child = source?.children[0];
			if (!child) throw new Error("expected a managed child row");
			child.explicitStatusId = "status-kept";
			const childId = child.id;

			// The folder is renamed on disk: the child's event arrives before the folder's own event.
			const renamedChild = fileAt("Projects/Clients2/Old.md");
			vault.remove("Projects/Clients/Old.md");
			vault.remove("Projects/Clients");
			vault.put(folderAt("Projects/Clients2", [renamedChild]));
			plugin.onVaultRenameEvent(renamedChild, old.path);
			plugin.onVaultRenameEvent(folderAt("Projects/Clients2"), "Projects/Clients");
			settle();

			const after = viewsManager.getNode("v1", "src");
			expect(after?.folderSource?.path).toBe("Projects/Clients2");
			expect(after?.children).toHaveLength(1);
			expect(after?.children[0].id).toBe(childId);
			expect(after?.children[0].explicitStatusId).toBe("status-kept");
			expect(after?.children[0].ref?.path).toBe("Projects/Clients2/Old.md");
			expect(refreshSpy).toHaveBeenCalled();
		});

		it("a file renamed within the source folder stays a row, with its ref rewritten", () => {
			const { plugin, vault, viewsManager, old } = populated("merge");
			vault.remove("Projects/Clients/Old.md");
			vault.put(fileAt("Projects/Clients/New.md"));
			plugin.onVaultRenameEvent(fileAt("Projects/Clients/New.md"), old.path);
			settle();
			const source = viewsManager.getNode("v1", "src");
			expect(source?.children.map((child) => child.ref?.path)).toEqual(["Projects/Clients/New.md"]);
		});
	});

	describe("refresh writes", () => {
		it("F2: a live refresh that finds nothing new does not save", () => {
			const { plugin, viewsManager, refreshSpy } = setup(
				[sourceNode("src", "Projects/Clients")],
				[folderAt("Projects/Clients", [fileAt("Projects/Clients/Hartley.md")])]
			);
			viewsManager.refreshFolderSource("v1", "src");
			const save = vi.spyOn(viewsManager as unknown as { save: () => void }, "save");
			refreshSpy.mockClear();

			// A matching event that changes nothing on disk: the refresh runs, but finds Hartley.md already a row.
			plugin.onVaultCreateEvent(fileAt("Projects/Clients/Hartley.md"));
			settle();

			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(save).not.toHaveBeenCalled();
		});
	});
});
