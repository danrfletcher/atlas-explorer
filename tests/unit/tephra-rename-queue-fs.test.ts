import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AtlasPlugin from "../../src/main";
import { nodeQueueStorage } from "../../src/tephra-rename-queue-fs";
import { TEPHRA_RENAME_QUEUE_FILE, TephraRenameQueue } from "../../src/tephra-rename-queue";

/** The real file system under the queue: a real temp folder, a real restart. */
const dirs: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "atlas-queue-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const open = (path: string, corrupt: unknown[] = []) =>
	new TephraRenameQueue({ storage: nodeQueueStorage, path, now: () => 1, onCorrupt: (info) => void corrupt.push(info), onWriteError: (error) => { throw error; } });

describe("nodeQueueStorage", () => {
	it("a missing file reads as null; a written file reads back", () => {
		const path = join(tempDir(), TEPHRA_RENAME_QUEUE_FILE);
		expect(nodeQueueStorage.read(path)).toBeNull();
		nodeQueueStorage.write(path, "hello");
		expect(nodeQueueStorage.read(path)).toBe("hello");
	});

	it("a write leaves only the queue file behind (no temp file), and replaces the old content whole", () => {
		const dir = tempDir();
		const path = join(dir, TEPHRA_RENAME_QUEUE_FILE);
		nodeQueueStorage.write(path, "x".repeat(10_000));
		nodeQueueStorage.write(path, "short");
		expect(readFileSync(path, "utf8")).toBe("short");
		expect(readdirSync(dir)).toEqual([TEPHRA_RENAME_QUEUE_FILE]);
	});

	it("the queue survives a restart through real files, unicode intact, and a corrupt file is kept aside on disk", () => {
		const dir = tempDir();
		const path = join(dir, TEPHRA_RENAME_QUEUE_FILE);
		const first = open(path);
		first.load();
		first.enqueue("Café ☕/Notes #1 [a].md", "日本語/Notes ^2.md");
		const second = open(path);
		second.load();
		expect(second.first()).toMatchObject({ oldPath: "Café ☕/Notes #1 [a].md", newPath: "日本語/Notes ^2.md" });

		writeFileSync(path, "{broken");
		const corrupt: Array<{ asidePath: string | null }> = [];
		const third = open(path, corrupt);
		third.load();
		expect(third.size()).toBe(0);
		expect(corrupt).toHaveLength(1);
		expect(readFileSync(corrupt[0].asidePath!, "utf8")).toBe("{broken");
		expect(readdirSync(dir).sort()).toEqual([`${TEPHRA_RENAME_QUEUE_FILE}.corrupt-1`]);
	});
});

/** R1: the queue file follows the plugin's real folder (`manifest.dir`), not `manifest.id`. The plugin's own path
 * method is called; the queue then writes through the real file system into a real temp vault. */
describe("the plugin's queue path (manifest.dir vs manifest.id)", () => {
	const pluginFor = (vault: string, manifest: { id: string; dir?: string }) => {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		plugin.manifest = manifest as never;
		plugin.app = { vault: { configDir: ".obsidian" } } as never;
		plugin.getVaultBasePath = () => vault;
		return plugin as unknown as { tephraRenameQueuePath(): string };
	};

	it("lands in manifest.dir when the folder is named differently from the id, and the rename survives a restart", () => {
		const vault = tempDir();
		mkdirSync(join(vault, ".obsidian/plugins/atlas"), { recursive: true });
		const path = pluginFor(vault, { id: "atlas-explorer", dir: ".obsidian/plugins/atlas" }).tephraRenameQueuePath();
		expect(path).toBe(`${vault}/.obsidian/plugins/atlas/${TEPHRA_RENAME_QUEUE_FILE}`);

		open(path).enqueue("a.md", "b.md");
		expect(readdirSync(join(vault, ".obsidian/plugins"))).toEqual(["atlas"]); // no stray atlas-explorer folder
		const restarted = open(path);
		restarted.load();
		expect(restarted.first()).toMatchObject({ oldPath: "a.md", newPath: "b.md" });
	});

	it("falls back to <configDir>/plugins/<id> only when the host gives no manifest.dir", () => {
		const vault = tempDir();
		expect(pluginFor(vault, { id: "atlas-explorer" }).tephraRenameQueuePath()).toBe(`${vault}/.obsidian/plugins/atlas-explorer/${TEPHRA_RENAME_QUEUE_FILE}`);
	});
});

describe("nodeQueueStorage: a missing folder", () => {
	it("is created, so a rename is never lost to ENOENT", () => {
		const path = join(tempDir(), "no/such/folder", TEPHRA_RENAME_QUEUE_FILE);
		nodeQueueStorage.write(path, "x");
		expect(readFileSync(path, "utf8")).toBe("x");
	});
});
