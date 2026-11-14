import { describe, expect, it } from "vitest";
import { computeSourcePromotions, type ResolvedLink } from "../../src/source-promotion";

const NAMES = ["tephra", "other"];
const run = (links: ResolvedLink[], extra: { isExcluded?: (p: string) => boolean; interfaceFolderFor?: (p: string) => string | null } = {}) =>
	[...computeSourcePromotions(links, { sourceNames: NAMES, isExcluded: () => false, interfaceFolderFor: () => null, ...extra }).units.values()];

describe("the pop-out rule per source (G1, G12)", () => {
	it("a link from the same top-level folder promotes nothing", () => {
		expect(run([{ from: "Sources/tephra/docs/a.md", to: "Sources/tephra/docs/deep/b.md", subpath: "" }])).toEqual([]);
	});

	it("a link from another folder of the same source promotes the file, recording its module", () => {
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Sources/tephra/docs/deep/b.md", subpath: "" }])).toEqual([
			{ type: "promoted-file", path: "Sources/tephra/docs/deep/b.md", topLevelFolder: "Sources/tephra/docs" },
		]);
	});

	it("a link from a top-level file of the source counts as from outside the folder", () => {
		expect(run([{ from: "Sources/tephra/README.md", to: "Sources/tephra/docs/b.md", subpath: "" }])).toHaveLength(1);
	});

	it("a link from a vault note counts as from outside the source (G12)", () => {
		expect(run([{ from: "Home.md", to: "Sources/tephra/docs/b.md", subpath: "" }])).toEqual([
			{ type: "promoted-file", path: "Sources/tephra/docs/b.md", topLevelFolder: "Sources/tephra/docs" },
		]);
	});

	it("a link from another source counts as from outside, even from a folder of the same name (G12)", () => {
		expect(run([{ from: "Sources/other/docs/a.md", to: "Sources/tephra/docs/b.md", subpath: "" }])).toEqual([
			{ type: "promoted-file", path: "Sources/tephra/docs/b.md", topLevelFolder: "Sources/tephra/docs" },
		]);
	});

	it("a link from under Sources/ that no listed source owns is skipped", () => {
		expect(run([{ from: "Sources/gone/a.md", to: "Sources/tephra/docs/b.md", subpath: "" }])).toEqual([]);
	});

	it("a vault note's block link into a source promotes the block only", () => {
		expect(run([{ from: "Home.md", to: "Sources/tephra/docs/b.md", subpath: "^k1" }])).toEqual([
			{ type: "promoted-block", path: "Sources/tephra/docs/b.md", subpath: "^k1" },
		]);
	});

	it("a link out of the source to a vault note promotes nothing here", () => {
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Home.md", subpath: "" }])).toEqual([]);
	});

	it("a subpath link promotes only the block, never the file", () => {
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Sources/tephra/docs/b.md", subpath: "^abc" }])).toEqual([
			{ type: "promoted-block", path: "Sources/tephra/docs/b.md", subpath: "^abc" },
		]);
	});

	it("a subpath link from inside the same top-level folder promotes nothing", () => {
		expect(run([{ from: "Sources/tephra/docs/a.md", to: "Sources/tephra/docs/b.md", subpath: "^abc" }])).toEqual([]);
	});

	it("a self-link promotes nothing, with or without a subpath", () => {
		expect(
			run([
				{ from: "Sources/tephra/docs/a.md", to: "Sources/tephra/docs/a.md", subpath: "" },
				{ from: "Sources/tephra/docs/a.md", to: "Sources/tephra/docs/a.md", subpath: "^x" },
			])
		).toEqual([]);
	});

	it("a link to a top-level file promotes nothing (it is already a row)", () => {
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Sources/tephra/README.md", subpath: "" }])).toEqual([]);
	});

	it("an ignored folder never pops out, as the target or as the origin", () => {
		const isExcluded = (p: string) => p.startsWith("Sources/tephra/target/");
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Sources/tephra/target/x.md", subpath: "" }], { isExcluded })).toEqual([]);
		expect(run([{ from: "Sources/tephra/target/x.md", to: "Sources/tephra/docs/b.md", subpath: "" }], { isExcluded })).toEqual([]);
	});

	it("an interface note promotes its folder, unless that folder is the target's own module", () => {
		const interfaceFolderFor = (p: string) => (p === "Sources/tephra/docs/sub/sub.md" ? "Sources/tephra/docs/sub" : p === "Sources/tephra/docs/docs.md" ? "Sources/tephra/docs" : null);
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Sources/tephra/docs/sub/sub.md", subpath: "" }], { interfaceFolderFor })).toEqual([
			{ type: "promoted-folder", path: "Sources/tephra/docs/sub", topLevelFolder: "Sources/tephra/docs" },
		]);
		expect(run([{ from: "Sources/tephra/crates/a.md", to: "Sources/tephra/docs/docs.md", subpath: "" }], { interfaceFolderFor })).toEqual([]);
	});

	it("longest-root: a link inside whoopx is not read as a link inside whoop", () => {
		const links: ResolvedLink[] = [{ from: "Sources/whoopx/a/x.md", to: "Sources/whoopx/b/y.md", subpath: "" }];
		const units = [...computeSourcePromotions(links, { sourceNames: ["whoop", "whoopx"], isExcluded: () => false, interfaceFolderFor: () => null }).units.values()];
		expect(units).toEqual([{ type: "promoted-file", path: "Sources/whoopx/b/y.md", topLevelFolder: "Sources/whoopx/b" }]);
	});

	it("a repeated link yields one unit", () => {
		const link = { from: "Sources/tephra/crates/a.md", to: "Sources/tephra/docs/b.md", subpath: "" };
		expect(run([link, { ...link }])).toHaveLength(1);
	});
});
