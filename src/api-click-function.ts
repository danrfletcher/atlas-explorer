/** Atlas-18 (G7-G9): the API source's Click function. A JavaScript function stored on the source that runs
 * when an API row is clicked, receives that row's metadata and decides what the row does. Deliberately free
 * of the explorer view and of Obsidian so every rule is testable with explicit inputs: this module only
 * compiles the source, calls it and checks what came back; running the outcome is the caller's job.
 *
 * F3: unsandboxed, with no timeout and no worker. The only mitigation is the warning the Data source modal
 * shows next to the code box (same as JS mapping mode). */

/** What the function receives. `extra` is `{}` for a not-found row and for a cleared cache (E6, E15);
 * `secondary` is `undefined` when the row has none. A fresh object per call: the function can never
 * change the stored row or the cache through it. */
export interface ClickFunctionItem {
	id: string;
	label: string;
	secondary: string | undefined;
	extra: Record<string, unknown>;
}

/** A shape the function may return, once checked. `fall-through` is a null or undefined return. */
export type ClickFunctionOutcome =
	| { kind: "fall-through" }
	| { kind: "none" }
	| { kind: "terminal"; argv: string[] }
	| { kind: "command"; id: string }
	| { kind: "uri"; uri: string };

export type ClickFunctionResult = { ok: true; outcome: ClickFunctionOutcome } | { ok: false; error: string };

type CompiledClickFunction = (item: ClickFunctionItem) => unknown;

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : "Unknown JavaScript error";
}

/** Compiles (but never calls) `source` as `(item) => result`. A syntax error, or source that does not
 * evaluate to a function, comes back as `{ ok: false, error }` with the message (G8). Sibling of
 * `compileJsMapper`, kept separate so the mapper's contract is untouched. */
export function compileClickFunction(source: string): { ok: true; fn: CompiledClickFunction } | { ok: false; error: string } {
	try {
		// F3: deliberately unsandboxed. `new Function` never closes over this module's scope. A single
		// trailing `;` is stripped so hand-typed "(item) => {...};" still fits the `return (...)` wrapper.
		const trimmed = source.trim().replace(/;\s*$/, "");
		const fn: unknown = new Function(`"use strict";\nreturn (\n${trimmed}\n);`)();
		if (typeof fn !== "function") return { ok: false, error: "Click function must be a function (the source did not evaluate to one)" };
		return { ok: true, fn: fn as CompiledClickFunction };
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
}

/** G8: the Save-time check. Compiles only; the function is never called, so a function with a side
 * effect leaves no trace after Save. */
export function validateClickFunctionSource(source: string): { ok: true } | { ok: false; error: string } {
	const compiled = compileClickFunction(source);
	return compiled.ok ? { ok: true } : { ok: false, error: compiled.error };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function describeType(value: unknown): string {
	if (Array.isArray(value)) return "an array";
	return value === null ? "null" : typeof value;
}

/** G9: checks what the function returned. Anything that is not exactly one of the documented shapes is an
 * error with a reason, and the caller runs nothing. Pure: never throws, never changes its input. A blank
 * `id` or `uri` counts as missing, matching how stored Click actions are read. */
export function validateClickFunctionResult(value: unknown): ClickFunctionResult {
	try {
		return checkClickFunctionResult(value);
	} catch (err) {
		// A returned object with a throwing getter (`then`, `kind`, `argv`...) is just another bad shape.
		return { ok: false, error: `Click function returned a value that could not be read: ${errorMessage(err)}` };
	}
}

function checkClickFunctionResult(value: unknown): ClickFunctionResult {
	if (value === undefined || value === null) return { ok: true, outcome: { kind: "fall-through" } };
	if (isThenable(value)) {
		// Nothing awaits it, so a rejection must not become an unhandled one.
		try {
			(value as PromiseLike<unknown>).then(undefined, () => undefined);
		} catch {
			// a hostile thenable: still just an invalid shape
		}
		return { ok: false, error: "Click function must be synchronous (it returned a Promise)" };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, error: `Click function must return an object or nothing, not ${describeType(value)}` };
	}
	const shape = value as { kind?: unknown; argv?: unknown; id?: unknown; uri?: unknown };
	switch (shape.kind) {
		case "none":
			return { ok: true, outcome: { kind: "none" } };
		case "terminal": {
			if (!Array.isArray(shape.argv)) return { ok: false, error: 'Click function: terminal "argv" must be an array of strings' };
			if (shape.argv.length === 0) return { ok: false, error: 'Click function: terminal "argv" must not be empty' };
			for (let i = 0; i < shape.argv.length; i++) {
				if (typeof shape.argv[i] !== "string") return { ok: false, error: `Click function: terminal "argv" element ${i} must be a string` };
			}
			return { ok: true, outcome: { kind: "terminal", argv: [...(shape.argv as string[])] } };
		}
		case "command":
			if (typeof shape.id !== "string" || shape.id.trim() === "") return { ok: false, error: 'Click function: command needs a string "id"' };
			return { ok: true, outcome: { kind: "command", id: shape.id } };
		case "uri":
			if (typeof shape.uri !== "string" || shape.uri.trim() === "") return { ok: false, error: 'Click function: uri needs a string "uri"' };
			return { ok: true, outcome: { kind: "uri", uri: shape.uri } };
		default:
			return {
				ok: false,
				error: typeof shape.kind === "string" ? `Click function: unknown kind "${shape.kind}"` : 'Click function: the returned object needs a "kind"',
			};
	}
}

/** True for `async` functions, which are refused without being called: their result is always a Promise,
 * so running one would only cause its side effects for a result that is thrown away. */
function isAsyncFunction(fn: unknown): boolean {
	return Object.prototype.toString.call(fn) === "[object AsyncFunction]";
}

/** G8/G9: compiles `source`, calls it once with `item` and checks the result. Never throws: a compile
 * error, a throw, an async function and every invalid return are all `{ ok: false, error }`. */
export function evaluateClickFunction(source: string, item: ClickFunctionItem): ClickFunctionResult {
	const compiled = compileClickFunction(source);
	if (!compiled.ok) return { ok: false, error: compiled.error.startsWith("Click function") ? compiled.error : `Click function: ${compiled.error}` };
	if (isAsyncFunction(compiled.fn)) return { ok: false, error: "Click function must be synchronous (it is an async function)" };
	let returned: unknown;
	try {
		returned = compiled.fn(item);
	} catch (err) {
		return { ok: false, error: `Click function threw: ${errorMessage(err)}` };
	}
	return validateClickFunctionResult(returned);
}

/** A deep copy of `extra` so the function cannot change the cache row it was read from. */
function copyExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!extra) return {};
	const cloner = (globalThis as { structuredClone?: (v: unknown) => unknown }).structuredClone;
	try {
		if (typeof cloner === "function") return cloner(extra) as Record<string, unknown>;
		return JSON.parse(JSON.stringify(extra)) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Builds the `item` argument. `id`, `label` and `secondary` come from the stored row state; `extra` from
 * the cached mapped row, and is `{}` when the row is not found (E6) or the cache has no row for it (E15). */
export function buildClickFunctionItem(
	row: { id: string; label: string; secondary?: string; notFound?: boolean },
	cachedExtra: Record<string, unknown> | undefined
): ClickFunctionItem {
	return {
		id: row.id,
		label: row.label,
		secondary: row.secondary,
		extra: row.notFound ? {} : copyExtra(cachedExtra),
	};
}
