import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RENDER_LOG_CAP,
	RENDER_LOG_SAVE_DELAY_MS,
	RENDER_TRIGGER_KINDS,
	RenderLog,
	RenderLogAdapter,
	RenderLogEntry,
	observeRender,
	renderCauseOr,
	withRenderCause,
} from "../../src/render-log";

const PATH = ".obsidian/plugins/atlas-explorer/render-log.json";

/** In-memory stand-in for the vault adapter: just `read`, `write` and `exists`, recording every call. */
class FakeAdapter implements RenderLogAdapter {
	files = new Map<string, string>();
	calls: { op: "read" | "write" | "exists"; path: string }[] = [];
	failWrites = false;
	/** When set, each write waits on this gate before landing, so overlapping writes can be forced. */
	gates: (() => void)[] = [];
	holdWrites = false;
	inFlight = 0;
	maxInFlight = 0;

	async exists(path: string): Promise<boolean> {
		this.calls.push({ op: "exists", path });
		return this.files.has(path);
	}
	async read(path: string): Promise<string> {
		this.calls.push({ op: "read", path });
		const data = this.files.get(path);
		if (data === undefined) throw new Error("ENOENT");
		return data;
	}
	async write(path: string, data: string): Promise<void> {
		this.calls.push({ op: "write", path });
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.holdWrites) await new Promise<void>((resolve) => this.gates.push(resolve));
			if (this.failWrites) throw new Error("disk full");
			this.files.set(path, data);
		} finally {
			this.inFlight--;
		}
	}
	writes(): number {
		return this.calls.filter((c) => c.op === "write").length;
	}
}

const entry = (n: number, over: Partial<RenderLogEntry> = {}): RenderLogEntry => ({ kind: "other", at: n, durationMs: n % 7, changed: n % 2 === 0, ...over });

let adapter: FakeAdapter;
let log: RenderLog;

beforeEach(() => {
	vi.useFakeTimers();
	adapter = new FakeAdapter();
	log = new RenderLog(adapter, PATH);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ring cap", () => {
	it("keeps at most 500 entries, oldest first, and the 501st evicts the oldest", () => {
		for (let i = 1; i <= RENDER_LOG_CAP; i++) log.record(entry(i));
		expect(log.entries()).toHaveLength(RENDER_LOG_CAP);
		expect(log.entries()[0].at).toBe(1);

		log.record(entry(RENDER_LOG_CAP + 1));

		const after = log.entries();
		expect(after).toHaveLength(RENDER_LOG_CAP);
		expect(after[0].at).toBe(2);
		expect(after[after.length - 1].at).toBe(RENDER_LOG_CAP + 1);
		expect(after.map((e) => e.at)).toEqual([...after.map((e) => e.at)].sort((a, b) => a - b));
	});

	it("never exceeds the cap however many entries arrive", () => {
		for (let i = 0; i < 1300; i++) log.record(entry(i));
		expect(log.entries()).toHaveLength(RENDER_LOG_CAP);
		expect(log.entries()[0].at).toBe(800);
	});
});

describe("entry shape and serialisation", () => {
	it("stores exactly kind, at, durationMs and changed, dropping any extra property handed in", () => {
		const sneaky = { ...entry(1), label: "Secret/Plan.md", text: "hunter2" } as RenderLogEntry;
		log.record(sneaky);
		expect(Object.keys(log.entries()[0]).sort()).toEqual(["at", "changed", "durationMs", "kind"]);
		expect(log.serialize()).not.toMatch(/Secret|hunter2/);
	});

	it("serialises to valid JSON that round-trips, one entry per line", () => {
		log.record(entry(1, { kind: "click", changed: true }));
		log.record(entry(2, { kind: "unit-index", changed: false }));
		const text = log.serialize();
		expect(JSON.parse(text)).toEqual(log.entries());
		expect(text.split("\n")).toHaveLength(4);
	});

	it("serialises an empty log as []", () => {
		expect(log.serialize()).toBe("[]");
	});

	it("entries() hands out copies, so a caller cannot edit the log", () => {
		log.record(entry(1));
		log.entries()[0].kind = "drop";
		expect(log.entries()[0].kind).toBe("other");
	});
});

describe("load", () => {
	it("starts empty without throwing when the file is missing", async () => {
		await expect(log.load()).resolves.toBeUndefined();
		expect(log.entries()).toEqual([]);
	});

	it("starts empty when the file is empty", async () => {
		adapter.files.set(PATH, "");
		await log.load();
		expect(log.entries()).toEqual([]);
	});

	it.each([["not json {"], ['{"kind":"click"}'], ["null"], ['"text"']])("starts empty when the file holds %s", async (content) => {
		adapter.files.set(PATH, content);
		await log.load();
		expect(log.entries()).toEqual([]);
	});

	it("the next save overwrites a corrupt file", async () => {
		adapter.files.set(PATH, "not json {");
		await log.load();
		log.record(entry(1));
		await log.flush();
		expect(JSON.parse(adapter.files.get(PATH) as string)).toEqual([entry(1)]);
	});

	it("does not throw when reading fails", async () => {
		adapter.files.set(PATH, "[]");
		vi.spyOn(adapter, "read").mockRejectedValue(new Error("EIO"));
		await expect(log.load()).resolves.toBeUndefined();
		expect(log.entries()).toEqual([]);
	});

	it("restores saved entries and keeps their order", async () => {
		adapter.files.set(PATH, JSON.stringify([entry(1), entry(2, { kind: "drop" })]));
		await log.load();
		expect(log.entries().map((e) => e.at)).toEqual([1, 2]);
	});

	it("keeps the valid entries of a partly bad file and cleans each to the four fields", async () => {
		adapter.files.set(
			PATH,
			JSON.stringify([
				{ ...entry(1), path: "Secret/Plan.md" },
				{ kind: "made-up", at: 2, durationMs: 1, changed: true },
				{ kind: "click", at: "x", durationMs: 1, changed: true },
				{ kind: "click", at: 3, durationMs: -4, changed: true },
				{ kind: "click", at: 4, durationMs: 1, changed: "yes" },
				null,
				entry(5),
			])
		);
		await log.load();
		expect(log.entries()).toEqual([entry(1), entry(5)]);
		expect(log.serialize()).not.toContain("Secret");
	});

	it("trims an oversized saved file to the newest 500", async () => {
		adapter.files.set(PATH, JSON.stringify(Array.from({ length: 700 }, (_, i) => entry(i))));
		await log.load();
		expect(log.entries()).toHaveLength(RENDER_LOG_CAP);
		expect(log.entries()[0].at).toBe(200);
	});

	it("places entries recorded during the load after the loaded ones", async () => {
		adapter.files.set(PATH, JSON.stringify([entry(1)]));
		const loading = log.load();
		log.record(entry(2));
		await loading;
		expect(log.entries().map((e) => e.at)).toEqual([1, 2]);
	});
});

describe("saving", () => {
	it("writes nothing until the debounce delay passes, then writes once for a burst", async () => {
		log.record(entry(1));
		log.record(entry(2));
		log.record(entry(3));
		expect(adapter.writes()).toBe(0);

		await vi.advanceTimersByTimeAsync(RENDER_LOG_SAVE_DELAY_MS - 1);
		expect(adapter.writes()).toBe(0);
		await vi.advanceTimersByTimeAsync(2);

		expect(adapter.writes()).toBe(1);
		expect(JSON.parse(adapter.files.get(PATH) as string)).toHaveLength(3);
	});

	it("the only path it ever touches is the log file", async () => {
		await log.load();
		log.record(entry(1));
		await log.flush();
		expect(new Set(adapter.calls.map((c) => c.path))).toEqual(new Set([PATH]));
	});

	it("flush on unload writes pending entries at once and cancels the timer", async () => {
		log.record(entry(1));
		await log.dispose();
		expect(adapter.writes()).toBe(1);
		expect(JSON.parse(adapter.files.get(PATH) as string)).toEqual([entry(1)]);

		await vi.advanceTimersByTimeAsync(RENDER_LOG_SAVE_DELAY_MS * 3);
		expect(adapter.writes()).toBe(1);
	});

	it("flush with nothing new does not rewrite the file", async () => {
		await log.flush();
		expect(adapter.writes()).toBe(0);
		log.record(entry(1));
		await log.flush();
		await log.flush();
		expect(adapter.writes()).toBe(1);
	});

	it("an entry recorded after dispose is kept in memory but schedules no write", async () => {
		await log.dispose();
		log.record(entry(1));
		await vi.advanceTimersByTimeAsync(RENDER_LOG_SAVE_DELAY_MS * 3);
		expect(adapter.writes()).toBe(0);
		expect(log.entries()).toHaveLength(1);
	});

	it("overlapping writes run one at a time, and the last one holds the newest content", async () => {
		adapter.holdWrites = true;
		log.record(entry(1));
		const first = log.flush();
		log.record(entry(2));
		const second = log.flush();
		log.record(entry(3));
		const third = log.flush();
		await vi.advanceTimersByTimeAsync(0);

		// Only the first write has started; the others wait their turn.
		expect(adapter.writes()).toBe(1);
		while (adapter.gates.length || adapter.inFlight) {
			adapter.gates.shift()?.();
			await vi.advanceTimersByTimeAsync(0);
		}
		await Promise.all([first, second, third]);

		expect(adapter.maxInFlight).toBe(1);
		expect(JSON.parse(adapter.files.get(PATH) as string).map((e: RenderLogEntry) => e.at)).toEqual([1, 2, 3]);
	});

	it("a rejected write is swallowed: record, flush and dispose neither throw nor reject", async () => {
		adapter.failWrites = true;
		log.record(entry(1));
		await expect(log.flush()).resolves.toBeUndefined();
		await expect(log.dispose()).resolves.toBeUndefined();
		expect(log.entries()).toHaveLength(1);
	});

	it("after a rejected write, the entries are still written once the adapter recovers", async () => {
		adapter.failWrites = true;
		log.record(entry(1));
		await log.flush();
		expect(adapter.files.has(PATH)).toBe(false);

		adapter.failWrites = false;
		await log.flush();
		expect(JSON.parse(adapter.files.get(PATH) as string)).toEqual([entry(1)]);
	});

	it("a timer-driven write that is rejected does not surface as an unhandled rejection", async () => {
		adapter.failWrites = true;
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			log.record(entry(1));
			await vi.advanceTimersByTimeAsync(RENDER_LOG_SAVE_DELAY_MS + 10);
			await vi.advanceTimersByTimeAsync(0);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});

describe("observeRender", () => {
	const observation = (over: Partial<Parameters<typeof observeRender>[2]> = {}) => ({
		kind: "click" as const,
		at: 1000,
		t0: performance.now(),
		isCurrent: () => true,
		readOutput: () => "<div>a</div>",
		lastOutput: { last: null as string | null },
		...over,
	});

	it("logs the first render as changed and remembers its output", async () => {
		const obs = observation();
		await observeRender(log, Promise.resolve(), obs);
		expect(log.entries()).toEqual([{ kind: "click", at: 1000, durationMs: expect.any(Number), changed: true }]);
		expect(obs.lastOutput.last).toBe("<div>a</div>");
	});

	it("logs a repeat render with identical output as unchanged", async () => {
		const lastOutput = { last: null as string | null };
		await observeRender(log, Promise.resolve(), observation({ lastOutput }));
		await observeRender(log, Promise.resolve(), observation({ lastOutput }));
		expect(log.entries().map((e) => e.changed)).toEqual([true, false]);
	});

	it("logs a superseded render once, as unchanged, without touching the remembered output", async () => {
		const lastOutput = { last: "<div>old</div>" as string | null };
		await observeRender(log, Promise.resolve(), observation({ lastOutput, isCurrent: () => false, readOutput: () => "<div>new</div>" }));
		expect(log.entries()).toHaveLength(1);
		expect(log.entries()[0].changed).toBe(false);
		expect(lastOutput.last).toBe("<div>old</div>");
	});

	it("logs a throwing render once and rethrows that same error", async () => {
		const boom = new Error("render failed");
		await expect(observeRender(log, Promise.reject(boom), observation())).rejects.toBe(boom);
		expect(log.entries()).toHaveLength(1);
	});

	it("a failure while logging never replaces the render's result or error", async () => {
		const readOutput = () => {
			throw new Error("serialisation failed");
		};
		await expect(observeRender(log, Promise.resolve(), observation({ readOutput }))).resolves.toBeUndefined();

		const boom = new Error("render failed");
		await expect(observeRender(log, Promise.reject(boom), observation({ readOutput }))).rejects.toBe(boom);
	});
});

describe("trigger attribution", () => {
	it("falls back outside any cause and names the cause inside one", () => {
		expect(renderCauseOr("other")).toBe("other");
		expect(withRenderCause("click", () => renderCauseOr("other"))).toBe("click");
		expect(renderCauseOr("other")).toBe("other");
	});

	it("the outermost cause wins over a nested one", () => {
		const seen = withRenderCause("leaf-activate", () => withRenderCause("folder-source-refresh", () => renderCauseOr("other")));
		expect(seen).toBe("leaf-activate");
	});

	it("clears the cause when the callback throws", () => {
		expect(() =>
			withRenderCause("drop", () => {
				throw new Error("x");
			})
		).toThrow("x");
		expect(renderCauseOr("other")).toBe("other");
	});

	it("lists the nine kinds the spec names", () => {
		expect([...RENDER_TRIGGER_KINDS].sort()).toEqual(
			["unit-index", "views-change", "leaf-activate", "folder-source-refresh", "settings", "click", "drop", "filter", "other"].sort()
		);
	});
});
