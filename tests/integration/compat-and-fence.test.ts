import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";

const root = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const data = JSON.parse(readFileSync(join(root, "tests/fixtures/data-v0.2.1.json"), "utf8"));

describe("data compatibility (a v0.2.1 data.json)", () => {
	it("settings keys are the v0.2.1 fixture's keys plus noAutoPromoteFolders", () => {
		// noAutoPromoteFolders is new and absent from the fixture; loading without it yields [] (see main-persistence tests).
		expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...Object.keys(data.settings), "noAutoPromoteFolders"].sort());
	});

	it("persisted AtlasData keys are the v0.2.1 fixture's keys plus PR-2's new fields", () => {
		const main = read("src/main.ts");
		const block = main.slice(main.indexOf("await this.saveData({"), main.indexOf("} satisfies AtlasData"));
		const keys = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
		// PR-2 added dismissedByView/dismissedGlobal/addedItems: absent from this v0.2.1 fixture
		// (so it still proves old-data compatibility), named explicitly so a future key addition
		// doesn't silently hide in this list the way PR-2's did before.
		const newPr2Keys = ["dismissedByView", "dismissedGlobal", "addedItems"];
		expect(keys).toEqual([...Object.keys(data), ...newPr2Keys].sort());
	});

	it("views and promotions load and re-save byte-identical, including after non-matching helper calls", () => {
		const app = new App();
		const persist = vi.fn();
		const views = new ViewsManager(app, structuredClone(data.views), data.activeViewId, persist);
		const index = new UnitIndex(app, data.settings, structuredClone(data.manualPromotions));
		expect(JSON.stringify(views.getViews())).toBe(JSON.stringify(data.views));
		expect(JSON.stringify(index.getManualPromotions())).toBe(JSON.stringify(data.manualPromotions));
		views.convertFileNodesToModule("Nope.md", "Nope", index);
		views.replaceMetaNodeWithUnit("default", "n1", { kind: "folder", path: "X" }); // a unit node: refused
		expect(JSON.stringify(views.getViews())).toBe(JSON.stringify(data.views));
		expect(persist).not.toHaveBeenCalled();
	});
});

describe("fence regression", () => {
	const NEW_FILES = ["src/name-rules.ts", "src/name-dialog.ts", "src/links-notice.ts", "src/test-harness.ts", "src/graduation.ts"];

	it("RG-1/2/3 adds no setting, command or menu item", () => {
		const commands = [...read("src/commands.ts").matchAll(/id: "([^"]+)"/g), ...read("src/f10-commands.ts").matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
		expect(commands.sort()).toEqual(["add-block", "new-view", "open-explorer", "place-active-file-in-view", "rebuild-index", "reveal-active-file", "switch-view"]);
		expect(read("src/settings.ts").match(/new Setting\(/g)).toHaveLength(18); // 17 + "Never auto-promote from these folders"
		for (const f of NEW_FILES) expect(read(f), f).not.toMatch(/addCommand\(|addItem\(|new Setting\(|addSettingTab|registerEditorSuggest/);
		const wired = [...readdirSync(join(root, "src"))].filter((f) => f.endsWith(".ts")).filter((f) => /openNameDialog/.test(read(`src/${f}`)));
		expect(wired.sort()).toEqual(["create-from-meta.ts", "create-module.ts", "main.ts", "name-dialog.ts", "test-harness.ts"]); // main.ts: graduation's clash dialog (PR-2); create-module.ts: PR-3; create-from-meta.ts: PR-4
	});

	it("RG-6 UI strings in the new files never say 'promote'", () => {
		const uiCall = /(setText|createEl|createDiv|createSpan|Notice|setTitle|setButtonText|setPlaceholder)\(/;
		for (const f of [...NEW_FILES, "src/create-module.ts", "src/create-from-meta.ts"]) {
			for (const line of read(f).split("\n")) {
				if (uiCall.test(line)) expect(line, `${f}: ${line}`).not.toMatch(/promot/i);
			}
		}
		expect(read("src/links-notice.ts")).not.toMatch(/"[^"\n]*promot/i);
		expect(read("src/name-dialog.ts")).toContain('text: "Create"');
	});

	it("RG-5 the helpers expose no reverse conversion and add no undo handler", () => {
		for (const f of NEW_FILES) expect(read(f), f).not.toMatch(/convert\w*ToFile|demote|undo/i);
		for (const f of ["src/views.ts", "src/unit-index.ts"]) {
			expect(read(f), f).not.toMatch(/^\t(convert(?!FileNodesToModule|ManualPromotionToModule)\w*|revert\w*|replaceUnitWith\w*)\(/m);
		}
	});

	it("the test harness is only reachable behind the build-time flag", () => {
		const main = read("src/main.ts");
		expect(main).toMatch(/if \(__ATLAS_TEST__\) this\.register\(registerTestHarness/);
		expect(main.match(/registerTestHarness/g)).toHaveLength(2); // import + gated call
		expect(read("esbuild.config.mjs")).toMatch(/!prod && process\.env\.ATLAS_TEST === "1"/);
	});
});
