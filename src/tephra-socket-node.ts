import type { TephraSocketFn } from "./tephra-client";
import { WS_OP_PONG, WsFrameParser, encodeClientFrame, encodeCloseFrame } from "./tephra-ws-frames";

/** The accept key RFC 6455 §1.3 defines: SHA-1 of the client's key and this GUID, base64. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The handshake gives up after this long. */
const HANDSHAKE_TIMEOUT_MS = 5000;

/** Lazy `require`s, for the reason `mcp-server.ts` gives for `requireNodeHttp`: a plain `require` bundles to
 * a CommonJS `require` in esbuild's cjs output, which Electron's renderer resolves; a dynamic `import()` isn't. */
function requireNodeHttp(): typeof import("node:http") {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay `require`, not `import()`.
	return require("node:http");
}
function requireNodeCrypto(): typeof import("node:crypto") {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay `require`, not `import()`.
	return require("node:crypto");
}

/**
 * The production `TephraSocketFn`: a receive-only WebSocket client over Node's `http` upgrade (a browser
 * `WebSocket` can't send the `Authorization` header Tephra requires). The headers it is given are sent on the
 * handshake and nowhere else; nothing here logs them or puts them in a result. It answers pings, closes on any
 * protocol violation, and reports a close exactly once.
 */
export const openNodeWebSocket: TephraSocketFn = ({ url, headers, onText, onClose }) =>
	new Promise((resolve) => {
		let settled = false;
		const settle = (result: Parameters<typeof resolve>[0]) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let request: import("node:http").ClientRequest;
		let key: string;
		let crypto: typeof import("node:crypto");
		try {
			crypto = requireNodeCrypto();
			key = crypto.randomBytes(16).toString("base64");
			request = requireNodeHttp().request(url, {
				method: "GET",
				headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
			});
		} catch {
			settle({ kind: "error" });
			return;
		}
		const expectedAccept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
		request.setTimeout(HANDSHAKE_TIMEOUT_MS, () => request.destroy());

		// The server answered with something other than an upgrade (a 401 for a bad token, usually).
		request.on("response", (response) => {
			response.resume();
			settle({ kind: "rejected", status: response.statusCode ?? 0 });
		});
		request.on("error", () => settle({ kind: "error" }));

		request.on("upgrade", (response, socket, head) => {
			if (response.headers["sec-websocket-accept"] !== expectedAccept) {
				socket.destroy();
				settle({ kind: "error" });
				return;
			}
			socket.setTimeout(0); // the handshake timeout doesn't apply to a connection that idles between pushes
			const parser = new WsFrameParser();
			let closed = false;
			const mask = () => crypto.randomBytes(4);
			const finish = () => {
				if (closed) return;
				closed = true;
				socket.destroy();
				onClose();
			};
			const handle = (bytes: Uint8Array) => {
				for (const event of parser.push(bytes)) {
					if (closed) return;
					if (event.type === "text") {
						try {
							onText(event.text);
						} catch (error) {
							console.error("[Atlas] a Tephra push listener threw", error);
						}
					} else if (event.type === "ping") {
						socket.write(encodeClientFrame(WS_OP_PONG, event.payload, mask()));
					} else if (event.type === "close") {
						socket.write(encodeCloseFrame(1000, mask()));
						finish();
					} else {
						socket.write(encodeCloseFrame(1002, mask()));
						finish();
					}
				}
			};
			socket.on("data", (chunk: Buffer) => handle(chunk));
			socket.on("error", finish);
			socket.on("close", finish);
			socket.on("end", finish);
			settle({
				kind: "open",
				handle: {
					close: () => {
						if (closed) return;
						closed = true; // the owner asked for this: no `onClose` for it
						try {
							socket.end(encodeCloseFrame(1000, mask()));
						} catch {
							/* already gone */
						}
						socket.destroy();
					},
				},
			});
			if (head.length > 0) handle(head);
		});
		request.end(); // sends the handshake (a GET has no body)
	});
