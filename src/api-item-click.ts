import { readRunnableClickAction } from "./click-action-runner";
import { ApiClickAction, ApiItemState, ClickAction } from "./types";

/** Atlas-18 (G11): what a click or Enter on an API item row does, as one ordered chain. The first layer
 * that decides stops the chain:
 *
 *   1. the Item override (`item.clickAction`): a terminal / command / URI action runs, and an explicit
 *      `{ kind: "none" }` runs nothing and opens nothing;
 *   2. the Click function layer (a seam: PR-5 fills it; with none supplied this layer is skipped);
 *   3. the source click action: None does nothing, Run terminal command runs the source's command;
 *   4. open attachment, which is only ever the source click action's own "Open attachment" (or unset) step.
 *
 * Deliberately free of the explorer view so every combination is testable with explicit inputs: the view
 * supplies the handlers that really run things, this module only decides which one is called. */

/** What the Click function layer reports back when it decides. It runs whatever it chose itself (through
 * the same runner), so the chain only needs to know whether to stop: `none` (nothing runs and no attachment
 * opens) or `handled` (it ran something). Returning `null` or `undefined` instead falls through to the
 * source click action. */
export type ApiClickLayerResult = { kind: "none" } | { kind: "handled" };

/** The Click function layer: asked for a row only when no Item override decided first. */
export type ApiClickFunctionLayer = (item: ApiItemState) => ApiClickLayerResult | null | undefined;

/** Which layer decided. `nothing` means every layer passed: the source click action was Open attachment
 * (or unset) and the row has no attached note, or the source click action is a value this build doesn't know. */
export type ApiItemClickDecision = "override" | "function" | "source" | "attachment" | "nothing";

export interface ApiItemClickInput {
	item: ApiItemState;
	/** Whether the row sits under a live API source. An Item override under a removed source, or on a
	 * Table or CSV row, is inert (E16): it is neither run nor deleted. */
	overrideApplies: boolean;
	/** The source's own click action, already defaulted (unset = open-attachment). */
	sourceAction: ApiClickAction;
	functionLayer?: ApiClickFunctionLayer;
}

export interface ApiItemClickHandlers {
	/** Runs a terminal, command or URI Item override. */
	runOverride(action: ClickAction): void | Promise<unknown>;
	/** Runs the source's static terminal command for this row ("Run terminal command" source action). */
	runSourceCommand(): void | Promise<unknown>;
	/** Opens the row's attached note. Only called when the row has one. */
	openAttachment(): void | Promise<unknown>;
}

/** True when the row carries an Item override that a click would act on (any stored value, "none"
 * included) and the row is under a live API source. The view uses it to keep a modifier-click or a click
 * on a row control from running the chain once an override is set. */
export function hasActiveItemOverride(item: ApiItemState, overrideApplies: boolean): boolean {
	return overrideApplies && item.clickAction !== undefined;
}

/** Runs the chain for one row and resolves to the layer that decided. Never changes any stored state. */
export async function runApiItemClick(input: ApiItemClickInput, handlers: ApiItemClickHandlers): Promise<ApiItemClickDecision> {
	const { item } = input;

	if (input.overrideApplies && item.clickAction) {
		if (item.clickAction.kind === "none") return "override";
		// Read defensively: a hand-edited value that bypassed the load-time sanitiser falls through as if absent.
		const action = readRunnableClickAction(item.clickAction);
		if (action) {
			await handlers.runOverride(action);
			return "override";
		}
	}

	if (input.functionLayer) {
		const result = input.functionLayer(item);
		if (result) return "function";
	}

	if (input.sourceAction === "none") return "source";
	if (input.sourceAction === "run-command") {
		await handlers.runSourceCommand();
		return "source";
	}
	if (input.sourceAction === "open-attachment" && item.noteRef) {
		await handlers.openAttachment();
		return "attachment";
	}
	return "nothing";
}
