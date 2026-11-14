import { describe, expect, it } from "vitest";
import {
	groupInboxSections,
	isListableTopLevelName,
	owningSourceName,
	parseUnitList,
	sourceUnitsFromEntries,
	VAULT_SECTION_KEY,
} from "../../src/inbox-sections";
import type { TephraSource } from "../../src/tephra-client";
import type { Unit } from "../../src/types";

const src = (name: string, status: TephraSource["status"] = "online"): TephraSource => ({ name, path: `/data/${name}`, status });
const file = (path: string): Unit => ({ type: "root-file", path });
const mod = (path: string): Unit => ({ type: "folder-unit", path });
const summarise = (sections: ReturnType<typeof groupInboxSections>) =>
	sections.map((s) => ({ key: s.key, kind: s.kind, missing: s.missing, paths: s.units.map((u) => u.path) }));

describe("groupInboxSections (G1)", () => {
	const vaultUnits = [file("Home.md"), mod("Projects"), file("_pool/20260101000000-abcd.md")];

	it.each<[string, Parameters<typeof groupInboxSections>[0], ReturnType<typeof summarise>]>([
		[
			"toggle off: one vault section holding everything, even a real folder called Sources",
			{ enabled: false, sources: [src("notes"), src("tephra")], units: [...vaultUnits, mod("Sources"), file("Sources/tephra/README.md")] },
			[{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: [...vaultUnits.map((u) => u.path), "Sources", "Sources/tephra/README.md"] }],
		],
		[
			"toggle on, no sources (Tephra offline or unchecked): the vault section alone",
			{ enabled: true, sources: [], units: vaultUnits },
			[{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: vaultUnits.map((u) => u.path) }],
		],
		[
			"vault first, then the others A-Z case-insensitively; the vault is matched as `notes` and gets no section of its own",
			{ enabled: true, sources: [src("tephra"), src("Zed"), src("notes"), src("alpha"), src("Beta")], units: vaultUnits },
			[
				{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: vaultUnits.map((u) => u.path) },
				{ key: "source:alpha", kind: "source", missing: false, paths: [] },
				{ key: "source:Beta", kind: "source", missing: false, paths: [] },
				{ key: "source:tephra", kind: "source", missing: false, paths: [] },
				{ key: "source:Zed", kind: "source", missing: false, paths: [] },
			],
		],
		[
			"units under Sources/<name>/ go to that source, never to the vault section; same-name files stay separate",
			{
				enabled: true,
				sources: [src("notes"), src("tephra")],
				units: [file("README.md"), file("Sources/tephra/README.md"), mod("Sources/tephra/crates"), file("Sources/tephra/Cargo.toml")],
			},
			[
				{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: ["README.md"] },
				{ key: "source:tephra", kind: "source", missing: false, paths: ["Sources/tephra/README.md", "Sources/tephra/crates", "Sources/tephra/Cargo.toml"] },
			],
		],
		[
			"longest-root ownership: Sources/whoopx/a.md is whoopx's, not whoop's",
			{
				enabled: true,
				sources: [src("whoop"), src("whoopx")],
				units: [file("Sources/whoop/a.md"), file("Sources/whoopx/a.md"), file("Sources/whoopx/b/c.md")],
			},
			[
				{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: [] },
				{ key: "source:whoop", kind: "source", missing: false, paths: ["Sources/whoop/a.md"] },
				{ key: "source:whoopx", kind: "source", missing: false, paths: ["Sources/whoopx/a.md", "Sources/whoopx/b/c.md"] },
			],
		],
		[
			"an empty source keeps its section with no rows",
			{ enabled: true, sources: [src("empty")], units: [] },
			[
				{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: [] },
				{ key: "source:empty", kind: "source", missing: false, paths: [] },
			],
		],
		[
			"a missing source keeps its section, flagged, with no rows even if units still point under it",
			{ enabled: true, sources: [src("gone", "missing"), src("tephra")], units: [file("Sources/gone/a.md"), file("Sources/tephra/b.md")] },
			[
				{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: [] },
				{ key: "source:gone", kind: "source", missing: true, paths: [] },
				{ key: "source:tephra", kind: "source", missing: false, paths: ["Sources/tephra/b.md"] },
			],
		],
		[
			"a unit under Sources/ that no listed source owns shows nowhere (PR-9 owns offline sections)",
			{ enabled: true, sources: [src("tephra")], units: [file("Sources/unlisted/a.md"), file("Sources/tephra/b.md"), file("Home.md")] },
			[
				{ key: VAULT_SECTION_KEY, kind: "vault", missing: false, paths: ["Home.md"] },
				{ key: "source:tephra", kind: "source", missing: false, paths: ["Sources/tephra/b.md"] },
			],
		],
	])("%s", (_label, input, expected) => {
		expect(summarise(groupInboxSections(input))).toEqual(expected);
	});

	it("an offline-status source (unknown to Tephra) is not shown as missing", () => {
		const [, section] = groupInboxSections({ enabled: true, sources: [src("x", "offline")], units: [file("Sources/x/a.md")] });
		expect(section.missing).toBe(false);
		expect(section.units).toHaveLength(1);
	});

	it("a ref seen twice keeps the first occurrence (the caller puts the unit.list units first), by ref and not by bare path", () => {
		const listed: Unit = { type: "root-file", path: "Sources/tephra/a.md" };
		const added: Unit = { type: "added-file", path: "Sources/tephra/a.md" };
		const block: Unit = { type: "promoted-block", path: "Sources/tephra/a.md", subpath: "^x" };
		const sections = groupInboxSections({ enabled: true, sources: [src("tephra")], units: [listed, added, block, { ...listed }] });
		// the file appears once, as the first (listed) unit; the block is a different ref and stays
		expect(sections[1].units.map((u) => u.type)).toEqual(["root-file", "promoted-block"]);
	});

	it("does not depend on the order the sources arrive in", () => {
		const a = groupInboxSections({ enabled: true, sources: [src("b"), src("a")], units: [] });
		const b = groupInboxSections({ enabled: true, sources: [src("a"), src("b")], units: [] });
		expect(a.map((s) => s.key)).toEqual(b.map((s) => s.key));
	});

	it("ignores a source name that isn't a safe single segment", () => {
		const sections = groupInboxSections({ enabled: true, sources: [src("a/b"), src(".."), src("ok")], units: [] });
		expect(sections.map((s) => s.key)).toEqual([VAULT_SECTION_KEY, "source:ok"]);
	});
});

describe("owningSourceName", () => {
	it("matches whole segments only, and never the Sources folder itself", () => {
		expect(owningSourceName("Sources/tephra", ["tephra"])).toBe("tephra");
		expect(owningSourceName("Sources/tephra/a.md", ["tephra"])).toBe("tephra");
		expect(owningSourceName("Sources/tephrax/a.md", ["tephra"])).toBeNull();
		expect(owningSourceName("Sources", ["tephra"])).toBeNull();
		expect(owningSourceName("Other/tephra/a.md", ["tephra"])).toBeNull();
	});
});

describe("parseUnitList / sourceUnitsFromEntries (G1)", () => {
	const entry = (name: string, kind: string, relPath = name) => ({ id: "x", name, rel_path: relPath, kind, size: 1, mtime: 1 });

	it("turns folders into modules and files into files, keyed Sources/<name>/<entry>", () => {
		const parsed = parseUnitList({
			source: "tephra",
			folder: "",
			recursive: false,
			offline: false,
			needs_rescan: false,
			entries: [entry("crates", "folder"), entry("docs", "folder"), entry("README.md", "markdown"), entry("Cargo.toml", "toml")],
		});
		expect(parsed?.offline).toBe(false);
		expect(sourceUnitsFromEntries("tephra", parsed!.entries)).toEqual([
			{ type: "folder-unit", path: "Sources/tephra/crates" },
			{ type: "folder-unit", path: "Sources/tephra/docs" },
			{ type: "root-file", path: "Sources/tephra/README.md" },
			{ type: "root-file", path: "Sources/tephra/Cargo.toml" },
		]);
	});

	it("keeps Unicode and spaces in names", () => {
		const parsed = parseUnitList({ entries: [entry("Leg Day.md", "markdown"), entry("résumé.pdf", "pdf")] });
		expect(sourceUnitsFromEntries("tephra", parsed!.entries).map((u) => u.path)).toEqual(["Sources/tephra/Leg Day.md", "Sources/tephra/résumé.pdf"]);
	});

	it("never lists dotfiles, .git, deeper paths, repeats or unsafe names", () => {
		const parsed = parseUnitList({
			entries: [
				entry(".git", "folder"),
				entry(".env", "file"),
				entry("deep.md", "markdown", "sub/deep.md"),
				entry("a/b", "file", "a/b"),
				entry("..", "folder"),
				entry("ok.md", "markdown"),
				entry("ok.md", "markdown"),
				entry("tab\tname", "file"),
				{ name: 3, rel_path: "3", kind: "file" },
				null,
				"x",
			],
		});
		expect(parsed!.entries).toEqual([{ name: "ok.md", kind: "file" }]);
	});

	it("reports offline: true (the source's folder is gone)", () => {
		expect(parseUnitList({ offline: true, entries: [] })).toEqual({ offline: true, entries: [] });
	});

	it("a zero-item source parses to an empty list, not null", () => {
		expect(parseUnitList({ entries: [] })).toEqual({ offline: false, entries: [] });
	});

	it.each([[null], [5], ["x"], [[]], [{}], [{ entries: "no" }]])("returns null for a result that isn't a listing: %j", (bad) => {
		expect(parseUnitList(bad)).toBeNull();
	});

	it("isListableTopLevelName", () => {
		expect(isListableTopLevelName("README.md")).toBe(true);
		expect(isListableTopLevelName(".git")).toBe(false);
		expect(isListableTopLevelName("")).toBe(false);
	});
});
