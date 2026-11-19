/** Shared rig for the G8 `[[` popup tests: the real `AtlasLinkSuggest` over the shared Obsidian mock, a real
 * `SourceLinkController` (so the resolver is the production one) and a real `TephraConnection` over a fake
 * Tephra client. Not a `*.test.ts` file, so vitest's glob skips it. */
import { vi } from "vitest";
import { App, TFile } from "obsidian";
import type { Editor, EditorSuggestContext } from "obsidian";
import { AtlasLinkSuggest } from "../src/link-suggest";
import type AtlasPlugin from "../src/main";
import { DEFAULT_SETTINGS, type AtlasSettings } from "../src/settings";
import { SourceLinkController } from "../src/source-link-controller";
import type { TephraCallResult, TephraSource, TephraSourcesResult } from "../src/tephra-client";
import { TephraConnection, type TephraConnectionClient } from "../src/tephra-connection";
import { UnitIndex } from "../src/unit-index";
import { seedPaths } from "./sources-vault";

/** The vault the spec's fixture describes. */
export const SPEC_PATHS = [
	"Weekly Review.md",
	"Sources/whoop/Workout Plan.md",
	"Sources/whoop/Leg Day.md",
	"Sources/tephra/README.md",
	"Sources/tephra/crates/tephrad/README.md",
	"Sources/tephra/crates/tephrad/src/registry.rs",
];

export const SPEC_SOURCES: TephraSource[] = [
	{ name: "notes", path: "/vault", status: "online" },
	{ name: "whoop", path: "/data/whoop", status: "online" },
	{ name: "tephra", path: "/code/tephra", status: "online" },
];

export type CallHandler = (method: string, params: unknown) => Promise<TephraCallResult> | TephraCallResult;

export interface RigOptions {
	paths?: string[];
	/** The Tephra toggle (`settings.tephraEnabled`). */
	enabled?: boolean;
	/** The Q13 fallback mode instead of the link hook. */
	fallback?: boolean;
	/** `source.list` answer; null means Tephra is unreachable (offline). */
	sources?: TephraSource[] | null;
	/** Answers `unit.search` / `block.ensure_id`. Defaults to an error saying nothing was set up. */
	onCall?: CallHandler;
	tephraLinks?: Record<string, string>;
	/** Runs after the vault is seeded, before the unit index is built. */
	prepare?: (app: App) => void;
}

export async function buildRig(options: RigOptions = {}) {
	const app = new App();
	seedPaths(app, options.paths ?? SPEC_PATHS);
	options.prepare?.(app);
	const enabled = options.enabled ?? true;
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, tephraEnabled: enabled, tephraLinkFallback: options.fallback === true, tephraLinks: options.tephraLinks ?? {} };
	const index = new UnitIndex(app, { ...settings }, [], {}, [], []);
	index.rebuild();

	const calls: Array<{ method: string; params: unknown }> = [];
	const listSources = vi.fn(async (): Promise<TephraSourcesResult> => {
		if (options.sources === null) return { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };
		return { ok: true, sources: options.sources ?? SPEC_SOURCES };
	});
	const client: TephraConnectionClient = {
		listSources,
		call: async (method, params) => {
			calls.push({ method, params });
			const handler = options.onCall ?? (() => ({ ok: false, error: { kind: "rpc", message: "no handler" } }) as TephraCallResult);
			return handler(method, params);
		},
	};
	const connection = new TephraConnection(client, () => () => {});

	const sourceLinks = new SourceLinkController(app, () => ({ tephraEnabled: enabled, tephraLinkFallback: options.fallback === true }), undefined, vi.fn());
	sourceLinks.sync();

	// What the vault says the plain link `[[X]]` is today, so a test can tell "exactly as today" from the G8 rule.
	(app.fileManager as unknown as { generateMarkdownLink: (f: TFile, from: string, subpath?: string, alias?: string) => string }).generateMarkdownLink = (f, _from, subpath, alias) =>
		`[[TODAY:${f.path}${subpath ?? ""}${alias ? `|${alias}` : ""}]]`;

	const plugin = {
		app,
		settings,
		unitIndex: index,
		sourceLinks,
		get tephraConnection() {
			return enabled ? connection : null;
		},
	} as unknown as AtlasPlugin;
	const suggest = new AtlasLinkSuggest(plugin);

	if (enabled) {
		connection.start();
		await connection.check();
	}
	return { app, settings, index, suggest, connection, calls, listSources, sourceLinks, plugin, dispose: () => { connection.stop(); sourceLinks.dispose(); } };
}

export type Rig = Awaited<ReturnType<typeof buildRig>>;

export interface Item {
	kind: string;
	text: string;
	pill?: string;
	secondary?: string;
	name?: string;
	missing?: boolean;
	all?: boolean;
	file?: { path: string };
}

export const suggestionsFor = async (rig: Rig, query: string, fromPath: string): Promise<Item[]> =>
	(await rig.suggest.getSuggestions({ query, file: { path: fromPath } } as unknown as EditorSuggestContext)) as unknown as Item[];

/** Opens the popup context the way Obsidian does on a `[[` trigger: `line` is the text of the line up to the
 * cursor, so `start` is where the `[[` is and `end` the cursor. */
export function openAt(rig: Rig, line: string, fromPath: string, lineAfterCursor = ""): { replaceRange: ReturnType<typeof vi.fn>; setCursor: ReturnType<typeof vi.fn>; context: EditorSuggestContext } {
	const replaceRange = vi.fn();
	const setCursor = vi.fn();
	const open = line.lastIndexOf("[[");
	const context = {
		file: { path: fromPath },
		editor: { getLine: () => line + lineAfterCursor, replaceRange, setCursor },
		start: { line: 0, ch: open },
		end: { line: 0, ch: line.length },
		query: line.slice(open + 2),
	} as unknown as EditorSuggestContext;
	(rig.suggest as unknown as { context: EditorSuggestContext }).context = context;
	return { replaceRange, setCursor, context };
}

export const stubEditor = (line: string): Editor => ({ getLine: () => line }) as unknown as Editor;

/** `onTrigger` for the typed `line` from the note at `fromPath` (which must exist in the rig's vault). */
export function triggerFor(rig: Rig, line: string, fromPath: string) {
	const file = rig.app.vault.getAbstractFileByPath(fromPath) as TFile;
	return rig.suggest.onTrigger({ line: 0, ch: line.length }, stubEditor(line), file);
}

export const texts = (items: Item[]): string[] => items.map((item) => item.text);
