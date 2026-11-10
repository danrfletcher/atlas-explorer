import { describe, expect, it } from "vitest";
import {
	buildClickFunctionItem,
	ClickFunctionItem,
	checkClickFunctionSyntax,
	compileClickFunction,
	evaluateClickFunction,
	validateClickFunctionResult,
	validateClickFunctionSource,
} from "../../src/api-click-function";

/** Atlas-18 G8/G9: the Click function's compile helper, result validator and evaluator. Every function here
 * is pure, so each test calls the real code with explicit inputs: no mocks. */

const item = (over: Partial<ClickFunctionItem> = {}): ClickFunctionItem => ({ id: "docker", label: "Docker 4.34", secondary: undefined, extra: {}, ...over });

/** The exact function from the plan (GP7). */
const PLAN_FUNCTION = `(item) => item.extra.path ? { kind: "terminal", argv: ["open", "-a", item.extra.path] } : { kind: "command", id: "app-runner:open-" + item.id }`;

describe("G8: compile on Save, never call", () => {
	it.each([
		["a syntax error", "(item) => {"],
		["source that is not a function (a number)", "42"],
		["source that is not a function (an object)", "({ kind: 'none' })"],
		["source that is not a function (a string)", '"x"'],
	])("%s is rejected with a message", (_label, source) => {
		const result = validateClickFunctionSource(source);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	it("shows the syntax error's own message", () => {
		const result = compileClickFunction("(item) => {");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Unexpected end of input|SyntaxError|Unexpected/i);
	});

	it("says a non-function source must be a function", () => {
		const result = compileClickFunction("42");
		expect(result).toEqual({ ok: false, error: expect.stringContaining("must be a function") });
	});

	it.each([
		["the plan's function", PLAN_FUNCTION],
		["a trailing semicolon", "(item) => undefined;"],
		["a function expression", "function (item) { return null; }"],
		["an async function (compiles; refused only at click time)", "async (item) => ({ kind: 'none' })"],
	])("accepts %s", (_label, source) => {
		expect(validateClickFunctionSource(source)).toEqual({ ok: true });
	});

	it("never calls the function: a side effect leaves no trace after validate or compile", () => {
		const g = globalThis as unknown as { __clickFunctionSideEffect?: number };
		delete g.__clickFunctionSideEffect;
		const source = "(item) => { globalThis.__clickFunctionSideEffect = (globalThis.__clickFunctionSideEffect || 0) + 1; return null; }";
		expect(validateClickFunctionSource(source)).toEqual({ ok: true });
		expect(compileClickFunction(source).ok).toBe(true);
		expect(g.__clickFunctionSideEffect).toBeUndefined();
		// ...and it does leave one when it is evaluated, so the check above proves something.
		evaluateClickFunction(source, item());
		expect(g.__clickFunctionSideEffect).toBe(1);
		delete g.__clickFunctionSideEffect;
	});

	it("introduces no timeout or worker: a compiled function is the plain function, called inline (F3)", () => {
		const compiled = compileClickFunction("(item) => item.id");
		expect(compiled.ok).toBe(true);
		if (compiled.ok) expect(compiled.fn(item({ id: "x" }))).toBe("x");
	});
});

describe("G9: a valid return", () => {
	it.each([
		["undefined", "(item) => undefined", { kind: "fall-through" }],
		["no return statement", "(item) => { }", { kind: "fall-through" }],
		["null", "(item) => null", { kind: "fall-through" }],
		["none", '(item) => ({ kind: "none" })', { kind: "none" }],
		["terminal argv", '(item) => ({ kind: "terminal", argv: ["open", "-a", "Docker"] })', { kind: "terminal", argv: ["open", "-a", "Docker"] }],
		["command", '(item) => ({ kind: "command", id: "app-runner:open-x" })', { kind: "command", id: "app-runner:open-x" }],
		["uri", '(item) => ({ kind: "uri", uri: "obsidian://open?vault=Notes&file=Docker" })', { kind: "uri", uri: "obsidian://open?vault=Notes&file=Docker" }],
	])("%s", (_label, source, outcome) => {
		expect(evaluateClickFunction(source, item())).toEqual({ ok: true, outcome });
	});

	it("a terminal argv element is kept literally: no tokenizing and no {field} resolution", () => {
		const result = evaluateClickFunction('(item) => ({ kind: "terminal", argv: ["tool", "{path}", "a b", "\\"q\\"", "$(x)"] })', item());
		expect(result).toEqual({ ok: true, outcome: { kind: "terminal", argv: ["tool", "{path}", "a b", '"q"', "$(x)"] } });
	});

	it("the returned argv is a copy: the function's own array is not shared", () => {
		const argv = ["open"];
		const result = validateClickFunctionResult({ kind: "terminal", argv });
		expect(result.ok && result.outcome.kind === "terminal" && result.outcome.argv).toEqual(["open"]);
		if (result.ok && result.outcome.kind === "terminal") expect(result.outcome.argv).not.toBe(argv);
	});

	it("GP7/GP8: the plan's function picks terminal with a path and command without one", () => {
		expect(evaluateClickFunction(PLAN_FUNCTION, item({ id: "docker", extra: { path: "/Applications/Docker.app" } }))).toEqual({
			ok: true,
			outcome: { kind: "terminal", argv: ["open", "-a", "/Applications/Docker.app"] },
		});
		expect(evaluateClickFunction(PLAN_FUNCTION, item({ id: "build-dashboard", extra: {} }))).toEqual({
			ok: true,
			outcome: { kind: "command", id: "app-runner:open-build-dashboard" },
		});
	});
});

describe("G9/E2/E3: every invalid shape is an error with a reason, and nothing is returned to run", () => {
	const invalid: [string, unknown, RegExp][] = [
		["an unknown kind", { kind: "shell", cmd: "ls" }, /unknown kind "shell"/],
		["no kind at all", { argv: ["a"] }, /needs a "kind"/],
		["a non-string kind", { kind: 3 }, /needs a "kind"/],
		["a command with no id", { kind: "command" }, /string "id"/],
		["a command with a number id", { kind: "command", id: 7 }, /string "id"/],
		["a command with a blank id", { kind: "command", id: "  " }, /string "id"/],
		["a uri with no uri", { kind: "uri" }, /string "uri"/],
		["a uri that is a number", { kind: "uri", uri: 7 }, /string "uri"/],
		["a uri that is blank", { kind: "uri", uri: "" }, /string "uri"/],
		["a terminal with no argv", { kind: "terminal" }, /array of strings/],
		["a terminal whose argv is a string", { kind: "terminal", argv: "open -a Docker" }, /array of strings/],
		["a terminal whose argv is an object", { kind: "terminal", argv: { 0: "open" } }, /array of strings/],
		["a terminal whose argv is empty", { kind: "terminal", argv: [] }, /must not be empty/],
		["a number in argv", { kind: "terminal", argv: ["open", 1] }, /element 1 must be a string/],
		["null in argv", { kind: "terminal", argv: [null] }, /element 0 must be a string/],
		["a nested array in argv", { kind: "terminal", argv: ["open", ["-a"]] }, /element 1 must be a string/],
		["undefined in argv", { kind: "terminal", argv: ["open", undefined] }, /element 1 must be a string/],
		["a bare string", "open", /not string/],
		["a number", 5, /not number/],
		["a boolean", true, /not boolean/],
		["an array", [{ kind: "none" }], /not an array/],
		["a function", () => ({ kind: "none" }), /not function/],
	];

	it.each(invalid)("%s", (_label, value, message) => {
		const result = validateClickFunctionResult(value);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(message);
	});

	it("a Promise return is an invalid shape that says the function must be synchronous", async () => {
		const result = validateClickFunctionResult(Promise.resolve({ kind: "none" }));
		expect(result).toEqual({ ok: false, error: expect.stringContaining("synchronous") });
	});

	it("a rejected Promise return is swallowed: no unhandled rejection", async () => {
		const seen: unknown[] = [];
		const onUnhandled = (reason: unknown) => seen.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = evaluateClickFunction("(item) => Promise.reject(new Error('late'))", item());
			expect(result.ok).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(seen).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("an async function is refused with the synchronous message, and is never called", () => {
		const g = globalThis as unknown as { __asyncCalled?: boolean };
		delete g.__asyncCalled;
		const result = evaluateClickFunction("async (item) => { globalThis.__asyncCalled = true; return { kind: 'none' }; }", item());
		expect(result).toEqual({ ok: false, error: expect.stringContaining("synchronous") });
		expect(g.__asyncCalled).toBeUndefined();
	});

	it("a thenable that is not a Promise is also refused", () => {
		const result = evaluateClickFunction("(item) => ({ then(resolve) { resolve({ kind: 'none' }); } })", item());
		expect(result).toEqual({ ok: false, error: expect.stringContaining("synchronous") });
	});

	it("a throw is an error carrying the thrown message, never an exception", () => {
		const result = evaluateClickFunction("(item) => { throw new Error('boom ' + item.id); }", item({ id: "x" }));
		expect(result).toEqual({ ok: false, error: "Click function threw: boom x" });
	});

	it("a thrown non-Error value is still reported", () => {
		expect(evaluateClickFunction("(item) => { throw 'plain'; }", item())).toEqual({ ok: false, error: "Click function threw: plain" });
	});

	it("reading a property of an undefined extra value is a throw, reported and contained (E6 guard)", () => {
		const result = evaluateClickFunction("(item) => item.extra.nested.path", item());
		expect(result.ok).toBe(false);
	});

	it("a source that no longer compiles at click time is an error, not an exception", () => {
		const result = evaluateClickFunction("(item) => {", item());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/^Click function: /);
	});

	it("a hostile thenable whose then getter throws is contained", () => {
		const hostile = {
			get then(): never {
				throw new Error("nope");
			},
		};
		expect(validateClickFunctionResult(hostile)).toEqual({ ok: false, error: expect.stringContaining("could not be read") });
	});
});

describe("buildClickFunctionItem: E6 and E15", () => {
	it("passes id, label and secondary from the stored row and extra from the cache", () => {
		expect(buildClickFunctionItem({ id: "a", label: "A", secondary: "sub" }, { path: "/x" })).toEqual({ id: "a", label: "A", secondary: "sub", extra: { path: "/x" } });
	});

	it("E15: a cleared cache gives extra = {} and secondary undefined when absent", () => {
		const built = buildClickFunctionItem({ id: "a", label: "A" }, undefined);
		expect(built).toEqual({ id: "a", label: "A", secondary: undefined, extra: {} });
		expect(built.extra.path).toBeUndefined();
	});

	it("E6: a not-found row gets extra = {} even if a stale cache row still has extras", () => {
		expect(buildClickFunctionItem({ id: "a", label: "A", notFound: true }, { path: "/stale" }).extra).toEqual({});
	});

	it("the function gets a copy of extra: changing it leaves the cache row untouched", () => {
		const cached = { path: "/x", nested: { a: 1 } };
		const built = buildClickFunctionItem({ id: "a", label: "A" }, cached);
		built.extra.path = "changed";
		(built.extra.nested as { a: number }).a = 99;
		expect(cached).toEqual({ path: "/x", nested: { a: 1 } });
	});

	it("an extra that cannot be copied (a function value) becomes {} rather than throwing", () => {
		expect(buildClickFunctionItem({ id: "a", label: "A" }, { fn: () => 1 }).extra).toEqual({});
	});
});

describe("checkClickFunctionSyntax (the typing-time, parse-only check)", () => {
	it("accepts valid source and a trailing semicolon, and rejects a syntax error with its message", () => {
		expect(checkClickFunctionSyntax("(item) => item.id")).toEqual({ ok: true });
		expect(checkClickFunctionSyntax("(item) => undefined;")).toEqual({ ok: true });
		const bad = checkClickFunctionSyntax("(item) => {");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toMatch(/Unexpected end of input|SyntaxError|Unexpected/i);
	});

	it("does not evaluate the source: an IIFE leaves no trace, and an infinite loop in it returns at once", () => {
		const g = globalThis as unknown as { __syntaxOnly?: number };
		delete g.__syntaxOnly;
		expect(checkClickFunctionSyntax("(() => { globalThis.__syntaxOnly = 1; return (item) => null; })()")).toEqual({ ok: true });
		expect(checkClickFunctionSyntax("(() => { while (true) {} })()")).toEqual({ ok: true });
		expect(g.__syntaxOnly).toBeUndefined();
	});

	it("cannot tell a non-function apart (that is the Save-time check's job)", () => {
		expect(checkClickFunctionSyntax("42")).toEqual({ ok: true });
		expect(validateClickFunctionSource("42").ok).toBe(false);
	});
});
