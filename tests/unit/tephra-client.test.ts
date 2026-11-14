import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TEPHRA_RPC_URL,
	TephraClient,
	parseTephraSources,
	parseTephraToken,
	resolveTephraRpcUrl,
	resolveTephraTokenPath,
	type TephraRequestFn,
	type TephraRequestParams,
} from "../../src/tephra-client";
import { startFakeTephra } from "../fixtures/fake-tephra-server.mjs";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b1".repeat(32);

let dir: string;
let tokenFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atlas-tephra-client-"));
	mkdirSync(join(dir, "tephra"));
	tokenFile = join(dir, "tephra", "token");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ok = (result: unknown, id = 1) => ({ status: 200, text: JSON.stringify({ jsonrpc: "2.0", id, result }) });

/** A scripted `RequestFn`: each call takes the next reply (a response, or an Error to reject with). */
function scripted(replies: Array<{ status: number; text: string } | Error | ((p: TephraRequestParams) => { status: number; text: string })>) {
	const calls: TephraRequestParams[] = [];
	const request: TephraRequestFn = async (params) => {
		calls.push(params);
		const reply = replies[calls.length - 1] ?? replies[replies.length - 1];
		if (reply instanceof Error) throw reply;
		return typeof reply === "function" ? reply(params) : reply;
	};
	return { request, calls };
}

function clientWith(request: TephraRequestFn, extra: Partial<ConstructorParameters<typeof TephraClient>[0]> = {}) {
	return new TephraClient({ request, tokenPath: () => tokenFile, ...extra });
}

describe("token path resolution", () => {
	it("uses $XDG_DATA_HOME/tephra/token when XDG_DATA_HOME is set", () => {
		expect(resolveTephraTokenPath({ XDG_DATA_HOME: "/data/xdg" }, "/Users/dan")).toBe("/data/xdg/tephra/token");
	});

	it("falls back to ~/.local/share/tephra/token when it is unset", () => {
		expect(resolveTephraTokenPath({}, "/Users/dan")).toBe("/Users/dan/.local/share/tephra/token");
	});

	it("ignores an empty or relative XDG_DATA_HOME, as the XDG spec says", () => {
		expect(resolveTephraTokenPath({ XDG_DATA_HOME: "" }, "/Users/dan")).toBe("/Users/dan/.local/share/tephra/token");
		expect(resolveTephraTokenPath({ XDG_DATA_HOME: "relative/dir" }, "/Users/dan")).toBe("/Users/dan/.local/share/tephra/token");
	});

	it("the default token path follows process.env at read time", async () => {
		const previous = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = dir; // dir/tephra/token is the temp file
		try {
			writeFileSync(tokenFile, TOKEN_A);
			const { request, calls } = scripted([ok([])]);
			const client = new TephraClient({ request }); // no tokenPath: the real default
			expect((await client.listSources()).ok).toBe(true);
			expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
		} finally {
			if (previous === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previous;
		}
	});
});

describe("token validation", () => {
	it.each([
		[TOKEN_A, TOKEN_A],
		[`${TOKEN_A}\n`, TOKEN_A],
		[`  ${TOKEN_B}  \n`, TOKEN_B],
		["A".repeat(64), "A".repeat(64)],
		["", null],
		["   \n", null],
		["a".repeat(63), null],
		["a".repeat(65), null],
		["g".repeat(64), null],
		[`${"a".repeat(32)} ${"a".repeat(32)}`, null],
	])("parseTephraToken(%j) is %j", (raw, expected) => {
		expect(parseTephraToken(raw)).toBe(expected);
	});

	it.each([
		["missing", () => {}],
		["empty", () => writeFileSync(tokenFile, "")],
		["not 64 hex characters", () => writeFileSync(tokenFile, "not-a-token")],
		["unreadable (a directory)", () => mkdirSync(tokenFile)],
	])("a %s token file is a no-token error, sends no request, and never throws", async (_label, setup) => {
		setup();
		const { request, calls } = scripted([ok([])]);
		const result = await clientWith(request).listSources();
		expect(result).toEqual({ ok: false, error: { kind: "no-token", message: expect.any(String) } });
		expect(calls).toHaveLength(0);
	});

	it("never puts the token in an error message or the console", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
		try {
			const replies = [
				{ status: 401, text: "{}" },
				{ status: 401, text: "{}" },
			];
			const seen = [
				await clientWith(scripted(replies).request).listSources(),
				await clientWith(scripted([new Error(`boom ${TOKEN_A}`)]).request).listSources(),
				await clientWith(scripted([{ status: 200, text: JSON.stringify({ error: { code: 1, message: "bad" } }) }]).request).listSources(),
				await clientWith(scripted([{ status: 500, text: TOKEN_A }]).request).listSources(),
			];
			for (const result of seen) expect(JSON.stringify(result)).not.toContain(TOKEN_A);
			for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN_A);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("request shape", () => {
	it("POSTs JSON-RPC 2.0 to 127.0.0.1:4812/rpc with the bearer token", async () => {
		writeFileSync(tokenFile, `${TOKEN_A}\n`);
		const { request, calls } = scripted([ok([])]);
		await clientWith(request).listSources();
		expect(TEPHRA_RPC_URL).toBe("http://127.0.0.1:4812/rpc");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:4812/rpc");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
		expect(calls[0].headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(calls[0].body)).toEqual({ jsonrpc: "2.0", id: 1, method: "source.list" });
	});

	it("sends params when given, and a fresh numeric id for each request", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const { request, calls } = scripted([ok(null)]);
		const client = clientWith(request);
		await client.call("source.rescan", { name: "whoop" });
		await client.call("source.list");
		const bodies = calls.map((c) => JSON.parse(c.body));
		expect(bodies[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "source.rescan", params: { name: "whoop" } });
		expect(bodies[1].id).toBe(2);
	});

	it("reads the token file once and reuses it across calls", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const readFile = vi.fn(async () => TOKEN_A);
		const { request } = scripted([ok([])]);
		const client = clientWith(request, { readFile });
		await client.listSources();
		await client.listSources();
		expect(readFile).toHaveBeenCalledTimes(1);
	});
});

describe("401: re-read the token once, retry once", () => {
	it("a rotated token: the first call 401s, the file is re-read, the retry carries the new token and succeeds", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const { request, calls } = scripted([
			(p) => {
				expect(p.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
				writeFileSync(tokenFile, TOKEN_B); // Tephra rotates the token
				return { status: 401, text: "{}" };
			},
			ok([{ name: "whoop", path: "/w" }]),
		]);
		const result = await clientWith(request).listSources();
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1].headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
	});

	it("a second 401 is an unauthorized error: exactly two requests, no loop", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const { request, calls } = scripted([{ status: 401, text: "{}" }]);
		const readFile = vi.fn(async () => TOKEN_A);
		const result = await clientWith(request, { readFile }).listSources();
		expect(result).toEqual({ ok: false, error: { kind: "unauthorized", message: expect.any(String), status: 401 } });
		expect(calls).toHaveLength(2);
		expect(readFile).toHaveBeenCalledTimes(2); // the initial read plus one re-read
	});

	it("a 401 whose re-read finds the token file gone is a no-token error with no second request", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const { request, calls } = scripted([
			() => {
				rmSync(tokenFile);
				return { status: 401, text: "{}" };
			},
		]);
		const result = await clientWith(request).listSources();
		expect(result).toMatchObject({ ok: false, error: { kind: "no-token" } });
		expect(calls).toHaveLength(1);
	});

	it("a later call after a 401-then-success uses the re-read token without reading again", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const readFile = vi.fn(async () => (readFile.mock.calls.length === 1 ? TOKEN_A : TOKEN_B));
		const { request, calls } = scripted([{ status: 401, text: "{}" }, ok([]), ok([])]);
		const client = clientWith(request, { readFile });
		await client.listSources();
		await client.listSources();
		expect(readFile).toHaveBeenCalledTimes(2);
		expect(calls[2].headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
	});
});

describe("error mapping", () => {
	beforeEach(() => writeFileSync(tokenFile, TOKEN_A));

	it("connection refused (the request rejects) is a network error", async () => {
		const result = await clientWith(scripted([new Error("ECONNREFUSED")]).request).listSources();
		expect(result).toMatchObject({ ok: false, error: { kind: "network" } });
	});

	it("a request that never answers times out, per attempt, and a late answer is ignored", async () => {
		let fire: () => void = () => {};
		const scheduleTimeout = vi.fn((_ms: number, onTimeout: () => void) => {
			fire = onTimeout;
			return () => {};
		});
		let release: (r: { status: number; text: string }) => void = () => {};
		const request: TephraRequestFn = () => new Promise((resolve) => (release = resolve));
		const pending = clientWith(request, { timeoutMs: 5000, scheduleTimeout }).listSources();
		await vi.waitFor(() => expect(scheduleTimeout).toHaveBeenCalledTimes(1)); // the token file is read first
		expect(scheduleTimeout).toHaveBeenCalledWith(5000, expect.any(Function));
		fire();
		expect(await pending).toMatchObject({ ok: false, error: { kind: "timeout" } });
		release(ok([])); // arrives after the timeout: nothing to resolve any more, nothing throws
	});

	it("the default real timer is cleared once the call ends", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const result = await clientWith(scripted([ok([])]).request).listSources();
			expect(result.ok).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses an injected scheduleTimeout, and cancels it when the request answers first", async () => {
		const cancel = vi.fn();
		const scheduleTimeout = vi.fn(() => cancel);
		await clientWith(scripted([ok([])]).request, { scheduleTimeout, timeoutMs: 1234 }).listSources();
		expect(scheduleTimeout).toHaveBeenCalledWith(1234, expect.any(Function));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each([
		["HTTP 500", { status: 500, text: "oops" }, "http"],
		["HTTP 404", { status: 404, text: "" }, "http"],
		["a non-JSON body", { status: 200, text: "<html>" }, "non-json"],
		["an empty body", { status: 200, text: "" }, "non-json"],
		["a JSON array body", { status: 200, text: "[]" }, "bad-response"],
		["a JSON string body", { status: 200, text: '"hi"' }, "bad-response"],
		["a response with neither result nor error", { status: 200, text: '{"jsonrpc":"2.0","id":1}' }, "bad-response"],
		["a JSON-RPC error object", { status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}' }, "rpc"],
		["a JSON-RPC error that is a bare string", { status: 200, text: '{"error":"nope"}' }, "rpc"],
		["a JSON-RPC error with no message", { status: 200, text: '{"error":{}}' }, "rpc"],
	])("%s is a %s error, not a throw", async (_label, reply, kind) => {
		const result = await clientWith(scripted([reply]).request).listSources();
		expect(result).toMatchObject({ ok: false, error: { kind } });
	});

	it("keeps the JSON-RPC error code and a bounded message", async () => {
		const long = "x".repeat(1000);
		const result = await clientWith(scripted([{ status: 200, text: JSON.stringify({ error: { code: -32000, message: long } }) }]).request).call("source.list");
		expect(result).toMatchObject({ ok: false, error: { kind: "rpc", code: -32000 } });
		if (!result.ok) expect(result.error.message.length).toBeLessThan(260);
	});

	it.each([
		["an object", { name: "x" }],
		["null", null],
		["a string", "ok"],
		["a number", 5],
	])("a source.list result that is %s (not an array) is a bad-response error", async (_label, value) => {
		const result = await clientWith(scripted([ok(value)]).request).listSources();
		expect(result).toMatchObject({ ok: false, error: { kind: "bad-response" } });
	});
});

describe("source.list rows", () => {
	beforeEach(() => writeFileSync(tokenFile, TOKEN_A));

	it("maps Tephra's own statuses (active / stale / offline / permission_denied) and the stand-in's (online / missing); anything else is offline", () => {
		// PR-4: Tephra's `source.list` sends `active|stale|offline|permission_denied` (Tephra's `status_str`). Its
		// `offline` is a source whose folder is gone, which Atlas calls missing; it is not "Tephra is unreachable".
		const rows = [
			{ name: "a", path: "/a", status: "online" },
			{ name: "b", path: "/b", status: "missing" },
			{ name: "c", path: "/c", status: "offline" },
			{ name: "d", path: "/d", status: "weird" },
			{ name: "e", path: "/e" },
			{ name: "f", path: "/f", status: "ONLINE" },
			{ name: "g", path: "/g", status: "active" },
			{ name: "h", path: "/h", status: "stale" },
			{ name: "i", path: "/i", status: "permission_denied" },
			{ name: "j", path: "/j", status: " Offline " },
		];
		expect(parseTephraSources(rows).map((s) => [s.name, s.status])).toEqual([
			["a", "online"],
			["b", "missing"],
			["c", "missing"],
			["d", "offline"],
			["e", "offline"],
			["f", "online"],
			["g", "online"],
			["h", "online"],
			["i", "online"],
			["j", "missing"],
		]);
	});

	it("skips bad rows: missing or non-string name/path, empty path, unsafe names, non-objects, repeats", () => {
		const rows = [
			null,
			5,
			"x",
			{},
			{ path: "/only-path" },
			{ name: "only-name" },
			{ name: 3, path: "/p" },
			{ name: "n", path: 4 },
			{ name: "", path: "/p" },
			{ name: "has/slash", path: "/p" },
			{ name: "..", path: "/p" },
			{ name: "__proto__", path: "/p" },
			{ name: "empty-path", path: "" },
			{ name: "good", path: "/good", status: "online" },
			{ name: "good", path: "/other", status: "offline" },
		];
		expect(parseTephraSources(rows)).toEqual([{ name: "good", path: "/good", status: "online" }]);
	});

	it("keeps Unicode and very long names and paths whole", () => {
		const longName = "ソース-" + "x".repeat(300);
		const longPath = "/Users/dän/" + "dir/".repeat(200);
		const sources = parseTephraSources([{ name: longName, path: longPath, status: "online" }]);
		expect(sources).toEqual([{ name: longName, path: longPath, status: "online" }]);
	});

	it("listSources returns the parsed rows from a real response", async () => {
		const result = await clientWith(scripted([ok([{ name: "notes", path: "/n", status: "online" }, { nope: true }])]).request).listSources();
		expect(result).toEqual({ ok: true, sources: [{ name: "notes", path: "/n", status: "online" }] });
	});
});

describe("against the fake Tephra server (a real HTTP round trip on an ephemeral port)", () => {
	it("lists the three default sources, and survives the token being rotated", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const fake = await startFakeTephra({ port: 0, tokenFile });
		try {
			const request: TephraRequestFn = async ({ url, method, headers, body }) => {
				const response = await fetch(url.replace(":4812", `:${fake.port}`), { method, headers, body });
				return { status: response.status, text: await response.text() };
			};
			const client = clientWith(request);
			const first = await client.listSources();
			expect(first.ok && first.sources.map((s) => s.name)).toEqual(["notes", "tephra", "whoop"]);

			writeFileSync(tokenFile, TOKEN_B); // rotated behind the client's back
			const second = await client.listSources();
			expect(second.ok).toBe(true);
			expect(fake.requests.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
		} finally {
			await fake.close();
		}
	});
});

describe("the loopback URL override (resolveTephraRpcUrl)", () => {
	it("is the default when nothing, an empty string or a non-string is saved", () => {
		for (const raw of [undefined, null, "", "   ", 4812, {}, ["http://127.0.0.1:5000"]]) expect(resolveTephraRpcUrl(raw), String(raw)).toBe(TEPHRA_RPC_URL);
	});

	it("accepts a loopback http address with a port, and always ends in /rpc", () => {
		expect(resolveTephraRpcUrl("http://127.0.0.1:53120")).toBe("http://127.0.0.1:53120/rpc");
		expect(resolveTephraRpcUrl("http://127.0.0.1:53120/")).toBe("http://127.0.0.1:53120/rpc");
		expect(resolveTephraRpcUrl("  http://127.0.0.1:53120/rpc  ")).toBe("http://127.0.0.1:53120/rpc");
		expect(resolveTephraRpcUrl("http://localhost:6000/rpc")).toBe("http://localhost:6000/rpc");
		expect(resolveTephraRpcUrl("http://[::1]:6000")).toBe("http://[::1]:6000/rpc");
	});

	it("never accepts an address the token must not go to", () => {
		const refused = [
			"http://example.com:4812/rpc", // remote host
			"http://192.168.1.5:4812/rpc", // LAN
			"http://0.0.0.0:4812/rpc",
			"http://127.0.0.1.evil.example:4812/rpc", // look-alike
			"http://127.0.0.1:4812@evil.example/rpc", // userinfo trick: the host is evil.example
			"http://user:pw@127.0.0.1:4812/rpc", // credentials
			"https://127.0.0.1:4812/rpc", // not http
			"ws://127.0.0.1:4812/rpc",
			"http://127.0.0.1/rpc", // no explicit port
			"http://127.0.0.1:0/rpc",
			"http://127.0.0.1:4812/other", // a path that isn't /rpc
			"http://127.0.0.1:4812/rpc?x=1",
			"http://127.0.0.1:4812/rpc#frag",
			"not a url",
			"127.0.0.1:4812",
		];
		for (const raw of refused) expect(resolveTephraRpcUrl(raw), raw).toBe(TEPHRA_RPC_URL);
	});

	it("a client built with the override talks to that port, and only that port (a real round trip)", async () => {
		writeFileSync(tokenFile, TOKEN_A);
		const fake = await startFakeTephra({ port: 0, tokenFile });
		try {
			const urls: string[] = [];
			const request: TephraRequestFn = async ({ url, method, headers, body }) => {
				urls.push(url);
				const response = await fetch(url, { method, headers, body });
				return { status: response.status, text: await response.text() };
			};
			const client = clientWith(request, { url: resolveTephraRpcUrl(`http://127.0.0.1:${fake.port}`) });
			const listed = await client.listSources();
			expect(listed.ok && listed.sources.map((s) => s.name)).toEqual(["notes", "tephra", "whoop"]);
			expect(urls).toEqual([`http://127.0.0.1:${fake.port}/rpc`]);
			expect(fake.requests.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN_A}`]);
		} finally {
			await fake.close();
		}
	});
});
