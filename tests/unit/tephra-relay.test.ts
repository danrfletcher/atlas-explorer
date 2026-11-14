// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { GRAPH_CHANGED_MESSAGE, encodeServerFrame, parseTarget, startRelay } from "../../scripts/tephra-relay.mjs";
import { TephraClient, type TephraRequestFn } from "../../src/tephra-client";
import { isGraphChangedMessage } from "../../src/tephra-connection";
import { openNodeWebSocket } from "../../src/tephra-socket-node";

/**
 * The dev relay for the live E6 check, run for real on ephemeral loopback ports in front of a stand-in
 * `tephrad` (a plain HTTP server that records what it receives), and driven by the plugin's own
 * `TephraClient` and `openNodeWebSocket`.
 */

const TOKEN = "c".repeat(64);

interface Seen {
	method?: string;
	url?: string;
	headers: IncomingHttpHeaders;
	body: string;
}

interface Relay {
	port: number;
	controlPort?: number;
	push(): number;
	clientCount(): number;
	close(): Promise<void>;
}

let upstream: Server | null = null;
let relay: Relay | null = null;
const seen: Seen[] = [];
let upgradesAtUpstream = 0;

/** A stand-in tephrad: answers every POST with a fixed status/body/headers and records the request. */
async function startUpstream(reply: { status: number; body: string; headers?: Record<string, string> }): Promise<number> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			seen.push({ method: req.method, url: req.url, headers: req.headers, body });
			res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
			res.end(reply.body);
		});
	});
	server.on("upgrade", (_req, socket) => {
		upgradesAtUpstream++;
		socket.destroy();
	});
	upstream = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

afterEach(async () => {
	await relay?.close();
	relay = null;
	const closing = upstream;
	upstream = null;
	if (closing) {
		closing.closeAllConnections();
		await new Promise<void>((resolve) => closing.close(() => resolve()));
	}
	seen.length = 0;
	upgradesAtUpstream = 0;
});

const post = (port: number, path: string, body: string, headers: Record<string, string>) =>
	new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
		const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
			let text = "";
			res.on("data", (chunk) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
		});
		req.on("error", reject);
		req.end(body);
	});

const nodeRequest: TephraRequestFn = async (params) => {
	const url = new URL(params.url);
	const result = await post(Number(url.port), url.pathname, params.body, params.headers);
	return { status: result.status, text: result.text } as Awaited<ReturnType<TephraRequestFn>>;
};

function clientFor(port: number): TephraClient {
	return new TephraClient({ request: nodeRequest, url: `http://127.0.0.1:${port}/rpc`, readFile: async () => TOKEN, tokenPath: () => "unused", openSocket: openNodeWebSocket });
}

describe("tephra-relay: HTTP is forwarded unchanged", () => {
	it("passes the method, path, query, body and headers up, and the status, body and headers back", async () => {
		const upstreamPort = await startUpstream({ status: 207, body: '{"jsonrpc":"2.0","id":1,"result":[]}', headers: { "X-Tephra-Probe": "yes" } });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		const body = '{"jsonrpc":"2.0","id":1,"method":"source.list"}';

		const answer = await post(relay.port, "/rpc?x=1&y=%20z", body, { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, "X-Custom": "kept" });

		expect(answer.status).toBe(207);
		expect(answer.text).toBe('{"jsonrpc":"2.0","id":1,"result":[]}');
		expect(answer.headers["x-tephra-probe"]).toBe("yes");
		expect(seen).toHaveLength(1);
		expect(seen[0].method).toBe("POST");
		expect(seen[0].url).toBe("/rpc?x=1&y=%20z");
		expect(seen[0].body).toBe(body);
		expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(seen[0].headers["content-type"]).toBe("application/json");
		expect(seen[0].headers["x-custom"]).toBe("kept");
		// The one header a proxy must rewrite: Host names the real tephrad, not the relay.
		expect(seen[0].headers.host).toBe(`127.0.0.1:${upstreamPort}`);
	});

	it("passes a 401 through as a 401 (the token is checked by tephrad, not the relay)", async () => {
		const upstreamPort = await startUpstream({ status: 401, body: "no" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		const answer = await post(relay.port, "/rpc", "{}", { "Content-Type": "application/json" });
		expect(answer.status).toBe(401);
		expect(answer.text).toBe("no");
	});

	it("answers 502 when tephrad isn't there", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "" });
		const closing = upstream as Server;
		upstream = null;
		await new Promise<void>((resolve) => closing.close(() => resolve()));
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		expect((await post(relay.port, "/rpc", "{}", {})).status).toBe(502);
	});

	it("the plugin's TephraClient lists sources through it", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ name: "tephra", path: "/tmp/tephra", status: "ok" }] }) });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		const listed = await clientFor(relay.port).listSources();
		expect(listed.ok).toBe(true);
		expect(listed.ok && listed.sources.map((s) => s.name)).toEqual(["tephra"]);
	});
});

describe("tephra-relay: the push channel", () => {
	it("completes the handshake itself, sends nothing until told, then one graph:changed text frame", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "{}" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		const texts: string[] = [];
		const opened = await clientFor(relay.port).openPush({ onText: (t) => texts.push(t), onClose: () => {} });
		expect(opened.ok).toBe(true);
		expect(relay.clientCount()).toBe(1);
		expect(upgradesAtUpstream).toBe(0); // the upgrade is answered by the relay, never forwarded

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(texts).toEqual([]); // silent until a signal

		expect(relay.push()).toBe(1);
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = setInterval(() => {
				if (texts.length > 0) (clearInterval(poll), resolve());
				else if (Date.now() - started > 3000) (clearInterval(poll), reject(new Error("no frame")));
			}, 10);
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(texts).toEqual([GRAPH_CHANGED_MESSAGE]); // exactly one
		expect(isGraphChangedMessage(texts[0])).toBe(true);
		if (opened.ok) opened.handle.close();
	});

	it("a push with no client connected sends to nobody", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "{}" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		expect(relay.push()).toBe(0);
	});

	it("refuses an upgrade with no Authorization header", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "{}" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		const result = await openNodeWebSocket({ url: `http://127.0.0.1:${relay.port}/rpc`, headers: {}, onText: () => {}, onClose: () => {} });
		expect(result).toEqual({ kind: "rejected", status: 401 });
		expect(relay.clientCount()).toBe(0);
	});

	it("forgets a client that closes", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "{}" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}` });
		const opened = await clientFor(relay.port).openPush({ onText: () => {}, onClose: () => {} });
		expect(opened.ok).toBe(true);
		if (opened.ok) opened.handle.close();
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = setInterval(() => {
				if (relay?.clientCount() === 0) (clearInterval(poll), resolve());
				else if (Date.now() - started > 3000) (clearInterval(poll), reject(new Error("client not dropped")));
			}, 10);
		});
	});

	it("the control port sends the frame: 409 with no client, 200 with one", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "{}" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}`, controlPort: 0 });
		const controlPort = relay.controlPort as number;
		expect((await post(controlPort, "/push", "", {})).status).toBe(409);
		expect((await post(controlPort, "/other", "", {})).status).toBe(404);

		const texts: string[] = [];
		const opened = await clientFor(relay.port).openPush({ onText: (t) => texts.push(t), onClose: () => {} });
		expect(opened.ok).toBe(true);
		const sent = await post(controlPort, "/push", "", {});
		expect(sent.status).toBe(200);
		expect(sent.text.trim()).toBe("1");
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = setInterval(() => {
				if (texts.length > 0) (clearInterval(poll), resolve());
				else if (Date.now() - started > 3000) (clearInterval(poll), reject(new Error("no frame")));
			}, 10);
		});
		if (opened.ok) opened.handle.close();
	});
});

describe("tephra-relay: loopback only, and not part of the plugin", () => {
	it("binds 127.0.0.1 only (relay and control port)", async () => {
		const upstreamPort = await startUpstream({ status: 200, body: "{}" });
		relay = await startRelay({ target: `http://127.0.0.1:${upstreamPort}`, controlPort: 0 });
		// Reachable on 127.0.0.1, and the listening address the OS reports is exactly 127.0.0.1.
		const probe = (port: number) =>
			new Promise<string>((resolve, reject) => {
				const net = require("node:net") as typeof import("node:net");
				const socket = net.connect(port, "127.0.0.1", () => (resolve(socket.remoteAddress ?? ""), socket.destroy()));
				socket.on("error", reject);
			});
		expect(await probe(relay.port)).toBe("127.0.0.1");
		expect(await probe(relay.controlPort as number)).toBe("127.0.0.1");
	});

	it("refuses a target that isn't an http loopback address with an explicit port", () => {
		expect(parseTarget("http://127.0.0.1:4812")).toMatchObject({ hostname: "127.0.0.1", port: 4812 });
		expect(parseTarget("http://localhost:4812").port).toBe(4812);
		expect(parseTarget("http://[::1]:4812")).toMatchObject({ hostname: "::1", port: 4812 });
		expect(() => parseTarget("http://example.com:4812")).toThrow(/loopback/);
		expect(() => parseTarget("http://192.168.1.5:4812")).toThrow(/loopback/);
		expect(() => parseTarget("http://0.0.0.0:4812")).toThrow(/loopback/);
		expect(() => parseTarget("https://127.0.0.1:4812")).toThrow(/http/);
		expect(() => parseTarget("http://127.0.0.1")).toThrow(/port/);
		expect(() => parseTarget("not a url")).toThrow();
	});

	it("startRelay refuses a non-loopback target", async () => {
		await expect(startRelay({ target: "http://example.com:80" })).rejects.toThrow(/loopback/);
	});

	it("encodes unmasked server frames with the right length forms", () => {
		const small = encodeServerFrame(0x1, "hi") as Buffer;
		expect([...small]).toEqual([0x81, 2, 0x68, 0x69]);
		const medium = encodeServerFrame(0x1, "a".repeat(300)) as Buffer;
		expect([medium[0], medium[1], medium.readUInt16BE(2), medium.length]).toEqual([0x81, 126, 300, 304]);
	});

	it("nothing in src/ refers to the script, and esbuild bundles only src/main.ts", () => {
		const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
		for (const file of walk(join(__dirname, "../../src"))) expect(readFileSync(file, "utf8")).not.toContain("tephra-relay");
		expect(readFileSync(join(__dirname, "../../esbuild.config.mjs"), "utf8")).toContain('entryPoints: ["src/main.ts"]');
	});
});
