import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { TEPHRA_START_ARGV, TephraStarter } from "../../src/tephra-start";
import { TephraStatusBar } from "../../src/tephra-status-bar";
import { TephraClient, type TephraRequestFn } from "../../src/tephra-client";
import { TephraConnection } from "../../src/tephra-connection";
import { TephraController } from "../../src/tephra-controller";

type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

/** A stand-in for `child_process.spawn` that records every launch and hands back a child the test ends by hand. */
function spawnSpy() {
	const launches: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
	const children: Child[] = [];
	const spawnImpl = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
		launches.push({ command, args, options });
		const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
		children.push(child);
		return child;
	}) as unknown as typeof spawn;
	return { spawnImpl, launches, children };
}

const TOKEN = "d".repeat(64);
const startArgv = ["tephractl", "daemon", "start"];

describe("the starter", () => {
	it("the argv is exactly tephractl daemon start", () => {
		expect([...TEPHRA_START_ARGV]).toEqual(startArgv);
	});

	it("runs once with argv [tephractl, daemon, start] and shell:false, then checks, then stops saying 'starting'", async () => {
		const spy = spawnSpy();
		const notices: string[] = [];
		const check = vi.fn(async () => {});
		const starter = new TephraStarter({ check, runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: (m) => notices.push(m) } });
		const states: boolean[] = [];
		starter.onChange(() => states.push(starter.isStarting()));

		const done = starter.start();
		expect(starter.isStarting()).toBe(true);
		expect(spy.launches).toHaveLength(1);
		expect([spy.launches[0].command, ...spy.launches[0].args]).toEqual(startArgv);
		expect(spy.launches[0].options.shell).toBe(false);
		expect(check).not.toHaveBeenCalled(); // not until the command has exited

		spy.children[0].emit("close", 0);
		await done;
		expect(check).toHaveBeenCalledTimes(1);
		expect(starter.isStarting()).toBe(false);
		expect(states).toEqual([true, false]);
		expect(notices).toEqual([]);
	});

	it("clicked twice quickly: one launch while the first is pending", async () => {
		const spy = spawnSpy();
		const starter = new TephraStarter({ check: async () => {}, runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: () => {} } });
		const first = starter.start();
		await starter.start();
		expect(spy.launches).toHaveLength(1);
		expect(starter.isStarting()).toBe(true);
		spy.children[0].emit("close", 0);
		await first;
		expect(spy.launches).toHaveLength(1);
		// finished: a later click is a new run
		const third = starter.start();
		expect(spy.launches).toHaveLength(2);
		spy.children[1].emit("close", 0);
		await third;
	});

	it("a non-zero exit: one notice with the exit message, no check, and 'starting' ends at once", async () => {
		const spy = spawnSpy();
		const notices: string[] = [];
		const check = vi.fn(async () => {});
		const starter = new TephraStarter({ check, runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: (m) => notices.push(m) } });
		const done = starter.start();
		spy.children[0].stderr.emit("data", Buffer.from("launchd: service not installed\n"));
		spy.children[0].emit("close", 3);
		await done;
		expect(notices).toEqual(["Atlas: command failed: launchd: service not installed"]);
		expect(starter.isStarting()).toBe(false);
		expect(check).not.toHaveBeenCalled();
	});

	it("tephractl not on PATH (spawn error event): one notice even if close follows; starting ends", async () => {
		const spy = spawnSpy();
		const notices: string[] = [];
		const starter = new TephraStarter({ check: async () => {}, runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: (m) => notices.push(m) } });
		const done = starter.start();
		spy.children[0].emit("error", new Error("spawn tephractl ENOENT"));
		spy.children[0].emit("close", null);
		await done;
		expect(notices).toEqual(["Atlas: command failed — spawn tephractl ENOENT"]);
		expect(starter.isStarting()).toBe(false);
	});

	it("spawn throwing synchronously: one notice, never an exception out of start()", async () => {
		const notices: string[] = [];
		const throwing = vi.fn(() => {
			throw new Error("EACCES");
		}) as unknown as typeof spawn;
		const starter = new TephraStarter({ check: async () => {}, runnerOptions: { spawnImpl: throwing, noticeImpl: (m) => notices.push(m) } });
		await expect(starter.start()).resolves.toBeUndefined();
		expect(notices).toEqual(["Atlas: command failed — EACCES"]);
		expect(starter.isStarting()).toBe(false);
	});

	it("after a failed start the next click can try again", async () => {
		const spy = spawnSpy();
		const starter = new TephraStarter({ check: async () => {}, runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: () => {} } });
		const a = starter.start();
		spy.children[0].emit("close", 1);
		await a;
		const b = starter.start();
		expect(spy.launches).toHaveLength(2);
		spy.children[1].emit("close", 0);
		await b;
	});

	it("'starting' lasts until the check after the command has finished", async () => {
		const spy = spawnSpy();
		let finishCheck: () => void = () => {};
		const starter = new TephraStarter({
			check: () => new Promise<void>((resolve) => (finishCheck = resolve)),
			runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: () => {} },
		});
		const done = starter.start();
		spy.children[0].emit("close", 0);
		await Promise.resolve();
		await Promise.resolve();
		expect(starter.isStarting()).toBe(true); // command done, check not yet
		finishCheck();
		await done;
		expect(starter.isStarting()).toBe(false);
	});

	it("cancel() (Tephra came up by itself) ends 'starting'; the late run can't clear a newer one", async () => {
		const spy = spawnSpy();
		const starter = new TephraStarter({ check: async () => {}, runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: () => {} } });
		const first = starter.start();
		starter.cancel();
		expect(starter.isStarting()).toBe(false);
		const second = starter.start();
		expect(starter.isStarting()).toBe(true);
		spy.children[0].emit("close", 0); // the first, late
		await first;
		expect(starter.isStarting()).toBe(true); // the second still owns the state
		spy.children[1].emit("close", 0);
		await second;
		expect(starter.isStarting()).toBe(false);
	});

	it("a check that throws doesn't leave 'starting' stuck", async () => {
		const spy = spawnSpy();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const starter = new TephraStarter({
			check: () => Promise.reject(new Error("boom")),
			runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: () => {} },
		});
		const done = starter.start();
		spy.children[0].emit("close", 0);
		await done;
		expect(starter.isStarting()).toBe(false);
		error.mockRestore();
	});
});

/** F7, end to end over the real controller, connection, status bar and starter (only the HTTP call, the process
 * launch and the notice are stand-ins). Mirrors the wiring `main.ts` makes in `createConnection`. */
describe("F7: nothing starts Tephra but a click on Start", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		document.body.innerHTML = "";
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	type Mode = { value: "refused" | "up" };

	function wire(mode: Mode) {
		const spy = spawnSpy();
		const notices: string[] = [];
		const requests: string[] = [];
		const request: TephraRequestFn = async ({ body }) => {
			const { method, id } = JSON.parse(body) as { method: string; id: number };
			requests.push(method);
			if (mode.value === "refused") throw new Error("ECONNREFUSED");
			return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id, result: method === "source.list" ? [{ name: "notes", path: "/n", status: "online" }] : {} }) } as Awaited<ReturnType<TephraRequestFn>>;
		};
		let connection: TephraConnection | null = null;
		const starter = new TephraStarter({ check: () => connection?.check() ?? Promise.resolve(), runnerOptions: { spawnImpl: spy.spawnImpl, noticeImpl: (m) => notices.push(m) } });
		const bar = new TephraStatusBar({
			addItem: () => {
				const el = document.createElement("div");
				document.body.appendChild(el);
				return el;
			},
			openSettings: () => {},
			start: () => void starter.start(),
		});
		let enabled = false;
		const controller = new TephraController({
			getEnabled: () => enabled,
			setEnabled: (v) => void (enabled = v),
			save: async () => {},
			isMobile: () => false,
			createConnection: () => {
				connection = new TephraConnection(new TephraClient({ request, readFile: async () => TOKEN, tokenPath: () => "/t/token" }));
				bar.attach(connection, starter);
				connection.onOnlineChange((online) => {
					if (online) starter.cancel();
				});
				return connection;
			},
			reportTeardownFailures: () => {},
			runTeardown: async () => [],
			afterChange: () => {},
		});
		return { spy, notices, requests, controller, starter, getConnection: () => connection };
	}

	const item = () => document.querySelector<HTMLElement>(".atlas-tephra-status");

	it("zero launches on load, toggle on, failed polls, a focus check and a failed RPC call; one on the click", async () => {
		const mode: Mode = { value: "refused" };
		const w = wire(mode);

		await w.controller.setEnabled(true); // toggle on with Tephra unreachable
		await vi.advanceTimersByTimeAsync(0);
		expect(w.getConnection()?.getSnapshot()).toMatchObject({ state: "offline", checked: true });
		expect(item()?.textContent).toBe("Tephra offline · Start");
		await vi.advanceTimersByTimeAsync(35_000); // failed polls
		window.dispatchEvent(new Event("focus")); // a focus check
		await vi.advanceTimersByTimeAsync(0);
		expect((await w.getConnection()!.call("unit.list", { source: "whoop" })).ok).toBe(false); // a failed RPC call
		await vi.advanceTimersByTimeAsync(0);
		expect(w.requests.length).toBeGreaterThan(4); // all of that really made requests
		expect(w.spy.launches).toHaveLength(0);
		expect(w.notices).toEqual([]);

		// Dan clicks Start
		item()!.querySelector<HTMLElement>(".atlas-tephra-start")!.click();
		expect(w.spy.launches).toHaveLength(1);
		expect([w.spy.launches[0].command, ...w.spy.launches[0].args]).toEqual(startArgv);
		expect(w.spy.launches[0].options.shell).toBe(false);
		expect(item()?.textContent).toBe("Tephra starting…");

		// no Start control to click now; the poll running meanwhile starts nothing
		item()!.click();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(w.spy.launches).toHaveLength(1);

		// the daemon comes up and the command exits: back to a normal online label
		mode.value = "up";
		w.spy.children[0].emit("close", 0);
		await vi.advanceTimersByTimeAsync(0);
		expect(item()?.textContent).toBe("Tephra · 1 source");
		expect(w.starter.isStarting()).toBe(false);
		expect(w.spy.launches).toHaveLength(1);

		await w.controller.setEnabled(false);
		expect(item()).toBeNull();
	});

	it("a failed Start puts the label back to 'Tephra offline · Start' and shows exactly one notice", async () => {
		const w = wire({ value: "refused" });
		await w.controller.setEnabled(true);
		await vi.advanceTimersByTimeAsync(0);
		item()!.querySelector<HTMLElement>(".atlas-tephra-start")!.click();
		expect(item()?.textContent).toBe("Tephra starting…");
		w.spy.children[0].stderr.emit("data", Buffer.from("tephractl: command not found"));
		w.spy.children[0].emit("close", 127);
		await vi.advanceTimersByTimeAsync(0);
		expect(w.notices).toEqual(["Atlas: command failed: tephractl: command not found"]);
		expect(item()?.textContent).toBe("Tephra offline · Start");
		await w.controller.setEnabled(false);
	});

	it("a poll that finds Tephra up while Start is pending ends 'starting' and shows online", async () => {
		const mode: Mode = { value: "refused" };
		const w = wire(mode);
		await w.controller.setEnabled(true);
		await vi.advanceTimersByTimeAsync(0);
		item()!.querySelector<HTMLElement>(".atlas-tephra-start")!.click();
		mode.value = "up";
		await vi.advanceTimersByTimeAsync(10_000);
		expect(item()?.textContent).toBe("Tephra · 1 source");
		expect(w.starter.isStarting()).toBe(false);
		await w.controller.setEnabled(false);
	});

	it("toggle off removes the item and no request follows (the item, interval and focus handler all go)", async () => {
		const w = wire({ value: "refused" });
		await w.controller.setEnabled(true);
		await vi.advanceTimersByTimeAsync(0);
		await w.controller.setEnabled(false);
		expect(item()).toBeNull();
		const count = w.requests.length;
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(w.requests.length).toBe(count);
		expect(vi.getTimerCount()).toBe(0);
		expect(w.spy.launches).toHaveLength(0);
	});
});

describe("F7: static", () => {
	const root = join(__dirname, "../..");
	const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
	const read = (file: string) => readFileSync(join(root, "src", file), "utf8");

	it("the only call of the starter's start() is the status bar's Start dependency in main.ts", () => {
		const callers = srcFiles.filter((f) => /tephraStarter\.start\(|starter\.start\(/.test(read(f)));
		expect(callers).toEqual(["main.ts"]);
		expect(read("main.ts").match(/tephraStarter\.start\(/g)).toHaveLength(1);
		expect(read("main.ts")).toMatch(/start: \(\) => void this\.tephraStarter\.start\(\)/);
	});

	it("no other file reads the start argv or the runner: settings and the other tephra-* modules can't start Tephra", () => {
		for (const file of srcFiles) {
			if (["main.ts", "tephra-start.ts", "tephra-status-bar.ts", "api-command-runner.ts"].includes(file)) continue;
			const text = read(file);
			expect(text, file).not.toMatch(/TEPHRA_START_ARGV/);
			expect(text, file).not.toMatch(/tephra-start"/);
			if (file.startsWith("tephra-") || file === "settings.ts") expect(text, file).not.toMatch(/api-command-runner/);
		}
	});

	it("main.ts gives the starter only a check, and a drop to online only cancels", () => {
		const main = read("main.ts");
		expect(main).toMatch(/new TephraStarter\(\{ check: \(\) => this\.tephraConnection\?\.check\(\) \?\? Promise\.resolve\(\) \}\)/);
		expect(main).toMatch(/if \(online\) this\.tephraStarter\.cancel\(\);/);
	});
});
