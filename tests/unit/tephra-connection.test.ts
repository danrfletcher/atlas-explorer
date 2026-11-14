import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEPHRA_CHECK_INTERVAL_MS, TephraConnection, type TephraConnectionClient, type TephraSnapshot } from "../../src/tephra-connection";
import type { TephraCallResult, TephraSource, TephraSourcesResult } from "../../src/tephra-client";

const WHOOP: TephraSource = { name: "whoop", path: "/w", status: "online" };
const NOTES: TephraSource = { name: "notes", path: "/n", status: "online" };
const down: TephraSourcesResult = { ok: false, error: { kind: "network", message: "Tephra is unreachable" } };

/** A client whose `source.list` answers are queued by the test, so a check can be held in flight. */
function fakeClient() {
	const pending: Array<(r: TephraSourcesResult) => void> = [];
	let listCalls = 0;
	const calls: string[] = [];
	const client: TephraConnectionClient = {
		listSources: () => {
			listCalls++;
			return new Promise((resolve) => pending.push(resolve));
		},
		call: async (method) => {
			calls.push(method);
			return callResult;
		},
	};
	let callResult: TephraCallResult = { ok: true, result: null };
	return {
		client,
		get listCalls() {
			return listCalls;
		},
		calls,
		/** Answers the oldest unanswered `source.list`. */
		answer: (r: TephraSourcesResult) => pending.shift()!(r),
		unanswered: () => pending.length,
		failNextCalls: () => (callResult = { ok: false, error: { kind: "network", message: "x" } }),
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TephraConnection states", () => {
	it("is off before start, and builds no timer and makes no call", () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		expect(connection.getSnapshot().state).toBe("off");
		expect(connection.isRunning()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(fake.listCalls).toBe(0);
	});

	it("off -> offline (unchecked) at start -> online when source.list answers", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		const seen: TephraSnapshot[] = [];
		connection.onChange((s) => seen.push(s));
		connection.start();
		expect(connection.getSnapshot()).toMatchObject({ state: "offline", checked: false });
		fake.answer({ ok: true, sources: [NOTES, WHOOP] });
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toEqual({ state: "online", checked: true, sources: [NOTES, WHOOP], error: null });
		expect(seen.map((s) => s.state)).toEqual(["offline", "online"]);
	});

	it("a failed first check is offline and checked, with the reason", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer(down);
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toMatchObject({ state: "offline", checked: true, sources: [], error: { kind: "network" } });
	});

	it("a client whose listSources rejects is offline, not a crash", async () => {
		const client: TephraConnectionClient = { listSources: () => Promise.reject(new Error("boom")), call: async () => ({ ok: true, result: null }) };
		const connection = new TephraConnection(client);
		connection.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toMatchObject({ state: "offline", checked: true });
		connection.stop();
	});

	it("online -> offline -> online as Tephra stops and starts, without reopening anything", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer({ ok: true, sources: [NOTES] });
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot().state).toBe("online");

		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		fake.answer(down);
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toMatchObject({ state: "offline", sources: [] });

		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		fake.answer({ ok: true, sources: [NOTES, WHOOP] });
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toMatchObject({ state: "online", sources: [NOTES, WHOOP] });
	});

	it("a source unregistered in Tephra drops out of the snapshot on the next check", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer({ ok: true, sources: [NOTES, WHOOP] });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		fake.answer({ ok: true, sources: [NOTES] });
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot().sources).toEqual([NOTES]);
	});

	it("emits only when something changed", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		const listener = vi.fn();
		connection.start();
		connection.onChange(listener);
		for (let i = 0; i < 3; i++) {
			fake.answer({ ok: true, sources: [NOTES] });
			await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		}
		expect(listener).toHaveBeenCalledTimes(1); // offline -> online once; two identical answers after it
	});

	it("a throwing listener doesn't stop the others or the connection", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const second = vi.fn();
		connection.onChange(() => {
			throw new Error("listener bug");
		});
		connection.onChange(second);
		connection.start();
		expect(second).toHaveBeenCalled();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("unsubscribed listeners hear nothing", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		const listener = vi.fn();
		connection.onChange(listener)();
		connection.start();
		expect(listener).not.toHaveBeenCalled();
	});
});

describe("the 10 s check", () => {
	it("checks at start and then every 10 s", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		expect(fake.listCalls).toBe(1);
		fake.answer({ ok: true, sources: [] });
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS - 1);
		expect(fake.listCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.listCalls).toBe(2);
		fake.answer({ ok: true, sources: [] });
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		expect(fake.listCalls).toBe(3);
	});

	it("the interval is 10 seconds", () => {
		expect(TEPHRA_CHECK_INTERVAL_MS).toBe(10_000);
	});

	it("keeps one timer however many times start() is called", () => {
		const connection = new TephraConnection(fakeClient().client);
		connection.start();
		connection.start();
		connection.start();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("after the daemon starts, the next tick flips the status to online on its own", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer(down);
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot().state).toBe("offline");
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		fake.answer({ ok: true, sources: [NOTES] });
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot().state).toBe("online");
	});
});

describe("the default scheduler (no injected one)", () => {
	it("checks every 10 s with exactly one timer pending, and leaves no timer after stop", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		expect(vi.getTimerCount()).toBe(1);
		for (let i = 1; i <= 4; i++) {
			fake.answer({ ok: true, sources: [] });
			await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
			expect(fake.listCalls).toBe(i + 1);
			expect(vi.getTimerCount()).toBe(1);
		}
		connection.stop();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS * 3);
		expect(fake.listCalls).toBe(5);
	});
});

describe("one check at a time", () => {
	it("ticks and manual checks while a check is in flight join it instead of starting another", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		expect(connection.isChecking()).toBe(true);
		const joined = [connection.check(), connection.check()];
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS * 3); // three ticks while the first check hangs
		expect(fake.listCalls).toBe(1);
		fake.answer({ ok: true, sources: [NOTES] });
		await Promise.all(joined);
		expect(connection.isChecking()).toBe(false);
		expect(connection.getSnapshot().state).toBe("online");
	});
});

describe("a check after a failed call", () => {
	it("a failed connection.call triggers one check right away, not at the next tick", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer({ ok: true, sources: [NOTES] });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.listCalls).toBe(1);

		fake.failNextCalls();
		const result = await connection.call("unit.list");
		expect(result.ok).toBe(false);
		expect(fake.calls).toEqual(["unit.list"]);
		expect(fake.listCalls).toBe(2); // the check
		fake.answer(down);
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot().state).toBe("offline");
	});

	it("a successful call triggers no check", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer({ ok: true, sources: [] });
		await vi.advanceTimersByTimeAsync(0);
		await connection.call("unit.list");
		expect(fake.listCalls).toBe(1);
	});

	it("a failure that lands while a check is in flight queues exactly one more check afterwards", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		connection.noteFailedCall();
		connection.noteFailedCall();
		expect(fake.listCalls).toBe(1);
		fake.answer({ ok: true, sources: [] });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.listCalls).toBe(2);
		fake.answer({ ok: true, sources: [] });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.listCalls).toBe(2);
	});

	it("noteFailedCall on a stopped connection does nothing", () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.noteFailedCall();
		expect(fake.listCalls).toBe(0);
	});
});

describe("stop() and the rapid-toggle rule", () => {
	it("stop clears the timer, goes to off, and drops the in-flight check's result", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		const listener = vi.fn();
		connection.start();
		connection.onChange(listener);
		expect(connection.isChecking()).toBe(true);
		connection.stop();
		expect(connection.isChecking()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(connection.getSnapshot().state).toBe("off");
		listener.mockClear();

		fake.answer({ ok: true, sources: [NOTES] }); // the answer arrives after off
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS * 3);
		expect(connection.getSnapshot()).toMatchObject({ state: "off", sources: [] });
		expect(listener).not.toHaveBeenCalled();
		expect(fake.listCalls).toBe(1); // and nothing new was asked
	});

	it("check() after stop does nothing", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		connection.stop();
		await connection.check();
		expect(fake.listCalls).toBe(1);
	});

	it("5 start/stop flips in a row end in the last state with at most one timer and no check in flight after stop", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		for (let i = 0; i < 5; i++) {
			connection.start();
			expect(vi.getTimerCount()).toBe(1);
			connection.stop();
			expect(vi.getTimerCount()).toBe(0);
			expect(connection.isChecking()).toBe(false);
		}
		connection.start(); // the sixth flip: on
		expect(vi.getTimerCount()).toBe(1);
		// every answer the earlier starts' checks are still owed arrives now: none may write
		while (fake.unanswered() > 1) fake.answer({ ok: true, sources: [WHOOP] });
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toMatchObject({ state: "offline", checked: false, sources: [] });
		fake.answer({ ok: true, sources: [NOTES] }); // only the live run's own check counts
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.getSnapshot()).toMatchObject({ state: "online", sources: [NOTES] });
		connection.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a stale check's end does not clear the new run's in-flight marker", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		connection.stop();
		connection.start(); // check #2 in flight
		fake.answer({ ok: true, sources: [] }); // check #1 ends late
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.isChecking()).toBe(true);
		expect(fake.listCalls).toBe(2);
	});
});
