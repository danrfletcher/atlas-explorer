import { describe, expect, it, vi } from "vitest";
import { FolderSourcePathStore } from "../../src/folder-source-path-store";

/** PR-3/PR-5 precedent: isolates `explorer-view.ts`'s wiring from the real modal's own
 * rendering/validation (already covered in `tests/unit/api-source-modal-outside-vault.test.ts`), same
 * as `tests/unit/explorer-view.test.ts` does for the API-source path. */
vi.mock("../../src/api-source-modal", () => {
	class FakeApiSourceModal {
		static instances: FakeApiSourceModal[] = [];
		onSave: (result: unknown) => void;
		open = vi.fn();
		constructor(
			public app: unknown,
			public initial: unknown,
			public headers: unknown,
			onSave: (result: unknown) => void,
			public initialFolderSource: unknown,
			public initialOutsidePath: unknown
		) {
			this.onSave = onSave;
			FakeApiSourceModal.instances.push(this);
		}
	}
	return { ApiSourceModal: FakeApiSourceModal };
});

import { ApiSourceModal } from "../../src/api-source-modal";
import { AtlasExplorerView } from "../../src/explorer-view";
import { View, ViewNode } from "../../src/types";
import { meta } from "../integration/create-from-meta-fixtures";

const FakeApiSourceModal = ApiSourceModal as unknown as {
	instances: { onSave: (result: unknown) => void; initialOutsidePath: unknown }[];
};

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

function openApiSourceModal(node: ViewNode, plugin: Record<string, unknown>) {
	const refreshFolderSource = vi.fn();
	const refreshApiSource = vi.fn();
	(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
		{ plugin, refreshFolderSource, refreshApiSource },
		view,
		node
	);
	return { refreshFolderSource, refreshApiSource };
}

/** In-memory stand-in for Obsidian's real per-device `loadLocalStorage`/`saveLocalStorage` — same
 * fixture shape as `tests/integration/api-source-storage.test.ts`'s `FakeLocalStorageHost` for
 * `ApiHeadersStore`, reused here for `FolderSourcePathStore` (G6/F6: a second, independent
 * device-local store, never sharing a storage key with the headers one). */
class FakeLocalStorageHost {
	private store = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.store.get(key) ?? null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		this.store.set(key, data);
	}
}

describe("FolderSourcePathStore — G6/F6: device-local-storage rule", () => {
	it("round-trips a path for a given node id", () => {
		const store = new FolderSourcePathStore(new FakeLocalStorageHost());
		store.set("node-a", "/Volumes/External/Notes");
		expect(store.get("node-a")).toBe("/Volumes/External/Notes");
	});

	it("returns an empty string for a node with no path set", () => {
		const store = new FolderSourcePathStore(new FakeLocalStorageHost());
		expect(store.get("unknown")).toBe("");
	});

	it("keeps paths isolated per node — setting one node's path never leaks into another's", () => {
		const store = new FolderSourcePathStore(new FakeLocalStorageHost());
		store.set("node-a", "/Volumes/A");
		store.set("node-b", "/Volumes/B");
		expect(store.get("node-a")).toBe("/Volumes/A");
		expect(store.get("node-b")).toBe("/Volumes/B");
	});

	it("delete removes exactly that node's entry, leaving others untouched", () => {
		const store = new FolderSourcePathStore(new FakeLocalStorageHost());
		store.set("node-a", "/Volumes/A");
		store.set("node-b", "/Volumes/B");
		store.delete("node-a");
		expect(store.get("node-a")).toBe("");
		expect(store.get("node-b")).toBe("/Volumes/B");
	});

	it("deleting a node with no entry is a no-op, not an error", () => {
		const store = new FolderSourcePathStore(new FakeLocalStorageHost());
		expect(() => store.delete("unknown")).not.toThrow();
	});

	it("uses its own storage key, distinct from ApiHeadersStore's — the two stores never collide", () => {
		const host = new FakeLocalStorageHost();
		const saveSpy = host.saveLocalStorage.bind(host);
		const keys: string[] = [];
		host.saveLocalStorage = (key, data) => {
			keys.push(key);
			saveSpy(key, data);
		};
		const pathStore = new FolderSourcePathStore(host);
		pathStore.set("node-a", "/Volumes/A");
		expect(keys).toEqual(["atlas-folder-source-outside-paths"]);
	});
});

describe("FolderSourcePathStore — F6: no-cross-device-inheritance rule", () => {
	it("two independent host instances (simulating two devices sharing a synced vault) never inherit or overwrite each other's stored path", () => {
		const deviceOne = new FolderSourcePathStore(new FakeLocalStorageHost());
		const deviceTwo = new FolderSourcePathStore(new FakeLocalStorageHost());

		deviceOne.set("node-a", "/Users/alice/External/Notes");
		expect(deviceTwo.get("node-a")).toBe("");

		deviceTwo.set("node-a", "/Volumes/BobDrive/Notes");
		expect(deviceOne.get("node-a")).toBe("/Users/alice/External/Notes");
		expect(deviceTwo.get("node-a")).toBe("/Volumes/BobDrive/Notes");
	});

	it("F6: a resolved path on one device and an unresolved one on another is never 'fixed' by either side — each device's own store stays exactly as set", () => {
		const deviceOne = new FolderSourcePathStore(new FakeLocalStorageHost());
		const deviceTwo = new FolderSourcePathStore(new FakeLocalStorageHost());

		deviceOne.set("node-a", "/Volumes/ExternalDrive/Notes");
		// Device two never had this drive attached — its store simply has no entry, not a copy/warning.
		expect(deviceTwo.get("node-a")).toBe("");
		expect(deviceOne.get("node-a")).toBe("/Volumes/ExternalDrive/Notes");
	});
});

describe("openApiSourceModal — G6 acceptance: path-cleared-on-mode-toggle rule", () => {
	it("saving a result with location 'outside' and a non-empty outsidePath stores it device-local", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn(), setApiSource: vi.fn() };
		const plugin = { app: {}, apiHeadersStore: { get: vi.fn(() => []), set: vi.fn() }, viewsManager, folderSourcePathStore };

		openApiSourceModal(node, plugin);
		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({
			type: "folder",
			source: { location: "outside", path: "", showFiles: true, showFolders: true },
			outsidePath: "/Volumes/External/Notes",
		});

		expect(folderSourcePathStore.set).toHaveBeenCalledWith(node.id, "/Volumes/External/Notes");
		expect(folderSourcePathStore.delete).not.toHaveBeenCalled();
	});

	it("saving a result with location 'inside' clears any previously stored outside path (toggle Outside -> Inside)", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		const folderSourcePathStore = { get: vi.fn(() => "/Volumes/External/Notes"), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn(), setApiSource: vi.fn() };
		const plugin = { app: {}, apiHeadersStore: { get: vi.fn(() => []), set: vi.fn() }, viewsManager, folderSourcePathStore };

		openApiSourceModal(node, plugin);
		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({
			type: "folder",
			source: { location: "inside", path: "Projects/Active", showFiles: true, showFolders: true },
			outsidePath: "",
		});

		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(node.id);
		expect(folderSourcePathStore.set).not.toHaveBeenCalled();
	});

	it("saving a result with location 'outside' but a blank outsidePath (cleared field) also clears the stored entry rather than storing blank", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		const folderSourcePathStore = { get: vi.fn(() => "/Volumes/External/Notes"), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn(), setApiSource: vi.fn() };
		const plugin = { app: {}, apiHeadersStore: { get: vi.fn(() => []), set: vi.fn() }, viewsManager, folderSourcePathStore };

		openApiSourceModal(node, plugin);
		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({
			type: "folder",
			source: { location: "outside", path: "", showFiles: true, showFolders: true },
			outsidePath: "",
		});

		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(node.id);
		expect(folderSourcePathStore.set).not.toHaveBeenCalled();
	});

	it("opening the modal reads the node's current device-local path to pass in as the initial value", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		const folderSourcePathStore = { get: vi.fn(() => "/Volumes/External/Notes"), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn(), setApiSource: vi.fn() };
		const plugin = { app: {}, apiHeadersStore: { get: vi.fn(() => []), set: vi.fn() }, viewsManager, folderSourcePathStore };

		openApiSourceModal(node, plugin);

		expect(folderSourcePathStore.get).toHaveBeenCalledWith(node.id);
		expect(FakeApiSourceModal.instances[0].initialOutsidePath).toBe("/Volumes/External/Notes");
	});
});
