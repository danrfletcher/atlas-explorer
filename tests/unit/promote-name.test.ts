import { describe, expect, it } from "vitest";
import { parentLabel, promoteConfirmText, promoteRefusalNotice, promotedSourceName, returnConfirmText } from "../../src/promote-name";

// PR-12 (G6): the folder's name as a source name (G3's rule), the confirm texts, and Tephra's refusal reasons.

describe("promote words", () => {
	it("the name is the folder's name, lowercased, spaces -> `-` (G3's rule)", () => {
		expect(promotedSourceName("Sources/tephra/crates/Tephra Daemon")).toBe("tephra-daemon");
		expect(promotedSourceName("Projects/Atlas")).toBe("atlas");
	});
	it("the confirm shows the name and where the folder is hidden", () => {
		expect(promoteConfirmText("tephrad", "tephra")).toBe("Make tephrad its own source? It will be hidden in tephra.");
		expect(promoteConfirmText("atlas", "notes")).toBe("Make atlas its own source? It will be hidden in the vault.");
		expect(promoteConfirmText("atlas", null)).toContain("the vault");
		expect(parentLabel("tephra")).toBe("tephra");
		expect(returnConfirmText("tephrad", "tephra")).toContain("Return tephrad to tephra?");
	});
	it("a refusal is Tephra's sentence after Atlas's lead-in; no answer is said in Atlas's words", () => {
		expect(promoteRefusalNotice("promote", "tephrad", { kind: "rpc", message: "Tephra error: the name \"tephrad\" is taken by the source \"tephrad\"" })).toBe(
			"Atlas: couldn't make tephrad its own source: the name \"tephrad\" is taken by the source \"tephrad\"."
		);
		expect(promoteRefusalNotice("return", "tephrad", { kind: "network", message: "x" })).toBe("Atlas: couldn't return tephrad to its parent: Tephra isn't running.");
		expect(promoteRefusalNotice("promote", "a", { kind: "timeout", message: "x" })).toContain("didn't answer in time");
	});
});

describe("the name that is shown and sent is the same one", () => {
	it.each([
		["Sources/tephra/crates/My Tools", "my-tools"],
		["Sources/tephra/crates/tephrad", "tephrad"],
		["Projects/Atlas", "atlas"],
		["Projects/Two  Spaces", "two--spaces"], // each space becomes one `-`: G3 changes nothing else
		["Top Level", "top-level"],
	])("%s -> %s, and the confirm names it", (path, name) => {
		expect(promotedSourceName(path)).toBe(name);
		expect(promoteConfirmText(name, "tephra")).toBe(`Make ${name} its own source? It will be hidden in tephra.`);
	});

	it("a name that can't be a source name is sent as it is: Tephra's reason is the answer, not a second Atlas rulebook", () => {
		expect(promotedSourceName("Sources/tephra/@@@")).toBe("@@@");
		expect(promoteRefusalNotice("promote", "@@@", { kind: "rpc", message: "Tephra error: invalid source name \"@@@\"" })).toBe("Atlas: couldn't make @@@ its own source: invalid source name \"@@@\".");
	});

	it("each refusal Tephra gives (name taken, nested, not inside a source) is shown word for word", () => {
		for (const reason of ["the name \"tephra\" is taken by the source \"tephra\"", "the folder is not inside a source", "the folder is nested inside the source \"x\""]) {
			expect(promoteRefusalNotice("promote", "n", { kind: "rpc", message: `Tephra error: ${reason}` })).toBe(`Atlas: couldn't make n its own source: ${reason}.`);
		}
		expect(promoteRefusalNotice("return", "n", { kind: "rpc", message: "Tephra error: the source is not promoted" })).toBe("Atlas: couldn't return n to its parent: the source is not promoted.");
	});
});
