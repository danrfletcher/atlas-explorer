import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";
import { Platform } from "obsidian";
import { CLICK_ACTION_DEBOUNCE_MS, ClickActionRunner, readRunnableClickAction, rowClickAction, sharedClickActionRunner } from "../src/click-action-runner";
import type { ClickActionKind, ViewNode } from "../src/types";

/** The runner is driven with explicit inputs: a fake `spawnImpl`, a recording `noticeImpl`, a fake
 * `app.commands`, a stubbed `window.open` and `Platform.isMobile`, and fake timers (the debounce reads
 * `Date.now()`). No explorer view is involved. */

type SpawnCall = { executable: string; args: string[]; options: Record<string, unknown> };

function fakeSpawn(exitCode: number | "error" = 0, stderr = "") {
	const calls: SpawnCall[] = [];
	const impl = ((executable: string, args: string[], options: Record<string, unknown>) => {
		calls.push({ executable, args, options });
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => {
			if (exitCode === "error") {
				child.emit("error", new Error("spawn nope ENOENT"));
				return;
			}
			if (stderr) child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", exitCode);
		});
		return child;
	}) as never;
	return { impl, calls };
}

function rig(opts: { commands?: { executeCommandById?: (id: string) => unknown }; spawn?: ReturnType<typeof fakeSpawn> } = {}) {
	const notices: string[] = [];
	const spawn = opts.spawn ?? fakeSpawn();
	const executeCommandById = vi.fn((_id: string): unknown => true);
	const commands = opts.commands ?? { executeCommandById };
	const runner = new ClickActionRunner({ app: { commands }, noticeImpl: (m) => notices.push(m), spawnImpl: spawn.impl });
	return { runner, notices, spawn, executeCommandById };
}

let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
	(Platform as { isMobile: boolean }).isMobile = false;
	openSpy = vi.spyOn(window, "open").mockImplementation(() => ({}) as Window);
});

afterEach(() => {
	(Platform as { isMobile: boolean }).isMobile = false;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("G3: each kind", () => {
	it("terminal: tokenizes into an argv array and spawns with shell: false", async () => {
		const r = rig();
		expect(await r.runner.run("n1", { kind: "terminal", value: 'open -a "Docker Desktop"' })).toBe("ran");
		expect(r.spawn.calls).toHaveLength(1);
		expect(r.spawn.calls[0].executable).toBe("open");
		expect(r.spawn.calls[0].args).toEqual(["-a", "Docker Desktop"]);
		expect(r.spawn.calls[0].options.shell).toBe(false);
		expect(r.notices).toEqual([]);
	});

	it("command: calls app.commands.executeCommandById with the stored id and nothing else", async () => {
		const r = rig();
		expect(await r.runner.run("n1", { kind: "command", value: "app-runner:open-live-captions" })).toBe("ran");
		expect(r.executeCommandById).toHaveBeenCalledExactlyOnceWith("app-runner:open-live-captions");
		expect(r.spawn.calls).toEqual([]);
		expect(openSpy).not.toHaveBeenCalled();
		expect(r.notices).toEqual([]);
	});

	it("uri: calls window.open with the stored value byte for byte", async () => {
		const r = rig();
		const uri = "obsidian://open?vault=My%20Notes&file=Docker  ";
		expect(await r.runner.run("n1", { kind: "uri", value: uri })).toBe("ran");
		expect(openSpy).toHaveBeenCalledExactlyOnceWith(uri);
		expect(r.executeCommandById).not.toHaveBeenCalled();
		expect(r.notices).toEqual([]);
	});
});

describe("G12: failure notices (and nothing on success)", () => {
	it("terminal non-zero exit keeps the existing 'command failed' notice", async () => {
		const r = rig({ spawn: fakeSpawn(2, "boom\n") });
		expect(await r.runner.run("n1", { kind: "terminal", value: "false" })).toBe("failed");
		expect(r.notices).toEqual(["Atlas: command failed: boom"]);
	});

	it("a missing executable gives the existing notice", async () => {
		const r = rig({ spawn: fakeSpawn("error") });
		expect(await r.runner.run("n1", { kind: "terminal", value: "nope-not-here" })).toBe("failed");
		expect(r.notices).toEqual(["Atlas: command failed — spawn nope ENOENT"]);
	});

	it("an unbalanced quote gives the command-error notice and spawns nothing", async () => {
		const r = rig();
		expect(await r.runner.run("n1", { kind: "terminal", value: 'open "oops' })).toBe("failed");
		expect(r.notices).toEqual(["Atlas: command error — Unbalanced quote in command"]);
		expect(r.spawn.calls).toEqual([]);
	});

	it("a command id that is not registered (executeCommandById returns false) shows 'command not found'", async () => {
		const r = rig({ commands: { executeCommandById: () => false } });
		expect(await r.runner.run("n1", { kind: "command", value: "gone:plugin-command" })).toBe("failed");
		expect(r.notices).toEqual(["Atlas: command not found: gone:plugin-command"]);
	});

	it("an app with no commands API at all shows 'command not found'", async () => {
		const r = rig({ commands: {} });
		expect(await r.runner.run("n1", { kind: "command", value: "x:y" })).toBe("failed");
		expect(r.notices).toEqual(["Atlas: command not found: x:y"]);
	});

	it("executeCommandById throwing shows a failure notice and the run resolves (no unhandled rejection)", async () => {
		const r = rig({
			commands: {
				executeCommandById: () => {
					throw new Error("kaput");
				},
			},
		});
		await expect(r.runner.run("n1", { kind: "command", value: "x:y" })).resolves.toBe("failed");
		expect(r.notices).toEqual(["Atlas: command failed: kaput"]);
	});

	it("executeCommandById returning a rejected promise shows a failure notice", async () => {
		const r = rig({ commands: { executeCommandById: () => Promise.reject(new Error("async kaput")) } });
		await expect(r.runner.run("n1", { kind: "command", value: "x:y" })).resolves.toBe("failed");
		expect(r.notices).toEqual(["Atlas: command failed: async kaput"]);
	});

	it("window.open throwing shows 'couldn't open URI'", async () => {
		openSpy.mockImplementation(() => {
			throw new Error("blocked");
		});
		const r = rig();
		await expect(r.runner.run("n1", { kind: "uri", value: "https://example.com" })).resolves.toBe("failed");
		expect(r.notices).toEqual(["Atlas: couldn't open URI"]);
	});

	it("window.open returning null on desktop is a successful open: no notice (Electron returns null on success)", async () => {
		(Platform as { isMobile: boolean }).isMobile = false;
		openSpy.mockImplementation(() => null);
		const r = rig();
		expect(await r.runner.run("n1", { kind: "uri", value: "https://example.com/" })).toBe("ran");
		expect(await r.runner.run("n2", { kind: "uri", value: "obsidian://open?vault=a21-pr1" })).toBe("ran");
		expect(openSpy).toHaveBeenCalledTimes(2);
		expect(r.notices).toEqual([]);
	});

	it("window.open returning null on mobile is not treated as a failure", async () => {
		(Platform as { isMobile: boolean }).isMobile = true;
		openSpy.mockImplementation(() => null);
		const r = rig();
		expect(await r.runner.run("n1", { kind: "uri", value: "obsidian://open?vault=Notes" })).toBe("ran");
		expect(r.notices).toEqual([]);
	});
});

describe("terminal placeholders: no row data on a module or Folder", () => {
	it("a {field} placeholder gives the existing resolve error at click and spawns nothing", async () => {
		const r = rig();
		expect(await r.runner.run("n1", { kind: "terminal", value: "open {path}" })).toBe("failed");
		expect(r.notices).toEqual(["Atlas: Missing value for placeholder: {path}"]);
		expect(r.spawn.calls).toEqual([]);
	});
});

describe("F2: no shell", () => {
	it("'echo hi; rm x' becomes literal tokens passed to one spawn, with shell: false", async () => {
		const r = rig();
		await r.runner.run("n1", { kind: "terminal", value: "echo hi; rm x" });
		expect(r.spawn.calls).toHaveLength(1);
		expect(r.spawn.calls[0].executable).toBe("echo");
		expect(r.spawn.calls[0].args).toEqual(["hi;", "rm", "x"]);
		expect(r.spawn.calls[0].options.shell).toBe(false);
	});
});

describe("G13/E17: mobile", () => {
	beforeEach(() => {
		(Platform as { isMobile: boolean }).isMobile = true;
	});

	it("a synced terminal action shows the desktop-only notice, spawns nothing and leaves the action untouched", async () => {
		const r = rig();
		const stored = { kind: "terminal", value: "open -a Docker" };
		const before = JSON.stringify(stored);
		expect(await r.runner.run("n1", stored)).toBe("failed");
		expect(r.notices).toEqual(["Atlas: terminal actions are desktop only"]);
		expect(r.spawn.calls).toEqual([]);
		expect(JSON.stringify(stored)).toBe(before);
	});

	it("command and URI kinds still run", async () => {
		const r = rig();
		expect(await r.runner.run("n1", { kind: "command", value: "a:b" })).toBe("ran");
		expect(await r.runner.run("n2", { kind: "uri", value: "obsidian://open?vault=N" })).toBe("ran");
		expect(r.executeCommandById).toHaveBeenCalledWith("a:b");
		expect(openSpy).toHaveBeenCalledWith("obsidian://open?vault=N");
		expect(r.notices).toEqual([]);
	});
});

describe("E1: an unregistered id keeps the setting", () => {
	it("the stored action object is unchanged after a 'command not found' run", async () => {
		const r = rig({ commands: { executeCommandById: () => false } });
		const stored = { kind: "command", value: "missing:id" };
		await r.runner.run("n1", stored);
		expect(stored).toEqual({ kind: "command", value: "missing:id" });
	});
});

describe("E9: 1 s per-node debounce from the start of the run", () => {
	const action = { kind: "command", value: "a:b" };

	it("ignores a second run of the same node inside the window, with no notice", async () => {
		const r = rig();
		expect(await r.runner.run("n1", action)).toBe("ran");
		vi.advanceTimersByTime(CLICK_ACTION_DEBOUNCE_MS - 1);
		expect(await r.runner.run("n1", action)).toBe("debounced");
		expect(r.executeCommandById).toHaveBeenCalledTimes(1);
		expect(r.notices).toEqual([]);
	});

	it("a different node is unaffected", async () => {
		const r = rig();
		await r.runner.run("n1", action);
		expect(await r.runner.run("n2", action)).toBe("ran");
		expect(r.executeCommandById).toHaveBeenCalledTimes(2);
	});

	it("runs again once 1 s has passed", async () => {
		const r = rig();
		await r.runner.run("n1", action);
		vi.advanceTimersByTime(CLICK_ACTION_DEBOUNCE_MS);
		expect(await r.runner.run("n1", action)).toBe("ran");
		expect(r.executeCommandById).toHaveBeenCalledTimes(2);
	});

	it("is measured from the start of the run, not its end: a slow terminal run does not extend the window", async () => {
		const finishers: (() => void)[] = [];
		const calls: string[] = [];
		const impl = ((executable: string) => {
			calls.push(executable);
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			finishers.push(() => child.emit("close", 0));
			return child;
		}) as never;
		const runner = new ClickActionRunner({ app: {}, noticeImpl: () => {}, spawnImpl: impl });
		const first = runner.run("n1", { kind: "terminal", value: "slow" });
		vi.advanceTimersByTime(CLICK_ACTION_DEBOUNCE_MS - 1);
		expect(await runner.run("n1", { kind: "terminal", value: "slow" })).toBe("debounced");
		vi.advanceTimersByTime(1); // now exactly 1 s after the START; the first run is still going
		const second = runner.run("n1", { kind: "terminal", value: "slow" });
		expect(calls).toEqual(["slow", "slow"]);
		for (const finish of finishers) finish();
		await Promise.all([first, second]);
	});

	it("a failed run still counts: a retry inside the window shows no second notice", async () => {
		const r = rig({ commands: { executeCommandById: () => false } });
		await r.runner.run("n1", action);
		await r.runner.run("n1", action);
		expect(r.notices).toEqual(["Atlas: command not found: a:b"]);
	});

	it("a malformed action does not start the window", async () => {
		const r = rig();
		expect(await r.runner.run("n1", { kind: "nope", value: "x" })).toBe("no-action");
		expect(await r.runner.run("n1", action)).toBe("ran");
	});
});

describe("malformed stored actions are no action and never throw", () => {
	const cases: [string, unknown][] = [
		["undefined", undefined],
		["null", null],
		["a string", "terminal"],
		["a number", 5],
		["an array", [{ kind: "command", value: "a:b" }]],
		["an empty object", {}],
		["a missing kind", { value: "a:b" }],
		["an unknown kind", { kind: "shell", value: "a:b" }],
		["a missing value", { kind: "command" }],
		["a non-string value", { kind: "command", value: 5 }],
		["a blank value", { kind: "uri", value: "   " }],
		["an empty value", { kind: "terminal", value: "" }],
	];

	it.each(cases)("%s", async (_label, raw) => {
		const r = rig();
		await expect(r.runner.run("n1", raw)).resolves.toBe("no-action");
		expect(readRunnableClickAction(raw)).toBeUndefined();
		expect(r.spawn.calls).toEqual([]);
		expect(r.executeCommandById).not.toHaveBeenCalled();
		expect(openSpy).not.toHaveBeenCalled();
		expect(r.notices).toEqual([]);
	});

	it("a valid action keeps kind and value exactly as stored (not trimmed), and drops extra keys", () => {
		expect(readRunnableClickAction({ kind: "uri", value: " x://y ", extra: 1 })).toEqual({ kind: "uri", value: " x://y " });
	});
});

describe("F1/G14: only a module or Folder node has a runnable action", () => {
	const action = { kind: "command" as ClickActionKind, value: "a:b" };
	const outside = vi.fn(() => false);

	it("a Folder (meta) node", () => {
		expect(rowClickAction({ id: "m", type: "meta", children: [], clickAction: action }, outside)).toEqual(action);
	});

	it("a module (a unit holding a folder ref)", () => {
		expect(rowClickAction({ id: "u", type: "unit", ref: { kind: "folder", path: "Mod" }, children: [], clickAction: action }, outside)).toEqual(action);
	});

	it.each<[string, Partial<ViewNode>]>([
		["a file", { ref: { kind: "file", path: "a.md" } }],
		["a block", { ref: { kind: "block", path: "a.md", subpath: "#^x" } }],
		["a unit with no ref", {}],
	])("%s never runs even if data.json put an action on it", (_label, over) => {
		expect(rowClickAction({ id: "u", type: "unit", children: [], clickAction: action, ...over } as ViewNode, outside)).toBeUndefined();
	});

	it("an Outside-Vault-managed module does not", () => {
		expect(rowClickAction({ id: "u", type: "unit", ref: { kind: "folder", path: "Mod" }, children: [], clickAction: action }, () => true)).toBeUndefined();
	});

	it("a node with no action, or a malformed one, has none and does not ask about Outside-Vault", () => {
		const probe = vi.fn(() => false);
		expect(rowClickAction({ id: "u", type: "unit", ref: { kind: "folder", path: "Mod" }, children: [] }, probe)).toBeUndefined();
		expect(rowClickAction({ id: "u", type: "unit", ref: { kind: "folder", path: "Mod" }, children: [], clickAction: { kind: "x", value: "y" } as never }, probe)).toBeUndefined();
		expect(probe).toHaveBeenCalledTimes(1); // only the malformed one got past the cheap checks
	});
});

describe("PR-1 R3: sharedClickActionRunner", () => {
	it("gives every caller on one app the same runner, and another app its own", () => {
		const app = {};
		expect(sharedClickActionRunner(app)).toBe(sharedClickActionRunner(app));
		expect(sharedClickActionRunner({})).not.toBe(sharedClickActionRunner(app));
	});

	it("so one node's 1 s debounce holds across callers: the second claim inside the window is refused", () => {
		vi.useFakeTimers();
		try {
			const app = {};
			expect(sharedClickActionRunner(app).tryStart("node")).toBe(true);
			expect(sharedClickActionRunner(app).tryStart("node")).toBe(false);
			vi.advanceTimersByTime(CLICK_ACTION_DEBOUNCE_MS);
			expect(sharedClickActionRunner(app).tryStart("node")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a missing app still gives a working runner (never shared)", () => {
		expect(sharedClickActionRunner(undefined as never)).toBeInstanceOf(ClickActionRunner);
	});
});
