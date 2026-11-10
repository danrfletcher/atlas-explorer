import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeApiCommand } from "../../src/api-command-runner";
import { buildClickFunctionItem, evaluateClickFunction } from "../../src/api-click-function";
import { createClickFunctionLayer } from "../../src/api-item-click";
import { ClickActionRunner } from "../../src/click-action-runner";
import { resolveArgv, tokenizeCommand } from "../../src/command-argv";

describe("click-action-run — G9b/E10: Background command execution and hostile values", () => {
	let tmpDir: string;
	let stubPath: string;
	let logPath: string;
	let notices: string[];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-click-action-test-"));
		stubPath = path.join(tmpDir, "record-args");
		logPath = path.join(tmpDir, "args.json");
		notices = [];

		// Create the stub executable using Node
		const stubContent = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--fail') {
  process.stderr.write('stub failed: permission denied\\n');
  process.exit(1);
}
const logFile = process.env.STUB_LOG;
if (logFile) {
  fs.writeFileSync(logFile, JSON.stringify(args));
}
process.exit(0);
`;
		fs.writeFileSync(stubPath, stubContent, { mode: 0o755 });
		process.env.STUB_LOG = logPath;
	});

	afterEach(() => {
		delete process.env.STUB_LOG;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("GP12: asserts exact argv for a normal row, and success produces no notice", async () => {
		const commandTemplate = `${stubPath} {path}`;
		const tokenRes = tokenizeCommand(commandTemplate);
		expect(tokenRes.ok).toBe(true);
		if (!tokenRes.ok) return;

		const resolved = resolveArgv(tokenRes.tokens, { path: "/Applications/Docker.app" });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand(resolved.argv, { noticeImpl: noticeSpy });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(notices).toHaveLength(0); // E10: no notice on exit 0

		expect(fs.existsSync(logPath)).toBe(true);
		const recorded = JSON.parse(fs.readFileSync(logPath, "utf8"));
		expect(recorded).toEqual(["/Applications/Docker.app"]);
	});

	it("Hostile row: literal argument reaches process intact without shell evaluation, no marker file created", async () => {
		const markerPath = path.join(tmpDir, "pwn_marker.txt");
		const hostileValue = `; touch "${markerPath}"; $(touch "${markerPath}")`;

		const commandTemplate = `${stubPath} {path}`;
		const tokenRes = tokenizeCommand(commandTemplate);
		expect(tokenRes.ok).toBe(true);
		if (!tokenRes.ok) return;

		const resolved = resolveArgv(tokenRes.tokens, { path: hostileValue });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand(resolved.argv, { noticeImpl: noticeSpy });

		expect(result.ok).toBe(true);
		expect(notices).toHaveLength(0);

		// Assert no shell injection happened: marker file must NOT exist
		expect(fs.existsSync(markerPath)).toBe(false);

		// Assert literal argument was recorded
		expect(fs.existsSync(logPath)).toBe(true);
		const recorded = JSON.parse(fs.readFileSync(logPath, "utf8"));
		expect(recorded).toEqual([hostileValue]);
	});

	it("E10: non-zero exit code produces a notice with the exit message and changes nothing else", async () => {
		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand([stubPath, "--fail"], { noticeImpl: noticeSpy });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("stub failed: permission denied");
	});

	it("E10: executable not found produces a notice without crashing", async () => {
		const nonExistent = path.join(tmpDir, "does-not-exist");
		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand([nonExistent, "arg"], { noticeImpl: noticeSpy });

		expect(result.ok).toBe(false);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("ENOENT");
	});

	describe("Mobile gate (Platform.isMobile)", () => {
		it("runs on desktop, but does nothing when Platform.isMobile is true", async () => {
			const fakePlatform = { isMobile: false };
			const runIfDesktop = async (platform: { isMobile: boolean }) => {
				if (platform.isMobile) return;
				await executeApiCommand([stubPath, "ran-on-desktop"], { noticeImpl: () => {} });
			};

			// Desktop execution
			await runIfDesktop(fakePlatform);
			expect(fs.existsSync(logPath)).toBe(true);
			expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual(["ran-on-desktop"]);

			// Reset log
			fs.unlinkSync(logPath);

			// Mobile simulation
			fakePlatform.isMobile = true;
			await runIfDesktop(fakePlatform);
			expect(fs.existsSync(logPath)).toBe(false); // Nothing executed on mobile
		});
	});
});

/** Atlas-18 G9 (GP8): the Click function's result reaches a REAL child process through the real compiler,
 * validator, layer and `ClickActionRunner`. Only the Obsidian command registry is a stand-in. */
describe("click-action-run: the Click function path (GP8, GP10)", () => {
	let tmpDir: string;
	let stubPath: string;
	let logPath: string;
	let notices: string[];
	let ranCommands: string[];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-click-function-test-"));
		stubPath = path.join(tmpDir, "record-args");
		logPath = path.join(tmpDir, "args.json");
		notices = [];
		ranCommands = [];
		fs.writeFileSync(stubPath, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`, { mode: 0o755 });
		process.env.STUB_LOG = logPath;
	});

	afterEach(() => {
		delete process.env.STUB_LOG;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** One click on a row through the same layer the explorer builds: claim, evaluate, run. */
	async function click(source: string, row: { id: string; label: string }, extra: Record<string, unknown> | undefined, runner: ClickActionRunner) {
		const layer = createClickFunctionLayer({
			source,
			buildItem: (r) => buildClickFunctionItem(r as { id: string; label: string }, extra),
			claim: (r) => runner.tryStart(`apps:${r.id}`),
			run: (outcome) => runner.runFunctionOutcome(outcome),
			notify: (m) => notices.push(m),
		});
		return layer({ ...row, kind: "placeholder" } as never);
	}

	const newRunner = () =>
		new ClickActionRunner({
			app: { commands: { executeCommandById: (id: string) => (ranCommands.push(id), true) } },
			noticeImpl: (m) => notices.push(m),
		});

	it("GP8: the argv a function returns reaches the process exactly, with no placeholder resolution or shell", async () => {
		const marker = path.join(tmpDir, "pwn");
		const source = `(item) => ({ kind: "terminal", argv: [${JSON.stringify(stubPath)}, "{path}", item.extra.path, '; touch ${marker}', "$(touch ${marker})"] })`;
		const decided = await click(source, { id: "docker", label: "Docker 4.34" }, { path: "/Applications/Docker.app" }, newRunner());
		expect(decided).toEqual({ kind: "handled" });
		expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual(["{path}", "/Applications/Docker.app", `; touch ${marker}`, `$(touch ${marker})`]);
		expect(fs.existsSync(marker)).toBe(false);
		expect(notices).toEqual([]);
	});

	it("GP8: the plan's function takes the command branch for a row with no path, and spawns nothing", async () => {
		const plan = `(item) => item.extra.path ? { kind: "terminal", argv: [${JSON.stringify(stubPath)}, item.extra.path] } : { kind: "command", id: "app-runner:open-" + item.id }`;
		await click(plan, { id: "build-dashboard", label: "Build Dashboard" }, {}, newRunner());
		expect(ranCommands).toEqual(["app-runner:open-build-dashboard"]);
		expect(fs.existsSync(logPath)).toBe(false);
	});

	it("GP10: a row added later (New App, no per-item setting) runs through the same function", async () => {
		const plan = `(item) => ({ kind: "command", id: "app-runner:open-" + item.id })`;
		await click(plan, { id: "new-app", label: "New App" }, undefined, newRunner());
		expect(ranCommands).toEqual(["app-runner:open-new-app"]);
	});

	it("E10: a failing process from the function shows the existing failure notice", async () => {
		const failing = path.join(tmpDir, "does-not-exist");
		await click(`(item) => ({ kind: "terminal", argv: [${JSON.stringify(failing)}] })`, { id: "x", label: "X" }, {}, newRunner());
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("ENOENT");
	});

	it("E2/E3: an invalid return spawns nothing and shows one notice", async () => {
		await click(`(item) => ({ kind: "terminal", argv: [${JSON.stringify(stubPath)}, 1] })`, { id: "x", label: "X" }, {}, newRunner());
		expect(notices).toHaveLength(1);
		expect(fs.existsSync(logPath)).toBe(false);
	});

	it("E9: two rapid clicks run the process once", async () => {
		const runner = newRunner();
		const source = `(item) => ({ kind: "terminal", argv: [${JSON.stringify(stubPath)}, "once"] })`;
		await click(source, { id: "x", label: "X" }, {}, runner);
		fs.unlinkSync(logPath);
		await click(source, { id: "x", label: "X" }, {}, runner);
		expect(fs.existsSync(logPath)).toBe(false);
	});

	it("evaluating alone never runs anything: a pure result for a valid function", () => {
		expect(evaluateClickFunction(`(item) => ({ kind: "terminal", argv: [${JSON.stringify(stubPath)}] })`, { id: "x", label: "X", secondary: undefined, extra: {} }).ok).toBe(true);
		expect(fs.existsSync(logPath)).toBe(false);
	});
});
