import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import AtlasPlugin from "../../src/main";
import { registerF10Commands } from "../../src/f10-commands";
import { RenderLog, RenderLogAdapter } from "../../src/render-log";

/** The real registration path (`registerF10Commands`) against a real `RenderLog`; only the plugin's
 * `addCommand` and the browser clipboard are stand-ins. */

type Cmd = { id: string; name: string; callback?: () => void; hotkeys?: unknown };

const adapter: RenderLogAdapter = { exists: async () => false, read: async () => "", write: async () => {} };

let commands: Cmd[];
let log: RenderLog;
let writeText: ReturnType<typeof vi.fn>;

function command(): Cmd {
	const cmd = commands.find((c) => c.id === "copy-render-log");
	if (!cmd) throw new Error("copy-render-log was not registered");
	return cmd;
}

/** Runs the command and lets its async body settle. */
async function run(): Promise<void> {
	command().callback?.();
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	Notice.reset();
	commands = [];
	log = new RenderLog(adapter, "render-log.json");
	writeText = vi.fn(async () => {});
	Object.assign(navigator, { clipboard: { writeText } });
	const plugin = { renderLog: log, addCommand: (c: Cmd) => commands.push(c) } as unknown as AtlasPlugin;
	registerF10Commands(plugin);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Copy render log command", () => {
	it("is registered as `copy-render-log` named `Copy render log`, with no hotkey", () => {
		expect(command().name).toBe("Copy render log");
		expect(command().hotkeys).toBeUndefined();
	});

	it("copies the serialised log and says how many entries", async () => {
		log.record({ kind: "click", at: 1, durationMs: 4, changed: true });
		log.record({ kind: "drop", at: 2, durationMs: 9, changed: false });

		await run();

		expect(writeText).toHaveBeenCalledTimes(1);
		expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual(log.entries());
		expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: copied 2 render log entries to the clipboard."]);
	});

	it("copies [] and says so when the log is empty", async () => {
		await run();

		expect(writeText).toHaveBeenCalledWith("[]");
		expect(Notice.instances[0].message).toBe("Atlas: render log is empty — copied [] to the clipboard.");
	});

	it("tells the user when the clipboard refuses, and does not throw", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		log.record({ kind: "click", at: 1, durationMs: 4, changed: true });

		await run();

		expect(Notice.instances.map((n) => n.message)).toEqual(["Atlas: couldn't copy the render log to the clipboard."]);
	});

	it("copies only the four fields per entry: no paths, labels or note text", async () => {
		log.record({ kind: "click", at: 1, durationMs: 4, changed: true });
		await run();
		const copied = JSON.parse(writeText.mock.calls[0][0] as string) as Record<string, unknown>[];
		expect(Object.keys(copied[0]).sort()).toEqual(["at", "changed", "durationMs", "kind"]);
	});
});

describe("AtlasPlugin.onunload and the render log", () => {
	it("flushes pending entries to disk on unload", async () => {
		const writes: string[] = [];
		const real = new RenderLog({ ...adapter, write: async (_p: string, d: string) => void writes.push(d) }, "render-log.json");
		real.record({ kind: "other", at: 1, durationMs: 0, changed: true });

		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		plugin.renderLog = real;
		plugin.outsideFolderWatchers = { closeAll: vi.fn(), sync: vi.fn() } as never;
		plugin.folderLiveRefresh = { cancelAll: vi.fn() } as never;
		plugin.persistDebounced = undefined;
		plugin.graduation = undefined;
		plugin.app = {} as never;
		plugin.linkSuggest = undefined as never;

		plugin.onunload();
		await Promise.resolve();
		await Promise.resolve();

		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0])).toHaveLength(1);
	});
});
