import { describe, expect, it } from "vitest";
import { EXPECTED_DELETE_TTL_MS, SourceDeleteClassifier } from "../../src/source-delete-classifier";

function make(links: Record<string, string> = { whoop: "/data/whoop", whoopx: "/data/whoopx" }, existing: string[] = ["/data/whoop", "/data/whoopx"]) {
	const clock = { now: 1_000 };
	const present = new Set(existing);
	const classifier = new SourceDeleteClassifier({
		getLinkTargets: () => links,
		targetExists: (target) => present.has(target),
		now: () => clock.now,
	});
	return { classifier, clock, present, links };
}

describe("SourceDeleteClassifier", () => {
	it("a delete outside Sources/ is real", () => {
		expect(make().classifier.classify("Notes/Leg Day.md")).toBe("real");
		expect(make().classifier.classify("SourcesX/whoop/a.md")).toBe("real");
		expect(make().classifier.classify("Sources.md")).toBe("real");
	});

	it("a delete inside a linked, present source is real (Dan deletes Leg Day.md)", () => {
		expect(make().classifier.classify("Sources/whoop/Leg Day.md")).toBe("real");
	});

	describe("expected deletes (Atlas unlinked, or excluded)", () => {
		it("an expected prefix matches itself and everything under it", () => {
			const { classifier } = make();
			classifier.expectPrefix("Sources/whoop");
			expect(classifier.classify("Sources/whoop")).toBe("expected");
			expect(classifier.classify("Sources/whoop/Leg Day.md")).toBe("expected");
			expect(classifier.classify("Sources/whoop/a/b/c.md")).toBe("expected");
		});

		it("the prefix rule is exact: Sources/whoopx/ is not Sources/whoop/", () => {
			const { classifier } = make();
			classifier.expectPrefix("Sources/whoop");
			expect(classifier.classify("Sources/whoopx/Leg Day.md")).toBe("real");
			expect(classifier.classify("Sources/whoop.md")).toBe("real");
		});

		it("the reverse also holds: expecting whoopx leaves whoop real", () => {
			const { classifier } = make();
			classifier.expectPrefix("Sources/whoopx");
			expect(classifier.classify("Sources/whoop/Leg Day.md")).toBe("real");
		});

		it("an expectation lapses after the TTL since its last match", () => {
			const { classifier, clock } = make();
			classifier.expectPrefix("Sources/whoop");
			clock.now += EXPECTED_DELETE_TTL_MS - 1;
			expect(classifier.classify("Sources/whoop/a.md")).toBe("expected");
			clock.now += EXPECTED_DELETE_TTL_MS - 1; // renewed by the match above
			expect(classifier.classify("Sources/whoop/b.md")).toBe("expected");
			clock.now += EXPECTED_DELETE_TTL_MS + 1;
			expect(classifier.classify("Sources/whoop/c.md")).toBe("real");
		});

		it("an expectation that never matched lapses too", () => {
			const { classifier, clock } = make();
			classifier.expectPrefix("Sources/whoop");
			clock.now += EXPECTED_DELETE_TTL_MS + 1;
			expect(classifier.classify("Sources/whoop/a.md")).toBe("real");
		});

		it("still expected for a source that is not in the records (it was just unlinked)", () => {
			const { classifier } = make({}, []);
			classifier.expectPrefix("Sources/old");
			expect(classifier.classify("Sources/old/a.md")).toBe("expected");
		});

		it("clear() forgets every expectation", () => {
			const { classifier } = make();
			classifier.expectPrefix("Sources/whoop");
			classifier.clear();
			expect(classifier.classify("Sources/whoop/a.md")).toBe("real");
		});
	});

	describe("missing sources (R3-4)", () => {
		it("a source whose folder is gone from disk is missing, though Tephra hasn't said so yet", () => {
			const { classifier, present } = make();
			present.delete("/data/whoop");
			expect(classifier.classify("Sources/whoop/Workout Plan.md")).toBe("missing");
			expect(classifier.classify("Sources/whoop")).toBe("missing");
		});

		it("a source Tephra reports missing is missing", () => {
			const { classifier } = make();
			classifier.setMissingSources(["whoop"]);
			expect(classifier.classify("Sources/whoop/a.md")).toBe("missing");
			expect(classifier.classify("Sources/whoopx/a.md")).toBe("real");
		});

		it("when the folder returns the next delete is real again", () => {
			const { classifier, present } = make();
			present.delete("/data/whoop");
			expect(classifier.classify("Sources/whoop/a.md")).toBe("missing");
			present.add("/data/whoop");
			classifier.setMissingSources([]);
			expect(classifier.classify("Sources/whoop/a.md")).toBe("real");
		});

		it("missing is exact too: whoopx stays real while whoop is missing", () => {
			const { classifier, present } = make();
			present.delete("/data/whoop");
			expect(classifier.classify("Sources/whoopx/a.md")).toBe("real");
		});

		it("a path under Sources/ that belongs to no known source is real", () => {
			expect(make().classifier.classify("Sources/stranger/a.md")).toBe("real");
		});

		it("a source name that is an Object.prototype member is not found by inheritance", () => {
			const { classifier } = make({}, []);
			expect(classifier.classify("Sources/constructor/a.md")).toBe("real");
			expect(classifier.classify("Sources/toString/a.md")).toBe("real");
		});
	});

	describe("a promoted source's folder (R3-4, E5)", () => {
		const TOP = "/data/tephra";
		const roots = [
			{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad", absRoot: "/data/tephra/crates/tephrad" },
			{ name: "core", vaultPath: "Sources/tephra/crates/tephrad/core", absRoot: "/data/tephra/crates/tephrad/core" },
		];
		function makePromoted(existing: string[] = [TOP, "/data/tephra/crates/tephrad", "/data/tephra/crates/tephrad/core"]) {
			const present = new Set(existing);
			const classifier = new SourceDeleteClassifier({
				getLinkTargets: () => ({ tephra: TOP }),
				targetExists: (target) => present.has(target),
				getPromotedRoots: () => roots,
			});
			return { classifier, present };
		}

		it("a delete under a promoted folder that is gone on disk is missing, though the top-level link target is there", () => {
			const { classifier, present } = makePromoted();
			present.delete("/data/tephra/crates/tephrad");
			expect(classifier.classify("Sources/tephra/crates/tephrad/src/registry.rs")).toBe("missing");
			expect(classifier.classify("Sources/tephra/crates/tephrad")).toBe("missing");
		});

		it("Tephra reporting the promoted source missing is enough, with no disk probe answer", () => {
			const { classifier } = makePromoted();
			classifier.setMissingSources(["tephrad"]);
			expect(classifier.classify("Sources/tephra/crates/tephrad/src/scan.rs")).toBe("missing");
		});

		it("a real delete under a promoted folder that is still there is real", () => {
			const { classifier } = makePromoted();
			expect(classifier.classify("Sources/tephra/crates/tephrad/src/registry.rs")).toBe("real");
		});

		it("a promoted folder inside a promoted folder: the outer one gone covers a delete in the inner one", () => {
			const { classifier, present } = makePromoted();
			present.delete("/data/tephra/crates/tephrad");
			present.delete("/data/tephra/crates/tephrad/core");
			expect(classifier.classify("Sources/tephra/crates/tephrad/core/a.rs")).toBe("missing");
		});

		it("whole segments only: crates/tephrad2 is not inside crates/tephrad", () => {
			const { classifier, present } = makePromoted();
			present.delete("/data/tephra/crates/tephrad");
			expect(classifier.classify("Sources/tephra/crates/tephrad2/a.rs")).toBe("real");
			expect(classifier.classify("Sources/tephra/crates/other/a.rs")).toBe("real");
		});

		it("a root with no known absolute path is judged by Tephra's status alone", () => {
			const classifier = new SourceDeleteClassifier({
				getLinkTargets: () => ({ tephra: TOP }),
				targetExists: () => true,
				getPromotedRoots: () => [{ name: "tephrad", vaultPath: "Sources/tephra/crates/tephrad" }],
			});
			expect(classifier.classify("Sources/tephra/crates/tephrad/a.rs")).toBe("real");
			classifier.setMissingSources(["tephrad"]);
			expect(classifier.classify("Sources/tephra/crates/tephrad/a.rs")).toBe("missing");
		});
	});
});
