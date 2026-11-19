#!/usr/bin/env node
// Dev-only loopback relay for the live E6 check (PR-3). NOT part of the plugin: it is not imported by
// `src/` and not bundled into `main.js` (esbuild's only entry is `src/main.ts`).
//
// Why it exists: Tephra dev b04c1cf sends no `graph:changed` on `source.register` / `source.unregister`, so
// Atlas's half of E6 ("Atlas follows a pushed `graph:changed` within 5 s") can't be seen live against an
// unmodified `tephrad`. This relay sits in front of the real `tephrad`:
//
//   - every plain HTTP request (the JSON-RPC `POST /rpc` calls) is forwarded to `tephrad` and the reply is
//     returned as it came: same method, path, query, body and status, the same headers both ways. The only
//     header touched is `Host`, which names `tephrad` instead of the relay (a proxy has to do that). The
//     relay never reads, changes or logs a request or reply body, and never logs a header.
//   - the push channel (a WebSocket upgrade on `GET /rpc`) is NOT forwarded: the relay completes the
//     RFC 6455 handshake itself and keeps the socket open. It sends nothing on its own. When it gets a
//     signal it sends ONE `graph:changed` text frame to every connected push client. That frame is the one
//     thing real Tephra doesn't send on a source add/remove, so write "stand-in push" next to it in any log.
//     It does not check the token on the push channel (it only requires an `Authorization` header to be
//     present); every forwarded HTTP call is still checked by `tephrad`.
//
// It binds 127.0.0.1 only, and refuses a target that isn't loopback.
//
// Usage:
//   node scripts/tephra-relay.mjs --target http://127.0.0.1:<tephrad-port> [--port <relay-port>] [--control-port <port>]
//
//   --target        the real tephrad (http://, loopback host, explicit port). Required.
//   --port          the relay's own port on 127.0.0.1 (default 0: the OS picks one; it is printed).
//   --control-port  optional second 127.0.0.1 port; `POST /push` on it sends the frame (answers 200 with
//                   the number of clients, or 409 with 0 clients). Kept off the relay port so the relayed
//                   traffic is untouched.
//
// Signals that send the frame: `SIGUSR1` to the relay's PID, a line `push` on stdin, or the control port.
// Point the plugin at the relay with `"tephraUrl": "http://127.0.0.1:<relay-port>"` in `settings` in data.json.

import * as http from "node:http";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Hop-by-hop headers (RFC 9110 §7.6.1) belong to one connection and are not forwarded.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The one frame the relay sends. Same shape Tephra's own `graph:changed` notification has (a JSON-RPC
 * notification: no `id`). */
export const GRAPH_CHANGED_MESSAGE = JSON.stringify({ jsonrpc: "2.0", method: "graph:changed", params: { paths: [] } });

/** An unmasked server text frame (RFC 6455 §5.2): FIN + opcode 1, then the length, then the payload. */
export function encodeServerFrame(opcode, payload) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	let header;
	if (body.length < 126) {
		header = Buffer.from([0x80 | opcode, body.length]);
	} else if (body.length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(body.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(body.length), 2);
	}
	return Buffer.concat([header, body]);
}

/** Parses and validates `--target`: http://, a loopback host, an explicit port. Throws otherwise. */
export function parseTarget(text) {
	let url;
	try {
		url = new URL(text);
	} catch {
		throw new Error(`--target is not a URL: ${text}`);
	}
	if (url.protocol !== "http:") throw new Error("--target must be an http:// address");
	if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error("--target must be a loopback address (127.0.0.1, localhost or [::1])");
	if (url.port === "") throw new Error("--target needs an explicit port");
	return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port), host: url.host };
}

function forwardedHeaders(headers, targetHost) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(name.toLowerCase())) continue;
		out[name] = value;
	}
	out.host = targetHost;
	return out;
}

/**
 * Starts the relay. Resolves with `{ port, controlPort, push(), clientCount(), close() }`.
 * `push()` sends the one `graph:changed` frame to every connected push client and returns how many got it.
 * @param {{ target: string, port?: number, controlPort?: number, log?: (line: string) => void }} options
 */
export async function startRelay({ target, port = 0, controlPort, log = () => {} }) {
	const upstream = parseTarget(target);
	const clients = new Set();

	const server = http.createServer((req, res) => {
		const forward = http.request(
			{ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: forwardedHeaders(req.headers, upstream.host) },
			(reply) => {
				const headers = {};
				for (const [name, value] of Object.entries(reply.headers)) {
					if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
				}
				res.writeHead(reply.statusCode ?? 502, reply.statusMessage, headers);
				reply.pipe(res);
			}
		);
		forward.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(forward);
	});

	server.on("upgrade", (req, socket) => {
		const key = req.headers["sec-websocket-key"];
		const isPush = req.method === "GET" && String(req.headers.upgrade ?? "").toLowerCase() === "websocket" && typeof key === "string";
		if (!isPush) {
			socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			return;
		}
		if (typeof req.headers.authorization !== "string" || req.headers.authorization === "") {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			return;
		}
		const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		clients.add(socket);
		log(`push client connected (${clients.size})`);
		const drop = () => {
			if (clients.delete(socket)) log(`push client gone (${clients.size})`);
			socket.destroy();
		};
		// Client frames are masked. Only ping (answer with pong) and close (answer, then end) matter; the
		// payload of anything else is ignored. A frame split across chunks is rare for these tiny control
		// frames, so the relay reads the first frame of each chunk and treats the rest as noise.
		socket.on("data", (chunk) => {
			if (chunk.length < 2) return;
			const opcode = chunk[0] & 0x0f;
			if (opcode === 0x8) {
				socket.write(encodeServerFrame(0x8, Buffer.alloc(0)));
				drop();
			} else if (opcode === 0x9) {
				let length = chunk[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					length = chunk.readUInt16BE(2);
					offset = 4;
				}
				const masked = (chunk[1] & 0x80) !== 0;
				const mask = masked ? chunk.subarray(offset, offset + 4) : null;
				if (masked) offset += 4;
				const payload = Buffer.from(chunk.subarray(offset, offset + length));
				if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
				socket.write(encodeServerFrame(0xa, payload));
			}
		});
		socket.on("error", drop);
		socket.on("close", drop);
		socket.on("end", drop);
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});

	const push = () => {
		const frame = encodeServerFrame(0x1, GRAPH_CHANGED_MESSAGE);
		for (const socket of clients) socket.write(frame);
		return clients.size;
	};

	let control = null;
	if (controlPort !== undefined) {
		control = http.createServer((req, res) => {
			if (req.method === "POST" && req.url === "/push") {
				const sent = push();
				log(`graph:changed frame sent to ${sent} client(s) (stand-in push)`);
				res.writeHead(sent > 0 ? 200 : 409, { "Content-Type": "text/plain" });
				res.end(`${sent}\n`);
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise((resolve, reject) => {
			control.once("error", reject);
			control.listen(controlPort, "127.0.0.1", resolve);
		});
	}

	return {
		port: server.address().port,
		controlPort: control ? control.address().port : undefined,
		push,
		clientCount: () => clients.size,
		close: async () => {
			for (const socket of clients) socket.destroy();
			clients.clear();
			await Promise.all([server, control].filter(Boolean).map((s) => new Promise((resolve) => (s.closeAllConnections?.(), s.close(resolve)))));
		},
	};
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const name = argv[i];
		if (!["--target", "--port", "--control-port"].includes(name) || i + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${name}`);
		args[name.slice(2)] = argv[++i];
	}
	return args;
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
		if (!args.target) throw new Error("--target is required");
	} catch (error) {
		console.error(`${error.message}\nusage: node scripts/tephra-relay.mjs --target http://127.0.0.1:<tephrad-port> [--port <port>] [--control-port <port>]`);
		process.exit(2);
	}
	const stamp = () => new Date().toISOString();
	const log = (line) => console.log(`${stamp()} ${line}`);
	let relay;
	try {
		relay = await startRelay({
			target: args.target,
			port: args.port === undefined ? 0 : Number(args.port),
			controlPort: args["control-port"] === undefined ? undefined : Number(args["control-port"]),
			log,
		});
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
	log(`relay pid=${process.pid} listening on 127.0.0.1:${relay.port} -> ${args.target}${relay.controlPort ? `; control 127.0.0.1:${relay.controlPort}` : ""}`);
	log("send the frame with: kill -USR1 <pid>, or a line 'push' on stdin" + (relay.controlPort ? ", or POST /push on the control port" : ""));
	const sendFrame = () => {
		const sent = relay.push();
		log(`graph:changed frame sent to ${sent} client(s) (stand-in push)`);
	};
	process.on("SIGUSR1", sendFrame);
	process.stdin.setEncoding("utf8");
	let pending = "";
	process.stdin.on("data", (text) => {
		pending += text;
		let newline;
		while ((newline = pending.indexOf("\n")) !== -1) {
			if (pending.slice(0, newline).trim() === "push") sendFrame();
			pending = pending.slice(newline + 1);
		}
	});
	const stop = () => {
		void relay.close().then(() => process.exit(0));
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
