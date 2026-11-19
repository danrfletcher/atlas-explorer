import { describe, expect, it } from "vitest";
import {
	FOLDER_RENAME_WINDOW_MS,
	RENAME_COALESCE_MS,
	STALE_MAX_RETRIES,
	STALE_RETRY_DELAY_MS,
	TEPHRA_RENAME_METHOD,
	TephraRenameForwarder,
	type RenameCaller,
	type RenameScheduler,
} from "../../src/tephra-rename-forwarder";
import { TephraRenameQueue, type QueueStorage } from "../../src/tephra-rename-queue";
import type { TephraCallResult } from "../../src/tephra-client";
import { flush } from "../helpers";

/** G11: the drain loop and the folder folding of `TephraRenameForwarder`, over a fake clock and a fake Tephra.
 * The real-client run against a stub server is `tests/integration/tephra-rename-forwarding.test.ts`. */

class FakeClock implements RenameScheduler {
	now = 0;
	private next = 1;
	private timers = new Map<number, { at: number; cb: () => void }>();
	setTimeout(cb: () => void, ms: number): unknown {
		const id = this.next++;
		this.timers.set(id, { at: this.now + ms, cb });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}
	get pendingTimers(): number {
		return this.timers.size;
	}
	async advance(ms: number): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.now = due[1].at;
			due[1].cb();
			await flush();
		}
		this.now = end;
		await flush();
	}
}

class MemoryStorage implements QueueStorage {
	files = new Map<string, string>();
	read(path: string) {
		return this.files.get(path) ?? null;
	}
	write(path: string, text: string) {
		this.files.set(path, text);
	}
	moveAside(from: string, to: string) {
		this.files.set(to, this.files.get(from) ?? "");
		this.files.delete(from);
	}
}

type Reply = TephraCallResult | "throw" | "hang";
const OK: TephraCallResult = { ok: true, result: null };
const rpcError = (message: string, code = -32000): TephraCallResult => ({ ok: false, error: { kind: "rpc", message, code } });
const NETWORK: TephraCallResult = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };
const STALE = rpcError("file changed, try again");
const ROOT = "/Users/dan/Vault";

function rig(options: { online?: boolean; active?: boolean; storage?: MemoryStorage } = {}) {
	const clock = new FakeClock();
	const storage = options.storage ?? new MemoryStorage();
	const state = { online: options.online ?? true, active: options.active ?? true, connected: true, root: ROOT as string | null };
	/** What Tephra receives, in order, whatever it answers, with the vault's folder taken off (the exact vault paths). */
	const sent: Array<{ old_path: string; new_path: string }> = [];
	/** The same calls as they went over the wire. */
	const wire: Array<{ old_path: string; new_path: string }> = [];
	const replies: Reply[] = [];
	let hang: (() => void) | null = null;
	const caller: RenameCaller = {
		isOnline: () => state.online,
		async call(method, params) {
			expect(method).toBe(TEPHRA_RENAME_METHOD);
			const p = params as { old_path: string; new_path: string };
			wire.push(p);
			sent.push({ old_path: p.old_path.replace(`${ROOT}/`, ""), new_path: p.new_path.replace(`${ROOT}/`, "") });
			const reply = replies.shift() ?? OK;
			if (reply === "throw") throw new Error("boom");
			if (reply === "hang") await new Promise<void>((resolve) => (hang = resolve));
			return reply === "hang" ? NETWORK : reply;
		},
	};
	const notices: string[] = [];
	const logs: string[] = [];
	const build = () =>
		new TephraRenameForwarder({
			queue: new TephraRenameQueue({ storage, path: "/q.json", now: () => clock.now, onCorrupt: () => {}, onWriteError: () => {} }),
			scheduler: clock,
			now: () => clock.now,
			isActive: () => state.active,
			getConnection: () => (state.connected ? caller : null),
			getVaultRoot: () => state.root,
			notify: (m) => void notices.push(m),
			log: (m) => void logs.push(m),
		});
	const forwarder = build();
	forwarder.load();
	return {
		forwarder,
		clock,
		storage,
		state,
		sent,
		wire,
		replies,
		notices,
		logs,
		build,
		releaseHang: () => hang?.(),
		queued: () => forwarder.pending().map((e) => [e.oldPath, e.newPath]),
		/** Records a file rename and lets the coalescing wait and the send finish. */
		async rename(oldPath: string, newPath: string, isFolder = false) {
			const queued = forwarder.record(oldPath, newPath, isFolder);
			await clock.advance(RENAME_COALESCE_MS);
			return queued;
		},
	};
}

describe("sending", () => {
	it("a rename goes to Tephra with the exact old and new vault paths and leaves the queue once acknowledged", async () => {
		const r = rig();
		await r.rename("Sources/whoop/Workout Plan.md", "Sources/whoop/Training Plan.md");
		expect(r.sent).toEqual([{ old_path: "Sources/whoop/Workout Plan.md", new_path: "Sources/whoop/Training Plan.md" }]);
		expect(r.queued()).toEqual([]);
		expect(r.storage.files.get("/q.json")).toContain('"entries":[]');
	});

	it("Tephra is sent absolute paths (the vault's folder plus the exact vault path), while the queue keeps the vault paths", async () => {
		const r = rig();
		await r.rename("Sources/whoop/Workout Plan.md", "Sources/whoop/Training Plan.md");
		expect(r.wire).toEqual([{ old_path: `${ROOT}/Sources/whoop/Workout Plan.md`, new_path: `${ROOT}/Sources/whoop/Training Plan.md` }]);
		const held = rig({ online: false });
		await held.rename("Sources/whoop/a #1 [x] ^y é.md", "b.md");
		expect(held.queued()).toEqual([["Sources/whoop/a #1 [x] ^y é.md", "b.md"]]); // never rewritten to absolute on disk
	});

	it("a vault folder with a trailing slash still gives one slash", async () => {
		const r = rig();
		r.state.root = `${ROOT}/`;
		await r.rename("a.md", "b.md");
		expect(r.wire).toEqual([{ old_path: `${ROOT}/a.md`, new_path: `${ROOT}/b.md` }]);
	});

	it("with no vault folder to anchor the paths nothing is sent and the entry stays queued, with no Notice", async () => {
		const r = rig();
		r.state.root = null;
		await r.rename("a.md", "b.md");
		expect(r.wire).toEqual([]);
		expect(r.queued()).toEqual([["a.md", "b.md"]]);
		expect(r.notices).toEqual([]);
		r.state.root = ROOT;
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.wire).toHaveLength(1);
		expect(r.queued()).toEqual([]);
	});

	it.each([
		["applied", { status: "applied", files_changed: 3 }],
		["already_applied", { status: "already_applied" }],
		["nothing_to_fix", { status: "nothing_to_fix" }],
	])("Tephra's `%s` answer is an acknowledgement with no Notice", async (_name, result) => {
		const r = rig();
		r.replies.push({ ok: true, result });
		await r.rename("a.md", "b.md");
		expect(r.queued()).toEqual([]);
		expect(r.notices).toEqual([]);
	});

	it("a `partial` answer acknowledges the entry and tells the user which files Tephra kept for a retry", async () => {
		const r = rig();
		r.replies.push({ ok: true, result: { status: "partial", files_changed: 1, deferred: [{ file: "Weekly Review.md", reason: "pending" }] } });
		r.replies.push(OK);
		await r.rename("a.md", "b.md");
		await r.rename("c.md", "d.md");
		expect(r.queued()).toEqual([]); // Tephra holds the leftovers in its pending fixes
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "c.md"]);
		expect(r.notices).toHaveLength(1);
		expect(r.notices[0]).toContain("Weekly Review.md");
		expect(r.notices[0]).toContain('"b.md"');
	});

	it("record() writes the queue before it returns, ahead of any send", () => {
		const r = rig();
		r.forwarder.record("a.md", "b.md", false);
		expect(r.sent).toEqual([]); // nothing left yet: the coalescing wait is still running
		expect(JSON.parse(r.storage.files.get("/q.json")!).entries).toHaveLength(1);
	});

	it("a burst of 50 renames: one send each, in event order, none merged", async () => {
		const r = rig();
		for (let i = 0; i < 50; i++) r.forwarder.record(`n${i}.md`, `m${i}.md`, false);
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent.map((s) => s.old_path)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}.md`));
		expect(r.queued()).toEqual([]);
	});

	it("A→B then B→C while offline: two ordered events, sent in that order once Tephra is back", async () => {
		const r = rig({ online: false });
		await r.rename("A.md", "B.md");
		await r.rename("B.md", "C.md");
		expect(r.sent).toEqual([]);
		expect(r.queued()).toEqual([["A.md", "B.md"], ["B.md", "C.md"]]);
		r.state.online = true;
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent).toEqual([
			{ old_path: "A.md", new_path: "B.md" },
			{ old_path: "B.md", new_path: "C.md" },
		]);
		expect(r.queued()).toEqual([]);
	});

	it("the queue survives the forwarder (restart) and is sent first-in first-out by the next one", async () => {
		const r = rig({ online: false });
		await r.rename("a.md", "b.md");
		await r.rename("c.md", "d.md");
		const next = r.build();
		next.load();
		expect(next.pending().map((e) => e.oldPath)).toEqual(["a.md", "c.md"]);
		r.state.online = true;
		next.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "c.md"]);
	});

	it("unicode, spaces, # ^ and [] reach Tephra byte for byte", async () => {
		const r = rig();
		const oldPath = "Café ☕/Notes #1 ^2 [draft].md";
		const newPath = "日本語/ノート #1 ^2 [final].md";
		await r.rename(oldPath, newPath);
		expect(r.sent[0].old_path).toBe(oldPath);
		expect(r.sent[0].new_path).toBe(newPath);
	});

	it("a no-op rename (same path) is not recorded", async () => {
		const r = rig();
		expect(await r.rename("a.md", "a.md")).toBe(false);
		expect(r.sent).toEqual([]);
	});
});

describe("offline, drops and restarts", () => {
	it("offline: queued and not sent; no call is made at all", async () => {
		const r = rig({ online: false });
		await r.rename("a.md", "b.md");
		expect(r.sent).toEqual([]);
		expect(r.queued()).toEqual([["a.md", "b.md"]]);
		expect(r.notices).toEqual([]); // the status bar says "offline" (PR-9); no extra notice per rename
	});

	it("no connection object at all (toggle just flipping) behaves as offline", async () => {
		const r = rig();
		r.state.connected = false;
		await r.rename("a.md", "b.md");
		expect(r.queued()).toEqual([["a.md", "b.md"]]);
	});

	it("E1: Tephra drops while the queue is being sent: unacknowledged entries stay, and sending resumes from the first of them; nothing is skipped, nothing acknowledged is sent twice", async () => {
		const r = rig();
		r.state.online = false;
		for (const name of ["a", "b", "c", "d"]) await r.rename(`${name}.md`, `${name}2.md`);
		r.state.online = true;
		r.replies.push(OK, OK, NETWORK); // a, b acknowledged; c's call fails as the daemon dies
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(r.queued()).toEqual([["c.md", "c2.md"], ["d.md", "d2.md"]]);
		r.state.online = false;
		await r.clock.advance(60_000);
		expect(r.sent).toHaveLength(3); // nothing is sent while it is down
		// back: c is first again, then d
		r.state.online = true;
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "b.md", "c.md", "c.md", "d.md"]);
		expect(r.queued()).toEqual([]);
	});

	it("a thrown call is treated as unreachable: the entry stays", async () => {
		const r = rig();
		r.replies.push("throw");
		await r.rename("a.md", "b.md");
		expect(r.queued()).toEqual([["a.md", "b.md"]]);
	});

	it.each([
		["no-token", { kind: "no-token", message: "Tephra's token file is missing, empty or unreadable" }],
		["unauthorized", { kind: "unauthorized", message: "Tephra rejected the token", status: 401 }],
		["timeout", { kind: "timeout", message: "Tephra did not answer in time" }],
		["http", { kind: "http", message: "Tephra answered HTTP 500", status: 500 }],
		["non-json", { kind: "non-json", message: "x" }],
	] as const)("a %s failure gives no answer from Tephra: the entry stays queued for the next check", async (_name, error) => {
		const r = rig();
		r.replies.push({ ok: false, error: { ...error } });
		await r.rename("a.md", "b.md");
		expect(r.queued()).toEqual([["a.md", "b.md"]]);
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.queued()).toEqual([]); // the next kick succeeds
	});

	it("a Tephra without the rename method (-32601): the whole queue waits, one notice, and sends when it has it", async () => {
		const r = rig();
		r.replies.push(rpcError("Method not found", -32601), rpcError("Method not found", -32601));
		await r.rename("a.md", "b.md");
		await r.rename("c.md", "d.md");
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "a.md"]); // the head only: order is kept, c is never sent first
		expect(r.queued()).toEqual([["a.md", "b.md"], ["c.md", "d.md"]]);
		expect(r.notices).toHaveLength(1);
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.queued()).toEqual([]);
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "a.md", "a.md", "c.md"]);
	});

	it("a second record() during an in-flight send waits its turn: one send at a time, in order", async () => {
		const r = rig();
		r.replies.push("hang");
		r.forwarder.record("a.md", "b.md", false);
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent).toHaveLength(1);
		r.forwarder.record("c.md", "d.md", false);
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent).toHaveLength(1); // c waits behind a
		r.releaseHang(); // a's call ends without an answer
		await flush();
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "a.md", "c.md"]);
		expect(r.queued()).toEqual([]);
	});
});

describe("E7: Tephra's 'file changed, try again'", () => {
	it("is retried after a pause with the entry as recorded; a Notice names the file once; later entries follow in order", async () => {
		const r = rig();
		r.replies.push(STALE, OK, OK);
		r.forwarder.record("a.md", "b.md", false);
		r.forwarder.record("c.md", "d.md", false);
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md"]); // c is held behind a, which is waiting to retry
		expect(r.notices).toHaveLength(1);
		expect(r.notices[0]).toContain("b.md");
		expect(r.logs.some((line) => line.includes("file changed, try again"))).toBe(true);
		await r.clock.advance(STALE_RETRY_DELAY_MS);
		expect(r.sent).toEqual([
			{ old_path: "a.md", new_path: "b.md" },
			{ old_path: "a.md", new_path: "b.md" }, // exactly as recorded
			{ old_path: "c.md", new_path: "d.md" },
		]);
		expect(r.queued()).toEqual([]);
		expect(r.notices).toHaveLength(1);
	});

	it("when it never settles: retried STALE_MAX_RETRIES times, then dropped with a Notice, and the next entry still goes", async () => {
		const r = rig();
		for (let i = 0; i <= STALE_MAX_RETRIES; i++) r.replies.push(STALE);
		r.forwarder.record("a.md", "b.md", false);
		r.forwarder.record("c.md", "d.md", false);
		await r.clock.advance(RENAME_COALESCE_MS + STALE_RETRY_DELAY_MS * (STALE_MAX_RETRIES + 1));
		expect(r.sent.filter((s) => s.old_path === "a.md")).toHaveLength(STALE_MAX_RETRIES + 1);
		expect(r.sent.at(-1)).toEqual({ old_path: "c.md", new_path: "d.md" });
		expect(r.queued()).toEqual([]);
		expect(r.notices.at(-1)).toContain("kept changing");
	});

	it("matches the message case-insensitively", async () => {
		const r = rig();
		r.replies.push(rpcError("File Changed, Try Again (b.md)"));
		await r.rename("a.md", "b.md");
		await r.clock.advance(STALE_RETRY_DELAY_MS);
		expect(r.sent).toHaveLength(2);
	});

	it("another error reply (a refusal) drops the entry with a Notice and never rewrites anything; later entries still go", async () => {
		const r = rig();
		r.replies.push(rpcError("path is outside every source", -32020));
		await r.rename("a.md", "b.md");
		await r.rename("c.md", "d.md");
		expect(r.sent.map((s) => s.old_path)).toEqual(["a.md", "c.md"]);
		expect(r.queued()).toEqual([]);
		expect(r.notices[0]).toContain("a.md");
	});

	it("unload while waiting to retry: the entry stays queued and nothing is sent afterwards", async () => {
		const r = rig();
		r.replies.push(STALE);
		await r.rename("a.md", "b.md");
		r.forwarder.dispose();
		await r.clock.advance(60_000);
		expect(r.sent).toHaveLength(1);
		expect(r.queued()).toEqual([["a.md", "b.md"]]);
		expect(r.clock.pendingTimers).toBe(0);
	});
});

describe("folders: one event for the folder, not one per child", () => {
	const children = (from: string, to: string, n: number): Array<[string, string]> => Array.from({ length: n }, (_, i) => [`${from}/c${i}.md`, `${to}/c${i}.md`]);

	it("children reported after the folder are dropped", async () => {
		const r = rig({ online: false });
		r.forwarder.record("Old", "New", true);
		for (const [o, n] of children("Old", "New", 200)) r.forwarder.record(o, n, false);
		expect(r.queued()).toEqual([["Old", "New"]]);
	});

	it("children reported before the folder are folded into it", async () => {
		const r = rig({ online: false });
		for (const [o, n] of children("Old", "New", 200)) r.forwarder.record(o, n, false);
		r.forwarder.record("Old", "New", true);
		expect(r.queued()).toEqual([["Old", "New"]]);
	});

	it("a child that moved elsewhere (not its folder's move) is a real event", async () => {
		const r = rig({ online: false });
		r.forwarder.record("Old", "New", true);
		r.forwarder.record("Old/a.md", "Elsewhere/a.md", false);
		r.forwarder.record("Old/b.md", "New/renamed.md", false);
		expect(r.queued()).toEqual([["Old", "New"], ["Old/a.md", "Elsewhere/a.md"], ["Old/b.md", "New/renamed.md"]]);
	});

	it("a folder rename long ago does not swallow a later, identical-shaped child event", async () => {
		const r = rig({ online: false });
		r.forwarder.record("Old", "New", true);
		await r.clock.advance(FOLDER_RENAME_WINDOW_MS + 1);
		r.forwarder.record("Old/a.md", "New/a.md", false);
		expect(r.queued()).toHaveLength(2);
	});

	it("a child event arriving first for the entry already in flight is not removed: Tephra has it", async () => {
		const r = rig();
		r.replies.push("hang");
		r.forwarder.record("Old/a.md", "New/a.md", false);
		await r.clock.advance(RENAME_COALESCE_MS); // sent, unanswered
		r.forwarder.record("Old", "New", true);
		expect(r.queued()).toEqual([["Old/a.md", "New/a.md"], ["Old", "New"]]);
	});

	it("sibling prefixes are not children: 'Old2/x' is not under 'Old'", async () => {
		const r = rig({ online: false });
		r.forwarder.record("Old", "New", true);
		r.forwarder.record("Old2/x.md", "New2/x.md", false);
		expect(r.queued()).toHaveLength(2);
	});
});

describe("toggle off, mobile and unload", () => {
	it("toggle off: nothing is queued and nothing is sent; turning it on does not send what happened while it was off", async () => {
		const r = rig({ active: false });
		expect(await r.rename("a.md", "b.md")).toBe(false);
		expect(r.queued()).toEqual([]);
		expect(r.storage.files.has("/q.json")).toBe(false);
		r.state.active = true;
		r.forwarder.kick();
		await r.clock.advance(60_000);
		expect(r.sent).toEqual([]);
	});

	it("entries queued before the toggle went off stay on disk and are sent after it is turned back on", async () => {
		const r = rig({ online: false });
		await r.rename("a.md", "b.md");
		r.state.active = false;
		r.state.online = true;
		r.forwarder.kick();
		await r.clock.advance(60_000);
		expect(r.sent).toEqual([]);
		expect(JSON.parse(r.storage.files.get("/q.json")!).entries).toHaveLength(1);
		r.state.active = true;
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(r.sent).toEqual([{ old_path: "a.md", new_path: "b.md" }]);
	});

	it("dispose (unload) leaves the queue file exactly as it was and stops everything", async () => {
		const r = rig({ online: false });
		await r.rename("a.md", "b.md");
		const before = r.storage.files.get("/q.json");
		r.forwarder.dispose();
		r.state.online = true;
		r.forwarder.kick();
		expect(r.forwarder.record("c.md", "d.md", false)).toBe(false);
		await r.clock.advance(60_000);
		expect(r.storage.files.get("/q.json")).toBe(before);
		expect(r.sent).toEqual([]);
		expect(r.clock.pendingTimers).toBe(0);
	});
});

describe("whenAcknowledged (graduation's hook)", () => {
	it("fires once when exactly that rename is acknowledged, not for others", async () => {
		const r = rig();
		const calls: string[] = [];
		r.forwarder.whenAcknowledged("a.md", "b.md", () => calls.push("ab"));
		r.forwarder.whenAcknowledged("x.md", "y.md", () => calls.push("xy"));
		await r.rename("a.md", "b.md");
		expect(calls).toEqual(["ab"]);
	});

	it("also fires when Tephra answered the rename with an error (it has dealt with it)", async () => {
		const r = rig();
		const calls: string[] = [];
		r.forwarder.whenAcknowledged("a.md", "b.md", () => calls.push("ab"));
		r.replies.push(rpcError("refused", -32020));
		await r.rename("a.md", "b.md");
		expect(calls).toEqual(["ab"]);
	});

	it("does not fire while offline, and the stop function cancels the wait", async () => {
		const r = rig({ online: false });
		const calls: string[] = [];
		r.forwarder.whenAcknowledged("a.md", "b.md", () => calls.push("ab"));
		const stop = r.forwarder.whenAcknowledged("c.md", "d.md", () => calls.push("cd"));
		await r.rename("a.md", "b.md");
		await r.rename("c.md", "d.md");
		stop();
		r.state.online = true;
		r.forwarder.kick();
		await r.clock.advance(RENAME_COALESCE_MS);
		expect(calls).toEqual(["ab"]);
	});
});
