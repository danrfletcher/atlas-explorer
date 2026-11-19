import { describe, expect, it } from "vitest";
import { SourcePromoter, type SourcePromoteConnection } from "../../src/source-promote";
import type { TephraCallResult } from "../../src/tephra-client";
import type { TephraSnapshot } from "../../src/tephra-connection";

// PR-12 (G6): the action: one confirm, one call, nothing queued, a refusal in Tephra's words.

const SOURCES: TephraSnapshot["sources"] = [
	{ name: "tephra", path: "/dev/Tephra", status: "online" },
	{ name: "tephrad", path: "/dev/Tephra/crates/tephrad", status: "online" },
];

function rig(options: { state?: "online" | "offline"; answer?: () => Promise<TephraCallResult>; confirm?: boolean; hold?: Promise<void> } = {}) {
	const calls: Array<{ method: string; params: unknown }> = [];
	const notices: string[] = [];
	const confirms: string[] = [];
	let checks = 0;
	let state = options.state ?? "online";
	const connection: SourcePromoteConnection = {
		getSnapshot: () => ({ state, checked: true, sources: state === "online" ? SOURCES : [] }) as TephraSnapshot,
		call: async (method, params) => {
			calls.push({ method, params });
			return options.answer ? options.answer() : ({ ok: true, result: { status: "applied", deferred: 0 } } as TephraCallResult);
		},
		requestCheck: () => void (checks += 1),
	};
	const promoter = new SourcePromoter({
		getConnection: () => connection,
		getVaultPath: () => "/Users/dan/Vault",
		confirm: async (message) => {
			confirms.push(message);
			if (options.hold) await options.hold;
			return options.confirm ?? true;
		},
		notify: (message) => void notices.push(message),
	});
	return { promoter, calls, notices, confirms, checks: () => checks, setState: (s: "online" | "offline") => void (state = s) };
}

describe("makeOwnSource", () => {
	it("one confirm, then one source.promote { name, root } with the absolute path; then a source-list check", async () => {
		const r = rig();
		await r.promoter.makeOwnSource("Sources/tephra/docs");
		expect(r.confirms).toEqual(["Make docs its own source? It will be hidden in tephra."]);
		expect(r.calls).toEqual([{ method: "source.promote", params: { name: "docs", root: "/dev/Tephra/docs" } }]);
		expect(r.checks()).toBe(1);
		expect(r.notices).toEqual([]);
	});

	it("a vault folder is sent with the vault's own path in front", async () => {
		const r = rig();
		await r.promoter.makeOwnSource("Projects/Atlas");
		expect(r.calls[0].params).toEqual({ name: "atlas", root: "/Users/dan/Vault/Projects/Atlas" });
		expect(r.confirms[0]).toContain("hidden in the vault");
	});

	it("Cancel sends nothing", async () => {
		const r = rig({ confirm: false });
		await r.promoter.makeOwnSource("Sources/tephra/docs");
		expect(r.calls).toEqual([]);
		expect(r.checks()).toBe(0);
		expect(r.notices).toEqual([]);
	});

	it("Tephra offline: nothing is asked, nothing is sent or queued, the user is told", async () => {
		const r = rig({ state: "offline" });
		await r.promoter.makeOwnSource("Sources/tephra/docs");
		expect(r.confirms).toEqual([]);
		expect(r.calls).toEqual([]);
		expect(r.notices).toEqual(["Atlas: Tephra isn't running."]);
	});

	it("Tephra going away while the dialog is open: confirmed, but nothing is sent", async () => {
		let release!: () => void;
		const r = rig({ hold: new Promise<void>((resolve) => (release = resolve)) });
		const pending = r.promoter.makeOwnSource("Sources/tephra/docs");
		await Promise.resolve();
		r.setState("offline");
		release();
		await pending;
		expect(r.calls).toEqual([]);
		expect(r.notices).toEqual(["Atlas: Tephra isn't running."]);
	});

	it("a refusal is shown in Tephra's sentence and changes nothing", async () => {
		const r = rig({ answer: async () => ({ ok: false, error: { kind: "rpc", message: "Tephra error: the name \"docs\" is taken by the source \"docs\"" } }) as TephraCallResult });
		await r.promoter.makeOwnSource("Sources/tephra/docs");
		expect(r.notices).toEqual(["Atlas: couldn't make docs its own source: the name \"docs\" is taken by the source \"docs\"."]);
		expect(r.checks()).toBe(0);
	});

	it("a timeout is not sent again, and asks for a fresh source list to see what happened", async () => {
		const r = rig({ answer: async () => ({ ok: false, error: { kind: "timeout", message: "t" } }) as TephraCallResult });
		await r.promoter.makeOwnSource("Sources/tephra/docs");
		expect(r.calls).toHaveLength(1);
		expect(r.checks()).toBe(1);
		expect(r.notices[0]).toContain("didn't answer in time");
	});

	it("an answer that leaves links unrewritten says how many, and still refreshes", async () => {
		const r = rig({ answer: async () => ({ ok: true, result: { status: "partial", deferred: 2 } }) as TephraCallResult });
		await r.promoter.makeOwnSource("Sources/tephra/docs");
		expect(r.notices[0]).toContain("2 linking files still point at the old name");
		expect(r.checks()).toBe(1);
	});

	it("a second request while one is open is refused, and the first completes", async () => {
		let release!: () => void;
		const r = rig({ hold: new Promise<void>((resolve) => (release = resolve)) });
		const first = r.promoter.makeOwnSource("Sources/tephra/docs");
		await Promise.resolve();
		await r.promoter.makeOwnSource("Sources/tephra/other");
		expect(r.notices).toEqual(["Atlas: A source change is in progress."]);
		release();
		await first;
		expect(r.calls).toHaveLength(1);
		expect(r.promoter.isBusy()).toBe(false);
	});

	it("a folder Atlas can't place on disk is not sent", async () => {
		const r = rig();
		await r.promoter.makeOwnSource("Sources/ghost/dir");
		expect(r.calls).toEqual([]);
		expect(r.confirms).toEqual([]);
		expect(r.notices[0]).toContain("can't tell which folder on disk");
	});
});

describe("returnToParent", () => {
	it("one confirm, then one source.unpromote { name }", async () => {
		const r = rig();
		await r.promoter.returnToParent("tephrad");
		expect(r.confirms[0]).toContain("Return tephrad to tephra?");
		expect(r.calls).toEqual([{ method: "source.unpromote", params: { name: "tephrad" } }]);
		expect(r.checks()).toBe(1);
	});

	it("a top-level or unknown source is not sent", async () => {
		const r = rig();
		await r.promoter.returnToParent("tephra");
		await r.promoter.returnToParent("ghost");
		expect(r.calls).toEqual([]);
		expect(r.confirms).toEqual([]);
	});

	it("Cancel sends nothing; a refusal is Tephra's sentence", async () => {
		const cancelled = rig({ confirm: false });
		await cancelled.promoter.returnToParent("tephrad");
		expect(cancelled.calls).toEqual([]);
		const refused = rig({ answer: async () => ({ ok: false, error: { kind: "rpc", message: "Tephra error: the source \"tephrad\" is offline" } }) as TephraCallResult });
		await refused.promoter.returnToParent("tephrad");
		expect(refused.notices).toEqual(["Atlas: couldn't return tephrad to its parent: the source \"tephrad\" is offline."]);
	});

	it("offline: nothing is sent", async () => {
		const r = rig({ state: "offline" });
		await r.promoter.returnToParent("tephrad");
		expect(r.calls).toEqual([]);
		expect(r.notices).toEqual(["Atlas: Tephra isn't running."]);
	});
});
