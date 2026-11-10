import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EventEmitter } from "node:events";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickActionRunner } from "../src/click-action-runner";
import { registerAddBlockCommand } from "../src/commands";
import { registerF10Commands } from "../src/f10-commands";
import { ViewsManager } from "../src/views";
import type { View } from "../src/types";

/** Atlas-18 PR-3 fence checks: source greps and registry checks that the Click action runner stayed inside
 * the lines the plan drew. Each assertion is on real source text or a real registry, not on a mock. */

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
/** The file's code with `//` and block comments removed, so a rule is checked against what runs, not what is said about it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
	});
}
const SRC = sourceFiles(join(root, "src")).map((f) => relative(root, f));

/** Every non-test file under `src/` whose text matches `pattern`. */
const filesMatching = (pattern: RegExp) => SRC.filter((f) => pattern.test(read(f)));

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("F2: the terminal kind never builds a shell string", () => {
	it("no file under src/ requests a shell or uses exec/execSync/execFile: spawn with shell: false is the only process path", () => {
		expect(filesMatching(/shell:\s*true/)).toEqual([]);
		expect(filesMatching(/\bexecSync\b|\bexecFile(Sync)?\b|\bchild_process["']\s*\)\s*\.exec\b|\{[^}]*\bexec\b[^}]*\}\s*from\s*["']child_process["']/)).toEqual([]);
		// A value import of child_process lives only in the shared runner (a type-only import elsewhere is fine).
		expect(filesMatching(/^import\s+(?!type\b)[^;]*from\s*["']child_process["']/m)).toEqual(["src/api-command-runner.ts"]);
		expect(read("src/api-command-runner.ts")).toContain("shell: false");
	});

	it("the click runner only reaches a process through executeApiCommand and the shared tokenizer", () => {
		const src = code("src/click-action-runner.ts");
		expect(src).toMatch(/executeApiCommand\(/);
		expect(src).toMatch(/tokenizeCommand\(/);
		expect(src).not.toMatch(/spawn\(/);
		expect(src).not.toMatch(/^import\s+(?!type\b)[^;]*from\s*["']child_process["']/m);
	});

	it("'echo hi; rm x' reaches spawn as one executable with literal tokens, shell: false", async () => {
		const calls: { executable: string; args: string[]; options: Record<string, unknown> }[] = [];
		const spawnImpl = ((executable: string, args: string[], options: Record<string, unknown>) => {
			calls.push({ executable, args, options });
			const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => child.emit("close", 0));
			return child;
		}) as never;
		const runner = new ClickActionRunner({ app: {}, noticeImpl: () => {}, spawnImpl });
		await runner.run("n", { kind: "terminal", value: "echo hi; rm x" });
		expect(calls).toHaveLength(1);
		expect(calls[0].executable).toBe("echo");
		expect(calls[0].args).toEqual(["hi;", "rm", "x"]);
		expect(calls[0].options.shell).toBe(false);
	});
});

describe("F4: Atlas does not know about App Runner, Advanced URI or any plugin", () => {
	it.each([/app-runner/i, /app runner/i, /apprunner/i, /advanced-uri/i, /advanced uri/i, /advanceduri/i])("no non-test file under src/ mentions %s", (pattern) => {
		expect(filesMatching(pattern)).toEqual([]);
	});

	it("the runner never asks which plugins or commands exist", () => {
		const src = code("src/click-action-runner.ts");
		expect(src).not.toMatch(/\bplugins\b|enabledPlugins|manifests|listCommands|\.commands\.commands|getPlugin/);
	});
});

describe("F6: no confirm prompt, no new command, no hotkey, no MCP tool for actions", () => {
	it("the registered command ids are exactly the existing eight, none with a hotkey", () => {
		const cmds: { id: string; hotkeys?: unknown }[] = [];
		const fakePlugin = { addCommand: (cmd: { id: string; hotkeys?: unknown }) => cmds.push(cmd) } as unknown as Parameters<typeof registerF10Commands>[0];
		registerF10Commands(fakePlugin);
		registerAddBlockCommand(fakePlugin);
		expect(cmds.map((c) => c.id).sort()).toEqual(["add-block", "copy-render-log", "new-view", "open-explorer", "place-active-file-in-view", "rebuild-index", "reveal-active-file", "switch-view"].sort());
		for (const c of cmds) expect(c.hotkeys).toBeUndefined();
	});

	it("every command registration in src/ is one of those (plus the render log's one command)", () => {
		const ids = SRC.flatMap((f) => [...read(f).matchAll(/addCommand\(\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1])).sort();
		expect(ids).toEqual(["add-block", "copy-render-log", "new-view", "open-explorer", "place-active-file-in-view", "rebuild-index", "reveal-active-file", "switch-view"].sort());
	});

	it("the MCP tool list is exactly the existing eleven; none is about click actions", () => {
		const names = SRC.filter((f) => /^src\/mcp-.*tools\.ts$/.test(f))
			.flatMap((f) => [...read(f).matchAll(/^\s*name:\s*"([^"]+)"/gm)].map((m) => m[1]))
			.sort();
		expect(names).toEqual(["add_node", "atlas_status", "create_folder", "get_node_status", "list_nodes", "list_status_sets", "list_views", "move_node", "remove_node", "rename_folder", "set_node_status"].sort());
		for (const n of names) expect(n).not.toMatch(/click|action/);
	});

	it("the runner shows no confirm modal before running", () => {
		const src = code("src/click-action-runner.ts");
		expect(src).not.toMatch(/Modal|confirm|ConfirmModal|prompt\(/i);
	});
});

describe("F7: no output capture for display, no log view, no run history in data.json", () => {
	it("the runner does not read stdout or stderr, and keeps no history of runs", () => {
		const src = code("src/click-action-runner.ts");
		expect(src).not.toMatch(/stdout|stderr/);
		expect(src).not.toMatch(/history|runLog|lastRun|\bhistory\b/i);
	});

	it("running actions leaves the stored views byte-identical and never signals a save", async () => {
		const views: View[] = [
			{
				id: "v",
				name: "V",
				inboxMode: "view",
				root: [
					{ id: "mod", type: "unit", ref: { kind: "folder", path: "Live Captions" }, children: [], clickAction: { kind: "command", value: "a:b" } },
					{ id: "apps", type: "meta", label: "Apps", children: [], clickAction: { kind: "uri", value: "obsidian://open?vault=N" } },
				],
			},
		];
		const onChange = vi.fn();
		const vm = new ViewsManager({} as App, views, "v", onChange);
		const before = JSON.stringify(vm.getViews());
		vi.spyOn(window, "open").mockImplementation(() => ({}) as Window);
		const runner = new ClickActionRunner({ app: { commands: { executeCommandById: () => false } }, noticeImpl: () => {} });
		for (const node of vm.getViews()[0].root) await runner.run(node.id, node.clickAction);
		expect(JSON.stringify(vm.getViews())).toBe(before);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("no persisted-state key in main.ts is about runs, logs or history of actions", () => {
		const block = read("src/main.ts").slice(read("src/main.ts").indexOf("await this.saveData({"));
		const keys = [...block.slice(0, block.indexOf("satisfies AtlasData")).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
		expect(keys.length).toBeGreaterThan(5);
		for (const k of keys) expect(k).not.toMatch(/run|log|history|click/i);
	});
});

describe("F9: ids go through executeCommandById exactly as stored", () => {
	it("the runner calls only executeCommandById, and has no command list of its own", async () => {
		const src = code("src/click-action-runner.ts");
		expect(src.match(/\.commands\b/g) ?? []).toHaveLength(1); // the single `this.options.app.commands` read
		expect(src).not.toMatch(/findCommand|listCommands|commands\.commands|editorCommands|Object\.keys\(.*commands/);

		const seen: string[] = [];
		const commands = { executeCommandById: (id: string) => (seen.push(id), true), commands: { "x:y": {} } };
		const runner = new ClickActionRunner({ app: { commands }, noticeImpl: () => {} });
		await runner.run("n1", { kind: "command", value: "  odd:ID-with Spaces " });
		expect(seen).toEqual(["  odd:ID-with Spaces "]);
	});

	it("an id that is not registered right now does not run and nothing is substituted for it", async () => {
		const registered = new Set(["real:cmd"]);
		const ran: string[] = [];
		const commands = { executeCommandById: (id: string) => (registered.has(id) ? (ran.push(id), true) : false) };
		const notices: string[] = [];
		const runner = new ClickActionRunner({ app: { commands }, noticeImpl: (m) => notices.push(m) });
		await runner.run("a", { kind: "command", value: "real:cmd-typo" });
		expect(ran).toEqual([]);
		expect(notices).toEqual(["Atlas: command not found: real:cmd-typo"]);
	});
});

describe("F10: a URI is passed to window.open byte for byte", () => {
	it("the runner never touches the vault name", () => {
		const src = code("src/click-action-runner.ts");
		expect(src).not.toMatch(/getName|vaultName|vault\.|encodeURI|URLSearchParams|new URL\(/);
		expect(src.match(/window\.open\(/g)).toHaveLength(1);
		expect(src).toMatch(/window\.open\(uri\)/);
	});

	it.each([
		"obsidian://open?file=Docker",
		"obsidian://open?vault=Other%20Vault&file=a%2Fb ",
		"  obsidian://x  ",
		"https://example.com/a b?c=d#e",
		"mailto:me@example.com",
		"obsidian://adv-uri?commandid=x%3Ay&vault=\u00e9",
	])("%j", async (uri) => {
		const open = vi.spyOn(window, "open").mockImplementation(() => ({}) as Window);
		const runner = new ClickActionRunner({ app: {}, noticeImpl: () => {} });
		await runner.run("n", { kind: "uri", value: uri });
		expect(open).toHaveBeenCalledExactlyOnceWith(uri);
	});
});

describe("F11: running writes nothing to disk", () => {
	it("the runner source calls no vault, adapter or file-manager API", () => {
		const src = code("src/click-action-runner.ts");
		expect(src).not.toMatch(/\b(vault|adapter|fileManager|app)\s*\.\s*(create|createFolder|modify|append|delete|trash|rename|copy|write|process)\b|renameFile|fileManager|\.adapter|saveData|persist|\bsave\(/);
	});
});

describe("F12: there is no fold-on-click behaviour", () => {
	it("no setting or code path ties a click action to folding", () => {
		const settings = read("src/settings.ts");
		expect(settings).not.toMatch(/foldOnClick|toggleOnClick|collapseOnClick/i);
		const runner = read("src/click-action-runner.ts");
		expect(runner).not.toMatch(/setNodeCollapsed|collapsed/);
		const view = read("src/explorer-view.ts");
		const start = view.indexOf("private runClickAction(");
		const end = view.indexOf("\n\t}\n", start);
		expect(view.slice(start, end)).not.toMatch(/setNodeCollapsed|collapsed/);
	});
});
