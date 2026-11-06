import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/settings";

/** Fence checks for the render log: no note edits, no setting, no extra UI, no new dependency, and
 * no new timer of its own. Source checks read the shipped files, so a later edit can't slip past. */

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
/** Source with comments removed, so a doc comment that names a forbidden call doesn't trip the check. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

describe("F4: the log never edits a note", () => {
	it.each(["src/render-log.ts", "src/render-log-command.ts"])("%s makes no vault or fileManager write", (file) => {
		const src = code(file);
		for (const banned of ["vault.create", "vault.modify", "vault.process", "vault.delete", "vault.rename", "fileManager", "renameFile", "trash("]) {
			expect(src).not.toContain(banned);
		}
	});

	it("render-log.ts reaches the disk only through the injected adapter's read, write and exists", () => {
		const src = code("src/render-log.ts");
		const adapterCalls = [...src.matchAll(/this\.adapter\.(\w+)\(/g)].map((m) => m[1]);
		expect(new Set(adapterCalls)).toEqual(new Set(["exists", "read", "write"]));
		expect(src).not.toMatch(/from "node:fs"|require\("fs"\)/);
	});
});

describe("F3: the debounced save reuses obsidian's debounce, with no timer of its own", () => {
	it("render-log.ts imports debounce from obsidian and calls no setInterval or setTimeout", () => {
		const src = code("src/render-log.ts");
		expect(src).toMatch(/import \{[^}]*\bdebounce\b[^}]*\} from "obsidian"/);
		expect(src).not.toMatch(/setInterval|setTimeout/);
	});
});

describe("F7: no setting, no UI beyond the command, no off switch", () => {
	it("DEFAULT_SETTINGS has exactly the keys it had before the render log", () => {
		expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(
			[
				"poolFolder",
				"excludedFolders",
				"noAutoPromoteFolders",
				"interfaceNoteAcceptAltNames",
				"replaceNativeExplorerOnStartup",
				"blockDisplayLength",
				"defaultViewId",
				"confirmAddToModule",
				"glowEnabled",
				"retainIcons",
				"retainIconMatchBackground",
				"highlightOpenNote",
				"mcpServerEnabled",
			].sort()
		);
	});

	it("the settings tab and the explorer view's user-visible strings never mention the render log", () => {
		expect(read("src/settings.ts")).not.toMatch(/render[ -]?log/i);
		// explorer-view.ts may *use* the log (identifiers, comments); it must add no visible text for it.
		const visible = [...read("src/explorer-view.ts").matchAll(/(?:text|title|placeholder|aria-label|setTitle|setName|setDesc|new Notice)\s*[:(]\s*["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
		for (const text of visible) expect(text).not.toMatch(/render[ -]?log/i);
	});

	it("the only command the log adds is copy-render-log, with no hotkey", () => {
		const src = read("src/render-log-command.ts");
		expect([...src.matchAll(/id: "([^"]+)"/g)].map((m) => m[1])).toEqual(["copy-render-log"]);
		expect(src).not.toContain("hotkeys");
		expect(src).not.toMatch(/addRibbonIcon|addStatusBarItem|new Modal|extends Modal|addSettingTab/);
	});

	it("the log has no off switch: explorer-view.ts consults no flag before logging", () => {
		const src = code("src/explorer-view.ts");
		// The only condition on logging is that a log object exists (a bare test double has none).
		expect(src).toMatch(/const log = this\.plugin\?\.renderLog;\s*const startedAt/);
		expect(src).not.toMatch(/settings\.[A-Za-z]*(render|log)[A-Za-z]*/i);
		expect(code("src/main.ts")).not.toMatch(/settings\.[A-Za-z]*renderLog/i);
	});
});

describe("F5: no new dependency", () => {
	it("package.json dependencies and devDependencies are the ones the render log was built against", () => {
		const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		expect(pkg.dependencies ?? {}).toEqual({});
		expect(pkg.devDependencies ?? {}).toEqual({
		  "@codemirror/state": "^6.5.0",
		  "@codemirror/view": "^6.38.6",
		  "@types/node": "^20.0.0",
		  "@typescript-eslint/eslint-plugin": "^8.70.0",
		  "@typescript-eslint/parser": "^8.70.0",
		  "builtin-modules": "^5.0.0",
		  "esbuild": "^0.28.2",
		  "eslint": "^10.10.0",
		  "jsdom": "^26.1.0",
		  "obsidian": "^1.13.1",
		  "tslib": "^2.6.0",
		  "typescript": "^5.9.3",
		  "vitest": "^3.2.7"
		});
	});
});
