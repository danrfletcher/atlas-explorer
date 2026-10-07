import { describe, expect, it } from "vitest";
import { ApiSourceController, ConfirmDeleteAnswer } from "../../src/api-source-controller";
import { RequestFn } from "../../src/api-http";
import { ApiSourceConfig, ViewNode } from "../../src/types";

/** G6b(ii)/G11: exercises `ApiSourceController.doRefresh`'s confirm-delete state machine directly —
 * manual vs. automatic trigger, answered vs. dismissed, the once-per-Folder rule, and the reset after
 * an answer — via a fake `requestImpl` (no real HTTP) and a fake `confirmDelete`. */

function makeNode(id: string, prevRows: Record<string, { id: string; label: string }> = {}, order: string[] = []): ViewNode {
	return { id, type: "meta", label: "API folder", children: [], apiItemState: { ...prevRows }, apiItemOrder: [...order] };
}

function overwriteSource(overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "http://example.invalid/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "overwrite",
		confirmBeforeDelete: true,
		...overrides,
	};
}

/** Response that reports only "1" — deletes "2" from a two-row prior state, so every scenario here
 * genuinely needs confirmation. */
const requestReportingOnlyRowOne: RequestFn = async () => ({ status: 200, text: JSON.stringify([{ id: "1", name: "One" }]) });

function seededNode(): ViewNode {
	return makeNode("n1", { "1": { id: "1", label: "One" }, "2": { id: "2", label: "Two" } }, ["1", "2"]);
}

describe("ApiSourceController — G6b(ii)/G11 confirm-delete policy", () => {
	it("manual trigger, confirmed: rows are deleted and awaiting-confirmation clears", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "confirmed";
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete });

		expect(node.apiItemState).toEqual({ "1": expect.objectContaining({ id: "1" }) });
		expect(node.apiAwaitingConfirmation).toBe(false);
		expect(node.apiCache?.ok).toBe(true);
	});

	it("manual trigger, explicit cancel: rows kept as-is, but the fetch still counts as a successful cache refresh", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "cancelled";
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete });

		expect(Object.keys(node.apiItemState ?? {}).sort()).toEqual(["1", "2"]);
		expect(node.apiAwaitingConfirmation).toBe(false);
		expect(node.apiCache?.ok).toBe(true);
	});

	it("manual trigger, dismissed (Escape/close): edge case counts as Cancel, not as unanswered", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "dismissed";
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete });

		expect(Object.keys(node.apiItemState ?? {}).sort()).toEqual(["1", "2"]);
		expect(node.apiAwaitingConfirmation).toBe(false);
		expect(node.apiCache?.ok).toBe(true);
	});

	it("automatic trigger, confirmed: rows are deleted and awaiting-confirmation clears, same as manual", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "confirmed";
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "automatic", confirmDelete });

		expect(node.apiItemState).toEqual({ "1": expect.objectContaining({ id: "1" }) });
		expect(node.apiAwaitingConfirmation).toBe(false);
	});

	it("automatic trigger, dismissed: unanswered — rows untouched, goes amber, cache left alone", async () => {
		const node = seededNode();
		const cacheBefore = node.apiCache;
		const controller = new ApiSourceController();
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "dismissed";
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "automatic", confirmDelete });

		expect(Object.keys(node.apiItemState ?? {}).sort()).toEqual(["1", "2"]);
		expect(node.apiAwaitingConfirmation).toBe(true);
		expect(node.apiCache).toBe(cacheBefore);
	});

	it("ask-at-most-once-per-Folder: a second automatic refresh while still awaiting skips silently, no re-ask, no persist", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		let confirmCalls = 0;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalls++;
			return "dismissed";
		};
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "automatic", confirmDelete });
		expect(confirmCalls).toBe(1);
		expect(node.apiAwaitingConfirmation).toBe(true);

		let persistCalls = 0;
		await controller.refresh(node, overwriteSource(), [], () => persistCalls++, { requestImpl: requestReportingOnlyRowOne, trigger: "automatic", confirmDelete });
		expect(confirmCalls).toBe(1);
		expect(persistCalls).toBe(0);
		expect(Object.keys(node.apiItemState ?? {}).sort()).toEqual(["1", "2"]);
	});

	it("a later manual Refresh now always asks again, ignoring an existing awaiting-confirmation flag", async () => {
		const node = seededNode();
		node.apiAwaitingConfirmation = true;
		const controller = new ApiSourceController();
		let confirmCalls = 0;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalls++;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete });
		expect(confirmCalls).toBe(1);
		expect(node.apiAwaitingConfirmation).toBe(false);
	});

	it("an actual answer (confirmed or cancelled) clears the awaiting flag even when it was already set", async () => {
		const node = seededNode();
		node.apiAwaitingConfirmation = true;
		const controller = new ApiSourceController();
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => "cancelled";
		// A subsequent automatic refresh with a real answer available (not "already awaiting and dismissed
		// again") still asks — the once-per-Folder skip only applies when this exact refresh finds it
		// needs confirmation and the Folder is already awaiting *and* the trigger is automatic with no
		// fresh answer. Here the fake genuinely answers, so it must not be treated as a silent skip.
		await controller.refresh(node, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete });
		expect(node.apiAwaitingConfirmation).toBe(false);
	});

	it("no confirmDelete supplied when confirmation is needed defaults to dismissed (safe default)", async () => {
		const automaticNode = seededNode();
		const controller = new ApiSourceController();
		await controller.refresh(automaticNode, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "automatic" });
		expect(automaticNode.apiAwaitingConfirmation).toBe(true);
		expect(Object.keys(automaticNode.apiItemState ?? {}).sort()).toEqual(["1", "2"]);

		const manualNode = seededNode();
		await controller.refresh(manualNode, overwriteSource(), [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual" });
		expect(manualNode.apiAwaitingConfirmation).toBe(false);
		expect(Object.keys(manualNode.apiItemState ?? {}).sort()).toEqual(["1", "2"]);
	});

	it("rapid double manual Refresh now collapses to a single in-flight request and asks for confirmation only once", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		let confirmCalls = 0;
		let resolveConfirm: ((answer: ConfirmDeleteAnswer) => void) | null = null;
		const confirmDelete = (): Promise<ConfirmDeleteAnswer> => {
			confirmCalls++;
			return new Promise((resolve) => {
				resolveConfirm = resolve;
			});
		};
		const source = overwriteSource();
		const [a, b] = [
			controller.refresh(node, source, [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete }),
			controller.refresh(node, source, [], () => {}, { requestImpl: requestReportingOnlyRowOne, trigger: "manual", confirmDelete }),
		];
		// Give the fetch/mapping microtasks a turn to reach the confirm call before asserting — a
		// macrotask boundary flushes every pending microtask from the fetch → map → plan chain first.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(confirmCalls).toBe(1);
		resolveConfirm?.("confirmed");
		await Promise.all([a, b]);
		expect(confirmCalls).toBe(1);
	});

	it("a guard-off Overwrite refresh with genuine deletions never invokes confirmDelete at all", async () => {
		const node = seededNode();
		const controller = new ApiSourceController();
		let confirmCalls = 0;
		const confirmDelete = async (): Promise<ConfirmDeleteAnswer> => {
			confirmCalls++;
			return "confirmed";
		};
		await controller.refresh(node, overwriteSource({ confirmBeforeDelete: false }), [], () => {}, {
			requestImpl: requestReportingOnlyRowOne,
			trigger: "automatic",
			confirmDelete,
		});
		expect(confirmCalls).toBe(0);
		expect(Object.keys(node.apiItemState ?? {})).toEqual(["1"]);
	});
});
