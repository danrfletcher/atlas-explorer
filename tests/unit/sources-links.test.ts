import { describe, expect, it } from "vitest";
import {
	checkSourcesOwnership,
	normalizeRoot,
	planSourceLinks,
	readSourcesEntries,
	selectTopLevelSources,
	type LinkEntry,
	type TopLevelSource,
} from "../../src/sources-links";
import type { TephraSource } from "../../src/tephra-client";
import { MemoryFs } from "../memory-fs";

const VAULT = "/Users/dan/Notes";
const src = (name: string, path: string): TephraSource => ({ name, path, status: "online" });
const NOTES = src("notes", VAULT);

describe("selectTopLevelSources (G2: only top-level sources, never notes)", () => {
	it("links every top-level source and never the vault source", () => {
		const { linked } = selectTopLevelSources([NOTES, src("tephra", "/Users/dan/Developer/Tephra"), src("whoop", "/Users/dan/Whoop")], VAULT);
		expect(linked).toEqual([
			{ name: "tephra", root: "/Users/dan/Developer/Tephra" },
			{ name: "whoop", root: "/Users/dan/Whoop" },
		]);
	});

	it("gives a source whose root is inside another source's root no link (nested or promoted)", () => {
		const { linked } = selectTopLevelSources([src("tephra", "/dev/Tephra"), src("tephrad", "/dev/Tephra/crates/tephrad"), src("other", "/dev/Other")], VAULT);
		expect(linked.map((s) => s.name)).toEqual(["other", "tephra"]);
	});

	it("a root that only shares a name prefix with another is not nested", () => {
		const { linked } = selectTopLevelSources([src("a", "/dev/Tephra"), src("b", "/dev/Tephra-extra")], VAULT);
		expect(linked.map((s) => s.name)).toEqual(["a", "b"]);
	});

	it("gives a source inside the vault's own root no link (the vault source covers it)", () => {
		const { linked } = selectTopLevelSources([NOTES, src("inner", `${VAULT}/Projects/Inner`)], VAULT);
		expect(linked).toEqual([]);
	});

	it("R5: with no notes row in Tephra's list, the vault path itself is the containing root", () => {
		const list = [src("inner", `${VAULT}/Projects/Inner`), src("whoop", "/Users/dan/Whoop")];
		expect(selectTopLevelSources(list, VAULT).linked).toEqual([{ name: "whoop", root: "/Users/dan/Whoop" }]);
		// With the notes row present the answer is the same, so the row's presence doesn't change which sources link.
		expect(selectTopLevelSources([NOTES, ...list], VAULT).linked).toEqual([{ name: "whoop", root: "/Users/dan/Whoop" }]);
		// A trailing slash on the vault path doesn't hide the nesting, and a sibling sharing the name prefix isn't inside it.
		const sibling = src("sibling", `${VAULT}-extra/Inner`);
		expect(selectTopLevelSources([src("inner", `${VAULT}/Inner`), sibling], `${VAULT}/`).linked).toEqual([{ name: "sibling", root: `${VAULT}-extra/Inner` }]);
	});

	it("R5: a notes row that points somewhere other than the vault doesn't stop the vault path counting", () => {
		const elsewhere = src("notes", "/Users/dan/OtherNotes");
		const { linked } = selectTopLevelSources([elsewhere, src("inner", `${VAULT}/Inner`), src("under-other", "/Users/dan/OtherNotes/Sub")], VAULT);
		expect(linked).toEqual([]);
	});

	it("two sources on the same folder: the first by name keeps the link", () => {
		const { linked } = selectTopLevelSources([src("zeta", "/dev/X"), src("alpha", "/dev/X")], VAULT);
		expect(linked).toEqual([{ name: "alpha", root: "/dev/X" }]);
	});

	it("ignores trailing slashes when comparing and when recording the target", () => {
		const { linked } = selectTopLevelSources([src("a", "/dev/X/"), src("b", "/dev/X/sub")], VAULT);
		expect(linked).toEqual([{ name: "a", root: "/dev/X" }]);
	});

	it("leaves out a source whose root holds the vault (its link would contain the vault)", () => {
		const { linked, skipped } = selectTopLevelSources([src("home", "/Users/dan")], VAULT);
		expect(linked).toEqual([]);
		expect(skipped).toEqual([{ name: "home", reason: "contains-vault" }]);
	});

	it("leaves out a relative root: a relative link target would resolve inside Sources/", () => {
		const { linked, skipped } = selectTopLevelSources([src("rel", "Documents/Recipes")], VAULT);
		expect(linked).toEqual([]);
		expect(skipped).toEqual([{ name: "rel", reason: "relative-path" }]);
	});

	it("never lets a name that isn't one path segment reach a path", () => {
		const { linked, skipped } = selectTopLevelSources([src("../evil", "/dev/E"), src("a/b", "/dev/F"), src("..", "/dev/G")], VAULT);
		expect(linked).toEqual([]);
		expect(skipped.map((s) => s.reason)).toEqual(["unusable-name", "unusable-name", "unusable-name"]);
	});

	it("names with . - _ and a 100-character name are fine", () => {
		const long = "n".repeat(100);
		const { linked } = selectTopLevelSources([src("my.repo", "/a"), src("my-repo", "/b"), src("my_repo", "/c"), src(long, "/d")], VAULT);
		expect(linked.map((s) => s.name).sort()).toEqual(["my-repo", "my.repo", "my_repo", long].sort());
	});

	it("works without a vault path (nothing to compare against)", () => {
		expect(selectTopLevelSources([src("a", "/dev/A")], null).linked).toHaveLength(1);
	});
});

describe("normalizeRoot", () => {
	it.each([
		["/a/b/", "/a/b"],
		["/a/b///", "/a/b"],
		["/", "/"],
		["a/b", null],
		["", null],
	])("%s -> %s", (input, expected) => {
		expect(normalizeRoot(input)).toBe(expected);
	});
});

const link = (target: string): LinkEntry => ({ kind: "symlink", target });
const other: LinkEntry = { kind: "other" };
const want = (name: string, root: string): TopLevelSource => ({ name, root });

describe("planSourceLinks", () => {
	it("creates a link for each wanted source that has no entry", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a"), want("b", "/x/b")], entries: new Map(), recorded: {} });
		expect(actions).toEqual([
			{ type: "create", name: "a", target: "/x/a" },
			{ type: "create", name: "b", target: "/x/b" },
		]);
	});

	it("does nothing for a link that is ours and right (idempotent)", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a")], entries: new Map([["a", link("/x/a")]]), recorded: { a: "/x/a" } });
		expect(actions).toEqual([]);
	});

	it("replaces our link when the source's root changed", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/new")], entries: new Map([["a", link("/x/old")]]), recorded: { a: "/x/old" } });
		expect(actions).toEqual([{ type: "replace", name: "a", target: "/x/new", from: "/x/old" }]);
	});

	it("removes a recorded link whose source is gone", () => {
		const actions = planSourceLinks({ wanted: [], entries: new Map([["gone", link("/x/gone")]]), recorded: { gone: "/x/gone" } });
		expect(actions).toEqual([{ type: "remove", name: "gone" }]);
	});

	it("never removes a link that isn't recorded (Dan's own link in Sources/)", () => {
		const actions = planSourceLinks({ wanted: [], entries: new Map([["mine", link("/elsewhere")]]), recorded: {} });
		expect(actions).toEqual([]);
	});

	it("recreates a link Dan deleted by hand, and forgets nothing", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a")], entries: new Map(), recorded: { a: "/x/a" } });
		expect(actions).toEqual([{ type: "create", name: "a", target: "/x/a" }]);
	});

	it("forgets a record whose entry vanished and whose source is gone too, touching nothing on disk", () => {
		const actions = planSourceLinks({ wanted: [], entries: new Map(), recorded: { a: "/x/a" } });
		expect(actions).toEqual([{ type: "forget", name: "a" }]);
	});

	it("forgets (and does not remove) a record whose entry became a real folder", () => {
		const actions = planSourceLinks({ wanted: [], entries: new Map([["a", other]]), recorded: { a: "/x/a" } });
		expect(actions).toEqual([{ type: "forget", name: "a" }]);
	});

	it("E2: a name clash with a real entry skips only that link; the others still link", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a"), want("b", "/x/b")], entries: new Map([["a", other]]), recorded: {} });
		expect(actions).toEqual([
			{ type: "skip", name: "a", reason: "clash" },
			{ type: "create", name: "b", target: "/x/b" },
		]);
	});

	it("a clash is skipped even when the name is recorded: a real folder is never replaced", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a")], entries: new Map([["a", other]]), recorded: { a: "/x/a" } });
		expect(actions).toEqual([{ type: "skip", name: "a", reason: "clash" }]);
	});

	it("a link we didn't record that points elsewhere is left alone and the source is not linked", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a")], entries: new Map([["a", link("/elsewhere")]]), recorded: {} });
		expect(actions).toEqual([{ type: "skip", name: "a", reason: "foreign-link" }]);
	});

	it("an unrecorded link already pointing at the right folder is adopted, not recreated", () => {
		const actions = planSourceLinks({ wanted: [want("a", "/x/a")], entries: new Map([["a", link("/x/a/")]]), recorded: {} });
		expect(actions).toEqual([{ type: "adopt", name: "a", target: "/x/a" }]);
	});

	it("never turns a hand-edited record name into a path action", () => {
		const actions = planSourceLinks({ wanted: [], entries: new Map(), recorded: { "../../etc": "/x" } });
		expect(actions).toEqual([{ type: "forget", name: "../../etc" }]);
	});

	it("a record named like an Object.prototype member is just a name", () => {
		const recorded = JSON.parse('{"constructor": "/x/c"}') as Record<string, string>;
		const actions = planSourceLinks({ wanted: [want("toString", "/x/t")], entries: new Map(), recorded });
		expect(actions).toEqual([
			{ type: "forget", name: "constructor" },
			{ type: "create", name: "toString", target: "/x/t" },
		]);
	});
});

describe("planSourceLinks applied to an in-memory fs: idempotency", () => {
	it("a second plan after the actions ran has nothing to do", async () => {
		const fs = new MemoryFs().dir(`${VAULT}/Sources`);
		const wanted = [want("a", "/x/a"), want("b", "/x/b")];
		const recorded: Record<string, string> = {};
		const first = planSourceLinks({ wanted, entries: await readSourcesEntries(fs, `${VAULT}/Sources`), recorded });
		for (const action of first) if (action.type === "create") {
			await fs.symlink(action.target, `${VAULT}/Sources/${action.name}`);
			recorded[action.name] = action.target;
		}
		expect(first).toHaveLength(2);
		expect(planSourceLinks({ wanted, entries: await readSourcesEntries(fs, `${VAULT}/Sources`), recorded })).toEqual([]);
	});
});

describe("readSourcesEntries", () => {
	it("tells links from real entries without following links", async () => {
		const fs = new MemoryFs().link(`${VAULT}/Sources/a`, "/x/a").dir(`${VAULT}/Sources/real`).file(`${VAULT}/Sources/note.md`);
		const entries = await readSourcesEntries(fs, `${VAULT}/Sources`);
		expect(entries.get("a")).toEqual({ kind: "symlink", target: "/x/a" });
		expect(entries.get("real")).toEqual({ kind: "other" });
		expect(entries.get("note.md")).toEqual({ kind: "other" });
	});

	it("is empty when Sources/ doesn't exist", async () => {
		expect((await readSourcesEntries(new MemoryFs().dir(VAULT), `${VAULT}/Sources`)).size).toBe(0);
	});
});

describe("checkSourcesOwnership (E13)", () => {
	it("accepts a vault with no Sources/", async () => {
		expect(await checkSourcesOwnership(new MemoryFs().dir(VAULT), VAULT, {})).toEqual({ ok: true });
	});

	it("accepts an empty Sources/ Atlas made on a previous run", async () => {
		expect(await checkSourcesOwnership(new MemoryFs().dir(`${VAULT}/Sources`), VAULT, {})).toEqual({ ok: true });
	});

	it("accepts a reload with every link in place and recorded", async () => {
		const fs = new MemoryFs().link(`${VAULT}/Sources/a`, "/x/a").link(`${VAULT}/Sources/b`, "/x/b");
		expect(await checkSourcesOwnership(fs, VAULT, { a: "/x/a", b: "/x/b" })).toEqual({ ok: true });
	});

	it("refuses a real folder holding a note, naming Sources", async () => {
		const fs = new MemoryFs().file(`${VAULT}/Sources/Reading list.md`, "x");
		const result = await checkSourcesOwnership(fs, VAULT, {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.path).toBe("Sources");
			expect(result.reason).toContain("Reading list.md");
		}
	});

	it("refuses a link that isn't recorded, even a symlink", async () => {
		const fs = new MemoryFs().link(`${VAULT}/Sources/a`, "/x/a");
		expect((await checkSourcesOwnership(fs, VAULT, {})).ok).toBe(false);
	});

	it("refuses a real sub-folder even when its name is recorded", async () => {
		const fs = new MemoryFs().dir(`${VAULT}/Sources/a`);
		expect((await checkSourcesOwnership(fs, VAULT, { a: "/x/a" })).ok).toBe(false);
	});

	it("refuses a file called Sources", async () => {
		const result = await checkSourcesOwnership(new MemoryFs().file(`${VAULT}/Sources`, "x"), VAULT, {});
		expect(result).toMatchObject({ ok: false, path: "Sources" });
	});

	it("refuses Sources as a link", async () => {
		const result = await checkSourcesOwnership(new MemoryFs().link(`${VAULT}/Sources`, "/elsewhere"), VAULT, {});
		expect(result).toMatchObject({ ok: false, path: "Sources" });
	});

	it("Sources.md next to the vault root is no clash", async () => {
		expect(await checkSourcesOwnership(new MemoryFs().file(`${VAULT}/Sources.md`, "x"), VAULT, {})).toEqual({ ok: true });
	});

	it("checking changes nothing", async () => {
		const fs = new MemoryFs().file(`${VAULT}/Sources/note.md`);
		await checkSourcesOwnership(fs, VAULT, {});
		expect(fs.calls.every((c) => c.startsWith("lstat ") || c.startsWith("readdir "))).toBe(true);
	});
});
