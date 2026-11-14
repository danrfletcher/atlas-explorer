// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { TephraClient, type TephraRequestFn } from "../../src/tephra-client";
import { openNodeWebSocket } from "../../src/tephra-socket-node";

/**
 * The production socket against a real HTTP server on an ephemeral loopback port (never Tephra's own 4812),
 * speaking the server side of RFC 6455 by hand: what Tephra's axum handler does at `GET /rpc`.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TOKEN = "a".repeat(64);
const accept = (key: string) => createHash("sha1").update(key + GUID).digest("base64");

/** An unmasked server text/control frame (payloads here are short). */
function frame(opcode: number, payload: Buffer | string, opts: { masked?: boolean } = {}): Buffer {
	const body = Buffer.from(payload);
	return Buffer.concat([Buffer.from([0x80 | opcode, (opts.masked ? 0x80 : 0) | body.length]), opts.masked ? Buffer.alloc(4) : Buffer.alloc(0), body]);
}

/** The opcode (and unmasked payload) of the first client frame in `data`. */
function readClientFrame(data: Buffer): { opcode: number; payload: Buffer; masked: boolean } {
	const masked = (data[1] & 0x80) !== 0;
	const length = data[1] & 0x7f;
	const mask = data.subarray(2, 6);
	const payload = Buffer.from(data.subarray(6, 6 + length)).map((b, i) => b ^ mask[i % 4]);
	return { opcode: data[0] & 0x0f, payload: Buffer.from(payload), masked };
}

interface Upgraded {
	socket: Socket;
	request: IncomingMessage;
	/** Resolves with the next bytes the client sends. */
	next: () => Promise<Buffer>;
}

let server: Server | null = null;
const sockets = new Set<Socket>();

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	const closing = server;
	server = null;
	if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Starts a server. `onUpgrade` decides what to do with each upgrade request; returns the URL. */
async function listen(onUpgrade: (u: Upgraded) => void, opts: { requireToken?: string; badAccept?: boolean } = {}): Promise<string> {
	const created = createServer((_req, res) => {
		res.writeHead(404).end();
	});
	created.on("upgrade", (request, socket: Socket) => {
		sockets.add(socket);
		if (opts.requireToken !== undefined && request.headers.authorization !== `Bearer ${opts.requireToken}`) {
			socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
		const key = String(request.headers["sec-websocket-key"]);
		const answer = opts.badAccept ? "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" : accept(key);
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
		const waiting: Array<(b: Buffer) => void> = [];
		const queued: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => (waiting.shift() ?? ((b: Buffer) => queued.push(b)))(chunk));
		onUpgrade({ socket, request, next: () => new Promise((resolve) => (queued.length > 0 ? resolve(queued.shift()!) : waiting.push(resolve))) });
	});
	server = created;
	await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(created.address() as AddressInfo).port}/rpc`;
}

const headers = { Authorization: `Bearer ${TOKEN}` };

describe("openNodeWebSocket against a real server", () => {
	it("sends the handshake headers, receives pushed text, and reports nothing else", async () => {
		let seen: IncomingMessage | null = null;
		const url = await listen(
			({ socket, request }) => {
				seen = request;
				socket.write(frame(0x1, '{"jsonrpc":"2.0","method":"graph:changed","params":{"source":"notes"}}'));
			},
			{ requireToken: TOKEN }
		);
		const messages: string[] = [];
		const got = new Promise<void>((resolve) => {
			void openNodeWebSocket({ url, headers, onText: (t) => (messages.push(t), resolve()), onClose: () => {} }).then((r) => expect(r.kind).toBe("open"));
		});
		await got;
		expect(JSON.parse(messages[0]).method).toBe("graph:changed");
		const request = seen as IncomingMessage | null;
		expect(request?.headers.upgrade).toBe("websocket");
		expect(request?.headers["sec-websocket-version"]).toBe("13");
		expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("reports a 401 handshake as rejected with the status", async () => {
		const url = await listen(() => {}, { requireToken: "b".repeat(64) });
		const result = await openNodeWebSocket({ url, headers, onText: () => {}, onClose: () => {} });
		expect(result).toEqual({ kind: "rejected", status: 401 });
	});

	it("refuses a server that answers with the wrong accept key", async () => {
		const url = await listen(() => {}, { badAccept: true });
		const result = await openNodeWebSocket({ url, headers, onText: () => {}, onClose: () => {} });
		expect(result).toEqual({ kind: "error" });
	});

	it("reports an error when nothing is listening", async () => {
		const url = await listen(() => {});
		const closing = server!;
		server = null;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => closing.close(() => resolve()));
		expect(await openNodeWebSocket({ url, headers, onText: () => {}, onClose: () => {} })).toEqual({ kind: "error" });
	});

	it("answers a ping with a masked pong carrying the same payload", async () => {
		let upgraded: Upgraded | null = null;
		const ready = new Promise<void>((resolve) => {
			void listen((u) => {
				upgraded = u;
				resolve();
			}).then(async (url) => {
				await openNodeWebSocket({ url, headers, onText: () => {}, onClose: () => {} });
			});
		});
		await ready;
		const { socket, next } = upgraded as unknown as Upgraded;
		socket.write(frame(0x9, "alive?"));
		const reply = readClientFrame(await next());
		expect(reply).toEqual({ opcode: 0xa, payload: Buffer.from("alive?"), masked: true });
	});

	it("calls onClose once when the server closes, after answering with a close frame", async () => {
		let upgraded: Upgraded | null = null;
		const closed: number[] = [];
		const closedP = new Promise<void>((resolve) => {
			void listen((u) => {
				upgraded = u;
				u.socket.write(frame(0x8, Buffer.from([0x03, 0xe8])));
			}).then((url) => openNodeWebSocket({ url, headers, onText: () => {}, onClose: () => (closed.push(1), resolve()) }));
		});
		await closedP;
		const reply = readClientFrame(await (upgraded as unknown as Upgraded).next());
		expect(reply.opcode).toBe(0x8);
		expect(reply.masked).toBe(true);
		expect(closed).toEqual([1]);
	});

	it("calls onClose when the connection drops", async () => {
		const closedP = new Promise<void>((resolve) => {
			void listen((u) => u.socket.destroy()).then((url) => openNodeWebSocket({ url, headers, onText: () => {}, onClose: resolve }));
		});
		await closedP;
	});

	it("closes with 1002 and reports the close when the server sends a masked frame", async () => {
		let upgraded: Upgraded | null = null;
		const messages: string[] = [];
		const closedP = new Promise<void>((resolve) => {
			void listen((u) => {
				upgraded = u;
				u.socket.write(frame(0x1, "x", { masked: true }));
			}).then((url) => openNodeWebSocket({ url, headers, onText: (t) => messages.push(t), onClose: resolve }));
		});
		await closedP;
		const close = readClientFrame(await (upgraded as unknown as Upgraded).next());
		expect(close.opcode).toBe(0x8);
		expect([...close.payload]).toEqual([0x03, 0xea]);
		expect(messages).toEqual([]);
	});

	it("handle.close() sends a close frame and doesn't report onClose (the owner asked for it)", async () => {
		let upgraded: Upgraded | null = null;
		let closes = 0;
		const url = await listen((u) => (upgraded = u));
		const result = await openNodeWebSocket({ url, headers, onText: () => {}, onClose: () => closes++ });
		expect(result.kind).toBe("open");
		if (result.kind !== "open") return;
		result.handle.close();
		result.handle.close(); // twice is harmless
		const close = readClientFrame(await (upgraded as unknown as Upgraded).next());
		expect(close.opcode).toBe(0x8);
		expect(closes).toBe(0);
	});
});

describe("TephraClient.openPush with the real socket", () => {
	const unusedRequest: TephraRequestFn = async () => ({ status: 500, text: "" });

	it("rereads a rotated token once after a 401 and then opens", async () => {
		const url = await listen(() => {}, { requireToken: "b".repeat(64) });
		const tokens = ["a".repeat(64), "b".repeat(64)];
		let reads = 0;
		const client = new TephraClient({ request: unusedRequest, url, openSocket: openNodeWebSocket, readFile: async () => tokens[Math.min(reads++, 1)] });
		const result = await client.openPush({ onText: () => {}, onClose: () => {} });
		expect(result.ok).toBe(true);
		expect(reads).toBe(2);
		if (result.ok) result.handle.close();
	});

	it("gives up after the second 401 with an error that carries no token", async () => {
		const url = await listen(() => {}, { requireToken: "c".repeat(64) });
		const client = new TephraClient({ request: unusedRequest, url, openSocket: openNodeWebSocket, readFile: async () => TOKEN });
		const result = await client.openPush({ onText: () => {}, onClose: () => {} });
		expect(result).toEqual({ ok: false, error: { kind: "unauthorized", message: "Tephra rejected the token", status: 401 } });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("reports no-token without touching the network when the token file is unreadable", async () => {
		let attempts = 0;
		const client = new TephraClient({
			request: unusedRequest,
			openSocket: async () => (attempts++, { kind: "error" }),
			readFile: async () => {
				throw new Error("ENOENT");
			},
		});
		const result = await client.openPush({ onText: () => {}, onClose: () => {} });
		expect(result).toEqual({ ok: false, error: { kind: "no-token", message: "Tephra's token file is missing, empty or unreadable" } });
		expect(attempts).toBe(0);
	});

	it("without a socket function it says the channel isn't available", async () => {
		const client = new TephraClient({ request: unusedRequest, readFile: async () => TOKEN });
		expect((await client.openPush({ onText: () => {}, onClose: () => {} })).ok).toBe(false);
	});

	it("a non-401 rejection and a throwing socket are errors, not retries", async () => {
		let calls = 0;
		const rejected = new TephraClient({ request: unusedRequest, readFile: async () => TOKEN, openSocket: async () => (calls++, { kind: "rejected", status: 503 }) });
		expect(await rejected.openPush({ onText: () => {}, onClose: () => {} })).toEqual({ ok: false, error: { kind: "http", message: "Tephra answered HTTP 503", status: 503 } });
		expect(calls).toBe(1);
		const throwing = new TephraClient({
			request: unusedRequest,
			readFile: async () => TOKEN,
			openSocket: async () => {
				throw new Error("boom");
			},
		});
		expect((await throwing.openPush({ onText: () => {}, onClose: () => {} })).ok).toBe(false);
	});
});
