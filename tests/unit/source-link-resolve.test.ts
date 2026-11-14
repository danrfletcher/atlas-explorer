import { beforeEach, describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import { LinkResolutionHook } from "../../src/link-resolution-hook";
import { SourceFileIndex, describeUnresolved, plainNameClashes, resolvePlainLinkInOwnSource, resolveSourceLink } from "../../src/source-links";
import { obsidianFirstLinkpathDest, seedPaths, sourcesVaultPaths } from "../sources-vault";

/** The fixture vault, plus a few extra paths a test needs. */
function buildApp(extra: string[] = []): { app: App; index: SourceFileIndex<TFile> } {
	const app = new App();
	seedPaths(app, [...sourcesVaultPaths(), ...extra]);
	return { app, index: new SourceFileIndex<TFile>(() => app.vault.getFiles()) };
}

const resolvedPath = (outcome: ReturnType<typeof resolveSourceLink<TFile>>): string | null => (outcome.kind === "resolved" ? outcome.file.path : null);

describe("the fixture vault is what the spec lists", () => {
	it("has exactly the spec's files", () => {
		expect(sourcesVaultPaths()).toEqual([
			"Leg Day.md",
			"README.md",
			"Sources/tephra/Cargo.toml",
			"Sources/tephra/README.md",
			"Sources/tephra/crates/tephrad/src/registry.rs",
			"Sources/tephra/docs/guide.md",
			"Sources/tephra/scripts/build.sh",
			"Sources/whoop/Leg Day.md",
			"Sources/whoop/Workout Plan.md",
			"Weekly Review.md",
		]);
	});
});

describe("@source:path resolves into that source", () => {
	let index: SourceFileIndex<TFile>;
	beforeEach(() => ({ index } = buildApp()));

	it.each([
		["@whoop:Workout Plan", "Sources/whoop/Workout Plan.md"], // notes drop `.md`
		["@whoop:Workout Plan.md", "Sources/whoop/Workout Plan.md"],
		["@whoop:workout plan", "Sources/whoop/Workout Plan.md"], // Obsidian matches case-insensitively
		["@WHOOP:Workout Plan", "Sources/whoop/Workout Plan.md"],
		["@whoop:Leg Day", "Sources/whoop/Leg Day.md"], // the whoop copy, not the vault-root one
		["@tephra:crates/tephrad/src/registry.rs", "Sources/tephra/crates/tephrad/src/registry.rs"], // other files keep their extension
		["@tephra:tephrad/src/registry.rs", "Sources/tephra/crates/tephrad/src/registry.rs"], // a path suffix is enough
		["@tephra:registry.rs", "Sources/tephra/crates/tephrad/src/registry.rs"],
		["@tephra:README", "Sources/tephra/README.md"], // not the vault-root README
		["@notes:README", "README.md"], // the vault is the source `notes`
		["@notes:Leg Day", "Leg Day.md"],
		["@whoop:Workout Plan#Week 1", "Sources/whoop/Workout Plan.md"], // a subpath is ignored for the file match
		["@whoop:Workout Plan#^plan1", "Sources/whoop/Workout Plan.md"],
	])("%j -> %s", (text, expected) => {
		const linkpath = text.split("#")[0];
		expect(resolvedPath(resolveSourceLink(index, linkpath))).toBe(expected);
	});

	it("never reaches another source or the vault", () => {
		for (const text of ["@whoop:registry.rs", "@whoop:Weekly Review", "@tephra:Leg Day", "@tephra:Workout Plan"]) {
			expect(resolveSourceLink(index, text).kind, text).toBe("unresolved");
		}
	});
});

describe("broken @ links", () => {
	let index: SourceFileIndex<TFile>;
	beforeEach(() => ({ index } = buildApp()));

	it("a missing file in a real source is not-found and says so", () => {
		const outcome = resolveSourceLink(index, "@whoop:Nope");
		expect(outcome).toEqual({ kind: "unresolved", reason: "not-found", source: "whoop", path: "Nope" });
		if (outcome.kind === "unresolved") expect(describeUnresolved(outcome, "@whoop:Nope")).toBe("No file Nope in whoop");
	});

	it("an unknown source is not-found too", () => {
		const outcome = resolveSourceLink(index, "@nosuch:x");
		expect(outcome).toEqual({ kind: "unresolved", reason: "not-found", source: "nosuch", path: "x" });
		if (outcome.kind === "unresolved") expect(describeUnresolved(outcome, "@nosuch:x")).toBe("No file x in nosuch");
	});

	it.each(["@:x", "@whoop:", "@who op:x", "@a*:x", "@whoop:sub/../x", "", "@", "@home"])("malformed %j is unresolved, never throws", (text) => {
		let outcome: ReturnType<typeof resolveSourceLink<TFile>> | undefined;
		expect(() => (outcome = resolveSourceLink(index, text))).not.toThrow();
		expect(outcome).toEqual({ kind: "unresolved", reason: "malformed" });
	});

	it("unicode names: a unicode file resolves, a unicode source name does not", () => {
		const { index: idx } = buildApp(["Sources/whoop/Entraînement 日本語.md"]);
		expect(resolvedPath(resolveSourceLink(idx, "@whoop:Entraînement 日本語"))).toBe("Sources/whoop/Entraînement 日本語.md");
		expect(resolveSourceLink(idx, "@wh😀:x").kind).toBe("unresolved");
	});

	it("a source folder whose symlink target is missing lists no files: links to it are broken", () => {
		// Obsidian shows a dangling symlink as an empty or absent folder (E5 groundwork).
		const { index: idx } = buildApp(); // Sources/gone is never seeded as having children
		expect(resolveSourceLink(idx, "@gone:x")).toMatchObject({ kind: "unresolved", reason: "not-found" });
		const { app, index: idx2 } = buildApp();
		app.vault.seedFolder("Sources/gone");
		expect(resolveSourceLink(idx2, "@gone:x")).toMatchObject({ kind: "unresolved", reason: "not-found" });
	});

	it("files directly under Sources/ and under Sources/notes/ are in no source", () => {
		const { index: idx } = buildApp(["Sources/stray.md", "Sources/notes/inner.md"]);
		expect(resolveSourceLink(idx, "@notes:stray").kind).toBe("unresolved");
		expect(resolveSourceLink(idx, "@notes:inner").kind).toBe("unresolved");
	});
});

describe("E3: two files tie on the shortest path", () => {
	it("is broken, and the outcome lists both paths", () => {
		const { index } = buildApp(["Sources/whoop/a/Plan2.md", "Sources/whoop/b/Plan2.md"]);
		const outcome = resolveSourceLink(index, "@whoop:Plan2");
		expect(outcome).toEqual({
			kind: "unresolved",
			reason: "ambiguous",
			source: "whoop",
			path: "Plan2",
			matches: ["Sources/whoop/a/Plan2.md", "Sources/whoop/b/Plan2.md"],
		});
		if (outcome.kind === "unresolved") {
			const message = describeUnresolved(outcome, "@whoop:Plan2");
			expect(message).toContain("2 matches in whoop");
			expect(message).toContain("Sources/whoop/a/Plan2.md");
			expect(message).toContain("Sources/whoop/b/Plan2.md");
		}
	});

	it("a shorter path wins over a longer one (no tie)", () => {
		const { index } = buildApp(["Sources/whoop/x/Plan3.md", "Sources/whoop/x/y/Plan3.md"]);
		expect(resolvedPath(resolveSourceLink(index, "@whoop:Plan3"))).toBe("Sources/whoop/x/Plan3.md");
	});

	it("a path that pins one of the tied files resolves it", () => {
		const { index } = buildApp(["Sources/whoop/a/Plan2.md", "Sources/whoop/b/Plan2.md"]);
		expect(resolvedPath(resolveSourceLink(index, "@whoop:b/Plan2"))).toBe("Sources/whoop/b/Plan2.md");
	});

	it("an exact path from the source root beats any suffix match", () => {
		const { index } = buildApp(["Sources/whoop/Plan4.md", "Sources/whoop/a/Plan4.md"]);
		expect(resolvedPath(resolveSourceLink(index, "@whoop:Plan4"))).toBe("Sources/whoop/Plan4.md");
	});

	it("an ambiguous plain same-source link is left to Obsidian's own pick: the first by path length", () => {
		const { index } = buildApp(["Sources/whoop/a/Plan2.md", "Sources/whoop/b/Plan2.md"]);
		expect(resolvePlainLinkInOwnSource(index, "Plan2", "Sources/whoop/Workout Plan.md")?.path).toBe("Sources/whoop/a/Plan2.md");
	});
});

describe("a plain link resolves in the linking file's own source", () => {
	let index: SourceFileIndex<TFile>;
	beforeEach(() => ({ index } = buildApp()));

	it("inside Sources/whoop/, [[Leg Day]] opens the whoop copy even with a vault-root Leg Day.md", () => {
		expect(resolvePlainLinkInOwnSource(index, "Leg Day", "Sources/whoop/Workout Plan.md")?.path).toBe("Sources/whoop/Leg Day.md");
	});

	it("never reaches the vault root or another source", () => {
		expect(resolvePlainLinkInOwnSource(index, "Weekly Review", "Sources/whoop/Workout Plan.md")).toBeNull();
		expect(resolvePlainLinkInOwnSource(index, "README", "Sources/whoop/Workout Plan.md")).toBeNull();
		expect(resolvePlainLinkInOwnSource(index, "registry.rs", "Sources/whoop/Workout Plan.md")).toBeNull();
	});

	it("inside Sources/tephra/, a non-note keeps its extension and a path suffix works", () => {
		expect(resolvePlainLinkInOwnSource(index, "registry.rs", "Sources/tephra/README.md")?.path).toBe("Sources/tephra/crates/tephrad/src/registry.rs");
		expect(resolvePlainLinkInOwnSource(index, "tephrad/src/registry.rs", "Sources/tephra/README.md")?.path).toBe("Sources/tephra/crates/tephrad/src/registry.rs");
		expect(resolvePlainLinkInOwnSource(index, "README", "Sources/tephra/crates/tephrad/src/registry.rs")?.path).toBe("Sources/tephra/README.md");
	});

	it("relative links are relative to the linking file, inside the source", () => {
		const { index: idx } = buildApp(["Sources/whoop/sub/Note.md", "Sources/whoop/sub/Sibling.md"]);
		expect(resolvePlainLinkInOwnSource(idx, "./Sibling", "Sources/whoop/sub/Note.md")?.path).toBe("Sources/whoop/sub/Sibling.md");
		expect(resolvePlainLinkInOwnSource(idx, "../Leg Day", "Sources/whoop/sub/Note.md")?.path).toBe("Sources/whoop/Leg Day.md");
		// Climbing past the source root clamps at the root (as Obsidian clamps at the vault root): it never reaches the vault.
		expect(resolvePlainLinkInOwnSource(idx, "../../Leg Day", "Sources/whoop/sub/Note.md")?.path).toBe("Sources/whoop/Leg Day.md");
		expect(resolvePlainLinkInOwnSource(idx, "/Leg Day", "Sources/whoop/sub/Note.md")?.path).toBe("Sources/whoop/Leg Day.md"); // `/` = the source root
	});
});

/** What Obsidian passes to `getFirstLinkpathDest`: the link text without `|alias` and `#subpath`. */
const linkpathOf = (inner: string): string => inner.split("|")[0].split("#")[0];

describe("F9 parity: plain links in vault notes resolve to the same file as Obsidian's own resolver", () => {
	const extra = ["Notes/Deep/Note.md", "Notes/Other/Note.md", "Notes/Deep/Unique One.md", "Notes/Leg Day.md", "img/pic.png", "data.v2.json", "Notes/Deep/Sources.md"];
	const sources = ["Weekly Review.md", "README.md", "Notes/Deep/Note.md", "Notes/Deep/Unique One.md", "img/pic.png"];
	const links = [
		"Leg Day",
		"leg day",
		"Leg Day.md",
		"Leg Day|a Leg alias", // alias: Obsidian strips it before resolving
		"Leg Day#Heading",
		"Leg Day#^blockid",
		"Leg Day#Heading|alias",
		"README",
		"Weekly Review",
		"Note",
		"Deep/Note",
		"Other/Note",
		"Notes/Deep/Note",
		"Notes/Other/Note.md",
		"Unique One",
		"./Unique One",
		"../Leg Day",
		"./Note",
		"/Leg Day",
		"/Notes/Leg Day",
		"pic.png",
		"img/pic.png",
		"data.v2.json",
		"data.v2",
		"Missing",
		"Missing#h",
		"@home", // not source syntax: no colon
		"@home#a:b",
		"Sources", // a file/folder name only
		"",
		"#Heading", // a link to a heading in the linking file itself
		"Sources.md",
	];
	const cases = sources.flatMap((source) => links.map((link) => [source, link] as const));

	it.each(cases)("from %s: [[%s]]", (sourcePath, inner) => {
		const { app } = buildApp(extra);
		const hook = new LinkResolutionHook(app);
		const reference = obsidianFirstLinkpathDest(app);
		const linkpath = linkpathOf(inner);
		const expected = reference(linkpath, sourcePath);
		// This table covers vault links whose Obsidian answer is NOT under Sources/ (own file or vault).
		expect(expected === null || !expected.path.startsWith("Sources/"), "table precondition").toBe(true);
		expect(hook.resolveFile(linkpath, sourcePath, reference)?.path ?? null).toBe(expected?.path ?? null);
	});

	it("is the very same TFile object, not a copy", () => {
		const { app } = buildApp(extra);
		const hook = new LinkResolutionHook(app);
		const reference = obsidianFirstLinkpathDest(app);
		expect(hook.resolveFile("Leg Day", "Weekly Review.md", reference)).toBe(app.vault.getAbstractFileByPath("Leg Day.md"));
	});
});

describe("plain links in vault notes never resolve into Sources/", () => {
	it("[[Workout Plan]], [[registry.rs]] and a full-path link into Sources/ stay unresolved from a vault note", () => {
		const { app } = buildApp();
		const hook = new LinkResolutionHook(app);
		const reference = obsidianFirstLinkpathDest(app);
		for (const link of ["Workout Plan", "registry.rs", "Sources/whoop/Workout Plan", "Sources/tephra/README.md", "whoop/Workout Plan"]) {
			expect(reference(link, "Weekly Review.md")?.path, `Obsidian alone resolves ${link}`).toMatch(/^Sources\//);
			expect(hook.resolveFile(link, "Weekly Review.md", reference), link).toBeNull();
		}
	});

	it("prefers a vault note over a Sources file Obsidian would have picked", () => {
		// From the vault root Obsidian picks the shortest path, which is the Sources file. The vault note must win.
		const { app } = buildApp(["Notes/Deep/Deeper/Workout Plan.md"]);
		const hook = new LinkResolutionHook(app);
		const reference = obsidianFirstLinkpathDest(app);
		expect(reference("Workout Plan", "Weekly Review.md")?.path).toBe("Sources/whoop/Workout Plan.md");
		expect(hook.resolveFile("Workout Plan", "Weekly Review.md", reference)?.path).toBe("Notes/Deep/Deeper/Workout Plan.md");
	});
});

describe("plainNameClashes (Q13 helper for PR-7's popup)", () => {
	const files = sourcesVaultPaths().map((path) => ({ path }));
	it("lists every file sharing a plain name across sources", () => {
		expect(plainNameClashes("README", files)).toEqual(["README.md", "Sources/tephra/README.md"]);
		expect(plainNameClashes("Leg Day", files)).toEqual(["Leg Day.md", "Sources/whoop/Leg Day.md"]);
	});
	it("is case-insensitive and accepts a trailing .md", () => {
		expect(plainNameClashes("readme.md", files)).toHaveLength(2);
		expect(plainNameClashes("README.MD", files)).toHaveLength(2);
	});
	it("is empty for a unique or unknown name, and for an empty name", () => {
		expect(plainNameClashes("Workout Plan", files)).toEqual([]);
		expect(plainNameClashes("registry.rs", files)).toEqual([]);
		expect(plainNameClashes("Nope", files)).toEqual([]);
		expect(plainNameClashes("", files)).toEqual([]);
	});
});
