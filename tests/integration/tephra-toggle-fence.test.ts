import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { App as ObsidianApp } from "obsidian";
import { App } from "../mocks/obsidian";
import AtlasPlugin from "../../src/main";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
import { TephraClient, type TephraRequestFn } from "../../src/tephra-client";
import { TephraConnection } from "../../src/tephra-connection";
import { TephraController } from "../../src/tephra-controller";
import { tephraTeardown } from "../../src/tephra-teardown";
import { createListNodesTool, createListStatusSetsTool, createListViewsTool, type McpStatusToolsContext } from "../../src/mcp-status-tools";
import type { AddedItem, UnitRef } from "../../src/types";

/** PR-2 fence (F6/F10/F7): turning Tephra on and off changes nothing outside the Tephra settings, and
 * nothing in Atlas can run `tephractl`. The behavioural half drives the real controller, the real
 * connection and the real client (only the HTTP call is a counting fake) next to real views, statuses,
 * the unit index and the MCP status tools, and compares what they hold before, during and after. */

const root = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
/** The file without whole-line comments, so a doc comment that names a forbidden thing doesn't trip a sweep. */
const code = (rel: string) =>
	read(rel)
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");
const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
const tephraFiles = srcFiles.filter((f) => f.startsWith("tephra-"));
const TOKEN = "c".repeat(64);

beforeEach(() => {
	vi.useFakeTimers();
	tephraTeardown.clear();
});
afterEach(() => {
	vi.useRealTimers();
	tephraTeardown.clear();
});

describe("static fence", () => {
	it("no Tephra file mentions the other data sources' controllers or stores (F6)", () => {
		for (const file of tephraFiles) {
			expect(read(`src/${file}`), file).not.toMatch(/apiSourceController|csvSourceController|markdownTableSourceController|ApiHeadersStore|FolderSourcePathStore/);
		}
	});

	it("those data-source files don't import any Tephra module (F6)", () => {
		const sourceFiles = srcFiles.filter((f) => /^(api-|csv-|folder-source|markdown-table)/.test(f));
		expect(sourceFiles.length).toBeGreaterThan(0);
		for (const file of sourceFiles) expect(read(`src/${file}`), file).not.toMatch(/from\s+["']\.\/tephra-/);
	});

	it("nothing in src can run a program: no child_process, exec, spawn or shell call (F7)", () => {
		for (const file of srcFiles.filter((f) => f !== "mcp-node-resolver.ts")) {
			const text = read(`src/${file}`);
			if (tephraFiles.includes(file) || file === "settings.ts" || file === "main.ts") {
				expect(text, file).not.toMatch(/child_process|\bexecSync\b|\bspawn(Sync)?\s*\(|\bexecFile(Sync)?\s*\(|\bexec\s*\(/);
			}
		}
	});

	it("`tephractl` appears in src only as the displayed install command constant", () => {
		const hits = srcFiles.filter((f) => code(`src/${f}`).includes("tephractl"));
		expect(hits).toEqual(["tephra-client.ts"]);
		expect(code("src/tephra-client.ts").match(/.*tephractl.*/g)).toEqual(['export const TEPHRA_INSTALL_COMMAND = "tephractl daemon install";']);
	});

	it("only the request module and the settings/exclude helpers import obsidian at runtime among Tephra files", () => {
		for (const file of tephraFiles) {
			const runtimeImport = /^import\s+(?!type\b)[^;]*from\s+["']obsidian["']/m.test(read(`src/${file}`));
			expect(runtimeImport, file).toBe(file === "tephra-request-obsidian.ts");
		}
	});

	it("the token never reaches data.json or localStorage: only tephra-client.ts reads it, and nothing stores it", () => {
		for (const file of srcFiles) {
			const text = read(`src/${file}`);
			if (file !== "tephra-client.ts") expect(text, file).not.toMatch(/tephra\/token|tokenPath|parseTephraToken/);
		}
		expect(code("src/tephra-client.ts")).not.toMatch(/localStorage|saveData|saveLocalStorage/);
		expect(read("src/settings.ts")).not.toMatch(/tephraToken|tephra[A-Za-z]*Secret/i);
	});
});

/** A real plugin shell around real managers, loaded from the v0.2.1 fixture. */
function buildPlugin(opts: { mobile?: boolean } = {}) {
	const fixture = JSON.parse(read("tests/fixtures/data-v0.2.1.json"));
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(fixture);
	const loaded = plugin as unknown as {
		settings: AtlasSettings;
		manualPromotions: UnitRef[];
		dismissedByView: Record<string, UnitRef[]>;
		dismissedGlobal: UnitRef[];
		addedItems: AddedItem[];
	};
	const app = new App();
	const viewsManager = new ViewsManager(app as unknown as ObsidianApp, fixture.views ?? [], fixture.activeViewId ?? "", () => {});
	const statusesManager = new StatusesManager(fixture.statusSets ?? [], fixture.colorPalette ?? [], () => {});
	const unitIndex = new UnitIndex(app as unknown as ObsidianApp, loaded.settings, loaded.manualPromotions, loaded.dismissedByView, loaded.dismissedGlobal, loaded.addedItems);
	const saved: Array<Record<string, unknown>> = [];
	Object.assign(plugin, {
		app,
		unitIndex,
		viewsManager,
		statusesManager,
		persistDebounced: { cancel: vi.fn() },
		saveData: async (data: Record<string, unknown>) => {
			saved.push(JSON.parse(JSON.stringify(data))); // what the disk would hold
		},
	});

	let requests = 0;
	const request: TephraRequestFn = async () => {
		requests++;
		return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ name: "notes", path: "/n", status: "online" }] }) };
	};
	const teardownSteps: string[] = [];
	tephraTeardown.register({ name: "spy", run: () => void teardownSteps.push("spy") });
	plugin.tephraController = new TephraController({
		getEnabled: () => loaded.settings.tephraEnabled,
		setEnabled: (enabled) => {
			loaded.settings.tephraEnabled = enabled;
		},
		save: () => plugin.flushSave(),
		isMobile: () => opts.mobile ?? false,
		createConnection: () => new TephraConnection(new TephraClient({ request, readFile: async () => TOKEN, tokenPath: () => "/nonexistent/tephra/token" })),
		reportTeardownFailures: () => {},
		afterChange: () => {},
	});

	const ctx: McpStatusToolsContext = {
		getViewsManager: () => viewsManager,
		getStatusesManager: () => statusesManager,
		getVaultName: () => "Fixture Vault",
		getVaultPath: () => "/tmp/fixture",
		getFolderSourcePath: () => "",
	};
	const mcpOutput = () => JSON.stringify([createListViewsTool(ctx).handler({}), createListNodesTool(ctx).handler({}), createListStatusSetsTool(ctx).handler({})]);
	const world = () => ({
		views: JSON.stringify(viewsManager.getViews()),
		activeView: viewsManager.getActiveViewId(),
		statusSets: JSON.stringify(statusesManager.getStatusSets()),
		palette: JSON.stringify(statusesManager.getColorPalette()),
		promotions: JSON.stringify(unitIndex.getManualPromotions()),
		mcp: mcpOutput(),
		vaultCalls: [...app.vault.calls],
		mcpServerEnabled: loaded.settings.mcpServerEnabled,
	});
	return { plugin, settings: loaded.settings, saved, world, app, requests: () => requests, teardownSteps, fixture };
}

describe("F6/F10: the toggle changes nothing but its own settings", () => {
	it("data sources, views, statuses and MCP output are identical before, during and after on/off", async () => {
		const h = buildPlugin();
		const before = h.world();
		expect(before.mcp.length).toBeGreaterThan(20); // the fixture really produces tool output

		await h.plugin.setTephraEnabled(true);
		await vi.advanceTimersByTimeAsync(25_000);
		const during = h.world();

		await h.plugin.setTephraEnabled(false);
		await vi.advanceTimersByTimeAsync(25_000);
		const after = h.world();

		expect(during).toEqual(before);
		expect(after).toEqual(before);
		expect(h.app.vault.calls).toEqual([]);
	});

	it("the saved data.json differs between off, on and off again only in settings.tephraEnabled", async () => {
		const h = buildPlugin();
		await h.plugin.flushSave();
		await h.plugin.setTephraEnabled(true);
		await h.plugin.setTephraEnabled(false);
		expect(h.saved).toHaveLength(3);
		const [off, on, offAgain] = h.saved;

		expect(offAgain).toEqual(off);
		const withoutFlag = (data: Record<string, unknown>) => ({ ...data, settings: { ...(data.settings as object), tephraEnabled: undefined } });
		expect(withoutFlag(on)).toEqual(withoutFlag(off));
		expect((off.settings as AtlasSettings).tephraEnabled).toBe(false);
		expect((on.settings as AtlasSettings).tephraEnabled).toBe(true);
	});

	it("loading tests/fixtures/data-v0.2.1.json and saving gives the same data apart from the new keys", async () => {
		const h = buildPlugin();
		await h.plugin.flushSave();
		const saved = h.saved[0];
		const fixtureSettings = h.fixture.settings as Record<string, unknown>;
		const savedSettings = saved.settings as Record<string, unknown>;

		for (const key of ["manualPromotions", "views", "activeViewId", "expandedModuleFolders", "statusSets", "colorPalette"]) {
			expect(saved[key], key).toEqual(h.fixture[key]);
		}
		for (const [key, value] of Object.entries(fixtureSettings)) {
			if (key === "excludedFolders" || key === "noAutoPromoteFolders") continue; // normalised by earlier PRs, covered by main-persistence.test.ts
			expect(savedSettings[key], key).toEqual(value);
		}
		const extra = Object.keys(savedSettings).filter((k) => !(k in fixtureSettings));
		// the keys added since v0.2.1: PR-1's tephraEnabled/tephraLinkFallback, this PR's tephraSourceSettings, plus earlier PRs'
		for (const key of ["tephraEnabled", "tephraSourceSettings", "tephraLinkFallback"]) expect(extra).toContain(key);
		expect(savedSettings.tephraEnabled).toBe(false);
		expect(savedSettings.tephraSourceSettings).toEqual({});
	});

	it("the MCP settings section and mcpServerEnabled behave as before: toggling Tephra never writes them", async () => {
		const h = buildPlugin();
		h.settings.mcpServerEnabled = true;
		await h.plugin.setTephraEnabled(true);
		expect(h.settings.mcpServerEnabled).toBe(true);
		await h.plugin.setTephraEnabled(false);
		expect(h.settings.mcpServerEnabled).toBe(true);
	});
});

describe("G16: with the toggle off nothing runs", () => {
	it("zero requests, no timer and no connection, however long Atlas runs", async () => {
		const h = buildPlugin();
		h.plugin.tephraController.startIfEnabled();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.requests()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(h.plugin.tephraConnection).toBeNull();
	});

	it("after turning it on and off, requests stop: none arrive in the next two minutes", async () => {
		const h = buildPlugin();
		await h.plugin.setTephraEnabled(true);
		await vi.advanceTimersByTimeAsync(35_000);
		expect(h.requests()).toBeGreaterThanOrEqual(3); // the first check plus a check every 10 s

		await h.plugin.setTephraEnabled(false);
		const atOff = h.requests();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.requests()).toBe(atOff);
		expect(vi.getTimerCount()).toBe(0);
		expect(h.plugin.tephraConnection).toBeNull();
		expect(h.teardownSteps).toEqual(["spy"]); // ran once, on the off path only
	});

	it("on mobile a saved `true` makes zero requests and starts no timer", async () => {
		const h = buildPlugin({ mobile: true });
		h.settings.tephraEnabled = true;
		(h.plugin.tephraController as TephraController).startIfEnabled();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.requests()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a saved `true` (an upgrade or restart) reconnects at load with a live timer, and dispose clears it", async () => {
		const h = buildPlugin();
		h.settings.tephraEnabled = true;
		const controller = new TephraController({
			getEnabled: () => h.settings.tephraEnabled,
			setEnabled: () => {},
			save: async () => {},
			isMobile: () => false,
			createConnection: () => new TephraConnection(new TephraClient({ request: async () => ({ status: 200, text: '{"result":[]}' }), readFile: async () => TOKEN })),
			reportTeardownFailures: () => {},
			afterChange: () => {},
		});
		controller.startIfEnabled();
		expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
		controller.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
