import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AtlasPlugin from "../../src/main";
import { AtlasSettingTab, DEFAULT_SETTINGS, normalizeTephraSettings, normalizeTephraSourceSettings, showsInSearch } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { TephraConnection, type TephraConnectionClient } from "../../src/tephra-connection";
import type { TephraSource, TephraSourcesResult } from "../../src/tephra-client";

interface ToggleState {
	value?: boolean;
	disabled?: boolean;
	onChange?: (v: boolean) => unknown;
}
interface Row {
	name: string;
	desc: string;
	heading: boolean;
	toggles: ToggleState[];
	settingEl: HTMLElement;
	controlEl: HTMLElement;
}

/** `Setting` replaced by a recorder (the technique `mcp-settings.test.ts` uses), except that each row also
 * builds the DOM Obsidian would, so the test can read what the tab shows the way a user sees it. */
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();

	class FakeSetting {
		static rows: Row[] = [];
		private row: Row;
		private nameEl: HTMLElement;
		private descEl: HTMLElement;
		constructor(public containerEl: HTMLElement) {
			const settingEl = containerEl.createDiv({ cls: "setting-item" });
			const info = settingEl.createDiv({ cls: "setting-item-info" });
			this.nameEl = info.createDiv({ cls: "setting-item-name" });
			this.descEl = info.createDiv({ cls: "setting-item-description" });
			const controlEl = settingEl.createDiv({ cls: "setting-item-control" });
			this.row = { name: "", desc: "", heading: false, toggles: [], settingEl, controlEl };
			FakeSetting.rows.push(this.row);
		}
		get controlEl() {
			return this.row.controlEl;
		}
		setName(name: string) {
			this.row.name = name;
			this.nameEl.textContent = name;
			return this;
		}
		setDesc(desc: string) {
			this.row.desc = desc;
			this.descEl.textContent = desc;
			return this;
		}
		setHeading() {
			this.row.heading = true;
			this.row.settingEl.addClass("setting-item-heading");
			return this;
		}
		setClass(cls: string) {
			this.row.settingEl.addClass(cls);
			return this;
		}
		addToggle(cb: (c: { setValue: (v: boolean) => unknown; setDisabled: (v: boolean) => unknown; onChange: (fn: (v: boolean) => unknown) => unknown }) => void) {
			const state: ToggleState = {};
			const component = {
				setValue: (v: boolean) => {
					state.value = v;
					return component;
				},
				setDisabled: (v: boolean) => {
					state.disabled = v;
					return component;
				},
				onChange: (fn: (v: boolean) => unknown) => {
					state.onChange = fn;
					return component;
				},
			};
			cb(component);
			this.row.toggles.push(state);
			return this;
		}
		addText() {
			return this;
		}
		addTextArea() {
			return this;
		}
		addDropdown() {
			return this;
		}
		addButton() {
			return this;
		}
		addExtraButton() {
			return this;
		}
	}

	return { ...actual, Setting: FakeSetting, Platform: { ...actual.Platform, isMobile: false } };
});

const WHOOP: TephraSource = { name: "whoop", path: "/Users/dan/Documents/Whoop", status: "online" };
const TEPHRA: TephraSource = { name: "tephra", path: "/Users/dan/Developer/Tephra", status: "missing" };
const NOTES: TephraSource = { name: "notes", path: "/Users/dan/Documents/Notes", status: "online" };
const down: TephraSourcesResult = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };

async function obsidian() {
	return (await import("obsidian")) as unknown as { Setting: { rows: Row[] }; Platform: { isMobile: boolean }; App: new () => import("obsidian").App };
}

/** A connection whose `source.list` answers are queued by the test. */
function controllableConnection() {
	const pending: Array<(r: TephraSourcesResult) => void> = [];
	const client: TephraConnectionClient = {
		listSources: () => new Promise((resolve) => pending.push(resolve)),
		call: async () => ({ ok: true, result: null }),
	};
	const connection = new TephraConnection(client);
	return {
		connection,
		answer: async (r: TephraSourcesResult) => {
			pending.shift()!(r);
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

async function buildTab(opts: { enabled?: boolean; tephraSourceSettings?: AtlasSettings["tephraSourceSettings"]; connection?: TephraConnection | null } = {}) {
	const { Setting, App } = await obsidian();
	Setting.rows.length = 0;
	const app = new App();
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: opts.enabled ?? false, tephraSourceSettings: opts.tephraSourceSettings ?? {} };
	const state: { connection: TephraConnection | null } = { connection: opts.connection ?? null };
	const plugin = {
		settings,
		app,
		saveSettings: vi.fn(async () => {}),
		setTephraEnabled: vi.fn(async (value: boolean) => {
			settings.tephraEnabled = value;
			if (!value) {
				state.connection?.stop();
				state.connection = null;
			}
		}),
		get tephraConnection() {
			return state.connection;
		},
	};
	const tab = new AtlasSettingTab(app as never, plugin as never);
	const containerEl = document.createElement("div");
	(tab as unknown as { containerEl: HTMLElement }).containerEl = containerEl;
	tab.display();
	const open = () => {
		const button = [...containerEl.querySelectorAll<HTMLButtonElement>(".atlas-settings-tab")].find((b) => b.textContent === "Tephra")!;
		button.click();
	};
	return { tab, plugin, containerEl, rows: Setting.rows, app, state, open };
}

const textOf = (el: Element) => el.textContent ?? "";
const sourceCards = (containerEl: HTMLElement) => [...containerEl.querySelectorAll<HTMLElement>(".atlas-tephra-source")];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the Tephra tab: toggle off (the default)", () => {
	it("adds a Tephra tab button next to Basic and Status", async () => {
		const { containerEl } = await buildTab();
		const labels = [...containerEl.querySelectorAll(".atlas-settings-tab")].map(textOf);
		expect(labels).toEqual(["Basic", "Status", "Tephra"]);
	});

	it("shows the explanation, the repo link, the toggle (off) and the uninstall note, and no list", async () => {
		const { containerEl, rows, open } = await buildTab();
		open();
		const body = containerEl.querySelector(".atlas-settings-body")!;
		expect(textOf(body.querySelector(".atlas-tephra-intro")!)).toMatch(/Tephra is a local program/);
		const link = body.querySelector<HTMLAnchorElement>('a[href="https://github.com/danrfletcher/Tephra"]');
		expect(link).not.toBeNull();
		expect(link!.getAttribute("target")).toBe("_blank");

		const toggleRow = rows.find((r) => r.name === "Turn on Tephra multi-data source vault")!;
		expect(toggleRow.toggles).toHaveLength(1);
		expect(toggleRow.toggles[0].value).toBe(false);
		expect(toggleRow.toggles[0].disabled).not.toBe(true);

		expect(textOf(body.querySelector(".atlas-tephra-uninstall-note")!)).toMatch(/Turn this switch off before uninstalling Atlas/);
		expect(body.querySelector(".atlas-tephra-live")).toBeNull();
		expect(rows.some((r) => r.name === "Sources" || r.name === "Show in Obsidian search & graph")).toBe(false);
		expect(textOf(body)).not.toMatch(/isn't running/);
	});

	it("never builds a connection for the tab: it only reads plugin.tephraConnection", async () => {
		const { plugin, open } = await buildTab();
		open();
		expect(plugin.setTephraEnabled).not.toHaveBeenCalled();
	});

	it("turning the toggle on calls the plugin's setTephraEnabled(true) and redraws the tab", async () => {
		const { plugin, rows, open, containerEl } = await buildTab();
		open();
		const toggle = rows.find((r) => r.name === "Turn on Tephra multi-data source vault")!.toggles[0];
		await toggle.onChange!(true);
		expect(plugin.setTephraEnabled).toHaveBeenCalledWith(true);
		// redrawn: the live section now exists
		expect(containerEl.querySelector(".atlas-tephra-live")).not.toBeNull();
	});

	it("turning it off calls setTephraEnabled(false) and the list goes away", async () => {
		const { connection } = controllableConnection();
		const { plugin, rows, open, containerEl } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		const toggle = rows.filter((r) => r.name === "Turn on Tephra multi-data source vault").at(-1)!.toggles[0];
		expect(toggle.value).toBe(true);
		await toggle.onChange!(false);
		expect(plugin.setTephraEnabled).toHaveBeenCalledWith(false);
		expect(containerEl.querySelector(".atlas-tephra-live")).toBeNull();
	});
});

describe("the Tephra tab: toggle on", () => {
	it("before the first check finishes it says it is checking, not that Tephra isn't running", async () => {
		const { connection } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		expect(textOf(containerEl)).toMatch(/Checking for Tephra/);
		expect(textOf(containerEl)).not.toMatch(/isn't running/);
	});

	it("Tephra not running: says so, with `tephractl daemon install` and the repo link, and no list", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer(down);
		const live = containerEl.querySelector<HTMLElement>(".atlas-tephra-live")!;
		expect(textOf(live)).toContain("Tephra isn't running.");
		expect(live.querySelector("code")!.textContent).toBe("tephractl daemon install");
		expect(live.querySelector('a[href="https://github.com/danrfletcher/Tephra"]')).not.toBeNull();
		expect(sourceCards(containerEl)).toHaveLength(0);
		// the toggle itself stays on
		expect(containerEl.querySelector(".atlas-tephra-uninstall-note")).not.toBeNull();
	});

	it("when the daemon starts, the next check flips the open tab to online without reopening settings", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open, rows } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer(down);
		expect(textOf(containerEl)).toContain("Tephra isn't running.");
		const rowsBefore = rows.length;

		await vi.advanceTimersByTimeAsync(10_000);
		await answer({ ok: true, sources: [NOTES, WHOOP] });
		expect(textOf(containerEl)).toContain("Connected to Tephra.");
		expect(textOf(containerEl)).not.toContain("isn't running");
		expect(sourceCards(containerEl)).toHaveLength(2);
		expect(rows.length).toBeGreaterThan(rowsBefore);
	});

	it("online: lists each source with name, folder path and status", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [NOTES, TEPHRA, WHOOP] });
		const cards = sourceCards(containerEl);
		expect(cards.map((c) => textOf(c.querySelector(".setting-item-name")!))).toEqual(["notes", "tephra", "whoop"]);
		expect(cards.map((c) => textOf(c.querySelector(".setting-item-description")!))).toEqual([NOTES.path, TEPHRA.path, WHOOP.path]);
		expect(cards.map((c) => textOf(c.querySelector(".atlas-tephra-source-status")!))).toEqual(["online", "missing", "online"]);
		expect(cards[1].querySelector(".atlas-tephra-source-status")!.classList.contains("is-missing")).toBe(true);
	});

	it("an offline source shows the offline status", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [{ ...WHOOP, status: "offline" }] });
		expect(textOf(sourceCards(containerEl)[0].querySelector(".atlas-tephra-source-status")!)).toBe("offline");
	});

	it("the vault (notes) row has no toggles; every other row has Show in Obsidian search & graph, on by default", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open, rows } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [NOTES, TEPHRA, WHOOP] });
		const cards = sourceCards(containerEl);
		expect(cards[0].querySelectorAll(".setting-item")).toHaveLength(1); // just its name row
		for (const card of cards.slice(1)) {
			const names = [...card.querySelectorAll(".setting-item-name")].map(textOf);
			expect(names).toContain("Show in Obsidian search & graph");
		}
		const sourceToggles = rows.filter((r) => r.name === "Show in Obsidian search & graph");
		expect(sourceToggles).toHaveLength(2);
		expect(sourceToggles.map((r) => r.toggles[0].value)).toEqual([true, true]);
		const notesRow = rows.find((r) => r.name === "notes")!;
		expect(notesRow.toggles).toHaveLength(0);
	});

	it("a source with a saved off setting shows its toggle off; unknown sources default to on", async () => {
		const { connection, answer } = controllableConnection();
		const { open, rows } = await buildTab({ enabled: true, connection, tephraSourceSettings: { whoop: { showInSearch: false } } });
		connection.start();
		open();
		await answer({ ok: true, sources: [TEPHRA, WHOOP] });
		const values = rows.filter((r) => r.name === "Show in Obsidian search & graph").map((r) => r.toggles[0].value);
		expect(values).toEqual([true, false]);
	});

	it("turning a source's toggle off saves it and adds Sources/<name>/ to Excluded files; turning it on removes exactly that", async () => {
		const { connection, answer } = controllableConnection();
		const { open, rows, plugin, app } = await buildTab({ enabled: true, connection });
		app.vault.setConfig("userIgnoreFilters", ["Private/"]);
		connection.start();
		open();
		await answer({ ok: true, sources: [WHOOP] });
		const toggle = rows.filter((r) => r.name === "Show in Obsidian search & graph").at(-1)!.toggles[0];

		await toggle.onChange!(false);
		expect(plugin.settings.tephraSourceSettings).toEqual({ whoop: { showInSearch: false } });
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(app.vault.getConfig("userIgnoreFilters")).toEqual(["Private/", "Sources/whoop/"]);

		await toggle.onChange!(true);
		expect(plugin.settings.tephraSourceSettings).toEqual({ whoop: { showInSearch: true } });
		expect(app.vault.getConfig("userIgnoreFilters")).toEqual(["Private/"]);
	});

	it("a source toggle refreshes Obsidian's Excluded files pane, so it lists the entry instead of the old list (C31)", async () => {
		const { connection, answer } = controllableConnection();
		const { open, rows, app } = await buildTab({ enabled: true, connection });
		app.vault.setConfig("userIgnoreFilters", ["Private/"]);
		const pane = { listed: ["Private/"] as unknown[] }; // built once by Obsidian, rebuilt only by update()
		const fileTab = { id: "file", update: vi.fn(() => { pane.listed = [...(app.vault.getConfig("userIgnoreFilters") as unknown[])]; }) };
		(app as unknown as { setting: unknown }).setting = { settingTabs: [fileTab] };
		connection.start();
		open();
		await answer({ ok: true, sources: [WHOOP] });
		const toggle = rows.filter((r) => r.name === "Show in Obsidian search & graph").at(-1)!.toggles[0];

		await toggle.onChange!(false);
		expect(pane.listed).toEqual(["Private/", "Sources/whoop/"]);
		await toggle.onChange!(false); // already excluded: nothing changed, nothing to refresh
		expect(fileTab.update).toHaveBeenCalledTimes(1);
		await toggle.onChange!(true);
		expect(pane.listed).toEqual(["Private/"]);
		expect(fileTab.update).toHaveBeenCalledTimes(2);
	});

	it("a source unregistered in Tephra while the tab is open: its row goes on the next check; its saved setting and exclude entry stay", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open, plugin, app } = await buildTab({ enabled: true, connection, tephraSourceSettings: { whoop: { showInSearch: false } } });
		app.vault.setConfig("userIgnoreFilters", ["Sources/whoop/"]);
		connection.start();
		open();
		await answer({ ok: true, sources: [NOTES, WHOOP] });
		expect(sourceCards(containerEl)).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(10_000);
		await answer({ ok: true, sources: [NOTES] });
		expect(sourceCards(containerEl).map((c) => textOf(c.querySelector(".setting-item-name")!))).toEqual(["notes"]);
		expect(plugin.settings.tephraSourceSettings).toEqual({ whoop: { showInSearch: false } });
		expect(app.vault.getConfig("userIgnoreFilters")).toEqual(["Sources/whoop/"]);
	});

	it("Tephra with no sources says so", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [] });
		expect(textOf(containerEl)).toContain("Tephra has no sources yet.");
	});

	it("renders Unicode and very long names and paths in full, in wrap-anywhere containers", async () => {
		const name = "ソース-ñ-" + "long".repeat(60);
		const path = "/Users/dän/Документы/" + "deep/".repeat(80);
		const { connection, answer } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [{ name, path, status: "online" }] });
		const card = sourceCards(containerEl)[0];
		expect(textOf(card.querySelector(".setting-item-name")!)).toBe(name);
		expect(textOf(card.querySelector(".setting-item-description")!)).toBe(path);
		const css = readFileSync(join(__dirname, "../../styles.css"), "utf8");
		expect(css).toMatch(/\.atlas-tephra-source \.setting-item-name,\s*\.atlas-tephra-source \.setting-item-description\s*\{[^}]*overflow-wrap:\s*anywhere/);
		expect(css).toMatch(/\.atlas-tephra-source \.setting-item-info\s*\{[^}]*min-width:\s*0/);
	});

	it("closing the settings window (hide) stops the live updates", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open, tab } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [NOTES] });
		const before = containerEl.innerHTML;
		tab.hide();
		await vi.advanceTimersByTimeAsync(10_000);
		await answer({ ok: true, sources: [NOTES, WHOOP] });
		expect(containerEl.innerHTML).toBe(before);
	});

	it("switching to another tab stops them too, and coming back shows the current state", async () => {
		const { connection, answer } = controllableConnection();
		const { containerEl, open } = await buildTab({ enabled: true, connection });
		connection.start();
		open();
		await answer({ ok: true, sources: [NOTES] });
		[...containerEl.querySelectorAll<HTMLButtonElement>(".atlas-settings-tab")].find((b) => b.textContent === "Basic")!.click();
		await vi.advanceTimersByTimeAsync(10_000);
		await answer({ ok: true, sources: [NOTES, WHOOP] });
		expect(containerEl.querySelector(".atlas-tephra-live")).toBeNull();
		open();
		expect(sourceCards(containerEl)).toHaveLength(2);
	});

	it("an off connection (no live connection object) never throws the tab", async () => {
		const { containerEl, open } = await buildTab({ enabled: true, connection: null });
		expect(() => open()).not.toThrow();
		expect(containerEl.querySelector(".atlas-tephra-live")).not.toBeNull();
	});
});

describe("the Tephra tab: mobile", () => {
	it("shows the Mac-only note, disables the toggle, and shows no list even if a synced data.json says on", async () => {
		const { Platform } = await obsidian();
		Platform.isMobile = true;
		try {
			const { containerEl, rows, open } = await buildTab({ enabled: true });
			open();
			expect(textOf(containerEl.querySelector(".atlas-tephra-mobile-note")!)).toMatch(/Mac only/);
			const toggle = rows.find((r) => r.name === "Turn on Tephra multi-data source vault")!.toggles[0];
			expect(toggle.disabled).toBe(true);
			expect(toggle.value).toBe(false);
			expect(containerEl.querySelector(".atlas-tephra-live")).toBeNull();
			expect(textOf(containerEl)).toMatch(/Turn this switch off before uninstalling Atlas/);
		} finally {
			Platform.isMobile = false;
		}
	});

	it("on desktop there is no Mac-only note", async () => {
		const { containerEl, open } = await buildTab();
		open();
		expect(containerEl.querySelector(".atlas-tephra-mobile-note")).toBeNull();
	});
});

describe("hand-edited data.json values", () => {
	it('tephraEnabled: "yes" and tephraSourceSettings: 5 load as off and {}', () => {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData({ settings: { poolFolder: "_pool", tephraEnabled: "yes", tephraSourceSettings: 5 } });
		expect(plugin.settings.tephraEnabled).toBe(false);
		expect(plugin.settings.tephraSourceSettings).toEqual({});
	});

	it("a missing key (an older data.json) loads as off and {}, and a real value is kept", () => {
		const old = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(old as unknown as { loadFromData(d: unknown): void }).loadFromData({ settings: { poolFolder: "_pool" } });
		expect(old.settings.tephraEnabled).toBe(false);
		expect(old.settings.tephraSourceSettings).toEqual({});

		const kept = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(kept as unknown as { loadFromData(d: unknown): void }).loadFromData({ settings: { poolFolder: "_pool", tephraEnabled: true, tephraSourceSettings: { whoop: { showInSearch: false } } } });
		expect(kept.settings.tephraEnabled).toBe(true);
		expect(kept.settings.tephraSourceSettings).toEqual({ whoop: { showInSearch: false } });
	});

	it("the loaded settings never share DEFAULT_SETTINGS' tephraSourceSettings object", async () => {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin;
		(plugin as unknown as { app: unknown }).app = new (await obsidian()).App();
		(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(null);
		expect(plugin.settings.tephraSourceSettings).not.toBe(DEFAULT_SETTINGS.tephraSourceSettings);
		plugin.settings.tephraSourceSettings.whoop = { showInSearch: false };
		expect(DEFAULT_SETTINGS.tephraSourceSettings).toEqual({});
	});

	it.each([
		[5, {}],
		["x", {}],
		[null, {}],
		[undefined, {}],
		[[], {}],
		[[{ showInSearch: false }], {}],
		[true, {}],
		[{ whoop: { showInSearch: false }, tephra: { showInSearch: true } }, { whoop: { showInSearch: false }, tephra: { showInSearch: true } }],
		[{ whoop: {} }, { whoop: { showInSearch: true } }],
		[{ whoop: { showInSearch: "no" } }, { whoop: { showInSearch: true } }],
		[{ whoop: 5, tephra: null, notes: [], ok: { showInSearch: false } }, { ok: { showInSearch: false } }],
	])("normalizeTephraSourceSettings(%j) is %j", (raw, expected) => {
		expect(normalizeTephraSourceSettings(raw)).toEqual(expected);
	});

	it("a __proto__ key in data.json is dropped, not applied as a prototype", () => {
		const raw = JSON.parse('{"__proto__": {"showInSearch": false}, "whoop": {"showInSearch": false}}');
		const result = normalizeTephraSourceSettings(raw);
		expect(Object.keys(result)).toEqual(["whoop"]);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	});

	it("normalizeTephraSettings applies each rule to its own key", () => {
		expect(normalizeTephraSettings({ tephraEnabled: "yes", tephraSourceSettings: 5, tephraLinkFallback: 1 })).toEqual({ tephraEnabled: false, tephraSourceSettings: {}, tephraLinkFallback: false });
		expect(normalizeTephraSettings({ tephraEnabled: true, tephraSourceSettings: { a: { showInSearch: false } }, tephraLinkFallback: true })).toEqual({
			tephraEnabled: true,
			tephraSourceSettings: { a: { showInSearch: false } },
			tephraLinkFallback: true,
		});
	});

	it("showsInSearch is true for a source with no entry, including names that match Object.prototype members", () => {
		const settings = { tephraSourceSettings: { whoop: { showInSearch: false } } };
		expect(showsInSearch(settings, "whoop")).toBe(false);
		expect(showsInSearch(settings, "tephra")).toBe(true);
		expect(showsInSearch(settings, "constructor")).toBe(true);
		expect(showsInSearch(settings, "toString")).toBe(true);
	});
});
