import { describe, expect, it } from "vitest";
import { RequestFn, RequestResult } from "../../src/api-http";
import { ApiSourceController, dotStateFor } from "../../src/api-source-controller";
import { ApiSourceConfig, ViewNode } from "../../src/types";

/** G3/E5: refresh pipeline exercised end to end with a mocked HTTP layer (one stub `RequestFn`, no
 * real network/server) — mirrors `refresh-modes.test.ts`'s own stub pattern, but drives
 * `mappingMode: "js"` instead of drag mapping, and walks an ok → throw → recovery sequence to prove
 * the dot/cache/rows behave the same way a drag-mode JS failure would (E5: "treated as a normal
 * failed refresh"). */

function node(overrides: Partial<ViewNode> = {}): ViewNode {
	return { id: "n1", type: "meta", label: "API folder", children: [], ...overrides };
}

function jsSource(source: string, overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "http://example.invalid/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		mappingMode: "js",
		jsSource: source,
		...overrides,
	};
}

const MAPPER = "(response) => response.map((item) => ({ id: item.id, label: item.name }))";

/** A single mutable slot the stub reads from on each call, so a test can change what the "server"
 * returns between successive `controller.refresh()` calls on the same node without a real server. */
function makeStubRequest(): { impl: RequestFn; respond: (result: RequestResult) => void; fail: (err: Error) => void } {
	let next: (() => Promise<RequestResult>) | null = null;
	return {
		impl: async () => {
			if (!next) throw new Error("stub not configured for this call");
			return next();
		},
		respond: (result) => {
			next = async () => result;
		},
		fail: (err) => {
			next = async () => {
				throw err;
			};
		},
	};
}

describe("ApiSourceController.refresh — G3: JS mapping mode end to end (mocked HTTP layer)", () => {
	it("ok: maps rows via the JS function and goes green", async () => {
		const stub = makeStubRequest();
		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }, { id: "2", name: "Two" }]) });
		const n = node();
		const controller = new ApiSourceController();

		await controller.refresh(n, jsSource(MAPPER), [], () => {}, { requestImpl: stub.impl });

		expect(dotStateFor(n.apiCache, n.apiAwaitingConfirmation)).toBe("green");
		expect(n.apiCache?.ok).toBe(true);
		expect(n.apiItemState?.["1"]).toEqual(expect.objectContaining({ id: "1", label: "One" }));
		expect(n.apiItemState?.["2"]).toEqual(expect.objectContaining({ id: "2", label: "Two" }));
	});

	it("E5: a JS mapper that throws is a normal failed refresh — red dot, previous rows kept, not thrown", async () => {
		const stub = makeStubRequest();
		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		const n = node();
		const controller = new ApiSourceController();

		// First: a good refresh with a valid mapper, to have rows to preserve.
		await controller.refresh(n, jsSource(MAPPER), [], () => {}, { requestImpl: stub.impl });
		expect(dotStateFor(n.apiCache)).toBe("green");
		const rowsBefore = n.apiItemState;

		// Second: the same URL now returns a response the mapper throws on.
		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		const throwingSource = jsSource("(response) => { throw new Error('mapper exploded'); }");
		await controller.refresh(n, throwingSource, [], () => {}, { requestImpl: stub.impl });

		expect(dotStateFor(n.apiCache)).toBe("red");
		expect(n.apiCache?.error).toBe("mapper exploded");
		// Previous rows (from the last good refresh) are preserved untouched.
		expect(n.apiItemState).toEqual(rowsBefore);
	});

	it("E1: JS output that isn't a list is a whole-refresh failure — red dot, previous rows kept", async () => {
		const stub = makeStubRequest();
		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		const n = node();
		const controller = new ApiSourceController();

		await controller.refresh(n, jsSource(MAPPER), [], () => {}, { requestImpl: stub.impl });
		const rowsBefore = n.apiItemState;

		stub.respond({ status: 200, text: JSON.stringify({ not: "a list" }) });
		const badShapeSource = jsSource("(response) => ({ not: 'an array' })");
		await controller.refresh(n, badShapeSource, [], () => {}, { requestImpl: stub.impl });

		expect(dotStateFor(n.apiCache)).toBe("red");
		expect(n.apiItemState).toEqual(rowsBefore);
	});

	it("recovery: after a failed refresh, a later good one clears the error and goes green again", async () => {
		const stub = makeStubRequest();
		const n = node();
		const controller = new ApiSourceController();

		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });
		await controller.refresh(n, jsSource("(response) => { throw new Error('nope'); }"), [], () => {}, { requestImpl: stub.impl });
		expect(dotStateFor(n.apiCache)).toBe("red");

		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }, { id: "2", name: "Two" }]) });
		await controller.refresh(n, jsSource(MAPPER), [], () => {}, { requestImpl: stub.impl });

		expect(dotStateFor(n.apiCache)).toBe("green");
		expect(n.apiCache?.error).toBeNull();
		expect(Object.keys(n.apiItemState ?? {}).sort()).toEqual(["1", "2"]);
	});

	it("merge mode keeps status/note across a JS-mode refresh, same as drag mode (G8/F5)", async () => {
		const stub = makeStubRequest();
		const n = node({
			apiItemState: { "1": { id: "1", label: "One", explicitStatusId: "in-progress", lastSeenAt: "2025-12-31T00:00:00.000Z" } },
			apiItemOrder: ["1"],
		});
		const controller = new ApiSourceController();

		stub.respond({ status: 200, text: JSON.stringify([{ id: "1", name: "One (updated)" }]) });
		await controller.refresh(n, jsSource(MAPPER, { mode: "merge" }), [], () => {}, { requestImpl: stub.impl });

		expect(n.apiItemState?.["1"].explicitStatusId).toBe("in-progress");
		expect(n.apiItemState?.["1"].label).toBe("One (updated)");
	});

	it("a network failure below the mapping step is a normal failed refresh too, same as drag mode", async () => {
		const stub = makeStubRequest();
		stub.fail(new Error("connection refused"));
		const n = node();
		const controller = new ApiSourceController();

		await controller.refresh(n, jsSource(MAPPER), [], () => {}, { requestImpl: stub.impl });

		expect(dotStateFor(n.apiCache)).toBe("red");
		expect(n.apiCache?.error).toBe("unreachable");
	});
});
