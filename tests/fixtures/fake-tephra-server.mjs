#!/usr/bin/env node
// A stand-in for the Tephra daemon, for tests and for checking Atlas by hand. It answers `source.list` over
// `POST /rpc` with JSON-RPC 2.0, behind the same bearer-token check. Nothing here is part of the plugin.
//
//   node tests/fixtures/fake-tephra-server.mjs [--port 4812] [--host 127.0.0.1] [--token-file <path>]
//
// Like Tephra, it re-reads the token file on every request, so rotating the token (rewriting the file) makes
// the old one stop working at once. The default token file is the one Atlas reads:
// `$XDG_DATA_HOME/tephra/token`, else `~/.local/share/tephra/token`.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SOURCES = [
	{ name: "notes", path: "/home/user/Documents/Notes", status: "online" },
	{ name: "tephra", path: "/home/user/Developer/Tephra", status: "online" },
	{ name: "whoop", path: "/home/user/Documents/Whoop", status: "online" },
];

export function defaultTokenFile(env = process.env) {
	const xdg = env.XDG_DATA_HOME;
	const base = typeof xdg === "string" && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "share");
	return join(base, "tephra", "token");
}

/**
 * Starts the fake daemon. `sources` may be an array or a function returning one (so a test can change what
 * the daemon lists between checks). Resolves to `{ server, port, requests, close }`; `requests` records every
 * request that reached the RPC handler as `{ authorization, body }`.
 */
export async function startFakeTephra({ port = 4812, host = "127.0.0.1", tokenFile = defaultTokenFile(), sources = DEFAULT_SOURCES } = {}) {
	const requests = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const send = (status, body) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (req.method !== "POST" || req.url !== "/rpc") return send(404, { error: "not found" });
			let expected = "";
			try {
				expected = readFileSync(tokenFile, "utf8").trim();
			} catch {
				// no token file: nothing can authenticate
			}
			const authorization = req.headers.authorization ?? "";
			let body = null;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				// handled below
			}
			requests.push({ authorization, body });
			if (expected === "" || authorization !== `Bearer ${expected}`) return send(401, { error: "unauthorized" });
			if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
				return send(200, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
			}
			if (body.method === "source.list") {
				const list = typeof sources === "function" ? sources() : sources;
				return send(200, { jsonrpc: "2.0", id: body.id, result: list });
			}
			return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } });
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	const address = server.address();
	return {
		server,
		port: typeof address === "object" && address ? address.port : port,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const port = Number(argValue("--port") ?? 4812);
	const host = argValue("--host") ?? "127.0.0.1";
	const tokenFile = argValue("--token-file") ?? defaultTokenFile();
	const fake = await startFakeTephra({ port, host, tokenFile });
	console.log(`fake Tephra listening on http://${host}:${fake.port}/rpc (token file: ${tokenFile})`);
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void fake.close().then(() => process.exit(0)));
}
