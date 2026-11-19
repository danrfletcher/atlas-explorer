import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnitRef, ViewNode } from "../../src/types";
import { makeSourcesRig, type SourcesRig } from "../sources-explorer-fixture";

// PR-9 (E1, R3-4): going offline is not a delete. A view holding two `Sources/whoop/...` units keeps both rows,
// unmarked, while Tephra is down, and the stored view is untouched. The real explorer, `UnitIndex`, `ViewsManager`
// and `TephraConnection` over the fixture vault; the daemon is `tests/fixtures/fake-tephra-server.mjs`, stopped
// with `rig.daemon.down` (every request refused, as a stopped Tephra's are).

let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
});

const LEG_DAY: UnitRef = { kind: "file", path: "Sources/whoop/Leg Day.md" };
const WORKOUT_PLAN: UnitRef = { kind: "file", path: "Sources/whoop/Workout Plan.md" };

const flatNodes = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((node) => [node, ...flatNodes(node.children ?? [])]);
const storedRefs = (r: SourcesRig) =>
	flatNodes(r.viewsManager.getActiveView().root)
		.filter((node) => node.type === "unit")
		.map((node) => node.ref);
const bucketRows = (r: SourcesRig) => [...r.h.panel().querySelectorAll<HTMLElement>(".atlas-bucket .atlas-row-unit")];
const bucketTexts = (r: SourcesRig) => bucketRows(r).map((row) => row.querySelector(".atlas-row-text")?.textContent);

/** Nothing in the bucket is drawn as a missing row: no `atlas-missing` class, no "(missing)" text, no Remove button. */
function expectNoMissingRows(r: SourcesRig): void {
	const bucket = r.h.panel().querySelector<HTMLElement>(".atlas-bucket")!;
	expect(bucket.querySelectorAll(".atlas-missing")).toHaveLength(0);
	expect(bucket.querySelectorAll(".atlas-row-action")).toHaveLength(0);
	expect(bucket.textContent).not.toContain("(missing)");
	for (const row of bucketRows(r)) expect(row.classList.contains("atlas-missing")).toBe(false);
}

async function placeBoth(r: SourcesRig): Promise<void> {
	const view = r.viewsManager.getActiveView();
	expect(r.viewsManager.placeUnit(view.id, LEG_DAY, null)).not.toBeNull();
	expect(r.viewsManager.placeUnit(view.id, WORKOUT_PLAN, null)).not.toBeNull();
	await r.h.render();
	await r.settle();
}

describe("views holding Sources/ units while Tephra goes offline (E1, R3-4)", () => {
	it("two placed source units: rendered online, then offline, then online again, none is ever marked missing", async () => {
		rig = await makeSourcesRig();
		await placeBoth(rig);

		// online
		expect(bucketTexts(rig)).toEqual(["Leg Day", "Workout Plan"]);
		expectNoMissingRows(rig);
		const placed = storedRefs(rig);
		expect(placed).toEqual([LEG_DAY, WORKOUT_PLAN]);

		// Tephra stops; the next check fails and the explorer redraws for it
		rig.daemon.down = true;
		await rig.check();
		expect(rig.connection.isOnline()).toBe(false);
		expect(rig.h.panel().textContent).toContain("(Tephra offline)"); // the offline render really happened
		expect(bucketTexts(rig)).toEqual(["Leg Day", "Workout Plan"]);
		expectNoMissingRows(rig);
		expect(storedRefs(rig)).toEqual(placed); // the view itself is untouched
		// the two are placed, so neither is also in the whoop Inbox section
		const whoop = rig.h.panel().querySelector<HTMLElement>('.atlas-inbox-source[data-source="whoop"]')!;
		expect(whoop.textContent).toContain("(Tephra offline)");
		expect(whoop.querySelectorAll(".atlas-inbox-spacer .atlas-row")).toHaveLength(0);

		// and back
		rig.daemon.down = false;
		await rig.check();
		expect(rig.connection.isOnline()).toBe(true);
		expect(rig.h.panel().textContent).not.toContain("(Tephra offline)");
		expect(bucketTexts(rig)).toEqual(["Leg Day", "Workout Plan"]);
		expectNoMissingRows(rig);
		expect(storedRefs(rig)).toEqual(placed);
	});

	it("an unplaced source unit stays in its offline section while a placed one stays in the view", async () => {
		rig = await makeSourcesRig();
		rig.viewsManager.placeUnit(rig.viewsManager.getActiveView().id, WORKOUT_PLAN, null);
		await rig.h.render();
		rig.daemon.down = true;
		await rig.check();
		expect(bucketTexts(rig)).toEqual(["Workout Plan"]);
		expectNoMissingRows(rig);
		const whoopRows = [...rig.h.panel().querySelectorAll('.atlas-inbox-source[data-source="whoop"] .atlas-inbox-spacer .atlas-row-text')].map((el) => el.textContent);
		expect(whoopRows).toEqual(["Leg Day"]);
	});

	it("started with Tephra down (nothing remembered): the placed units still resolve and are not missing", async () => {
		rig = await makeSourcesRig({ down: true, settings: { tephraLinks: { tephra: "/vault/Sources/tephra", whoop: "/vault/Sources/whoop" } } });
		expect(rig.connection.getSnapshot()).toMatchObject({ state: "offline", checked: true });
		await placeBoth(rig);
		expect(bucketTexts(rig)).toEqual(["Leg Day", "Workout Plan"]);
		expectNoMissingRows(rig);
		expect(storedRefs(rig)).toEqual([LEG_DAY, WORKOUT_PLAN]);
	});

	it("going offline writes nothing to the views: no save, no change to the stored nodes", async () => {
		rig = await makeSourcesRig();
		await placeBoth(rig);
		const before = JSON.stringify(rig.viewsManager.getViews());
		const flush = rig.plugin.flushSave as ReturnType<typeof vi.fn>;
		flush.mockClear();
		rig.daemon.down = true;
		await rig.check();
		expect(JSON.stringify(rig.viewsManager.getViews())).toBe(before);
		expect(flush).not.toHaveBeenCalled();
	});
});
