import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEPHRA_CHECK_INTERVAL_MS, TephraConnection, type TephraConnectionClient, type TephraSnapshot } from "../../src/tephra-connection";
import { TephraClient, type TephraCallResult, type TephraRequestFn, type TephraSource, type TephraSourcesResult } from "../../src/tephra-client";
import type { Unit } from "../../src/types";

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


// ---------------------------------------------------------------------------------------------------------
// PR-9 (G13/E1): every way an outcome can arrive ends in the right state, with exactly one change event per
// real change. The connection and the client are real; only the HTTP transport is a scripted stand-in whose
// mode the test switches (Tephra up, refusing connections, not answering, 401, 5xx, a JSON-RPC error).
// ---------------------------------------------------------------------------------------------------------

type Mode = "up" | "refused" | "silent" | "401" | "503" | "rpc-error";

function rig(initial: Mode = "up") {
	let mode: Mode = initial;
	let sources: TephraSource[] = [NOTES, WHOOP];
	const requests: string[] = [];
	const request: TephraRequestFn = async ({ body }) => {
		const { method, id } = JSON.parse(body) as { method: string; id: number };
		requests.push(method);
		switch (mode) {
			case "refused":
				throw new Error("ECONNREFUSED");
			case "silent":
				return new Promise(() => {}); // never answers: the client's own timeout ends it
			case "401":
				return { status: 401, text: "" } as Awaited<ReturnType<TephraRequestFn>>;
			case "503":
				return { status: 503, text: "oops" } as Awaited<ReturnType<TephraRequestFn>>;
			case "rpc-error": // Tephra answers, but refuses every method except `source.list`
				if (method === "source.list") return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id, result: sources }) } as Awaited<ReturnType<TephraRequestFn>>;
				return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "no such source" } }) } as Awaited<ReturnType<TephraRequestFn>>;
			default:
				return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id, result: method === "source.list" ? sources : { entries: [] } }) } as Awaited<ReturnType<TephraRequestFn>>;
		}
	};
	const client = new TephraClient({ request, readFile: async () => "a".repeat(64), tokenPath: () => "/t/token" });
	const connection = new TephraConnection(client);
	const snapshots: TephraSnapshot[] = [];
	const online: boolean[] = [];
	connection.onChange((snapshot) => snapshots.push(snapshot));
	connection.onOnlineChange((value) => online.push(value));
	return {
		connection,
		snapshots,
		online,
		requests,
		setMode: (next: Mode) => (mode = next),
		setSources: (next: TephraSource[]) => (sources = next),
	};
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("PR-9: how an outcome arrives", () => {
	const failures: Array<{ mode: Mode; kind: string }> = [
		{ mode: "refused", kind: "network" },
		{ mode: "401", kind: "unauthorized" },
		{ mode: "503", kind: "http" },
	];

	for (const { mode, kind } of failures) {
		it(`a failed RPC call (${mode}) flips to offline at once, with one change event and no 10 s wait`, async () => {
			const r = rig();
			r.connection.start();
			await settle();
			expect(r.connection.getSnapshot().state).toBe("online");
			r.snapshots.length = 0;
			r.online.length = 0;

			r.setMode(mode);
			const result = await r.connection.call("unit.list", { source: "whoop" });
			await settle();

			expect(result.ok).toBe(false);
			expect(r.connection.getSnapshot()).toMatchObject({ state: "offline", checked: true, sources: [], error: { kind } });
			expect(r.snapshots).toHaveLength(1);
			expect(r.online).toEqual([false]);
			// no tick passed: it was the failed call, not the poll
			expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
			r.connection.stop();
		});

		it(`the 10 s poll finding ${mode} flips to offline with one change event`, async () => {
			const r = rig();
			r.connection.start();
			await settle();
			r.snapshots.length = 0;
			r.online.length = 0;
			r.setMode(mode);
			await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
			expect(r.connection.getSnapshot()).toMatchObject({ state: "offline", error: { kind } });
			expect(r.snapshots).toHaveLength(1);
			expect(r.online).toEqual([false]);
			// still down at the next poll: same answer, no new event
			await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS * 3);
			expect(r.snapshots).toHaveLength(1);
			expect(r.online).toEqual([false]);
			r.connection.stop();
		});
	}

	it("a call that times out is offline with kind timeout (after the client's own 5 s limit), one event", async () => {
		const r = rig();
		r.connection.start();
		await settle();
		r.snapshots.length = 0;
		r.setMode("silent");
		const pending = r.connection.call("unit.list", { source: "whoop" });
		await vi.advanceTimersByTimeAsync(5000); // the call times out; its failure starts a check
		expect((await pending).ok).toBe(false);
		expect(r.connection.getSnapshot().state).toBe("online"); // the check is still waiting on its own timeout
		await vi.advanceTimersByTimeAsync(5000);
		expect(r.connection.getSnapshot()).toMatchObject({ state: "offline", error: { kind: "timeout" } });
		expect(r.snapshots).toHaveLength(1);
		r.connection.stop();
	});

	it("an RPC success changes nothing: no event and no extra check", async () => {
		const r = rig();
		r.connection.start();
		await settle();
		r.snapshots.length = 0;
		const before = r.requests.filter((m) => m === "source.list").length;
		expect((await r.connection.call("unit.list", { source: "whoop" })).ok).toBe(true);
		await settle();
		expect(r.snapshots).toHaveLength(0);
		expect(r.online).toEqual([true]); // the one flip when it first came online
		expect(r.requests.filter((m) => m === "source.list").length).toBe(before);
		r.connection.stop();
	});

	it("an RPC refusal (a JSON-RPC error) while source.list still answers: stays online, no event", async () => {
		const r = rig();
		r.connection.start();
		await settle();
		r.snapshots.length = 0;
		r.setMode("rpc-error");
		expect((await r.connection.call("unit.list", { source: "x" })).ok).toBe(false);
		await settle();
		expect(r.connection.getSnapshot().state).toBe("online");
		expect(r.snapshots).toHaveLength(0);
		expect(r.requests.filter((m) => m === "source.list").length).toBeGreaterThan(1); // the failed call did ask for a check
		r.connection.stop();
	});

	it("coming back is one event, with the new list; the online flip is published once each way", async () => {
		const r = rig("refused");
		r.connection.start();
		await settle();
		expect(r.connection.isOnline()).toBe(false);
		r.snapshots.length = 0;
		r.online.length = 0;
		r.setMode("up");
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		expect(r.connection.isOnline()).toBe(true);
		expect(r.snapshots).toHaveLength(1);
		expect(r.snapshots[0]).toMatchObject({ state: "online", sources: [NOTES, WHOOP] });
		expect(r.online).toEqual([true]);
		r.connection.stop();
		expect(r.online).toEqual([true, false]); // stop() leaves online: off is not online
	});

	it("a change of reason while offline (refused, then a 401) is a real change: one event, and no online flip", async () => {
		const r = rig("refused");
		r.connection.start();
		await settle();
		r.snapshots.length = 0;
		r.online.length = 0;
		r.setMode("401");
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		expect(r.snapshots).toHaveLength(1);
		expect(r.connection.getSnapshot().error?.kind).toBe("unauthorized");
		expect(r.online).toEqual([]);
		r.connection.stop();
	});

	it("a source list that changes while online is a snapshot change but not an online flip", async () => {
		const r = rig();
		r.connection.start();
		await settle();
		r.snapshots.length = 0;
		r.online.length = 0;
		r.setSources([NOTES]);
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		expect(r.snapshots).toHaveLength(1);
		expect(r.online).toEqual([]);
		r.connection.stop();
	});

	it("flapping: success and failure alternating across polls ends each time in the last result's state, one timer, one event per flip", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		const states: string[] = [];
		const online: boolean[] = [];
		connection.onChange((s) => states.push(s.state));
		connection.onOnlineChange((v) => online.push(v));
		connection.start();
		fake.answer({ ok: true, sources: [NOTES] });
		await settle();
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
			fake.answer(i % 2 === 0 ? down : { ok: true, sources: [NOTES] });
			await settle();
			expect(connection.getSnapshot().state).toBe(i % 2 === 0 ? "offline" : "online");
			expect(vi.getTimerCount()).toBe(1); // the interval chain only: timers never stack
		}
		expect(states).toEqual(["offline", "online", "offline", "online", "offline", "online", "offline", "online"]);
		expect(online).toEqual([true, false, true, false, true, false, true]);
		connection.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("PR-9: the focus check", () => {
	it("an injected focus source: focus checks straight away, and stop() removes the listener", async () => {
		const fake = fakeClient();
		let handler: (() => void) | null = null;
		let removed = 0;
		const connection = new TephraConnection(fake.client, undefined, undefined, undefined, (onFocus) => {
			handler = onFocus;
			return () => {
				removed++;
				handler = null;
			};
		});
		expect(handler).toBeNull(); // nothing listens before start
		connection.start();
		fake.answer({ ok: true, sources: [NOTES] });
		await settle();
		expect(fake.listCalls).toBe(1);
		handler!();
		expect(fake.listCalls).toBe(2); // checked at once, no 10 s wait
		fake.answer({ ok: true, sources: [NOTES] });
		await settle();
		connection.stop();
		expect(removed).toBe(1);
		expect(handler).toBeNull();
	});

	it("the real window's focus event asks for a check while running, and after stop() nothing runs (fake timers)", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		fake.answer({ ok: true, sources: [NOTES] });
		await settle();
		window.dispatchEvent(new Event("focus"));
		expect(fake.listCalls).toBe(2);
		fake.answer(down);
		await settle();
		expect(connection.getSnapshot().state).toBe("offline"); // the focus check's answer shows now, not at the tick

		connection.stop();
		const callsAtStop = fake.listCalls;
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS * 5);
		expect(fake.listCalls).toBe(callsAtStop);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("start() twice adds one focus listener: one focus makes one check", async () => {
		const fake = fakeClient();
		const connection = new TephraConnection(fake.client);
		connection.start();
		connection.start();
		fake.answer({ ok: true, sources: [] });
		await settle();
		window.dispatchEvent(new Event("focus"));
		expect(fake.listCalls).toBe(2);
		connection.stop();
	});
});

describe("PR-9: what the connection remembers in memory for an offline section", () => {
	const unit = (path: string): Unit => ({ type: "root-file", path });

	it("keeps the last source list and unit lists through going offline, and forgets them at stop()", async () => {
		const r = rig();
		r.connection.start();
		await settle();
		r.connection.rememberUnits("whoop", [unit("Sources/whoop/a.md")]);
		r.setMode("refused");
		await vi.advanceTimersByTimeAsync(TEPHRA_CHECK_INTERVAL_MS);
		expect(r.connection.getSnapshot().sources).toEqual([]);
		expect(r.connection.getLastSources()).toEqual([NOTES, WHOOP]);
		expect(r.connection.getRememberedUnits("whoop")).toEqual([unit("Sources/whoop/a.md")]);
		r.connection.stop();
		expect(r.connection.getLastSources()).toBeNull();
		expect(r.connection.getRememberedUnits("whoop")).toBeNull();
		r.connection.rememberUnits("whoop", [unit("Sources/whoop/b.md")]); // stopped: ignored
		expect(r.connection.getRememberedUnits("whoop")).toBeNull();
	});

	it("started while Tephra is down: no source list is known", async () => {
		const r = rig("refused");
		r.connection.start();
		await settle();
		expect(r.connection.getLastSources()).toBeNull();
		r.connection.stop();
	});
});

describe("PR-9: unload and toggle-off clear the interval and the focus listener", () => {
	it("after stop() no check runs, however long the fake clock runs, and a focus event does nothing", async () => {
		const r = rig();
		r.connection.start();
		await settle();
		r.connection.stop();
		const count = r.requests.length;
		await vi.advanceTimersByTimeAsync(120_000);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(r.requests.length).toBe(count);
		expect(vi.getTimerCount()).toBe(0);
	});
});
