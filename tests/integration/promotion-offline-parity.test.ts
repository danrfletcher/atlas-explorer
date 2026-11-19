import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Platform } from "obsidian";
import type { CachedMetadata, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { TephraConnection, type TephraConnectionClient } from "../../src/tephra-connection";
import type { TephraPushHandlers, TephraPushResult, TephraSourcesResult } from "../../src/tephra-client";
import { TephraGraphSync } from "../../src/tephra-graph-sync";
import { seedRoot } from "../helpers";

// G12: promotion across sources, through the real `UnitIndex` and `TephraGraphSync` with a fake PR-2 client that
// serves `graph.get_edges` fixture JSON. Note links come from Obsidian's cache; non-note links from Tephra.

const link = (name: string) => ({ link: name, original: `[[${name}]]`, displayText: name, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } });
const cacheOf = (...names: string[]) => ({ links: names.map(link) }) as CachedMetadata;
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ from, to: { resolved: to }, to_raw: to, kind: "wikilink", offline: false, line: 3, ...extra });

const FILES = [
	"Home.md",
	"scripts/deploy.sh", // a vault code file: no Obsidian cache
	"Private/notes.pdf",
	"Sources/demo/README.md",
	"Sources/demo/crates/core/src/registry.rs",
	"Sources/demo/crates/Core.md",
	"Sources/demo/scripts/build.sh",
	"Sources/demo/docs/guide/Setup.md",
	"Sources/demo/docs/Leg Day.md",
	"Sources/demo/docs/Private/Hidden.md",
	"Sources/demo/docs/Private/scan.pdf", // a code/PDF-like file under an excludable folder: no Obsidian cache
	"Sources/whoop/Workout Plan.md",
	"Sources/whoop/deep/Plan.md",
];
const FOLDERS = ["Sources", "Sources/demo", "Sources/demo/crates", "Sources/demo/crates/core", "Sources/demo/crates/core/src", "Sources/demo/scripts", "Sources/demo/docs", "Sources/demo/docs/guide", "Sources/demo/docs/Private", "Sources/whoop", "Sources/whoop/deep", "scripts", "Private"];
const NOTE_RESOLVE: Record<string, string> = { Setup: "Sources/demo/docs/guide/Setup.md", "Workout Plan": "Sources/whoop/Workout Plan.md", Plan: "Sources/whoop/deep/Plan.md" };
const CACHE_FREE = new Set(["scripts/deploy.sh", "Private/notes.pdf", "Sources/demo/crates/core/src/registry.rs", "Sources/demo/scripts/build.sh", "Sources/demo/docs/Private/scan.pdf"]);

function make(caches: Record<string, CachedMetadata>, settings: Partial<AtlasSettings> = {}, noCache: Iterable<string> = CACHE_FREE) {
	const app = new App();
	seedRoot(app, FILES, FOLDERS);
	const free = new Set(noCache);
	app.metadataCache.getFileCache = ((file: TFile) => (caches[file.path] ?? (free.has(file.path) && file.path.endsWith(".md") ? null : {}))) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const dest = NOTE_RESOLVE[linkpath];
		return dest ? (app.vault.getAbstractFileByPath(dest) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, tephraEnabled: true, ...settings }, []);
	index.rebuild();
	return { app, index };
}
const sourceUnits = (index: UnitIndex) => index.getUnits().filter((u) => u.path.startsWith("Sources/") && u.type.startsWith("promoted")).map((u) => `${u.type}:${u.path}`).sort();
const REGISTRY = "Sources/demo/crates/core/src/registry.rs";
const SETUP = "Sources/demo/docs/guide/Setup.md";

beforeEach(() => {
	Platform.isMobile = false;
});

/** A client serving `graph.get_edges`; `fail()` makes every later call fail. */
function fakeClient(edges: unknown[]) {
	let failing = false;
	let edgeCalls = 0;
	let answer = edges;
	let list: TephraSourcesResult = { ok: true, sources: [{ name: "demo", path: "/d", status: "online" }] };
	const opens: TephraPushHandlers[] = [];
	const client: TephraConnectionClient = {
		listSources: async () => (failing ? { ok: false, error: { kind: "network", message: "down" } } : list),
		call: async (method) => {
			if (method === "graph.get_edges") edgeCalls++;
			return failing || method !== "graph.get_edges" ? { ok: false, error: { kind: "network", message: "down" } } : { ok: true, result: answer };
		},
		openPush: (handlers): Promise<TephraPushResult> => {
			opens.push(handlers);
			return Promise.resolve({ ok: true, handle: { close() {} } });
		},
	};
	return {
		client,
		opens,
		fail: () => (failing = true),
		setEdges: (next: unknown[]) => (answer = next),
		get edgeCalls() {
			return edgeCalls;
		},
		setList: (next: TephraSourcesResult) => (list = next),
	};
}

describe("note links promote the same online and offline (G12)", () => {
	const caches = { "Home.md": cacheOf("Setup", "Plan"), "Sources/demo/crates/Core.md": cacheOf("Setup") };

	it("the Obsidian-cache result is the same every time, with no Tephra data at all", () => {
		const first = sourceUnits(make(caches).index);
		const second = sourceUnits(make(caches).index);
		expect(second).toEqual(first);
		expect(first).toEqual([`promoted-file:${SETUP}`, "promoted-file:Sources/whoop/deep/Plan.md"]);
	});

	it("a Tephra answer with note edges in it changes nothing: those links come through Obsidian's cache alone", () => {
		const { index } = make(caches);
		const before = sourceUnits(index);
		index.setTephraEdges(parse([edge("@notes:Home.md", "@demo:docs/guide/Setup.md"), edge("@demo:docs/Leg Day.md", "@demo:docs/guide/Setup.md")]));
		expect(sourceUnits(index)).toEqual(before);
	});
});

function parse(rows: unknown[]) {
	return rows.map((row) => {
		const r = row as { from: string; to: { resolved: string }; to_raw: string; line: number | null; kind: string; offline: boolean };
		const hash = r.to_raw.indexOf("#");
		return { from: r.from, to: r.to.resolved, toRaw: r.to_raw, subpath: hash === -1 ? "" : r.to_raw.slice(hash + 1), line: r.line, kind: r.kind, offline: r.offline };
	});
}

describe("non-note links from Tephra (G12)", () => {
	it("a code file's link promotes the deeper file it names, in its source's section", () => {
		const { index } = make({});
		expect(sourceUnits(index)).toEqual([]);
		expect(index.setTephraEdges(parse([edge("@demo:scripts/build.sh", `@demo:crates/core/src/registry.rs`), edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md")]))).toBe(true);
		expect(sourceUnits(index)).toEqual([`promoted-file:${REGISTRY}`, `promoted-file:${SETUP}`]);
		expect(index.getUnits().filter((u) => !u.path.startsWith("Sources/") && u.type.startsWith("promoted"))).toEqual([]);
	});

	it("a link from the same module does not promote (a code file in the same top-level folder)", () => {
		const { index } = make({});
		index.setTephraEdges(parse([edge("@demo:crates/core/src/registry.rs", "@demo:crates/Core.md")]));
		expect(sourceUnits(index)).toEqual([]);
	});

	it("a vault code file or PDF linking into a source counts as from outside", () => {
		const { index } = make({});
		index.setTephraEdges(parse([edge("@notes:scripts/deploy.sh", "@demo:docs/guide/Setup.md"), edge("@notes:Private/notes.pdf", "@whoop:deep/Plan.md")]));
		expect(sourceUnits(index)).toEqual([`promoted-file:${SETUP}`, "promoted-file:Sources/whoop/deep/Plan.md"]);
	});

	it("honours excludedFolders for a vault origin, as for a vault link", () => {
		const { index } = make({}, { excludedFolders: ["scripts"] });
		index.setTephraEdges(parse([edge("@notes:scripts/deploy.sh", "@demo:docs/guide/Setup.md")]));
		expect(sourceUnits(index)).toEqual([]);
	});

	// R1: an `excludedFolders` entry under Sources/<name>/ is held to as for a vault path, for Tephra's edges too.
	describe("excludedFolders under Sources/<name>/ (R1)", () => {
		const PRIVATE = { excludedFolders: ["Sources/demo/docs/Private"] };
		const HIDDEN = "promoted-file:Sources/demo/docs/Private/Hidden.md";
		const toHidden = () => parse([edge("@demo:scripts/build.sh", "@demo:docs/Private/Hidden.md")]);
		const fromScan = () => parse([edge("@demo:docs/Private/scan.pdf", "@demo:crates/core/src/registry.rs")]);

		it("control: with no exclusion both edges promote", () => {
			const a = make({}).index;
			a.setTephraEdges(toHidden());
			expect(sourceUnits(a)).toEqual([HIDDEN]);
			const b = make({}).index;
			b.setTephraEdges(fromScan());
			expect(sourceUnits(b)).toEqual([`promoted-file:${REGISTRY}`]);
		});

		it("an edge into an excluded folder promotes nothing", () => {
			const { index } = make({}, PRIVATE);
			index.setTephraEdges(toHidden());
			expect(sourceUnits(index)).toEqual([]);
		});

		it("an edge from a file inside an excluded folder promotes nothing", () => {
			const { index } = make({}, PRIVATE);
			index.setTephraEdges(fromScan());
			expect(sourceUnits(index)).toEqual([]);
		});

		it("an edge into an excluded folder from a vault code file promotes nothing either", () => {
			const { index } = make({}, PRIVATE);
			index.setTephraEdges(parse([edge("@notes:scripts/deploy.sh", "@demo:docs/Private/Hidden.md")]));
			expect(sourceUnits(index)).toEqual([]);
		});
	});

	it("a block edge whose target id carries no subpath but whose raw text does promotes the block only too", () => {
		const { index } = make({});
		index.setTephraEdges(parse([edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md", { to_raw: "Setup#^k1" })]));
		expect(sourceUnits(index)).toEqual([`promoted-block:${SETUP}`]);
	});

	it("a block edge promotes the block only, never the file", () => {
		const { index } = make({});
		index.setTephraEdges(parse([edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md#^k1", { to_raw: "Setup#^k1" })]));
		expect(sourceUnits(index)).toEqual([`promoted-block:${SETUP}`]);
	});

	it("skips, silently, an edge naming an unknown or removed source, a path with no vault file, a self-link, or a target outside every source", () => {
		const { index } = make({});
		index.setTephraEdges(
			parse([
				edge("@gone:x.sh", "@demo:docs/guide/Setup.md"),
				edge("@demo:no/such.sh", "@demo:docs/guide/Setup.md"),
				edge("@demo:scripts/build.sh", "@gone:x.md"),
				edge("@demo:scripts/build.sh", "@demo:scripts/build.sh"),
				edge("@demo:scripts/build.sh", "@notes:Home.md"),
			])
		);
		expect(sourceUnits(index)).toEqual([]);
	});

	it("never reads an edge whose origin is a note Obsidian indexes, so a code fence in a note stays inert even if Tephra reports it", () => {
		const { index } = make({ "Home.md": cacheOf() }); // Home.md has a cache and no resolved links: its only link sits in a fence
		index.setTephraEdges(parse([edge("@notes:Home.md", "@demo:docs/guide/Setup.md"), edge("@demo:docs/Leg Day.md", "@demo:docs/guide/Setup.md")]));
		expect(sourceUnits(index)).toEqual([]);
	});

	it("a code file whose Obsidian cache is {} (what live Obsidian 1.14.4 returns, not null) still promotes through its edge", () => {
		const { app, index } = make({});
		expect(app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Sources/demo/scripts/build.sh") as TFile)).toEqual({});
		index.setTephraEdges(parse([edge("@demo:scripts/build.sh", "@demo:crates/core/src/registry.rs")]));
		expect(sourceUnits(index)).toEqual([`promoted-file:${REGISTRY}`]);
	});

	it("a source hidden from Obsidian (its notes have no cache) still promotes, through Tephra's edge", () => {
		const hidden = [...CACHE_FREE, "Sources/demo/crates/Core.md", "Sources/demo/docs/Leg Day.md"];
		const { index } = make({}, {}, hidden);
		index.setTephraEdges(parse([edge("@demo:crates/Core.md", "@demo:docs/guide/Setup.md")]));
		expect(sourceUnits(index)).toEqual([`promoted-file:${SETUP}`]);
	});

	it("the same edges twice give the same units, and an empty answer afterwards removes them", () => {
		const { index } = make({});
		const edges = parse([edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md")]);
		index.setTephraEdges(edges);
		expect(index.setTephraEdges(edges)).toBe(false);
		expect(sourceUnits(index)).toHaveLength(1);
		expect(index.setTephraEdges([])).toBe(true);
		expect(sourceUnits(index)).toEqual([]);
	});

	it("an edge set held while the toggle is off promotes nothing, and nothing per source is derived", () => {
		const { index } = make({}, { tephraEnabled: false });
		index.setTephraEdges(parse([edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md")]));
		expect(index.getUnits().filter((u) => u.type.startsWith("promoted"))).toEqual([]);
	});

	// G12 / spec: "`computePromotions` with 5,000 non-note edges plus the existing vault stays within 2x today's logged
	// `promotions recomputed in` time". The vault is big enough (3,000 notes, 9,000 links) for the base time to be real and
	// there is no floor: the edge run must be under twice the vault-only run. The 5,000 edges are 5,000 distinct
	// (from, to) pairs (50 code files x 100 docs), so `setTephraEdges`' dedupe keeps all of them. The two kinds of run are
	// interleaved, one pair after another, so load from parallel test workers hits both alike; each side takes its minimum
	// over many runs, and the whole measurement may repeat up to 3 times, so a loaded machine can't fail it but a real 2x
	// breach (which fails every attempt) still does.
	it("5,000 non-note edges recompute within 2x of the vault-only time, on a 3,000-note vault", () => {
		const NOTES = 3000;
		const MODULES = 30;
		const CODE = 50;
		const DOCS = 100;
		const notePath = (i: number) => `M${i % MODULES}/n${i}.md`;
		const codePath = (c: number) => `m${c % 5}/code${c}.rs`;
		const docPath = (d: number) => `t${d % 10}/doc${d}.md`;
		const noteFiles = Array.from({ length: NOTES }, (_, i) => notePath(i));
		const noteFolders = Array.from({ length: MODULES }, (_, m) => `M${m}`);
		const codeFiles = Array.from({ length: CODE }, (_, c) => `Sources/demo/${codePath(c)}`);
		const targets = Array.from({ length: DOCS }, (_, d) => `Sources/demo/${docPath(d)}`);
		const sourceFolders = ["Sources", "Sources/demo", ...[0, 1, 2, 3, 4].map((m) => `Sources/demo/m${m}`), ...Array.from({ length: 10 }, (_, t) => `Sources/demo/t${t}`)];
		const app = new App();
		seedRoot(app, [...noteFiles, ...codeFiles, ...targets], [...noteFolders, ...sourceFolders]);
		const caches: Record<string, CachedMetadata> = {};
		for (let i = 0; i < NOTES; i++) caches[notePath(i)] = cacheOf(`n${(i * 7 + 1) % NOTES}`, `n${(i * 13 + 5) % NOTES}`, `t${i % DOCS}`);
		const resolve: Record<string, string> = {};
		for (let i = 0; i < NOTES; i++) resolve[`n${i}`] = notePath(i);
		for (let i = 0; i < DOCS; i++) resolve[`t${i}`] = targets[i];
		const free = new Set(codeFiles);
		app.metadataCache.getFileCache = ((file: TFile) => caches[file.path] ?? (free.has(file.path) && file.path.endsWith(".md") ? null : {})) as App["metadataCache"]["getFileCache"];
		app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => (resolve[linkpath] ? app.vault.getAbstractFileByPath(resolve[linkpath]) : null)) as App["metadataCache"]["getFirstLinkpathDest"];
		const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, tephraEnabled: true, excludedFolders: ["Private", "Archive"], tephraExcludes: { demo: ["Sources/demo/t9"] } }, []);
		index.rebuild();

		// 5,000 edges, every (from, to) pair different: code c -> doc d for all c < 50, d < 100.
		const edges = parse(Array.from({ length: CODE * DOCS }, (_, i) => edge(`@demo:${codePath(i % CODE)}`, `@demo:${docPath(Math.floor(i / CODE))}`, { line: (i % 40) + 1 })));
		expect(edges).toHaveLength(5000);
		index.setTephraEdges(edges);
		const held = index as unknown as { tephraLinks: unknown[] };
		const links = held.tephraLinks;
		expect(links).toHaveLength(5000); // dedupe kept every edge, so all 5,000 are timed
		expect(sourceUnits(index).length).toBeGreaterThan(0); // and they are really read

		const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		const timed = (): number => {
			const start = performance.now();
			index.onMetadataResolved();
			return performance.now() - start;
		};
		const measure = (): { base: number; withEdges: number } => {
			const base: number[] = [];
			const withEdges: number[] = [];
			for (let i = 0; i < 15; i++) {
				// alternate which side goes first in the pair, so neither always follows the other
				const order = i % 2 === 0 ? [false, true] : [true, false];
				for (const withTephra of order) {
					held.tephraLinks = withTephra ? links : [];
					(withTephra ? withEdges : base).push(timed());
				}
			}
			return { base: Math.min(...base), withEdges: Math.min(...withEdges) };
		};
		timed(); // warm up
		let last = { base: 0, withEdges: Infinity };
		for (let attempt = 0; attempt < 3; attempt++) {
			last = measure();
			if (last.withEdges < last.base * 2) break;
		}
		held.tephraLinks = links;
		debug.mockRestore();

		expect(last.base).toBeGreaterThan(0.5); // a real base time, not a rounding error
		expect(last.withEdges).toBeLessThan(last.base * 2);
	});
});

describe("TephraGraphSync: the in-memory edge set follows Tephra (G12)", () => {
	afterEach(() => vi.useRealTimers());

	function wire(edges: unknown[], settings: Partial<AtlasSettings> = {}) {
		vi.useFakeTimers();
		const { index } = make({}, settings);
		const fake = fakeClient(edges);
		const connection = new TephraConnection(fake.client);
		const refreshed: boolean[] = [];
		const sync = new TephraGraphSync({
			setEdges: (e) => index.setTephraEdges(e),
			clearEdges: () => index.clearTephraEdges(),
			afterRefresh: (changed) => void refreshed.push(changed),
		});
		sync.bind(connection);
		return { index, fake, connection, sync, refreshed };
	}
	const GRAPH_CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: {} });
	const BUILD_TO_SETUP = [edge("@demo:scripts/build.sh", "@demo:docs/guide/Setup.md")];

	it("fetches when Tephra first answers, and promotes", async () => {
		const { index, connection, fake } = wire(BUILD_TO_SETUP);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.edgeCalls).toBe(1);
		expect(sourceUnits(index)).toEqual([`promoted-file:${SETUP}`]);
	});

	it("50 graph:changed notifications within 1 s cause one recompute", async () => {
		const { index, connection, fake, refreshed } = wire(BUILD_TO_SETUP);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		const recomputes = vi.spyOn(index as unknown as { computePromotions(): void }, "computePromotions");
		const calls = fake.edgeCalls;
		fake.setEdges([...BUILD_TO_SETUP, edge("@demo:scripts/build.sh", "@whoop:deep/Plan.md")]);
		for (let i = 0; i < 50; i++) {
			fake.opens[0].onText(GRAPH_CHANGED);
			await vi.advanceTimersByTimeAsync(10); // 500 ms in all
		}
		expect(fake.edgeCalls).toBe(calls); // nothing yet: still inside the quiet period
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.edgeCalls).toBe(calls + 1);
		expect(recomputes).toHaveBeenCalledTimes(1);
		expect(sourceUnits(index)).toEqual([`promoted-file:${SETUP}`, "promoted-file:Sources/whoop/deep/Plan.md"]);
		expect(refreshed.at(-1)).toBe(true);
	});

	it("a stream that never pauses still refreshes at the max wait", async () => {
		const { connection, fake } = wire(BUILD_TO_SETUP);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		const calls = fake.edgeCalls;
		for (let i = 0; i < 40; i++) {
			fake.opens[0].onText(GRAPH_CHANGED);
			await vi.advanceTimersByTimeAsync(100); // 4 s, never a 300 ms gap
		}
		expect(fake.edgeCalls).toBeGreaterThan(calls);
	});

	it("a timer tick or a source.list check alone does not refetch the graph", async () => {
		const { connection, fake } = wire(BUILD_TO_SETUP);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		const calls = fake.edgeCalls;
		await vi.advanceTimersByTimeAsync(35_000);
		expect(fake.edgeCalls).toBe(calls);
	});

	it("keeps the last answer when Tephra fails: promotions don't flicker, within the session", async () => {
		const { index, connection, fake } = wire(BUILD_TO_SETUP);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		fake.fail();
		fake.opens[0].onText(GRAPH_CHANGED);
		await vi.advanceTimersByTimeAsync(1000);
		expect(sourceUnits(index)).toEqual([`promoted-file:${SETUP}`]);
	});

	it("after a fresh load with Tephra offline, non-note promotions are absent until it returns; then they come back", async () => {
		vi.useFakeTimers();
		const { index } = make({});
		const fake = fakeClient(BUILD_TO_SETUP);
		fake.fail();
		const connection = new TephraConnection(fake.client);
		const sync = new TephraGraphSync({ setEdges: (e) => index.setTephraEdges(e), clearEdges: () => index.clearTephraEdges(), afterRefresh: () => undefined });
		sync.bind(connection);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sourceUnits(index)).toEqual([]);
		// Tephra returns: the next check sees it online and the edges are fetched.
		const back = fakeClient(BUILD_TO_SETUP);
		const online = new TephraConnection(back.client);
		sync.bind(online);
		online.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sourceUnits(index)).toEqual([`promoted-file:${SETUP}`]);
	});

	it("note-link promotions are identical in both states, and edges never become manual promotions (the persisted-keys diff is in tephra-persistence-fence.test.ts)", async () => {
		const caches = { "Home.md": cacheOf("Setup") };
		const online = make(caches).index;
		online.setTephraEdges(parse(BUILD_TO_SETUP));
		const offline = make(caches).index;
		expect(sourceUnits(online).filter((u) => u.includes("Setup"))).toEqual(sourceUnits(offline));
		expect(JSON.stringify(online.getManualPromotions())).toBe("[]");
	});

	it("toggle off: the edges are forgotten, promotions recompute, and no further call is made", async () => {
		const { index, connection, fake, sync, refreshed } = wire(BUILD_TO_SETUP);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sourceUnits(index)).toHaveLength(1);
		const calls = fake.edgeCalls;
		sync.unbind();
		connection.stop();
		expect(sourceUnits(index)).toEqual([]);
		expect(refreshed.at(-1)).toBe(true);
		fake.opens[0].onText(GRAPH_CHANGED);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fake.edgeCalls).toBe(calls);
	});

	it("an answer that arrives after unbind is dropped", async () => {
		const { index, sync, connection } = wire(BUILD_TO_SETUP);
		connection.start();
		const pending = sync.requestNow();
		sync.unbind();
		await pending;
		await vi.advanceTimersByTimeAsync(0);
		expect(sourceUnits(index)).toEqual([]);
	});
});
