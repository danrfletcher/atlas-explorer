import { describe, expect, it } from "vitest";
import { SOURCE_TYPE_OPTIONS } from "../../src/api-source-modal";

/** PR-3 R3 / T2: the unit tests elsewhere in this suite fake `DropdownComponent` with a plain
 * `{ value: string }` field (see `FakeDropdownComponent` in api-source-modal.test.ts), which can't
 * prove what a real `<select>` does with `setValue("")` when no option has that value — it could
 * either show nothing selected, or silently fall back to the browser's first-option default.
 *
 * The "obsidian" package ships only type definitions (no runtime — see node_modules/obsidian), so no
 * test can construct a real `DropdownComponent`. But its contract is pinned by `obsidian.d.ts`:
 * `DropdownComponent.selectEl` is a genuine `HTMLSelectElement`, and `setValue` is documented/known to
 * assign straight to `selectEl.value`. That assignment's behavior with no matching option is not
 * Obsidian-specific at all — it is the DOM's own `HTMLSelectElement value` IDL-attribute algorithm
 * (WHATWG HTML spec), which every Chromium build (Obsidian included, as an Electron app) and jsdom
 * both implement. So building a real `<select>` with the exact same options `ApiSourceModal` adds,
 * with no `vi.mock("obsidian", ...)` involved, and assigning `.value = ""` on it directly exercises
 * that same spec'd algorithm — the closest thing to a live Obsidian render this suite can do. */
describe("PR-3 R3 / T2 — a <select> with no matching option shows blank, not the first option", () => {
	it("setting value to a string no <option> has leaves nothing selected", () => {
		const select = document.createElement("select");
		for (const option of SOURCE_TYPE_OPTIONS) {
			const el = document.createElement("option");
			el.value = option.value;
			el.textContent = option.label;
			select.appendChild(el);
		}
		document.body.appendChild(select);

		// Sanity check: a freshly-inserted <select> with no option explicitly marked `selected`
		// defaults to its first option per the HTML parser's own reset algorithm — this is the
		// fallback T2/R3 worried `setValue("")` might silently reproduce.
		expect(select.value).toBe("api");
		expect(select.selectedIndex).toBe(0);

		select.value = "";

		expect(select.value).toBe("");
		expect(select.selectedIndex).toBe(-1);

		document.body.removeChild(select);
	});
});
