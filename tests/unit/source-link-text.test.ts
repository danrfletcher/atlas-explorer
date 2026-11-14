import { describe, expect, it } from "vitest";
import { pathInSource, sourceLinkText, sourceOfVaultPath } from "../../src/source-link-text";
import { resolveSourceLink, SourceFileIndex } from "../../src/source-links";

const f = (path: string) => ({ path });

const VAULT = [
	"Weekly Review.md",
	"README.md",
	"Leg Day.md",
	"Notes/Plan.md",
	"Sources/whoop/Workout Plan.md",
	"Sources/whoop/Leg Day.md",
	"Sources/whoop/Plan.md",
	"Sources/whoop/archive/Plan.md",
	"Sources/tephra/README.md",
	"Sources/tephra/crates/tephrad/README.md",
	"Sources/tephra/crates/tephrad/src/registry.rs",
	"Sources/tephra/crates/other/src/registry.rs",
	"Sources/tephra/Cargo.toml",
	"Sources/tephra/docs/Guide.md",
	"Sources/stray.md", // directly under Sources/: in no source
	"Sources/notes/Hidden.md", // the reserved name: in no source
].map(f);

const NO_FALLBACK = { fullPathOnClash: false };
const FALLBACK = { fullPathOnClash: true };

const text = (picked: string, from: string, options = NO_FALLBACK) => sourceLinkText(f(picked), from, VAULT, options).text;

describe("sourceOfVaultPath", () => {
	it.each([
		["Weekly Review.md", "notes"],
		["Notes/Plan.md", "notes"],
		["Sources/whoop/Leg Day.md", "whoop"],
		["Sources/Tephra/x.md", "Tephra"], // keeps the case it has on disk
		["Sources/stray.md", null],
		["Sources/notes/Hidden.md", null],
		["Sources/bad name/x.md", null],
		["Sources", null],
		["sources/whoop/x.md", "notes"], // the folder name is matched exactly
	])("%s -> %s", (path, source) => {
		expect(sourceOfVaultPath(path)).toBe(source);
	});

	it("pathInSource strips the Sources/<name>/ prefix and leaves vault paths alone", () => {
		expect(pathInSource("Sources/tephra/crates/x.rs", "tephra")).toBe("crates/x.rs");
		expect(pathInSource("Notes/Plan.md", "notes")).toBe("Notes/Plan.md");
	});
});

describe("same source -> [[Name]]", () => {
	it("a note in whoop picking a whoop file inserts the bare name, no extension", () => {
		expect(text("Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md")).toBe("Leg Day");
	});

	it("keeps the file's real case, not what was typed", () => {
		expect(text("Sources/whoop/Workout Plan.md", "Sources/whoop/Leg Day.md")).toBe("Workout Plan");
	});

	it("a vault note picking a vault file gives the bare name too", () => {
		expect(text("Leg Day.md", "Weekly Review.md")).toBe("Leg Day");
	});

	it("a non-note file keeps its extension", () => {
		expect(text("Sources/tephra/Cargo.toml", "Sources/tephra/README.md")).toBe("Cargo.toml");
	});

	it("the result is marked same-source with the file's source", () => {
		expect(sourceLinkText(f("Sources/whoop/Leg Day.md"), "Sources/whoop/Workout Plan.md", VAULT, NO_FALLBACK)).toEqual({
			text: "Leg Day",
			kind: "same-source",
			source: "whoop",
		});
	});
});

describe("other source -> [[@source:path]]", () => {
	it("a vault note picking a whoop note", () => {
		expect(text("Sources/whoop/Workout Plan.md", "Weekly Review.md")).toBe("@whoop:Workout Plan");
	});

	it("a whoop note picking a vault file", () => {
		expect(text("Weekly Review.md", "Sources/whoop/Workout Plan.md")).toBe("@notes:Weekly Review");
	});

	it("a note in another source picking a tephra file", () => {
		expect(text("Sources/tephra/docs/Guide.md", "Sources/whoop/Leg Day.md")).toBe("@tephra:Guide");
	});

	it("a non-note file keeps its extension", () => {
		expect(text("Sources/tephra/Cargo.toml", "Weekly Review.md")).toBe("@tephra:Cargo.toml");
	});

	it("is marked cross-source", () => {
		expect(sourceLinkText(f("Sources/whoop/Leg Day.md"), "Weekly Review.md", VAULT, NO_FALLBACK)).toMatchObject({ kind: "cross-source", source: "whoop" });
	});
});

describe("shortest unique path under clashes", () => {
	it("two READMEs in tephra: the nested one needs its folders, and the root one resolves to the root file", () => {
		// The shortest path wins a bare name (in Atlas's resolver and in Tephra's), so the root README is plain
		// `README`. The nested one needs its full path from the source root, as the spec example says: Tephra
		// matches a target with a `/` against the whole path, so a trailing slice like `tephrad/README` dangles.
		expect(text("Sources/tephra/crates/tephrad/README.md", "Weekly Review.md")).toBe("@tephra:crates/tephrad/README");
		expect(text("Sources/tephra/README.md", "Weekly Review.md")).toBe("@tephra:README");
		const root = text("Sources/tephra/README.md", "Weekly Review.md");
		const outcome = resolveSourceLink(new SourceFileIndex(() => VAULT), root);
		expect(outcome.kind).toBe("resolved");
		expect((outcome as { file: { path: string } }).file.path).toBe("Sources/tephra/README.md");
	});

	it("a clashing name is the bare name or the full path in the source, never a partial path", () => {
		// `registry.rs` is in crates/tephrad/src and crates/other/src. The shorter path (`other`) wins the bare
		// name, as in Tephra; the other one needs its full path from the source root.
		expect(text("Sources/tephra/crates/other/src/registry.rs", "Weekly Review.md")).toBe("@tephra:registry.rs");
		expect(text("Sources/tephra/crates/tephrad/src/registry.rs", "Weekly Review.md")).toBe("@tephra:crates/tephrad/src/registry.rs");
	});

	it("same-source picks follow the same rule: the full path in the source, not a trailing slice", () => {
		expect(text("Sources/tephra/crates/tephrad/README.md", "Sources/tephra/Cargo.toml")).toBe("crates/tephrad/README");
		expect(text("Sources/whoop/archive/Plan.md", "Sources/whoop/Leg Day.md")).toBe("archive/Plan");
	});

	it("any text with a `/` is the file's whole path from its source root (Tephra's resolution rule)", () => {
		for (const file of VAULT) {
			const source = sourceOfVaultPath(file.path);
			if (source === null) continue;
			const inserted = text(file.path, "Weekly Review.md").replace(/^@[^:]+:/, "");
			if (!inserted.includes("/")) continue;
			const full = pathInSource(file.path, source);
			expect(full === inserted || full === `${inserted}.md`, `${file.path} -> ${inserted}`).toBe(true);
		}
	});

	it("every inserted link resolves back to exactly the file that was picked (never ambiguous)", () => {
		const index = new SourceFileIndex(() => VAULT);
		for (const file of VAULT) {
			if (sourceOfVaultPath(file.path) === null) continue;
			const inserted = text(file.path, "Weekly Review.md");
			const link = inserted.startsWith("@") ? inserted : `@notes:${inserted}`;
			const outcome = resolveSourceLink(index, link);
			expect(outcome.kind, `${file.path} -> ${inserted}`).toBe("resolved");
			expect((outcome as { file: { path: string } }).file.path).toBe(file.path);
		}
	});

	it("same-source clash: two Plan.md in whoop each get a path that differs", () => {
		const a = text("Sources/whoop/Plan.md", "Sources/whoop/Leg Day.md");
		const b = text("Sources/whoop/archive/Plan.md", "Sources/whoop/Leg Day.md");
		expect(a).not.toBe(b);
		expect(b).toBe("archive/Plan");
	});
});

describe("vault-source files under Sources/ are excluded from uniqueness", () => {
	it("a vault note's README link is not made ambiguous by the READMEs in tephra", () => {
		expect(text("README.md", "Weekly Review.md")).toBe("README");
	});

	it("`Leg Day` exists in the vault and in whoop; each is bare within its own source", () => {
		expect(text("Leg Day.md", "Weekly Review.md")).toBe("Leg Day");
		expect(text("Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md")).toBe("Leg Day");
	});

	it("a file in no source (`Sources/notes/…`, `Sources/x.md`) is inserted by its full vault path", () => {
		expect(sourceLinkText(f("Sources/notes/Hidden.md"), "Weekly Review.md", VAULT, NO_FALLBACK)).toEqual({
			text: "Sources/notes/Hidden",
			kind: "full-path",
			source: null,
		});
		expect(text("Sources/stray.md", "Weekly Review.md")).toBe("Sources/stray");
	});
});

describe("Q13 fallback: the full vault path where a plain name clashes with another source", () => {
	it("a tephra note picking tephra's README, which also exists in the vault, inserts the full vault path", () => {
		expect(sourceLinkText(f("Sources/tephra/README.md"), "Sources/tephra/docs/Guide.md", VAULT, FALLBACK)).toEqual({
			text: "Sources/tephra/README",
			kind: "full-path",
			source: "tephra",
		});
	});

	it("a vault note picking the vault README, which also exists in tephra, is a full-path pick", () => {
		expect(sourceLinkText(f("README.md"), "Weekly Review.md", VAULT, FALLBACK)).toMatchObject({ text: "README", kind: "full-path" });
	});

	it("`Leg Day` (vault and whoop) from a whoop note, in fallback mode", () => {
		expect(text("Sources/whoop/Leg Day.md", "Sources/whoop/Workout Plan.md", FALLBACK)).toBe("Sources/whoop/Leg Day");
	});

	it("a name that exists in one source only stays bare", () => {
		expect(text("Sources/whoop/Workout Plan.md", "Sources/whoop/Leg Day.md", FALLBACK)).toBe("Workout Plan");
	});

	it("cross-source picks are unaffected by the mode", () => {
		expect(text("Sources/tephra/docs/Guide.md", "Weekly Review.md", FALLBACK)).toBe("@tephra:Guide");
	});

	it("without the fallback the same pick is the bare name", () => {
		expect(text("Sources/tephra/README.md", "Sources/tephra/docs/Guide.md", NO_FALLBACK)).toBe("README");
	});
});
