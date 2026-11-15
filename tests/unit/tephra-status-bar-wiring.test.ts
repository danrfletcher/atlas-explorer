import { beforeEach, describe, expect, it, vi } from "vitest";
import AtlasPlugin from "../../src/main";
import { AtlasSettingTab, DEFAULT_SETTINGS } from "../../src/settings";
import { TephraStatusBar } from "../../src/tephra-status-bar";
import { TephraStarter } from "../../src/tephra-start";
import { TephraConnection } from "../../src/tephra-connection";
import { App } from "../mocks/obsidian";

// PR-9 (G13): the plugin's half of the status bar: the toggle hides/shows it in the same tick, and the online
// item opens Atlas's settings on the Tephra tab. The plugin is the real class (built without onload).

type P = AtlasPlugin & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const online = () => new TephraConnection({ listSources: async () => ({ ok: true, sources: [{ name: "notes", path: "/n", status: "online" }] }), call: async () => ({ ok: true, result: null }) }, undefined, undefined, undefined, () => () => {});

function build() {
	document.body.innerHTML = "";
	const p = Object.create(AtlasPlugin.prototype) as P;
	const app = new App();
	const settings = { ...DEFAULT_SETTINGS, tephraEnabled: true };
	const tab = new AtlasSettingTab(app as never, p as never);
	Object.assign(p, { app, settings, manifest: { id: "atlas" }, settingTab: tab });
	(app as unknown as { settingTabs: Map<string, unknown> }).settingTabs.set("atlas", tab);
	p.tephraStarter = new TephraStarter({ check: async () => {} });
	p.tephraStatusBar = new TephraStatusBar({
		addItem: () => {
			const el = document.createElement("div");
			document.body.appendChild(el);
			return el;
		},
		openSettings: () => p.openTephraSettings(),
		start: () => {},
	});
	return { p, app, tab };
}

beforeEach(() => vi.useRealTimers());

describe("setTephraEnabled and the status bar", () => {
	it("off removes the item in the same tick, before the controller's teardown has finished", () => {
		const { p } = build();
		const conn = online();
		conn.start();
		p.tephraStatusBar.attach(conn, p.tephraStarter);
		let release: () => void = () => {};
		p.tephraController = { getConnection: () => conn, setEnabled: vi.fn(() => new Promise<void>((resolve) => (release = resolve))) };
		expect(document.querySelector(".atlas-tephra-status")).not.toBeNull();

		const settled = p.setTephraEnabled(false); // not awaited
		expect(document.querySelector(".atlas-tephra-status")).toBeNull();
		release();
		return settled.then(() => conn.stop());
	});

	it("on with a connection already live puts the item back; on with none leaves it to createConnection", async () => {
		const { p } = build();
		p.tephraController = { getConnection: () => null, setEnabled: vi.fn(async () => {}) };
		await p.setTephraEnabled(true);
		expect(document.querySelector(".atlas-tephra-status")).toBeNull();

		const conn = online();
		p.tephraController = { getConnection: () => conn, setEnabled: vi.fn(async () => {}) };
		conn.start();
		await p.setTephraEnabled(true);
		expect(document.querySelectorAll(".atlas-tephra-status")).toHaveLength(1);
		conn.stop();
	});
});

describe("openTephraSettings", () => {
	it("opens the settings window on Atlas's Tephra tab", () => {
		const { p, app, tab } = build();
		const display = vi.spyOn(tab, "display").mockImplementation(() => {}); // the tab's own drawing is tested in tephra-settings
		p.openTephraSettings();
		const setting = (app as unknown as { setting: { isOpen: boolean; openedTabId: string | null } }).setting;
		expect(setting.isOpen).toBe(true);
		expect(setting.openedTabId).toBe("atlas");
		expect(display).toHaveBeenCalled();
		expect((tab as unknown as { activeTab: string }).activeTab).toBe("tephra");
	});

	it("does nothing, and doesn't throw, when this Obsidian has no app.setting", () => {
		const { p, app } = build();
		delete (app as unknown as { setting?: unknown }).setting;
		expect(() => p.openTephraSettings()).not.toThrow();
	});
});
