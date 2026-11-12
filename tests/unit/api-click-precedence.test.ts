import { describe, expect, it, vi } from "vitest";
import { ApiClickFunctionLayer, ApiItemClickHandlers, hasActiveItemOverride, runApiItemClick } from "../../src/api-item-click";
import { ApiClickAction, ApiItemClickAction, ApiItemState, ApiSourceConfig, ClickAction, UnitRef } from "../../src/types";
import { resolveClickAction } from "../../src/views";

/** Atlas-18 G10/G11: the precedence chain for a click or Enter on an API item row. Calls the real
 * `runApiItemClick` and `resolveClickAction` with explicit inputs; the handlers are the only stubs, and the
 * assertion is on which one (if any) was called. */

const NOTE: UnitRef = { kind: "file", path: "Docker.md" };
const TERMINAL: ClickAction = { kind: "terminal", value: "open -a Docker" };
const COMMAND: ClickAction = { kind: "command", value: "app-runner:open-docker" };
const URI: ClickAction = { kind: "uri", value: "obsidian://open?vault=Notes&file=Docker" };

type SourceLabel = "unset" | ApiClickAction;
const sourceConfig = (label: SourceLabel): ApiSourceConfig => ({ ...({ url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } as ApiSourceConfig), ...(label === "unset" ? {} : { action: label }) });

function handlers() {
	return { runOverride: vi.fn(), runSourceCommand: vi.fn(), openAttachment: vi.fn() } satisfies ApiItemClickHandlers;
}

const row = (clickAction: ApiItemClickAction | undefined, hasNote: boolean): ApiItemState => {
	const item: ApiItemState = { id: "1", label: "Docker 4.34", kind: "placeholder" };
	if (clickAction) item.clickAction = clickAction;
	if (hasNote) item.noteRef = NOTE;
	return item;
};

type OverrideLabel = "absent" | "none" | "terminal" | "command" | "uri";
const OVERRIDES: Record<OverrideLabel, ApiItemClickAction | undefined> = { absent: undefined, none: { kind: "none" }, terminal: TERMINAL, command: COMMAND, uri: URI };
const SOURCES: SourceLabel[] = ["unset", "none", "open-attachment", "run-command"];

type Expected = { calls: "none" | "runOverride" | "runSourceCommand" | "openAttachment"; decision: string };

function expectedFor(override: OverrideLabel, source: SourceLabel, hasNote: boolean): Expected {
	if (override === "none") return { calls: "none", decision: "override" };
	if (override !== "absent") return { calls: "runOverride", decision: "override" };
	if (source === "none") return { calls: "none", decision: "source" };
	if (source === "run-command") return { calls: "runSourceCommand", decision: "source" };
	return hasNote ? { calls: "openAttachment", decision: "attachment" } : { calls: "none", decision: "nothing" };
}

const table = (Object.keys(OVERRIDES) as OverrideLabel[]).flatMap((override) => SOURCES.flatMap((source) => [true, false].map((hasNote) => ({ override, source, hasNote }))));

describe("G11: every override × source action × noteRef combination calls exactly one runner, or none", () => {
	it("the table covers all 5 × 4 × 2 combinations", () => {
		expect(table).toHaveLength(40);
	});

	it.each(table)("override $override, source $source, note attached: $hasNote", async ({ override, source, hasNote }) => {
		const h = handlers();
		const item = row(OVERRIDES[override], hasNote);
		const decision = await runApiItemClick({ item, overrideApplies: true, sourceAction: resolveClickAction(sourceConfig(source)) }, h);

		const expected = expectedFor(override, source, hasNote);
		expect(decision).toBe(expected.decision);
		for (const name of ["runOverride", "runSourceCommand", "openAttachment"] as const) {
			if (name === expected.calls) expect(h[name], name).toHaveBeenCalledTimes(1);
			else expect(h[name], name).not.toHaveBeenCalled();
		}
		if (expected.calls === "runOverride") expect(h.runOverride).toHaveBeenCalledWith(OVERRIDES[override]);
	});
});

describe("G11: the last step is the source setting's own Open attachment step", () => {
	it.each<SourceLabel>(["none", "run-command"])("with the source on %s and no override, a click never opens the attachment", async (source) => {
		const h = handlers();
		await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction: resolveClickAction(sourceConfig(source)) }, h);
		expect(h.openAttachment).not.toHaveBeenCalled();
	});

	it("an override of None beats a source set to Open attachment, and opens nothing", async () => {
		const h = handlers();
		await runApiItemClick({ item: row({ kind: "none" }, true), overrideApplies: true, sourceAction: "open-attachment" }, h);
		expect(h.openAttachment).not.toHaveBeenCalled();
		expect(h.runOverride).not.toHaveBeenCalled();
	});

	it("an override of None beats a source set to Run terminal command", async () => {
		const h = handlers();
		await runApiItemClick({ item: row({ kind: "none" }, false), overrideApplies: true, sourceAction: "run-command" }, h);
		expect(h.runSourceCommand).not.toHaveBeenCalled();
	});

	it("a terminal override runs and does not open the attached note", async () => {
		const h = handlers();
		await runApiItemClick({ item: row(TERMINAL, true), overrideApplies: true, sourceAction: "open-attachment" }, h);
		expect(h.runOverride).toHaveBeenCalledExactlyOnceWith(TERMINAL);
		expect(h.openAttachment).not.toHaveBeenCalled();
	});

	it("an unknown source action value (hand-edited data) does nothing, as before", async () => {
		const h = handlers();
		const decision = await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction: "bogus" as ApiClickAction }, h);
		expect(decision).toBe("nothing");
		expect(h.openAttachment).not.toHaveBeenCalled();
		expect(h.runSourceCommand).not.toHaveBeenCalled();
	});
});

describe("E16: an override under no live API source is inert", () => {
	it.each(table.filter((c) => c.override !== "absent"))("override $override, source $source, note $hasNote: falls to the source layer and is never run", async ({ override, source, hasNote }) => {
		const h = handlers();
		const item = row(OVERRIDES[override], hasNote);
		const decision = await runApiItemClick({ item, overrideApplies: false, sourceAction: resolveClickAction(sourceConfig(source)) }, h);
		expect(h.runOverride).not.toHaveBeenCalled();
		// Exactly what an item with no override does under the same source setting.
		const expected = expectedFor("absent", source, hasNote);
		expect(decision).toBe(expected.decision);
		if (expected.calls !== "none") expect(h[expected.calls]).toHaveBeenCalledTimes(1);
		// ...and the stored override is untouched.
		expect(item.clickAction).toEqual(OVERRIDES[override]);
	});
});

describe("G11/G10: hasActiveItemOverride", () => {
	it("is true for any stored override, None included, only under a live source", () => {
		expect(hasActiveItemOverride(row(TERMINAL, false), true)).toBe(true);
		expect(hasActiveItemOverride(row({ kind: "none" }, false), true)).toBe(true);
		expect(hasActiveItemOverride(row(undefined, false), true)).toBe(false);
		expect(hasActiveItemOverride(row(TERMINAL, false), false)).toBe(false);
	});
});

describe("the Click function seam (PR-5 plugs in here)", () => {
	it("an Item override still beats the function layer, which is never asked", async () => {
		const h = handlers();
		const layer = vi.fn<ApiClickFunctionLayer>(() => ({ kind: "handled" }));
		await runApiItemClick({ item: row(URI, false), overrideApplies: true, sourceAction: "open-attachment", functionLayer: layer }, h);
		expect(layer).not.toHaveBeenCalled();
		expect(h.runOverride).toHaveBeenCalledExactlyOnceWith(URI);
	});

	it("an override of None beats the function layer too", async () => {
		const h = handlers();
		const layer = vi.fn<ApiClickFunctionLayer>(() => ({ kind: "handled" }));
		await runApiItemClick({ item: row({ kind: "none" }, true), overrideApplies: true, sourceAction: "open-attachment", functionLayer: layer }, h);
		expect(layer).not.toHaveBeenCalled();
	});

	it("a function layer returning { kind: 'none' } stops the chain: no source action, no attachment", async () => {
		const h = handlers();
		const layer: ApiClickFunctionLayer = () => ({ kind: "none" });
		for (const sourceAction of ["open-attachment", "run-command", "none"] as const) {
			const decision = await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction, functionLayer: layer }, h);
			expect(decision).toBe("function");
		}
		expect(h.openAttachment).not.toHaveBeenCalled();
		expect(h.runSourceCommand).not.toHaveBeenCalled();
		expect(h.runOverride).not.toHaveBeenCalled();
	});

	it("a function layer that ran something stops the chain: the source layer does not also run", async () => {
		const h = handlers();
		const functionRunner = vi.fn();
		const layer: ApiClickFunctionLayer = () => {
			functionRunner();
			return { kind: "handled" };
		};
		const decision = await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction: "open-attachment", functionLayer: layer }, h);
		expect(decision).toBe("function");
		expect(functionRunner).toHaveBeenCalledTimes(1);
		expect(h.openAttachment).not.toHaveBeenCalled();
	});

	it.each([[undefined], [null]])("a function layer returning %s falls through to the source layer", async (result) => {
		const h = handlers();
		const layer = vi.fn<ApiClickFunctionLayer>(() => result);
		const decision = await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction: "open-attachment", functionLayer: layer }, h);
		expect(layer).toHaveBeenCalledTimes(1);
		expect(decision).toBe("attachment");
		expect(h.openAttachment).toHaveBeenCalledTimes(1);

		const h2 = handlers();
		await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction: "run-command", functionLayer: layer }, h2);
		expect(h2.runSourceCommand).toHaveBeenCalledTimes(1);
	});

	it("the layer is handed the clicked item", async () => {
		const layer = vi.fn<ApiClickFunctionLayer>(() => undefined);
		const item = row(undefined, false);
		await runApiItemClick({ item, overrideApplies: true, sourceAction: "none", functionLayer: layer }, handlers());
		expect(layer).toHaveBeenCalledExactlyOnceWith(item);
	});

	it("with no function layer at all, the chain is override then source then attachment (F8)", async () => {
		const h = handlers();
		expect(await runApiItemClick({ item: row(undefined, true), overrideApplies: true, sourceAction: "open-attachment" }, h)).toBe("attachment");
	});
});

describe("a malformed stored override that bypassed the load-time sanitiser", () => {
	it.each<[string, unknown]>([
		["an unknown kind", { kind: "shell", value: "ls" }],
		["a blank value", { kind: "terminal", value: "  " }],
		["a non-string value", { kind: "uri", value: 5 }],
	])("%s falls through as if absent and runs nothing", async (_label, bad) => {
		const h = handlers();
		const item = { ...row(undefined, true), clickAction: bad } as ApiItemState;
		const decision = await runApiItemClick({ item, overrideApplies: true, sourceAction: "open-attachment" }, h);
		expect(decision).toBe("attachment");
		expect(h.runOverride).not.toHaveBeenCalled();
	});
});
