import * as fs from "fs";
import * as os from "os";
import { join as joinPath } from "path";
import type { RequestResult, ScheduleTimeout } from "./api-http";

/** Tephra's daemon, local only. G16: nothing in Atlas builds a client unless the Tephra toggle is on. */
export const TEPHRA_RPC_URL = "http://127.0.0.1:4812/rpc";

/** Each request attempt gives up after this long; `requestUrl` can't be aborted, so the client races it. */
export const TEPHRA_CALL_TIMEOUT_MS = 5000;

/** What the user can run to install the daemon. Atlas only ever shows this command; it never runs it (F7). */
export const TEPHRA_INSTALL_COMMAND = "tephractl daemon install";
export const TEPHRA_REPO_URL = "https://github.com/danrfletcher/Tephra";

const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
const MAX_RPC_MESSAGE_LENGTH = 200;

/** One POST of a JSON-RPC body. Mirrors `RequestParams` in `api-http.ts` but sends a body, which that one
 * (GET-only, by the API-source fence) deliberately can't. `requestUrl` backs it in production. */
export interface TephraRequestParams {
	url: string;
	method: "POST";
	headers: Record<string, string>;
	body: string;
}

/** Resolves with the status and body, rejects only on a genuine network failure; never throws for a
 * non-2xx status (same contract as `RequestFn` in `api-http.ts`). */
export type TephraRequestFn = (params: TephraRequestParams) => Promise<RequestResult>;

export type TephraErrorKind = "no-token" | "unauthorized" | "timeout" | "network" | "http" | "non-json" | "rpc" | "bad-response";

export interface TephraError {
	kind: TephraErrorKind;
	/** Short and safe to show: never contains the token or a response body. */
	message: string;
	status?: number;
	code?: number;
}

export type TephraCallResult<T = unknown> = { ok: true; result: T } | { ok: false; error: TephraError };

export type TephraSourceStatus = "online" | "missing" | "offline";

export interface TephraSource {
	name: string;
	path: string;
	status: TephraSourceStatus;
}

export type TephraSourcesResult = { ok: true; sources: TephraSource[] } | { ok: false; error: TephraError };

/** Where Tephra writes its token: `$XDG_DATA_HOME/tephra/token`, else `~/.local/share/tephra/token`. An
 * empty or relative `XDG_DATA_HOME` is ignored, as the XDG spec says. */
export function resolveTephraTokenPath(env: { XDG_DATA_HOME?: string | undefined }, home: string): string {
	const xdg = env.XDG_DATA_HOME;
	const base = typeof xdg === "string" && xdg.startsWith("/") ? xdg : joinPath(home, ".local", "share");
	return joinPath(base, "tephra", "token");
}

/** Tephra's token is 64 hex characters; surrounding whitespace (a trailing newline) is not part of it. */
export function parseTephraToken(raw: string): string | null {
	const trimmed = raw.trim();
	return TOKEN_PATTERN.test(trimmed) ? trimmed : null;
}

/** A source name is one path segment under `Sources/`. Tephra's own rules are stricter; this only stops
 * a name from reaching outside that segment (and so from building an exclude entry that covers more). */
export function isUsableSourceName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== ".." && name !== "__proto__" && !/[\\/\u0000-\u001f]/.test(name);
}

function mapSourceStatus(raw: unknown): TephraSourceStatus {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (value === "online") return "online";
	if (value === "missing") return "missing";
	return "offline";
}

/** Rows without a usable `name` and `path` are skipped; a repeated name keeps its first row. */
export function parseTephraSources(rows: unknown[]): TephraSource[] {
	const sources: TephraSource[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const { name, path, status } = row as Record<string, unknown>;
		if (typeof name !== "string" || typeof path !== "string") continue;
		if (!isUsableSourceName(name) || path.length === 0 || seen.has(name)) continue;
		seen.add(name);
		sources.push({ name, path, status: mapSourceStatus(status) });
	}
	return sources;
}

export interface TephraClientOptions {
	request: TephraRequestFn;
	/** Where to read the token from, looked up each time the file is read. */
	tokenPath?: () => string;
	/** Reads the token file as text (throws if it can't). Defaults to Node's `fs`. */
	readFile?: (path: string) => Promise<string>;
	url?: string;
	timeoutMs?: number;
	scheduleTimeout?: ScheduleTimeout;
}

type Attempt = { kind: "response"; status: number; text: string } | { kind: "error"; error: TephraError };

const defaultScheduleTimeout: ScheduleTimeout = (ms, onTimeout) => {
	const timer = setTimeout(onTimeout, ms);
	return () => clearTimeout(timer);
};

/**
 * Tephra's JSON-RPC client. The token lives only in this object's memory: it is read from Tephra's own
 * token file, never written to `data.json` or localStorage, and never logged or put in an error message.
 * Tephra rotates the token, so a 401 re-reads the file once and retries once; a second 401 is an error,
 * not a loop. Every request attempt has its own timeout. Nothing here throws: failures come back as
 * `{ ok: false, error }`.
 */
export class TephraClient {
	private token: string | null = null;
	private nextId = 1;
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly scheduleTimeout: ScheduleTimeout;
	private readonly tokenPath: () => string;
	private readonly readFile: (path: string) => Promise<string>;

	constructor(private readonly options: TephraClientOptions) {
		this.url = options.url ?? TEPHRA_RPC_URL;
		this.timeoutMs = options.timeoutMs ?? TEPHRA_CALL_TIMEOUT_MS;
		this.scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
		this.tokenPath = options.tokenPath ?? (() => resolveTephraTokenPath(process.env, os.homedir()));
		this.readFile = options.readFile ?? ((path) => fs.promises.readFile(path, "utf8"));
	}

	async call(method: string, params?: unknown): Promise<TephraCallResult> {
		let attempt = await this.attempt(method, params, false);
		if (attempt.kind === "response" && attempt.status === 401) {
			// Tephra rotates its token: read the file again once, and send once more.
			attempt = await this.attempt(method, params, true);
			if (attempt.kind === "response" && attempt.status === 401) {
				return { ok: false, error: { kind: "unauthorized", message: "Tephra rejected the token", status: 401 } };
			}
		}
		if (attempt.kind === "error") return { ok: false, error: attempt.error };
		return interpretResponse(attempt.status, attempt.text);
	}

	async listSources(): Promise<TephraSourcesResult> {
		const result = await this.call("source.list");
		if (!result.ok) return result;
		if (!Array.isArray(result.result)) {
			return { ok: false, error: { kind: "bad-response", message: "source.list did not return a list" } };
		}
		return { ok: true, sources: parseTephraSources(result.result) };
	}

	private async attempt(method: string, params: unknown, rereadToken: boolean): Promise<Attempt> {
		const token = await this.getToken(rereadToken);
		if (token === null) {
			return { kind: "error", error: { kind: "no-token", message: "Tephra's token file is missing, empty or unreadable" } };
		}
		const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, ...(params === undefined ? {} : { params }) });
		const request = this.options
			.request({
				url: this.url,
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body,
			})
			.then(
				(response): Attempt => ({ kind: "response", status: response.status, text: response.text }),
				(): Attempt => ({ kind: "error", error: { kind: "network", message: "Tephra is unreachable" } })
			);

		let cancel: () => void = () => {};
		const timeout = new Promise<Attempt>((resolve) => {
			cancel = this.scheduleTimeout(this.timeoutMs, () => resolve({ kind: "error", error: { kind: "timeout", message: "Tephra did not answer in time" } }));
		});
		try {
			return await Promise.race([request, timeout]);
		} finally {
			cancel();
		}
	}

	private async getToken(reread: boolean): Promise<string | null> {
		if (!reread && this.token !== null) return this.token;
		this.token = null;
		try {
			this.token = parseTephraToken(await this.readFile(this.tokenPath()));
		} catch {
			this.token = null; // missing or unreadable: the same answer as an empty file
		}
		return this.token;
	}
}

function interpretResponse(status: number, text: string): TephraCallResult {
	if (status < 200 || status >= 300) {
		return { ok: false, error: { kind: "http", message: `Tephra answered HTTP ${status}`, status } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, error: { kind: "non-json", message: "Tephra's answer is not valid JSON" } };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: { kind: "bad-response", message: "Tephra's answer is not a JSON-RPC response" } };
	}
	const response = parsed as Record<string, unknown>;
	if (response.error !== undefined && response.error !== null) {
		const err = response.error as Record<string, unknown> | string;
		const detail = typeof err === "string" ? err : typeof err === "object" && typeof err.message === "string" ? err.message : "";
		const code = typeof err === "object" && typeof err.code === "number" ? err.code : undefined;
		const message = detail.length > 0 ? `Tephra error: ${detail.slice(0, MAX_RPC_MESSAGE_LENGTH)}` : "Tephra returned an error";
		return { ok: false, error: { kind: "rpc", message, ...(code === undefined ? {} : { code }) } };
	}
	if (!("result" in response)) {
		return { ok: false, error: { kind: "bad-response", message: "Tephra's answer has no result" } };
	}
	return { ok: true, result: response.result };
}
