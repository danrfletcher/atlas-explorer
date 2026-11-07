import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { bucketRows, flush, openExplorer, pointer, PressEnv } from "./explorer-view-press-helpers";

/** Atlas #16 PR-1 (E4, E5, E9): only a press that starts inside an Atlas pane holds Atlas renders.
 * Real `onOpen` listeners on the real document, one press per target, then a render request. */

let h: SectionHarness;
let env: PressEnv;

beforeEach(async () => {
	vi.useFakeTimers();
	h = makeSectionHarness({ bucketRows: 1, inboxRows: 1 });
	env = await openExplorer(h);
	env.renderNow.mockClear();
});

afterEach(() => {
	env.teardown();
	h.teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A bare element appended to the document, optionally inside a chain of parents. */
function el(tag: string, attrs: Record<string, string>, parent: HTMLElement = document.body): HTMLElement {
	const node = parent.appendChild(document.createElement(tag));
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	return node;
}

/** A second Atlas leaf: its own pane element with rendered content inside, as a hidden leaf has. */
function secondAtlasLeaf(): { leaf: HTMLElement; content: HTMLElement; row: HTMLElement; chrome: HTMLElement } {
	const leaf = el("div", { class: "workspace-leaf-content", "data-type": "atlas-explorer" });
	const chrome = el("div", { class: "view-header" }, leaf);
	const content = el("div", { class: "view-content atlas-explorer" }, leaf);
	const row = el("div", { class: "atlas-row atlas-row-unit" }, content);
	return { leaf, content, row, chrome };
}

const targets: [string, () => HTMLElement, boolean][] = [
	["a row in the bucket", () => bucketRows()[0], true],
	["the toolbar", () => document.querySelector<HTMLElement>(".atlas-toolbar")!, true],
	[
		"the filter box",
		() => {
			const input = document.createElement("input");
			input.className = "atlas-filter";
			document.querySelector(".atlas-toolbar")!.appendChild(input);
			return input;
		},
		true,
	],
	["a section header", () => document.querySelector<HTMLElement>(".atlas-inbox > .atlas-section-header")!, true],
	["the Atlas pane's own header, outside the rendered content", () => secondAtlasLeaf().chrome, true],
	["a row in the second Atlas leaf", () => secondAtlasLeaf().row, true],
	[
		"the editor",
		() => el("div", { class: "cm-content" }, el("div", { class: "workspace-leaf-content", "data-type": "markdown" })),
		false,
	],
	[
		"another sidebar",
		() => el("div", { class: "nav-file-title" }, el("div", { class: "workspace-leaf-content", "data-type": "file-explorer" })),
		false,
	],
	["a menu item in the body", () => el("div", { class: "menu-item" }, el("div", { class: "menu" })), false],
	["the bare document body", () => document.body, false],
];

describe("Atlas #16 — which presses hold renders", () => {
	for (const [name, target, holds] of targets) {
		it(`${holds ? "holds" : "does not hold"} when the press starts on ${name}`, async () => {
			const node = target();
			pointer("pointerdown", node, { buttons: 1 });
			env.ex.refresh();
			await vi.advanceTimersByTimeAsync(50);
			expect(env.renderNow).toHaveBeenCalledTimes(holds ? 0 : 1);

			pointer("pointerup", node);
			await flush(env);
			expect(env.renderNow).toHaveBeenCalledTimes(1); // held render runs after release; unheld ran already
		});
	}

	it("a press in the editor ends a press whose release was lost, and the held render runs", async () => {
		const row = bucketRows()[0];
		pointer("pointerdown", row, { buttons: 1 }); // pointerup never arrives
		env.ex.refresh();
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();

		pointer("pointerdown", el("div", { class: "cm-content" }, el("div", { class: "workspace-leaf-content", "data-type": "markdown" })), { buttons: 1 });
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});

	it("a press outside Atlas leaves later renders unheld even after an earlier Atlas press ended", async () => {
		pointer("pointerdown", bucketRows()[0], { buttons: 1 });
		pointer("pointerup", bucketRows()[0]);
		pointer("pointerdown", document.body, { buttons: 1 });
		env.ex.refresh();
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});
});

describe("Atlas #16 (E9) — two Atlas leaves share the rule", () => {
	it("a press in the other Atlas leaf holds this view's renders too, and ending it releases them", async () => {
		const other = secondAtlasLeaf();
		pointer("pointerdown", other.row, { buttons: 1 });
		env.fireUnitIndexChange();
		await vi.advanceTimersByTimeAsync(50);
		expect(env.renderNow).not.toHaveBeenCalled();

		pointer("pointerup", other.row);
		await flush(env);
		expect(env.renderNow).toHaveBeenCalledTimes(1);
	});
});
