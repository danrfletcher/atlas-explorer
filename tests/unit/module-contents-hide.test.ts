import { afterEach, describe, expect, it } from "vitest";
import AtlasPlugin from "../../src/main";
import { StatusesManager } from "../../src/statuses";
import { itemRow, makeModuleRig } from "./module-contents-fixtures";

// atlas-17 PR-3 (G3): hide/unhide persistence per module. Driven through the real modal eye button, the
// real AtlasPlugin methods and the real UnitIndex record, then through the real persistNow/loadFromData
// to prove what lands in data.json. (PR-2's module-contents-hide-unhide.test.ts covers the row visuals,
// the debounce and the link-promotion suppression; this file is the per-module state table.)

afterEach(() => {
	document.body.innerHTML = "";
});

const FILES = ["Mod/a.md", "Mod/b.md", "Mod/sub/c.md", "Other/x.md", "Other/y.md"];
const FOLDERS = ["Mod", "Mod/sub", "Other"];

const eye = (row: HTMLElement) => row.querySelector<HTMLElement>(".atlas-module-item-hide")!;

type Step = { module: string; item: string };
const click = (rig: ReturnType<typeof makeModuleRig>, { module, item }: Step) => {
	const modal = rig.openModal(module);
	eye(itemRow(modal, item)).click();
	modal.close();
};

describe("G3 hide/unhide state per module, as data.json will hold it", () => {
	const cases: { name: string; steps: Step[]; expected: Record<string, string[]> }[] = [
		{ name: "hide one file", steps: [{ module: "Mod", item: "a.md" }], expected: { Mod: ["Mod/a.md"] } },
		{
			name: "hide two files in one module",
			steps: [
				{ module: "Mod", item: "a.md" },
				{ module: "Mod", item: "b.md" },
			],
			expected: { Mod: ["Mod/a.md", "Mod/b.md"] },
		},
		{
			name: "hide in two modules keeps them on separate keys",
			steps: [
				{ module: "Mod", item: "a.md" },
				{ module: "Other", item: "x.md" },
			],
			expected: { Mod: ["Mod/a.md"], Other: ["Other/x.md"] },
		},
		{
			name: "hide then unhide drops the path and the module's empty key",
			steps: [
				{ module: "Mod", item: "a.md" },
				{ module: "Mod", item: "a.md" },
			],
			expected: {},
		},
		{
			name: "toggling a hidden item back to visible removes only that path",
			steps: [
				{ module: "Mod", item: "a.md" },
				{ module: "Mod", item: "b.md" },
				{ module: "Mod", item: "a.md" },
			],
			expected: { Mod: ["Mod/b.md"] },
		},
		{
			name: "three toggles of one file end hidden (no duplicate path)",
			steps: Array.from({ length: 3 }, () => ({ module: "Mod", item: "a.md" })),
			expected: { Mod: ["Mod/a.md"] },
		},
		{ name: "a folder row is hidden by its own path", steps: [{ module: "Mod", item: "sub" }], expected: { Mod: ["Mod/sub"] } },
	];

	it.each(cases)("$name", async ({ steps, expected }) => {
		const rig = makeModuleRig(FILES, FOLDERS);
		for (const step of steps) click(rig, step);
		expect(rig.index.getHiddenModuleItems()).toEqual(expected);

		// Through the real persist and load path.
		const saved: Record<string, unknown>[] = [];
		Object.assign(rig.plugin, {
			statusesManager: new StatusesManager([], [], () => {}),
			saveData: async (d: Record<string, unknown>) => void saved.push(d),
		});
		await (rig.plugin as unknown as { persistNow(): Promise<void> }).persistNow();
		expect(saved).toHaveLength(1);
		const onDisk = JSON.parse(JSON.stringify(saved[0])) as Record<string, unknown>;
		expect(onDisk.hiddenModuleItems).toEqual(expected);

		const reloaded = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(reloaded as unknown as { loadFromData(d: unknown): void }).loadFromData(onDisk);
		const fresh = makeModuleRig(FILES, FOLDERS, (reloaded as unknown as { hiddenModuleItems: Record<string, string[]> }).hiddenModuleItems);
		expect(fresh.index.getHiddenModuleItems()).toEqual(expected);
	});

	it("a reopened modal shows exactly the persisted rows as hidden, and others visible", () => {
		const rig = makeModuleRig(FILES, FOLDERS, { Mod: ["Mod/a.md"], Other: ["Other/y.md"] });
		const mod = rig.openModal("Mod");
		expect(itemRow(mod, "a.md").classList.contains("atlas-module-item-hidden")).toBe(true);
		expect(itemRow(mod, "b.md").classList.contains("atlas-module-item-hidden")).toBe(false);
		const other = rig.openModal("Other");
		expect(itemRow(other, "y.md").classList.contains("atlas-module-item-hidden")).toBe(true);
		expect(itemRow(other, "x.md").classList.contains("atlas-module-item-hidden")).toBe(false);
	});

	it("hiding in one module does not hide the same-named item in another", () => {
		const rig = makeModuleRig(["A/n.md", "B/n.md"], ["A", "B"]);
		click(rig, { module: "A", item: "n.md" });
		expect(rig.plugin.isModuleItemHidden("A", "A/n.md")).toBe(true);
		expect(rig.plugin.isModuleItemHidden("B", "B/n.md")).toBe(false);
	});
});

describe("G3 plugin-level toggles are idempotent", () => {
	it("setModuleItemHidden(true) twice = one entry and one persist; (false) twice = none and no extra persist", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const plugin = rig.plugin;
		plugin.setModuleItemHidden("Mod", "Mod/a.md", true);
		plugin.setModuleItemHidden("Mod", "Mod/a.md", true);
		expect(rig.index.getHiddenModuleItems()).toEqual({ Mod: ["Mod/a.md"] });
		expect(rig.persistDebounced).toHaveBeenCalledTimes(1);

		plugin.setModuleItemHidden("Mod", "Mod/a.md", false);
		plugin.setModuleItemHidden("Mod", "Mod/a.md", false);
		expect(rig.index.getHiddenModuleItems()).toEqual({});
		expect(rig.persistDebounced).toHaveBeenCalledTimes(2);
	});

	it("unhiding something never hidden changes and persists nothing", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		rig.plugin.setModuleItemHidden("Mod", "Mod/a.md", false);
		expect(rig.index.getHiddenModuleItems()).toEqual({});
		expect(rig.persistDebounced).not.toHaveBeenCalled();
	});

	it("hide and unhide change plugin data only: no vault call (F1)", () => {
		const rig = makeModuleRig(FILES, FOLDERS);
		const before = [...rig.app.vault.calls];
		rig.plugin.setModuleItemHidden("Mod", "Mod/a.md", true);
		rig.plugin.setModuleItemHidden("Mod", "Mod/a.md", false);
		expect(rig.app.vault.calls).toEqual(before);
	});
});
