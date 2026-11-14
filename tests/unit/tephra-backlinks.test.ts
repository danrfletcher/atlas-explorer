import { describe, expect, it } from "vitest";
import {
	backlinkRows,
	fetchAllEdges,
	fetchBacklinkRows,
	parseTephraEdges,
	parseTephraId,
	tephraIdToVaultPath,
	vaultPathToTephraId,
	type BacklinkContext,
	isIndexedNote,
	type TephraCaller,
} from "../../src/tephra-backlinks";
import { parseSourceLink } from "../../src/source-links";
import { sourceLinkPath } from "../../src/sources-path";

// Edge JSON as Tephra `dev` serves it (crates/tephra-graph/src/model.rs): `to` is {resolved: id} or "dangling".
const edge = (from: string, to: string | null, extra: Record<string, unknown> = {}) => ({
	from,
	to: to === null ? "dangling" : { resolved: to },
	to_raw: to ?? "Nowhere",
	kind: "wikilink",
	offline: false,
	line: 3,
	...extra,
});

const SOURCES = new Set(["whoop", "demo"]);
const FILES = new Set([
	"scripts/build.sh",
	"Sources/demo/scripts/build.sh",
	"Sources/demo/docs/guide/Setup.md",
	"Sources/demo/docs/Spec.pdf",
	"Sources/demo/Café Notes.pdf",
	"Sources/demo/with space/a b.docx",
	"Sources/whoop/Workout Plan.md",
	"Weekly Review.md",
	"Notes/Idea.md",
	"slides.pptx",
]);
const NOTES_WITH_CACHE = new Set(["Weekly Review.md", "Notes/Idea.md", "Sources/demo/docs/guide/Setup.md", "Sources/whoop/Workout Plan.md"]);

const context = (extra: Partial<BacklinkContext> = {}): BacklinkContext => ({
	knownSources: SOURCES,
	fileExists: (p) => FILES.has(p),
	hasFileCache: (p) => NOTES_WITH_CACHE.has(p),
	activePath: "Sources/demo/crates/core/src/registry.rs",
	includeCrossSourceNotes: false,
	...extra,
});

describe("tephraIdToVaultPath (PR-1's mapping: @notes:x -> x, @<name>:x -> Sources/<name>/x)", () => {
	it("maps notes and a known source", () => {
		expect(tephraIdToVaultPath("@notes:Weekly Review.md", SOURCES)).toBe("Weekly Review.md");
		expect(tephraIdToVaultPath("@demo:scripts/build.sh", SOURCES)).toBe("Sources/demo/scripts/build.sh");
	});

	it("keeps spaces and unicode", () => {
		expect(tephraIdToVaultPath("@demo:Café Notes.pdf", SOURCES)).toBe("Sources/demo/Café Notes.pdf");
		expect(tephraIdToVaultPath("@demo:with space/a b.docx", SOURCES)).toBe("Sources/demo/with space/a b.docx");
	});

	it("is null for an unknown or removed source, a malformed id and an unsafe path", () => {
		for (const id of ["@gone:a.md", "@demo", "demo:a.md", "@:a.md", "@demo:", "@demo:../x", "@demo:a/../x", "@demo:a//b", "@demo:/a", "@bad name:a", "", "@demo:a\\b", "@demo:a\u0000b"]) {
			expect(tephraIdToVaultPath(id, SOURCES), id).toBeNull();
		}
	});

	it("never maps a notes id under Sources/, which is Atlas's own links", () => {
		expect(tephraIdToVaultPath("@notes:Sources/demo/a.md", SOURCES)).toBeNull();
		expect(tephraIdToVaultPath("@notes:Sources", SOURCES)).toBeNull();
	});

	it("does not match a source name by prefix", () => {
		expect(tephraIdToVaultPath("@demox:a.md", SOURCES)).toBeNull();
	});

	it("keeps the extension PR-1's parseSourceLink drops, in its original case", () => {
		expect(tephraIdToVaultPath("@demo:docs/Guide.MD", SOURCES)).toBe("Sources/demo/docs/Guide.MD");
		expect(tephraIdToVaultPath("@demo:docs/Guide.md", SOURCES)).toBe("Sources/demo/docs/Guide.md");
		expect(tephraIdToVaultPath("@notes:Guide.md", SOURCES)).toBe("Guide.md");
	});

	it("never splits a file id at `#`, and keeps a literal `%`", () => {
		expect(tephraIdToVaultPath("@demo:src/a#b.rs", SOURCES)).toBe("Sources/demo/src/a#b.rs");
		expect(tephraIdToVaultPath("@demo:100%25.md", SOURCES)).toBe("Sources/demo/100%25.md");
		expect(tephraIdToVaultPath("@demo:100%.md", SOURCES)).toBe("Sources/demo/100%.md");
		expect(tephraIdToVaultPath("@demo:#.md", SOURCES)).toBe("Sources/demo/#.md");
	});

	// R4: the id rule is PR-1's, so it accepts and refuses exactly what parseSourceLink does (and builds the path with
	// sourceLinkPath); the only differences are the kept extension and the `notes` / known-source handling.
	it("agrees with parseSourceLink on every id, so the two rules cannot drift apart", () => {
		const ids = ["@demo:a.md", "@demo:a/b.rs", "@demo:../x", "@demo:a//b", "@demo:", "@:a", "@bad name:a", "@demo:a\\b", "@demo:a\u0001", "@demo:/a", "@demo:./a", "@demo:a/.", "@demo:Café.pdf", "@DEMO:a.md", "@notes:a/b.md"];
		for (const id of ids) {
			const parsed = parseSourceLink(id);
			const mapped = parseTephraId(id);
			expect(mapped === null, id).toBe(parsed === null);
			if (parsed === null || mapped === null) continue;
			expect(mapped.source, id).toBe(parsed.source);
			const rel = mapped.source === "notes" ? mapped.path : mapped.path.slice(sourceLinkPath(parsed.source).length + 1);
			expect(rel.replace(/\.md$/i, ""), id).toBe(parsed.path);
		}
	});
});

describe("vaultPathToTephraId", () => {
	it("is the inverse, and null for the Sources folder itself", () => {
		expect(vaultPathToTephraId("Notes/Idea.md")).toBe("@notes:Notes/Idea.md");
		expect(vaultPathToTephraId("Sources/demo/Café Notes.pdf")).toBe("@demo:Café Notes.pdf");
		expect(vaultPathToTephraId("Sources/demo")).toBeNull();
		expect(vaultPathToTephraId("Sources/demo/")).toBeNull();
		expect(vaultPathToTephraId("Sources/x.md")).toBeNull();
	});
});

describe("parseTephraEdges", () => {
	it("reads resolved, dangling and subpath edges; a missing line is null", () => {
		const edges = parseTephraEdges([
			edge("@demo:scripts/build.sh", "@demo:crates/core/src/registry.rs"),
			edge("@notes:Weekly Review.md", "@whoop:Workout Plan.md", { to_raw: "Workout Plan#^k1|alias", line: null }),
			edge("@notes:Notes/Idea.md", null),
		]);
		expect(edges).toEqual([
			{ from: "@demo:scripts/build.sh", to: "@demo:crates/core/src/registry.rs", toRaw: "@demo:crates/core/src/registry.rs", subpath: "", line: 3, kind: "wikilink", offline: false },
			{ from: "@notes:Weekly Review.md", to: "@whoop:Workout Plan.md", toRaw: "Workout Plan#^k1|alias", subpath: "^k1", line: null, kind: "wikilink", offline: false },
			{ from: "@notes:Notes/Idea.md", to: null, toRaw: "Nowhere", subpath: "", line: 3, kind: "wikilink", offline: false },
		]);
	});

	it("drops a row without a from, and treats a bad line as null", () => {
		const edges = parseTephraEdges([{ to: { resolved: "@a:b" } }, null, 7, edge("@demo:x.rs", "@demo:y.rs", { line: 0 }), edge("@demo:x.rs", "@demo:y.rs", { line: 2.5 })])!;
		expect(edges.map((e) => e.line)).toEqual([null, null]);
	});

	it("is null for anything that isn't a list", () => {
		for (const value of [null, undefined, {}, "x", 3]) expect(parseTephraEdges(value)).toBeNull();
	});
});

describe("backlinkRows", () => {
	const rows = (edges: unknown[], extra?: Partial<BacklinkContext>) => backlinkRows(parseTephraEdges(edges)!, context(extra));

	it("a code file's link becomes a path:line row", () => {
		expect(rows([edge("@demo:scripts/build.sh", "@demo:crates/core/src/registry.rs")])).toEqual([{ path: "Sources/demo/scripts/build.sh", line: 3 }]);
	});

	it("skips an edge from a file Obsidian indexes: a note-to-note link is Obsidian's own Backlinks' (no duplicate)", () => {
		expect(rows([edge("@notes:Weekly Review.md", "@demo:x"), edge("@demo:docs/guide/Setup.md", "@demo:x")])).toEqual([]);
	});

	it("under the Q13 fallback lists a note in another source, but still never one in the active file's own source", () => {
		const edges = [edge("@notes:Weekly Review.md", "@demo:x"), edge("@demo:docs/guide/Setup.md", "@demo:x"), edge("@whoop:Workout Plan.md", "@demo:x")];
		expect(rows(edges, { includeCrossSourceNotes: true }).map((r) => r.path)).toEqual(["Sources/whoop/Workout Plan.md", "Weekly Review.md"]);
	});

	it("skips an unknown or removed source, a path with no vault file, and the file itself", () => {
		const edges = [
			edge("@gone:a.sh", "@demo:x"),
			edge("@demo:nope/missing.sh", "@demo:x"),
			edge("@demo:crates/core/src/registry.rs", "@demo:crates/core/src/registry.rs"),
			edge("@demo:scripts/build.sh", "@demo:x"),
		];
		expect(rows(edges)).toEqual([{ path: "Sources/demo/scripts/build.sh", line: 3 }]);
	});

	it("keeps a row with no line (the file opens at the top) and sorts by path, then line, rows without a line first", () => {
		const result = rows([
			edge("@demo:scripts/build.sh", "@demo:x", { line: 12 }),
			edge("@demo:docs/Spec.pdf", "@demo:x", { line: null }),
			edge("@demo:scripts/build.sh", "@demo:x", { line: 2 }),
			edge("@notes:slides.pptx", "@demo:x", { line: null }),
			edge("@demo:scripts/build.sh", "@demo:x", { line: null }),
		]);
		expect(result).toEqual([
			{ path: "Sources/demo/docs/Spec.pdf", line: null },
			{ path: "Sources/demo/scripts/build.sh", line: null },
			{ path: "Sources/demo/scripts/build.sh", line: 2 },
			{ path: "Sources/demo/scripts/build.sh", line: 12 },
			{ path: "slides.pptx", line: null },
		]);
	});

	it("is one row per (path, line)", () => {
		expect(rows([edge("@demo:scripts/build.sh", "@demo:x"), edge("@demo:scripts/build.sh", "@demo:x#^b", { to_raw: "x#^b" })])).toHaveLength(1);
	});

	it("maps spaces and unicode, and a #/^ subpath on the target changes nothing about the origin's row", () => {
		const result = rows([edge("@demo:Café Notes.pdf", "@demo:x#^id", { to_raw: "x#^id" }), edge("@demo:with space/a b.docx", "@demo:x#H")]);
		expect(result.map((r) => r.path)).toEqual(["Sources/demo/Café Notes.pdf", "Sources/demo/with space/a b.docx"]);
	});

	it("500 backlinks render as rows in well under 200 ms", () => {
		const many: unknown[] = [];
		for (let i = 0; i < 500; i++) many.push(edge("@demo:scripts/build.sh", "@demo:x", { line: i + 1 }));
		const parsed = parseTephraEdges(many)!;
		const start = performance.now();
		const result = backlinkRows(parsed, context());
		expect(performance.now() - start).toBeLessThan(200);
		expect(result).toHaveLength(500);
	});
});

/** A fake PR-2 Tephra client serving fixture `Edge` JSON per method. */
function fakeCaller(answers: Record<string, unknown>): TephraCaller & { calls: Array<{ method: string; params?: unknown }> } {
	const calls: Array<{ method: string; params?: unknown }> = [];
	return {
		calls,
		async call(method, params) {
			calls.push({ method, params });
			const answer = answers[method];
			if (answer instanceof Error) throw answer;
			if (answer === undefined) return { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };
			return { ok: true, result: answer };
		},
	};
}
const { activePath: _ignored, ...fetchContext } = context();
void _ignored;

describe("fetchBacklinkRows", () => {
	it("asks graph.get_backlinks for the active file's federated id and returns its rows", async () => {
		const caller = fakeCaller({ "graph.get_backlinks": [edge("@demo:scripts/build.sh", "@demo:crates/core/src/registry.rs")] });
		const result = await fetchBacklinkRows(caller, "Sources/demo/crates/core/src/registry.rs", fetchContext);
		expect(caller.calls).toEqual([{ method: "graph.get_backlinks", params: { id: "@demo:crates/core/src/registry.rs" } }]);
		expect(result).toEqual({ ok: true, rows: [{ path: "Sources/demo/scripts/build.sh", line: 3 }] });
	});

	it("asks nothing for a path with no federated id", async () => {
		const caller = fakeCaller({});
		expect(await fetchBacklinkRows(caller, "Sources/demo", fetchContext)).toEqual({ ok: false });
		expect(caller.calls).toEqual([]);
	});

	it("a failed call, a thrown error and a non-list answer are { ok: false }, never an exception", async () => {
		expect(await fetchBacklinkRows(fakeCaller({}), "Notes/Idea.md", fetchContext)).toEqual({ ok: false });
		expect(await fetchBacklinkRows(fakeCaller({ "graph.get_backlinks": new Error("boom") }), "Notes/Idea.md", fetchContext)).toEqual({ ok: false });
		expect(await fetchBacklinkRows(fakeCaller({ "graph.get_backlinks": { not: "a list" } }), "Notes/Idea.md", fetchContext)).toEqual({ ok: false });
	});

	it("an empty answer is ok with no rows", async () => {
		expect(await fetchBacklinkRows(fakeCaller({ "graph.get_backlinks": [] }), "Notes/Idea.md", fetchContext)).toEqual({ ok: true, rows: [] });
	});
});

describe("fetchAllEdges", () => {
	it("returns the parsed edge list, or null on a failure", async () => {
		const edges = await fetchAllEdges(fakeCaller({ "graph.get_edges": [edge("@demo:scripts/build.sh", "@demo:x")] }));
		expect(edges).toHaveLength(1);
		expect(await fetchAllEdges(fakeCaller({}))).toBeNull();
		expect(await fetchAllEdges(fakeCaller({ "graph.get_edges": new Error("boom") }))).toBeNull();
	});
});

describe("isIndexedNote (live Obsidian: a non-markdown file's cache is {}, not null)", () => {
	it("a code, PDF or Office file is never a note, whether its cache is {} or null", () => {
		for (const ext of ["rs", "sh", "pdf", "docx", "pptx"]) {
			expect(isIndexedNote({ extension: ext }, {})).toBe(false);
			expect(isIndexedNote({ extension: ext }, null)).toBe(false);
		}
	});

	it("a markdown file is a note only with a cache; without one it is not", () => {
		expect(isIndexedNote({ extension: "md" }, {})).toBe(true);
		expect(isIndexedNote({ extension: "MD" }, { links: [] })).toBe(true);
		expect(isIndexedNote({ extension: "md" }, null)).toBe(false);
	});
});
