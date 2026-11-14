import { afterEach, describe, expect, it } from "vitest";
import { makeSectionHarness, SectionHarness } from "./explorer-header-fixtures";

// PR-4 (F1 / G16): with the Tephra toggle off the Inbox DOM is what it was before sections existed. The two
// snapshot files in tests/fixtures/ were written from the code as it stood before PR-4 touched the explorer,
// so any change to the toggle-off markup (an extra attribute, class or element) fails here. Regenerate one
// only on purpose, with `npx vitest run -u`.
describe("Inbox DOM with the Tephra toggle off matches the pre-PR snapshot (F1)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("an open Inbox", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 5 });
		await h.render();
		await expect(h.panel().innerHTML).toMatchFileSnapshot("./fixtures/inbox-toggle-off-open.html");
	});

	it("a collapsed Inbox", async () => {
		h = makeSectionHarness({ bucketRows: 3, inboxRows: 5 });
		await h.render();
		h.inboxChevron().click();
		await expect(h.panel().innerHTML).toMatchFileSnapshot("./fixtures/inbox-toggle-off-collapsed.html");
	});
});
