import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import type { UnitRef, View, ViewNode } from "../../src/types";
import { createEmptyView } from "../../src/types";

// --- bucket rows (renderNode, G1/G3) and inbox rows (renderInboxRow, G2) never show pills from the
// wrong place: "promoted"/"added" belong only to the inbox. Rendered via the real prototype methods
// against a stubbed `this`, the same way `add-to-inbox.test.ts` drives `renderInboxRow`. ----------------

interface PillRowInfo {
	text: string;
	icon: string;
	promoted: boolean;
	added: boolean;
	missing: boolean;
	secondary?: string;
}

const noop = () => {};

/** Fake `this` for `renderNode`: every collaborator it touches is stubbed, and `resolveRef` /
 * `resolveOutsideManagedRowInfo` return the given RowInfo so the test controls promoted/added. */
function fakeBucketThis(info: PillRowInfo, outsideManaged = false) {
	return {
		plugin: { viewsManager: { managedRowFilterState: vi.fn(() => "shown") } },
		selectedBucketNodeIds: new Set<string>(),
		isOutsideManagedUnit: vi.fn(() => outsideManaged),
		resolveOutsideManagedRowInfo: vi.fn(() => info),
		resolveRef: vi.fn(async () => info),
		matchesFilter: vi.fn(() => true),
		renderRowIcon: vi.fn(noop),
		wireModuleRow: vi.fn(noop),
		setPlacementTooltip: vi.fn(noop),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		openRef: vi.fn(async () => {}),
		makeDropZone: vi.fn(noop),
		buildNodeDragPayload: vi.fn(() => ({})),
		handleRowKeydown: vi.fn(noop),
		showUnitMenu: vi.fn(noop),
		renderFoldableChildren: vi.fn(async () => {}),
	};
}

type BucketFake = ReturnType<typeof fakeBucketThis>;

function callRenderNode(fake: BucketFake, container: HTMLElement, node: ViewNode, view: View): Promise<void> {
	return (
		AtlasExplorerView.prototype as unknown as {
			renderNode: (this: BucketFake, node: ViewNode, container: HTMLElement, view: View, depth: number, ancestors: []) => Promise<void>;
		}
	).renderNode.call(fake, node, container, view, 0, []);
}

function unitNode(id: string, ref: UnitRef): ViewNode {
	return { id, type: "unit", ref, children: [] } as ViewNode;
}

function badgesOf(row: HTMLElement): string[] {
	return Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent ?? "");
}

function renderBucketRow(info: PillRowInfo, ref: UnitRef, outsideManaged = false): Promise<HTMLElement> {
	const container = document.createElement("div");
	const fake = fakeBucketThis(info, outsideManaged);
	return callRenderNode(fake, container, unitNode("n1", ref), createEmptyView("v1", "Default")).then(() => {
		return container.querySelector<HTMLElement>(".atlas-row-unit")!;
	});
}

function renderInboxRowFor(info: PillRowInfo, ref: UnitRef): HTMLElement {
	const container = document.createElement("div");
	const fake = { selectedInboxRefKeys: new Set<string>(), setPlacementTooltip: vi.fn(noop) };
	return (
		AtlasExplorerView.prototype as unknown as {
			renderInboxRow: (this: typeof fake, container: HTMLElement, ref: UnitRef, info: PillRowInfo, view: View, hidden?: boolean) => HTMLElement;
		}
	).renderInboxRow.call(fake, container, ref, info, createEmptyView("v1", "Default"), false);
}

const promotedInfo: PillRowInfo = { text: "Hartley Haulage", icon: "file", promoted: true, added: false, missing: false };
const addedInfo: PillRowInfo = { text: "Notes", icon: "file", promoted: false, added: true, missing: false };

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("bucket rows never show promoted/added pills (G1)", () => {
	it("GP2: a promoted note rendered as a bucket row shows its title and no 'promoted' pill", async () => {
		const row = await renderBucketRow(promotedInfo, { kind: "file", path: "Hartley Haulage.md" });
		expect(row.querySelector(".atlas-row-text")?.textContent).toBe("Hartley Haulage");
		expect(badgesOf(row)).toEqual([]);
	});

	it("GP2: an added file placed in the bucket shows no 'added' pill", async () => {
		const row = await renderBucketRow(addedInfo, { kind: "file", path: "Areas/Notes.md" });
		expect(badgesOf(row)).toEqual([]);
	});

	it("G1: a folder unit / promoted folder bucket row shows no pill", async () => {
		const row = await renderBucketRow({ ...promotedInfo, icon: "folder" }, { kind: "folder", path: "ModuleA" });
		expect(badgesOf(row)).toEqual([]);
	});

	it("G1: an Outside-managed bucket row shows no pill", async () => {
		const row = await renderBucketRow(addedInfo, { kind: "file", path: "external.md" }, true);
		expect(badgesOf(row)).toEqual([]);
	});

	it("G3: other secondary text on a bucket row still renders as before", async () => {
		const row = await renderBucketRow(
			{ text: "Gone", icon: "file", promoted: true, added: false, missing: true, secondary: "2 items" },
			{ kind: "file", path: "Gone.md" }
		);
		expect(badgesOf(row)).toEqual([]);
		const secondary = Array.from(row.querySelectorAll(".atlas-row-secondary")).map((s) => s.textContent);
		expect(secondary).toEqual(["2 items", "(missing)"]);
		expect(row.classList.contains("atlas-missing")).toBe(true);
	});
});

describe("inbox rows keep their promoted/added pills (G2, GP1, GP3)", () => {
	it("GP1: a promoted note in the inbox shows 'Hartley Haulage' with a 'promoted' pill", () => {
		const row = renderInboxRowFor(promotedInfo, { kind: "file", path: "Hartley Haulage.md" });
		expect(row.querySelector(".atlas-row-text")?.textContent).toBe("Hartley Haulage");
		expect(badgesOf(row)).toEqual(["promoted"]);
	});

	it("GP3: an added file in the inbox shows an 'added' pill", () => {
		const row = renderInboxRowFor(addedInfo, { kind: "file", path: "Areas/Notes.md" });
		expect(badgesOf(row)).toEqual(["added"]);
	});
});

describe("RowInfo is still resolved for bucket rows (G1)", () => {
	it("G1: renderNode still resolves the ref through resolveRef, so RowInfo.promoted/added are still populated upstream", async () => {
		const fake = fakeBucketThis(promotedInfo);
		await callRenderNode(fake, document.createElement("div"), unitNode("n1", { kind: "file", path: "Hartley Haulage.md" }), createEmptyView("v1", "Default"));
		expect(fake.resolveRef).toHaveBeenCalledWith({ kind: "file", path: "Hartley Haulage.md" });
	});
});
