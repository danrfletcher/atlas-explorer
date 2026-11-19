import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TephraConnection, isGraphChangedMessage, parseSourceRenames, type TephraConnectionClient } from "../../src/tephra-connection";
import type { TephraPushHandlers, TephraPushResult, TephraSourcesResult } from "../../src/tephra-client";

const GRAPH_CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: { source: "notes" } });
const ok: TephraSourcesResult = { ok: true, sources: [{ name: "whoop", path: "/w", status: "online" }] };
const down: TephraSourcesResult = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };

/** A client whose push channel the test drives: each `openPush` is answered by `answerOpen`, and the test
 * emits messages and closes through the handlers of the channel that is open. */
function fakeClient() {
	let listCalls = 0;
	let listAnswer: TephraSourcesResult = ok;
	const opens: Array<{ handlers: TephraPushHandlers; resolve: (r: TephraPushResult) => void; handle: { closed: number; close(): void } }> = [];
	const client: TephraConnectionClient = {
		listSources: async () => (listCalls++, listAnswer),
		call: async () => ({ ok: true, result: null }),
		openPush: (handlers) =>
			new Promise((resolve) => {
				const handle = { closed: 0, close() { handle.closed++; } };
				opens.push({ handlers, resolve: (r) => resolve(r.ok ? { ok: true, handle } : r), handle });
			}),
	};
	return {
		client,
		opens,
		get listCalls() {
			return listCalls;
		},
		setList: (r: TephraSourcesResult) => (listAnswer = r),
		/** Answers the open attempt `n` as open. */
		accept: (n = opens.length - 1) => opens[n].resolve({ ok: true, handle: opens[n].handle }),
		refuse: (n = opens.length - 1) => opens[n].resolve({ ok: false, error: { kind: "network", message: "Tephra is unreachable" } }),
		push: (text: string, n = opens.length - 1) => opens[n].handlers.onText(text),
		drop: (n = opens.length - 1) => opens[n].handlers.onClose(),
	};
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("isGraphChangedMessage", () => {
	it("accepts a graph:changed notification only", () => {
		expect(isGraphChangedMessage(GRAPH_CHANGED)).toBe(true);
		expect(isGraphChangedMessage(JSON.stringify({ jsonrpc: "2.0", method: "graph:changed" }))).toBe(true);
		for (const other of [
			JSON.stringify({ jsonrpc: "2.0", method: "something:else" }),
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "graph:changed" }), // a request/response has an id
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
			JSON.stringify([{ method: "graph:changed" }]),
			"null",
			"not json",
			"",
		]) {
			expect(isGraphChangedMessage(other), other).toBe(false);
		}
	});
});

describe("TephraConnection push channel", () => {
	it("opens the channel on start and a graph:changed push runs a check at once, not at the next 10 s tick", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		await settle();
		expect(fake.opens).toHaveLength(1);
		fake.accept();
		await settle();
		const before = fake.listCalls;
		const checks: number[] = [];
		connection.onCheck(() => checks.push(1));

		fake.push(GRAPH_CHANGED);
		await settle();
		expect(fake.listCalls).toBe(before + 1);
		expect(checks).toHaveLength(1);
		connection.stop();
	});

	it("ignores other messages and malformed text", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		await settle();
		fake.accept();
		await settle();
		const before = fake.listCalls;
		fake.push("not json");
		fake.push(JSON.stringify({ jsonrpc: "2.0", id: 4, result: "x" }));
		await settle();
		expect(fake.listCalls).toBe(before);
		connection.stop();
	});

	it("a burst of pushes makes one check now and one more when the cooldown ends", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client, undefined, undefined, { cooldownMs: 1000 });
		connection.start();
		await settle();
		fake.accept();
		await settle();
		const before = fake.listCalls;

		for (let i = 0; i < 20; i++) fake.push(GRAPH_CHANGED);
		await settle();
		expect(fake.listCalls).toBe(before + 1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.listCalls).toBe(before + 2); // the burst's last push, not 19 more checks
		await vi.advanceTimersByTimeAsync(5000);
		expect(fake.listCalls).toBe(before + 2);

		fake.push(GRAPH_CHANGED); // a quiet push after the cooldown is immediate again
		await settle();
		expect(fake.listCalls).toBe(before + 3);
		connection.stop();
	});

	it("a push that arrives while a check is in flight queues exactly one more", async () => {
		const fake = fakeClient();
		let release: (r: TephraSourcesResult) => void = () => {};
		let calls = 0;
		const client: TephraConnectionClient = {
			...fake.client,
			listSources: () => (calls++, new Promise((resolve) => (release = resolve))),
		};
		const connection = new TephraConnection(client);
		connection.start(); // check 1 is in flight
		await settle();
		fake.accept(); // on open the connection asks for a check: queued behind check 1
		await settle();
		expect(calls).toBe(1);
		release(ok);
		await settle();
		expect(calls).toBe(2);
		release(ok);
		await settle();
		connection.stop();
	});

	it("reconnects with a growing wait after the channel drops, and asks for a check on reconnect", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client, undefined, 10 ** 9, { reconnectBaseMs: 1000, reconnectMaxMs: 4000 });
		connection.start();
		await settle();
		fake.accept();
		await settle();

		fake.drop();
		await vi.advanceTimersByTimeAsync(999);
		expect(fake.opens).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.opens).toHaveLength(2);
		fake.refuse(); // still down: wait doubles
		await settle();
		await vi.advanceTimersByTimeAsync(1999);
		expect(fake.opens).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.opens).toHaveLength(3);
		fake.refuse();
		await settle();
		await vi.advanceTimersByTimeAsync(4000); // 4 s: the cap
		expect(fake.opens).toHaveLength(4);
		fake.refuse();
		await settle();
		await vi.advanceTimersByTimeAsync(4000); // stays at the cap
		expect(fake.opens).toHaveLength(5);

		const before = fake.listCalls;
		fake.accept();
		await settle();
		expect(fake.listCalls).toBe(before + 1); // pushes may have been missed while it was down

		fake.drop(); // a success resets the wait to the base
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.opens).toHaveLength(6);
		connection.stop();
	});

	it("a closed channel's late messages and closes are ignored once a newer one is open", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client, undefined, 10 ** 9, { reconnectBaseMs: 10 });
		connection.start();
		await settle();
		fake.accept();
		await settle();
		fake.drop();
		await vi.advanceTimersByTimeAsync(10);
		fake.accept();
		await settle();
		const before = fake.listCalls;

		fake.push(GRAPH_CHANGED, 0); // the first channel is dead
		fake.drop(0);
		await settle();
		expect(fake.listCalls).toBe(before);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fake.opens).toHaveLength(2); // and its close started no reconnect
		connection.stop();
	});

	it("a channel that closed while it was still opening is retried, not trusted", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client, undefined, 10 ** 9, { reconnectBaseMs: 500 });
		connection.start();
		await settle();
		fake.drop(); // closed before the open was reported
		fake.accept();
		await settle();
		expect(fake.opens[0].handle.closed).toBe(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(fake.opens).toHaveLength(2);
		connection.stop();
	});

	it("stop() closes the channel, cancels the reconnect and the cooldown, and drops a channel that opens afterwards", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client, undefined, 10 ** 9, { cooldownMs: 1000, reconnectBaseMs: 500 });
		connection.start();
		await settle();
		fake.accept();
		await settle();
		fake.push(GRAPH_CHANGED);
		fake.push(GRAPH_CHANGED); // cooldown armed and a push pending
		await settle();
		connection.stop();
		expect(fake.opens[0].handle.closed).toBe(1);
		expect(vi.getTimerCount()).toBe(0);

		const calls = fake.listCalls;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fake.listCalls).toBe(calls);
		expect(fake.opens).toHaveLength(1);

		// stopped while an open was still in flight: when it lands it is closed, never used
		connection.start();
		await settle();
		expect(fake.opens).toHaveLength(2);
		connection.stop();
		fake.accept(1);
		await settle();
		expect(fake.opens[1].handle.closed).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("while Tephra is down it keeps retrying quietly, and an answered check restarts a channel that is not up", async () => {
		const fake = fakeClient();
		fake.setList(down);
		const connection = new TephraConnection(fake.client, undefined, 10_000, { reconnectBaseMs: 1000, reconnectMaxMs: 30_000 });
		connection.start();
		await settle();
		fake.refuse();
		await settle();
		expect(connection.getSnapshot().state).toBe("offline");

		fake.setList(ok);
		await vi.advanceTimersByTimeAsync(10_000); // the 10 s check answers; the retry wait (1 s) already ended
		expect(connection.getSnapshot().state).toBe("online");
		expect(fake.opens.length).toBeGreaterThanOrEqual(2);
		connection.stop();
	});

	it("never opens two channels at once, whatever starts it", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		connection.start();
		await settle();
		await vi.advanceTimersByTimeAsync(10_000); // a check answered while the first open is pending
		expect(fake.opens).toHaveLength(1);
		fake.accept();
		await settle();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.opens).toHaveLength(1);
		connection.stop();
	});

	it("a client without a push channel just polls, and a throwing openPush is a failed attempt", async () => {
		const plain: TephraConnectionClient = { listSources: async () => ok, call: async () => ({ ok: true, result: null }) };
		const connection = new TephraConnection(plain);
		connection.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(connection.getSnapshot().state).toBe("online");
		connection.stop();

		let attempts = 0;
		const throwing: TephraConnectionClient = {
			...plain,
			openPush: async () => {
				attempts++;
				throw new Error("boom");
			},
		};
		const c2 = new TephraConnection(throwing, undefined, 10 ** 9, { reconnectBaseMs: 100 });
		c2.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(attempts).toBe(2);
		c2.stop();
	});
});

// PR-11 (E6): a rename Tephra announces. The frame shape is Tephra dev's: `forward.rs` puts the registry's
// `SourceChange` list under `params.sources_changed`, and a rename is `{ kind: "renamed", name: <new>, old_name: <old> }`.
const frame = (changes: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: { source: "journal", paths: [], sources_changed: changes }, ...extra });
const RENAMED = { kind: "renamed", name: "journal", old_name: "notes" };

describe("parseSourceRenames", () => {
	it("reads a rename (old name from old_name, new name from name), in order, among other changes", () => {
		expect(parseSourceRenames(frame([RENAMED]))).toEqual([{ oldName: "notes", newName: "journal" }]);
		expect(
			parseSourceRenames(frame([{ kind: "added", name: "x" }, RENAMED, { kind: "renamed", name: "b", old_name: "a" }, { kind: "removed", name: "y" }]))
		).toEqual([
			{ oldName: "notes", newName: "journal" },
			{ oldName: "a", newName: "b" },
		]);
	});

	it.each([
		["an add", [{ kind: "added", name: "x" }]],
		["a remove", [{ kind: "removed", name: "x" }]],
		["a promote", [{ kind: "promoted", name: "x" }]],
		["an unpromote", [{ kind: "unpromoted", name: "x" }]],
		["a rename with no old_name", [{ kind: "renamed", name: "x" }]],
		["a rename with an empty old_name", [{ kind: "renamed", name: "x", old_name: "" }]],
		["a rename with an empty name", [{ kind: "renamed", name: "", old_name: "x" }]],
		["a rename with a non-string name", [{ kind: "renamed", name: 4, old_name: "x" }]],
		["a null entry", [null]],
		["a string entry", ["renamed"]],
		["no list", undefined],
		["a list that isn't one", { kind: "renamed", name: "x", old_name: "y" }],
	])("%s gives nothing", (_label, changes) => {
		expect(parseSourceRenames(frame(changes))).toEqual([]);
	});

	it.each([
		["a response with an id", frame([RENAMED], { id: 1 })],
		["another method", JSON.stringify({ jsonrpc: "2.0", method: "other", params: { sources_changed: [RENAMED] } })],
		["no params", JSON.stringify({ jsonrpc: "2.0", method: "graph:changed" })],
		["null params", JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: null })],
		["an array", "[1]"],
		["not json", "{"],
		["", ""],
	])("%s gives nothing", (_label, text) => {
		expect(parseSourceRenames(text)).toEqual([]);
	});
});

describe("onSourceRenamed: only a frame on the live push channel", () => {
	it("calls the listener once per rename frame with (old, new), and also asks for the check a graph:changed does", async () => {
		const f = fakeClient();
		const connection = new TephraConnection(f.client);
		const renamed = vi.fn();
		const changed = vi.fn();
		connection.onSourceRenamed(renamed);
		connection.onGraphChanged(changed);
		connection.start();
		await settle();
		f.accept();
		await settle();
		f.push(frame([RENAMED]));
		await settle();
		expect(renamed).toHaveBeenCalledExactlyOnceWith("notes", "journal");
		expect(changed).toHaveBeenCalledTimes(1);
		f.push(frame([{ kind: "added", name: "x" }]));
		await settle();
		expect(renamed).toHaveBeenCalledTimes(1);
		connection.stop?.();
	});

	it("unsubscribing stops the calls, and a listener that throws doesn't stop the others or the check", async () => {
		const f = fakeClient();
		const connection = new TephraConnection(f.client);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const first = vi.fn(() => {
			throw new Error("boom");
		});
		const second = vi.fn();
		const off = connection.onSourceRenamed(second);
		connection.onSourceRenamed(first);
		const changed = vi.fn();
		connection.onGraphChanged(changed);
		connection.start();
		await settle();
		f.accept();
		await settle();
		f.push(frame([RENAMED]));
		await settle();
		expect(second).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalled();
		off();
		f.push(frame([RENAMED]));
		await settle();
		expect(second).toHaveBeenCalledTimes(1);
		error.mockRestore();
		connection.stop?.();
	});
});
