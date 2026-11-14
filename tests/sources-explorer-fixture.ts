/** PR-4 (G1): the real explorer against the `tests/fixtures/sources-vault/` vault and a Tephra answering over HTTP.
 *
 * Real: `UnitIndex`, `ViewsManager`, `AtlasExplorerView` (its `onOpen` subscriptions, `render()`, row wiring, drag
 * and drop, menus, "+"), `TephraClient`, `TephraConnection` and the vault-side wiring `main.ts` uses
 * (`refreshExplorersOnTephraChange`). Stand-ins: Obsidian itself (the shared mock, seeded with the fixture's files
 * as real `TFile`/`TFolder`s), jsdom's missing layout (the section harness), the Tephra daemon (PR-2's fake server,
 * on an ephemeral port, now also answering `unit.list`) and its push channel (`push()` is what a `graph:changed`
 * frame looks like to the client). Not a `*.test.ts` file, so vitest's include glob skips it. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { App } from "obsidian";
import { refreshExplorersOnTephraChange } from "../src/explorer-view";
import { DEFAULT_SETTINGS, type AtlasSettings } from "../src/settings";
import { TephraClient, type TephraRequestFn, type TephraSocketFn, type TephraSocketParams } from "../src/tephra-client";
import { TephraConnection } from "../src/tephra-connection";
import { UnitIndex } from "../src/unit-index";
import { ViewsManager } from "../src/views";
import { startFakeTephra } from "./fixtures/fake-tephra-server.mjs";
import { makeSectionHarness, SectionHarness } from "./explorer-header-fixtures";
import { seedPaths, sourcesVaultPaths } from "./sources-vault";
import { makeStatusesManager } from "./unit/explorer-view-sort-truncate-helpers";

export interface FakeEntry {
	name: string;
	kind: "folder" | "markdown" | "file";
}
export type FakeListing = FakeEntry[] | { entries: FakeEntry[]; offline: boolean };
export interface FakeSourceRow {
	name: string;
	path: string;
	status: "online" | "missing";
}

/** The top-level entries of `Sources/<name>/` in the fixture vault, as Tephra's `unit.list` reports them. */
export function fixtureEntries(name: string, paths: readonly string[] = sourcesVaultPaths()): FakeEntry[] {
	const root = `Sources/${name}/`;
	const byName = new Map<string, FakeEntry>();
	for (const path of paths) {
		if (!path.startsWith(root)) continue;
		const rest = path.slice(root.length);
		const slash = rest.indexOf("/");
		const entry = slash === -1 ? rest : rest.slice(0, slash);
		byName.set(entry, { name: entry, kind: slash !== -1 ? "folder" : rest.endsWith(".md") ? "markdown" : "file" });
	}
	return [...byName.values()];
}

export interface SourcesRig {
	h: SectionHarness;
	app: App;
	settings: AtlasSettings;
	unitIndex: UnitIndex;
	viewsManager: ViewsManager;
	connection: TephraConnection;
	/** What the fake daemon answers; change it, then `push()` or `check()`. */
	daemon: { sources: FakeSourceRow[]; units: Record<string, FakeListing>; requests: Array<{ method: string; params: unknown }> };
	plugin: Record<string, unknown>;
	/** A `graph:changed` frame on the push channel, then everything it sets going (the check, the queued render). */
	push: () => Promise<void>;
	/** One Tephra check (as a focus check does), then the render it queues. */
	check: () => Promise<void>;
	/** Waits for the explorer's queued and in-flight renders. */
	settle: () => Promise<void>;
	teardown: () => Promise<void>;
}

const TOKEN = "c".repeat(64);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function makeSourcesRig(
	options: { sources?: FakeSourceRow[]; settings?: Partial<AtlasSettings>; vaultPaths?: readonly string[]; units?: Record<string, FakeListing> } = {}
): Promise<SourcesRig> {
	const vaultPaths = options.vaultPaths ?? sourcesVaultPaths();
	const app = new App();
	seedPaths(app, vaultPaths);
	(app.workspace as unknown as { on: unknown }).on = vi.fn(() => ({}));
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: true, ...options.settings };
	const unitIndex = new UnitIndex(app, settings, [], {}, [], []);
	unitIndex.rebuild();
	const viewsManager = new ViewsManager(app, [], "", () => {});

	const dir = mkdtempSync(join(tmpdir(), "atlas-sources-rig-"));
	const tokenFile = join(dir, "token");
	writeFileSync(tokenFile, TOKEN);
	const daemon: SourcesRig["daemon"] = {
		sources: options.sources ?? [
			{ name: "tephra", path: "/home/user/Developer/Tephra", status: "online" },
			{ name: "whoop", path: "/home/user/Documents/Whoop", status: "online" },
		],
		units: options.units ?? { tephra: fixtureEntries("tephra", vaultPaths), whoop: fixtureEntries("whoop", vaultPaths) },
		requests: [],
	};
	const fake = await startFakeTephra({ port: 0, tokenFile, sources: (() => daemon.sources) as never, units: (() => daemon.units) as never });
	const request: TephraRequestFn = async ({ url, method, headers, body }) => {
		daemon.requests.push(JSON.parse(body) as { method: string; params: unknown });
		const response = await fetch(url.replace(":4812", `:${fake.port}`), { method, headers, body });
		return { status: response.status, text: await response.text() } as Awaited<ReturnType<TephraRequestFn>>;
	};
	let socket: TephraSocketParams | null = null;
	const openSocket: TephraSocketFn = async (params) => {
		socket = params;
		return { kind: "open", handle: { close: () => {} } };
	};
	const client = new TephraClient({ request, tokenPath: () => tokenFile, openSocket });
	const connection = new TephraConnection(client);

	const plugin: Record<string, unknown> = {
		app,
		settings,
		unitIndex,
		viewsManager,
		statusesManager: makeStatusesManager(),
		folderSourcePathStore: { get: () => undefined },
		apiHeadersStore: { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => ({}) },
		freeBlockTextCache: undefined,
		flushSave: vi.fn(async () => {}),
		saveManualPromotions: vi.fn(),
		isModuleFolderExpanded: vi.fn(() => false),
		setModuleFolderExpanded: vi.fn(),
		isModuleItemHidden: vi.fn(() => false),
		moduleHiddenBy: vi.fn(() => null),
		setModuleItemHidden: vi.fn(),
		tephraConnection: connection,
	};
	const h = makeSectionHarness({ real: plugin });
	const explorer = h.explorer as unknown as {
		leaf: unknown;
		registerEvent: unknown;
		registerDomEvent: (el: EventTarget, type: string, cb: (evt: Event) => void, opts?: boolean | AddEventListenerOptions) => void;
		onOpen: () => Promise<void>;
		onClose: () => Promise<void>;
		awaitRenderSettled: () => Promise<void>;
	};
	const removers: Array<() => void> = [];
	explorer.leaf = {};
	explorer.registerEvent = vi.fn();
	explorer.registerDomEvent = (el, type, cb, opts) => {
		el.addEventListener(type, cb, opts);
		removers.push(() => el.removeEventListener(type, cb, opts));
	};
	// The same subscription `main.ts` makes, over the one pane that is open.
	const unsubscribe = refreshExplorersOnTephraChange(connection, () => [h.explorer]);
	connection.start();
	await connection.check();
	await explorer.onOpen();

	const settle = async () => {
		await tick(); // a queued render is a zero-delay timeout
		await explorer.awaitRenderSettled();
	};
	await settle(); // `onOpen` queues its first render
	return {
		h,
		app,
		settings,
		unitIndex,
		viewsManager,
		connection,
		daemon,
		plugin,
		settle,
		check: async () => {
			await connection.check();
			await settle();
		},
		push: async () => {
			if (!socket) throw new Error("Tephra's push channel was never opened");
			socket.onText(JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: { source: "tephra" } }));
			await connection.check(); // joins the check the push started
			await settle();
		},
		teardown: async () => {
			unsubscribe();
			connection.stop();
			await explorer.onClose().catch(() => {});
			for (const remove of removers) remove();
			h.teardown();
			await fake.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Rows' text in one Inbox section. */
export const sectionRows = (section: Element): string[] => [...section.querySelectorAll(".atlas-inbox-spacer .atlas-row")].map((el) => (el.querySelector(".atlas-row-text")?.textContent ?? ""));
export const sectionEl = (h: SectionHarness, name: string | null): HTMLElement => h.panel().querySelector<HTMLElement>(name === null ? ".atlas-inbox:not(.atlas-inbox-source)" : `.atlas-inbox-source[data-source="${name}"]`)!;
export const sectionTitles = (h: SectionHarness): string[] => [...h.panel().querySelectorAll(".atlas-inbox > .atlas-section-header .atlas-section-title")].map((el) => el.textContent ?? "");
export const rowByKey = (h: SectionHarness, key: string): HTMLElement => h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-select-key="${key}"]`)!;
