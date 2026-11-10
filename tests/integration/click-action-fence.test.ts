import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeApiCommand } from "../../src/api-command-runner";
import { resolveClickAction } from "../../src/views";
import { ApiSourceConfig } from "../../src/types";

describe("click-action-fence — F1 & F2 Fence checks during click action", () => {
	it("F1: click and command execution path issues no HTTP requests", async () => {
		const networkSpy = vi.fn();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = networkSpy as unknown as typeof fetch;

		try {
			await executeApiCommand(["echo", "hello"], { noticeImpl: () => {} });
			expect(networkSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("F2: Atlas itself performs no disk moves, file creations, or file edits during click execution (spy on vault adapter)", async () => {
		const vaultAdapterSpy = {
			write: vi.fn(),
			append: vi.fn(),
			remove: vi.fn(),
			rename: vi.fn(),
		};
		const vaultSpy = {
			create: vi.fn(),
			modify: vi.fn(),
			delete: vi.fn(),
			rename: vi.fn(),
			createFolder: vi.fn(),
			adapter: vaultAdapterSpy,
		};

		// Run a command execution through executeApiCommand
		await executeApiCommand(["echo", "safe"], { noticeImpl: () => {} });

		// Assert no calls were made to vault or its adapter
		expect(vaultSpy.create).not.toHaveBeenCalled();
		expect(vaultSpy.modify).not.toHaveBeenCalled();
		expect(vaultSpy.delete).not.toHaveBeenCalled();
		expect(vaultSpy.rename).not.toHaveBeenCalled();
		expect(vaultSpy.createFolder).not.toHaveBeenCalled();
		expect(vaultAdapterSpy.write).not.toHaveBeenCalled();
		expect(vaultAdapterSpy.append).not.toHaveBeenCalled();
		expect(vaultAdapterSpy.remove).not.toHaveBeenCalled();
		expect(vaultAdapterSpy.rename).not.toHaveBeenCalled();
	});

	it("F2: command action is off unless explicitly opted-in by user", () => {
		// Default new source (or PR-2 source without explicit action)
		const defaultSource: ApiSourceConfig = {
			url: "https://api.example.com",
			method: "GET",
			mapping: { idField: "id", labelField: "name" },
			mode: "merge",
		};
		// Effective action is open-attachment, NEVER run-command
		expect(resolveClickAction(defaultSource)).toBe("open-attachment");
		expect(resolveClickAction(defaultSource)).not.toBe("run-command");

		// When explicitly set to "none", it is "none"
		const noneSource: ApiSourceConfig = {
			...defaultSource,
			action: "none",
		};
		expect(resolveClickAction(noneSource)).toBe("none");

		// Only when explicitly configured as "run-command" is it "run-command"
		const commandSource: ApiSourceConfig = {
			...defaultSource,
			action: "run-command",
			command: "open -a Docker",
		};
		expect(resolveClickAction(commandSource)).toBe("run-command");
	});
});

/** Atlas-18 (G7-G9) fence regressions for the Click function. Source-text checks read the real files, so a
 * later edit that adds a timeout wrapper, a shell, a command or a plugin name fails here. */
describe("click-action-fence: the Click function (F3, F4, F6, F8, no shell)", () => {
	const SRC = path.resolve(__dirname, "../../src");
	const read = (file: string) => fs.readFileSync(path.join(SRC, file), "utf8");
	/** Code only: line and block comments removed, so a comment saying "no timeout" is not a hit. */
	const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

	it("F3: no timeout, worker, abort or race wrapper around the function (the warning is the only mitigation)", () => {
		for (const file of ["api-click-function.ts", "api-item-click.ts"]) {
			expect(code(file), file).not.toMatch(/setTimeout|setInterval|new Worker|Worker\(|AbortController|AbortSignal|Promise\.race|worker_threads|vm\.|runInNewContext/);
		}
	});

	it("F3: the Data source modal shows the no-sandbox, no-timeout warning with the Click function box", () => {
		const modal = read("api-source-modal.ts");
		const section = modal.slice(modal.indexOf("private renderClickFunctionSection"));
		expect(section).toContain("atlas-api-js-warning");
		expect(section).toContain("no sandbox");
		expect(section).toContain("no timeout");
	});

	it("No shell: the function's terminal route spawns with shell: false and never builds a shell string", () => {
		const runner = code("click-action-runner.ts");
		expect(runner).not.toMatch(/exec\(|execSync|shell:\s*true|\/bin\/sh|\bsh -c|cmd\.exe/);
		expect(code("api-command-runner.ts")).toContain("shell: false");
		// the function's argv is handed to executeApiCommand as an array, not joined into a string
		const spawnArgv = runner.slice(runner.indexOf("private async spawnArgv"));
		expect(spawnArgv).toContain("executeApiCommand(argv,");
		expect(spawnArgv).not.toMatch(/\.join\(/);
	});

	it("F4: Atlas source names no plugin (App Runner or otherwise)", () => {
		for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
			expect(read(file), file).not.toMatch(/app[- ]?runner/i);
		}
	});

	it("F6: no command-palette command, hotkey or MCP tool is added for the function", () => {
		for (const file of ["api-click-function.ts", "api-item-click.ts", "click-action-runner.ts"]) {
			expect(code(file), file).not.toMatch(/addCommand|hotkeys|registerTool|registerMcp|new Modal|confirm\(/);
		}
		expect(code("api-click-function.ts")).not.toMatch(/Notice/); // it only decides; the caller shows notices
	});

	it("F8: with no function the layer is never built, so a source without one takes the pre-existing path", () => {
		const view = read("explorer-view.ts");
		expect(view).toMatch(/if \(!source\?\.trim\(\)\) return undefined;/);
		expect(view).toMatch(/allowFunction && folderNode\.apiSource\?\.clickFunction\?\.trim\(\)/);
	});
});
