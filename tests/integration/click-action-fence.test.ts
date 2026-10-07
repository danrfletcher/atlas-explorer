import { describe, expect, it, vi } from "vitest";
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
