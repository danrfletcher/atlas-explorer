import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiItemState, StatusGovernance, View, ViewNode } from "../../src/types";
import { activeSortFor } from "../../src/sort";
import { basenameRowInfo, callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, proto, realNode, rowOrder, useRealRenderNode, view } from "./explorer-view-sort-truncate-helpers";
import { dragOverAt, makeDropFake, makeRow, makeVm } from "./explorer-view-drop-helpers";

function apiItem(id: string, explicitStatusId?: string): ApiItemState {
	return { id, label: id, explicitStatusId };
}

describe("G25 — sort: API item rows share the one sort pass real units get", () => {
	it("sortMode manual (default): real children first, then apiItemOrder, both kinds in their own build order", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual" });
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "real-2", "api-1", "api-2"]);
	});

	it("sortMode status, ascending: real units and API items interleave by resolved rank, ties keep build order", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		// ranks (index into STATUS_SET.statuses): todo=0, doing=1, done=2
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" }); // rank 2
		const real2 = realNode("real-2", { explicitStatusId: "todo" }); // rank 0, tied with api-2

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		// rank 0 tie (real-2 before api-2, build order), then rank 1 (api-1), then rank 2 (real-1).
		expect(rowOrder(container)).toEqual(["real-2", "api-2", "api-1", "real-1"]);
	});

	it("sortReverse inverts the combined order for both unit types together, without reordering within a tie", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status", sortReverse: true });
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "api-1", "real-2", "api-2"]);
	});

	it("re-rendering an unchanged tie never thrashes order (stable sort, deterministic across renders)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" }); // same rank as api-1

		const first = (async () => {
			const fake = makeFakeExplorer(sm);
			const container = document.createElement("div");
			await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);
			return rowOrder(container);
		})();
		const second = (async () => {
			const fake = makeFakeExplorer(sm);
			const container = document.createElement("div");
			await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);
			return rowOrder(container);
		})();

		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(["real-1", "api-1"]);
		expect(b).toEqual(["real-1", "api-1"]);
	});

	it("a folder with only API items (no real units) still sorts correctly via the shared pass", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status", sortReverse: true });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo"), "api-2": apiItem("api-2", "done") };
		folder.apiItemOrder = ["api-1", "api-2"];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["api-2", "api-1"]);
	});

	it("a folder with only real units (no apiOwner) renders exactly as before the fix — additive, not a rewrite", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder]); // no apiOwner

		expect(rowOrder(container)).toEqual(["real-2", "real-1"]);
		expect(fake.renderApiItemRow).not.toHaveBeenCalled();
	});

	it("a stale apiItemOrder id with no matching apiItemState entry is skipped, not a crash", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1", "ghost-id"]; // "ghost-id" has no matching state entry

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await expect(callRenderNodeList(fake, [], container, view, 1, [folder], folder)).resolves.toBeUndefined();

		expect(rowOrder(container)).toEqual(["api-1"]);
	});
});

// PR-2.F3 (G10) regression: a newly added-under row with a hidden status (hideCompleted) gets no
// element of its own regardless of where the sort pass places it — the sort pass reorders what's
// visible, it never rescues a row `hideCompleted`/`hideCancelled` already excluded (G10's "current
// sort or grouping" reason assumes exactly this). Runs the REAL `renderNode`, so the assertion is on
// the `data-select-key` attribute the hidden-row helper itself queries.
describe("PR-2.F3 (G10) regression — a hidden-status row yields no data-select-key element even when the sort pass runs", () => {
	it("a 'done' sibling under hideCompleted renders no element, whatever position sortMode would otherwise give it", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status", hideCompleted: true });
		const real1 = realNode("real-1", { ref: { kind: "file", path: "R1.md" }, explicitStatusId: "todo" });
		const real2 = realNode("real-2", { ref: { kind: "file", path: "R2.md" }, explicitStatusId: "done" }); // stands in for the newly added-under row

		const fake = makeFakeExplorer(sm, { resolveRef: basenameRowInfo });
		useRealRenderNode(fake);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(container.querySelector('[data-select-key="real-1"]')).not.toBeNull(); // positive control
		expect(container.querySelector('[data-select-key="real-2"]')).toBeNull();
		expect(container.querySelectorAll("[data-select-key]")).toHaveLength(1);
	});
});


// PR-1 (G6-G21): A-Z / Modified / Time added — read straight off the list's own direct governor
// (`ancestors[0]`), never inherited past it (unlike sortMode: "status" above).
describe("PR-1 — sort children: alphabetical / modified / time-added", () => {
	it("alphabetical sorts by the resolved display name, case-insensitively", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "A.md" ? "zebra" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);

		// "Apple" (b's resolved text) sorts before "zebra" (a's) regardless of original build order.
		expect(rowOrder(container)).toEqual(["b", "a"]);
	});

	it("alphabetical + Reverse flips the direction", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical", sortReverse: true });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "A.md" ? "Apple" : "Banana",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["b", "a"]);
	});

	it("modified sorts newest file-modified-time first, via the row's own modifiedTimeForRef", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "modified" });
		const older = realNode("older", { ref: { kind: "file", path: "Old.md" } });
		const newer = realNode("newer", { ref: { kind: "file", path: "New.md" } });

		const fake = makeFakeExplorer(sm, {
			modifiedTimeForRef: vi.fn((ref: { path: string }) => (ref.path === "Old.md" ? 100 : 200)),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [older, newer], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["newer", "older"]);
		// G9: "modified" never resolves display text — only mtime is needed.
		expect(fake.resolveRef).not.toHaveBeenCalled();
	});

	it("modified: a row with no time (e.g. a meta Folder, G9) sorts last, even under Reverse", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "modified", sortReverse: true });
		const timed = realNode("timed", { ref: { kind: "file", path: "T.md" } });
		const metaChild: ViewNode = { id: "meta-child", type: "meta", label: "Sub", children: [] };

		const fake = makeFakeExplorer(sm, { modifiedTimeForRef: vi.fn(() => 500) });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [metaChild, timed], container, view, 1, [folder]);

		// Even reversed, the no-time meta folder stays last, not first.
		expect(rowOrder(container)).toEqual(["timed", "meta-child"]);
	});

	it("time-added sorts newest placedAt first and never calls resolveRef or modifiedTimeForRef", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added" });
		const older = realNode("older", { placedAt: 100 });
		const newer = realNode("newer", { placedAt: 200 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [older, newer], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["newer", "older"]);
		expect(fake.resolveRef).not.toHaveBeenCalled();
		expect(fake.modifiedTimeForRef).not.toHaveBeenCalled();
	});

	it("time-added: a node with no placedAt (e.g. loaded from a pre-feature data.json, E8) sorts last under Reverse too", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added", sortReverse: true });
		const stamped = realNode("stamped", { placedAt: 500 });
		const unstamped = realNode("unstamped"); // no placedAt at all

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [stamped, unstamped], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["stamped", "unstamped"]);
	});

	it("ties keep their existing (manual) relative order and are not flipped by Reverse (stable sort)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added", sortReverse: true });
		const first = realNode("first", { placedAt: 100 });
		const second = realNode("second", { placedAt: 100 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [first, second], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["first", "second"]);
	});

	it("API rows sort alphabetically by label, and count as no time for modified/time-added (G18)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		folder.apiItemState = { "api-1": apiItem("api-1"), "api-2": apiItem("api-2") };
		folder.apiItemOrder = ["api-1", "api-2"];
		// Override the labels directly rather than relying on apiItem()'s id-as-label default.
		folder.apiItemState["api-1"].label = "Zeta";
		folder.apiItemState["api-2"].label = "Alpha";

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["api-2", "api-1"]);
	});

	it("never inherited past the direct parent (F6) — a sort mode set on a grandparent governor has no effect here", async () => {
		const sm = makeStatusesManager();
		// The immediate parent (ancestors[0]) sets nothing; a further ancestor sets alphabetical.
		const directParent = folderGovernor({ id: "direct", sortMode: undefined });
		const grandparent = folderGovernor({ id: "grand", sortMode: "alphabetical" });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "A.md" ? "zebra" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 2, [directParent, grandparent]);

		// Build order preserved, not alphabetical — the grandparent's setting never reaches here.
		expect(rowOrder(container)).toEqual(["a", "b"]);
	});

	it("sortMode manual is a no-op even with sortReverse left set from a prior mode", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual", sortReverse: true });
		const a = realNode("a", { placedAt: 100 });
		const b = realNode("b", { placedAt: 200 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["a", "b"]);
	});
});

// PR-1 (R1 fix) — E9: a renamed file re-sorts under A-Z after the rename. The render pass always
// re-resolves display text live (via resolveRef), so a rename's effect on A-Z order is already
// correct the very next time renderNodeList runs — no separate "re-sort on rename" logic exists.
describe("PR-1 E9 — a renamed file re-sorts under A-Z after the rename", () => {
	it("the same two nodes render in a different order once the renamed one's resolved name changes", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		const renamed = realNode("renamed", { ref: { kind: "file", path: "Renamed.md" } });
		const fixed = realNode("fixed", { ref: { kind: "file", path: "Fixed.md" } });

		// Before the rename: the renamed file's display name is "Zebra" — sorts after "Mango".
		const before = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "Renamed.md" ? "Zebra" : "Mango",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const beforeContainer = document.createElement("div");
		await callRenderNodeList(before, [renamed, fixed], beforeContainer, view, 1, [folder]);
		expect(rowOrder(beforeContainer)).toEqual(["fixed", "renamed"]);

		// After the rename (same node, same ref.path — only its resolved display text changed, the
		// way a real on-disk rename would change what resolveRef returns for it): "Apple" now sorts
		// before "Mango".
		const after = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "Renamed.md" ? "Apple" : "Mango",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const afterContainer = document.createElement("div");
		await callRenderNodeList(after, [renamed, fixed], afterContainer, view, 1, [folder]);
		expect(rowOrder(afterContainer)).toEqual(["renamed", "fixed"]);
	});
});

// PR-1 (R1 fix) — E12: missing (greyed) rows sort as "no time" under Modified/Time added, and by
// their last known name under A-Z. `resolveRef`'s own fallback (the missing ref's last-known name)
// is exactly the "name" sortKeyFor reads for A-Z — covered here at the render-pass level, not just
// via sort.ts's displayNameFor (sort.test.ts) or the comparator (explorer-view-sort.test.ts's own
// modified/time-added "no time" cases above).
describe("PR-1 E12 — missing rows sort by last-known name under A-Z, and as no-time under Modified/Time added", () => {
	it("A-Z: a missing row sorts by the name resolveRef falls back to, alongside present rows", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		const missing = realNode("missing", { ref: { kind: "file", path: "Gone.md" } });
		const present = realNode("present", { ref: { kind: "file", path: "Here.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) =>
				ref.path === "Gone.md"
					? { text: "Alpha (missing)", icon: "file", promoted: false, added: false, missing: true }
					: { text: "Zulu", icon: "file", promoted: false, added: false, missing: false }
			),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [present, missing], container, view, 1, [folder]);

		// "Alpha (missing)" sorts before "Zulu" — the missing row's last-known name, not its build order.
		expect(rowOrder(container)).toEqual(["missing", "present"]);
	});

	it("Modified: a missing row (no mtime) sorts last, even under Reverse — same as any other no-time row", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "modified", sortReverse: true });
		const missing = realNode("missing", { ref: { kind: "file", path: "Gone.md" } });
		const present = realNode("present", { ref: { kind: "file", path: "Here.md" } });

		const fake = makeFakeExplorer(sm, {
			modifiedTimeForRef: vi.fn((ref: { path: string }) => (ref.path === "Gone.md" ? null : 500)),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [missing, present], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["present", "missing"]);
	});

	it("Time added: a missing row (no placedAt) sorts last, even under Reverse — same as any other unstamped row", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added", sortReverse: true });
		const missing = realNode("missing", { ref: { kind: "file", path: "Gone.md" } }); // no placedAt
		const present = realNode("present", { ref: { kind: "file", path: "Here.md" }, placedAt: 500 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [missing, present], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["present", "missing"]);
	});
});

// PR-1 (R1 fix) — E11 (render-pass level; the model-level round trip is in sort-setting.test.ts):
// the Bucket root sorts per view, and switching views keeps each root's own setting. `View`
// extends `StatusGovernance`, so ancestors[0] being the view itself (the top-level render call's
// own `[view]` ancestors list) is exactly how a real top-level render reaches this.
describe("PR-1 E11 — the Bucket root sorts per view, independently of any other view", () => {
	it("the same two nodes render in a different order under two different views' own root sort settings", async () => {
		const sm = makeStatusesManager();
		const viewA: View = { ...view, id: "vA", sortMode: "alphabetical" };
		const viewB: View = { ...view, id: "vB", sortMode: "time-added" };
		const a = realNode("a", { ref: { kind: "file", path: "Z.md" }, placedAt: 200 }); // "zebra", newer
		const b = realNode("b", { ref: { kind: "file", path: "A.md" }, placedAt: 100 }); // "apple", older

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "Z.md" ? "zebra" : "apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});

		const containerA = document.createElement("div");
		await callRenderNodeList(fake, [a, b], containerA, viewA, 0, [viewA]);
		expect(rowOrder(containerA)).toEqual(["b", "a"]); // alphabetical: apple before zebra

		const containerB = document.createElement("div");
		await callRenderNodeList(fake, [a, b], containerB, viewB, 0, [viewB]);
		expect(rowOrder(containerB)).toEqual(["a", "b"]); // time-added, newest first: a (200) before b (100)
	});
});

// PR-1 (R1 fix) — E6: a sort changed while the folder is collapsed is saved, and applies on
// expand. `renderFoldableChildren` always renders (and therefore always sorts) its children
// regardless of `node.collapsed` — only the wrapper's CSS class hides them — so a sort set while
// collapsed is already correctly ordered underneath, ready to show the moment it's expanded.
describe("PR-1 E6 — a sort set while the folder is collapsed is applied, ready for when it expands", () => {
	it("a collapsed folder's children render already sorted inside its (CSS-)hidden wrapper", async () => {
		const sm = makeStatusesManager();
		const folder: ViewNode = { id: "folder", type: "meta", label: "Folder", children: [], sortMode: "alphabetical", collapsed: true };
		const zebra: ViewNode = { id: "zebra", type: "unit", ref: { kind: "file", path: "Z.md" }, children: [] };
		const apple: ViewNode = { id: "apple", type: "unit", ref: { kind: "file", path: "A.md" }, children: [] };
		folder.children = [zebra, apple];

		const base = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "Z.md" ? "Zebra" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const fake = base as unknown as Record<string, unknown>;
		fake.renderNodeList = proto.renderNodeList; // the real sort + render pass, not a stub

		const container = document.createElement("div");
		const chevron = document.createElement("div");
		const method = proto.renderFoldableChildren as unknown as (
			node: ViewNode,
			chevron: HTMLElement,
			container: HTMLElement,
			view: View,
			depth: number,
			ancestors: StatusGovernance[]
		) => Promise<void>;
		await method.call(fake, folder, chevron, container, view, 1, [folder]);

		const wrap = container.querySelector(".atlas-meta-children") as HTMLElement;
		expect(wrap.classList.contains("is-collapsed")).toBe(true); // still visually collapsed
		const inner = wrap.querySelector(".atlas-meta-children-inner") as HTMLElement;
		expect(rowOrder(inner)).toEqual(["apple", "zebra"]); // already sorted underneath
	});
});

// PR-2 (G9/E4): `resolvedMtimeForSort`'s cache/gate interaction, exercised through the real render
// path (`renderNodeList` → `sortKeyFor`) rather than the gate class in isolation — proves the
// caching wrapper itself (not just `SortRefreshGate`) behaves as documented.
describe("PR-2 G9/E4 — a Modified-sorted list only re-reads file mtimes when this render is allowed to", () => {
	it("serves the cached mtime and ignores a changed modifiedTimeForRef while sortRefreshAllowedForThisRender is false, then picks up the change once it's true again", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "modified" });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		let times: Record<string, number> = { "A.md": 100, "B.md": 200 };
		const modifiedTimeForRef = vi.fn((ref: { path: string }) => times[ref.path]);
		const fake = makeFakeExplorer(sm, { modifiedTimeForRef });
		const container = document.createElement("div");

		// First render: no cache entry yet, so it reads real mtimes regardless of the flag — B (200)
		// is newer than A (100), and Modified defaults to newest-first.
		fake.sortRefreshAllowedForThisRender = false;
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);
		expect(rowOrder(container)).toEqual(["b", "a"]);
		expect(modifiedTimeForRef).toHaveBeenCalledTimes(2);

		// E4: the underlying files changed (A is now the newer one), but no refresh trigger fired —
		// sortRefreshAllowedForThisRender stays false, so the stale cached mtimes are served and the
		// row order does not move, even though a plain re-render happened.
		times = { "A.md": 300, "B.md": 50 };
		modifiedTimeForRef.mockClear();
		container.empty();
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);
		expect(rowOrder(container)).toEqual(["b", "a"]); // unchanged — still serving the stale cache
		expect(modifiedTimeForRef).not.toHaveBeenCalled();

		// A refresh trigger fires (e.g. the pane regains focus) — this render is now allowed to
		// recompute, and the row order catches up to the real (changed) mtimes.
		fake.sortRefreshAllowedForThisRender = true;
		container.empty();
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);
		expect(rowOrder(container)).toEqual(["a", "b"]);
		expect(modifiedTimeForRef).toHaveBeenCalledTimes(2);
	});
});

// PR-2 (G19/E5): `activeSortFor` is the single source of truth both the render pass's own
// status-sort activation and the "Sort children…" menu's tick use — this table pins its exact
// absent/explicit-Manual/explicit-other/explicit-status resolution against an inherited governor.
describe("PR-2 G19/E5 — activeSortFor: absent vs. explicit Manual vs. explicit other vs. explicit Status, against an inherited status governor", () => {
	const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };

	it("absent own setting + a reaching status governor: resolves to status (inherited)", () => {
		expect(activeSortFor({}, governor)).toEqual({ mode: "status", reverse: false });
	});

	it("absent own setting + no governor at all: resolves to nothing (effectively Manual)", () => {
		expect(activeSortFor({}, null)).toBeNull();
	});

	it("explicit Manual overrides an inherited status sort — rows return to manual order", () => {
		expect(activeSortFor({ sortMode: "manual" }, governor)).toBeNull();
	});

	it("explicit A-Z overrides an inherited status sort — the governor is ignored, not blended", () => {
		expect(activeSortFor({ sortMode: "alphabetical", sortReverse: true }, governor)).toEqual({ mode: "alphabetical", reverse: true });
	});

	it("explicit Status on this row itself resolves the same way as an inherited one, direction included", () => {
		expect(activeSortFor({ sortMode: "status", sortReverse: true }, governor)).toEqual({ mode: "status", reverse: true });
	});

	it("PR-2 R6: explicit Status on this row with no governor reachable resolves to nothing (effectively Manual) — the render pass has no status set to rank by, so the indicator and menu must not claim a sort", () => {
		expect(activeSortFor({ sortMode: "status" }, null)).toBeNull();
	});
});

// PR-4 (T2/C31 fix) — G5: a sorted-insert drop's stored slot is exactly the raw drop index, not
// the item's comparator-correct slot; the render pass is what makes the *displayed* order follow
// the comparator regardless. Drives a real drop through `handleDrop`/`assessDrop` (same harness
// `explorer-view.test.ts`'s own G4/G5 tests use), then renders the real resulting children through
// the real (unstubbed) `renderNodeList` sort pass to prove the two orders can legitimately differ.
describe("PR-4 G5 — sorted-place landing: display always follows the sort, the stored order is the raw drop slot", () => {
	it("a sorted-insert drop lands at the dropped slot in storage, but renders in comparator order; switching to Manual afterward shows that stored (drop-slot) order", async () => {
		const annual: ViewNode = { id: "annual", type: "unit", ref: { kind: "file", path: "Annual.md" }, children: [] };
		const quarry: ViewNode = { id: "quarry", type: "unit", ref: { kind: "file", path: "Quarry.md" }, children: [] };
		const zebra: ViewNode = { id: "zebra", type: "unit", ref: { kind: "file", path: "Zebra.md" }, children: [] };
		const projects: ViewNode = { id: "projects", type: "meta", label: "Projects", children: [annual, quarry, zebra], sortMode: "alphabetical" };

		const vm = makeVm([projects]);
		const sm = makeStatusesManager();
		const fake = makeDropFake(vm, sm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "Oslo.md" }] };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "annual", viewId: "v1" }, true);

		// Drop "Oslo.md" on the TOP edge of "Annual.md" -- i.e. at raw index 0, deliberately NOT
		// its alpha-sorted slot (which would be between "Quarry.md" and "Zebra.md").
		dragOverAt(row, 5);
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		const folderNode = vm.getViews()[0].root[0];
		// Stored (manual) order: exactly the dropped slot, not the comparator's slot.
		expect(folderNode.children.map((n) => n.ref?.path)).toEqual(["Oslo.md", "Annual.md", "Quarry.md", "Zebra.md"]);

		// Rendered order still follows the folder's own A-Z comparator, regardless of where the
		// item actually sits in storage.
		const renderFake = makeFakeExplorer(sm, {
			renderNode: vi.fn(async (n: ViewNode, container: HTMLElement) => {
				container.createDiv({ cls: "marker-node", attr: { "data-id": n.ref?.path ?? n.id } });
			}),
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path.replace(".md", ""),
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const sortedContainer = document.createElement("div");
		await callRenderNodeList(renderFake, folderNode.children, sortedContainer, view, 1, [folderNode]);
		expect(rowOrder(sortedContainer)).toEqual(["Annual.md", "Oslo.md", "Quarry.md", "Zebra.md"]);

		// Switching the same folder to Manual: the render pass stops re-sorting, so the stored
		// drop-slot order is exactly what shows.
		folderNode.sortMode = "manual";
		const manualContainer = document.createElement("div");
		await callRenderNodeList(renderFake, folderNode.children, manualContainer, view, 1, [folderNode]);
		expect(rowOrder(manualContainer)).toEqual(["Oslo.md", "Annual.md", "Quarry.md", "Zebra.md"]);
	});
});

// PR-1 (R6): `placedAt` is read from a hand-editable data.json; a non-number must not poison the
// comparator (NaN comparisons give an unstable order).
describe("PR-1 R6 — a hand-edited non-number placedAt counts as 'no stamp' under Time added", () => {
	it("string, NaN and null stamps sort last in build order, after the validly stamped rows (newest first)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added" });
		const mk = (id: string, placedAt: unknown) => realNode(id, { ref: { kind: "file", path: `${id}.md` }, placedAt: placedAt as number });
		const rows = [mk("str", "2026-01-01"), mk("old", 100), mk("nan", Number.NaN), mk("new", 500), mk("nul", null), mk("inf", Number.POSITIVE_INFINITY)];

		const container = document.createElement("div");
		await callRenderNodeList(makeFakeExplorer(sm), rows, container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["new", "old", "str", "nan", "nul", "inf"]);
	});

	it("the same holds reversed: invalid stamps still sort last, not first", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added", sortReverse: true });
		const mk = (id: string, placedAt: unknown) => realNode(id, { ref: { kind: "file", path: `${id}.md` }, placedAt: placedAt as number });
		const rows = [mk("str", "oops"), mk("old", 100), mk("new", 500)];

		const container = document.createElement("div");
		await callRenderNodeList(makeFakeExplorer(sm), rows, container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["old", "new", "str"]);
	});
});

// PR-1 (R2): Outside-Vault Folder-source children are named relative to their source's root, which
// the vault can't look up. Modified stats them through the folder-source layer instead, so they sort
// normally (G18) rather than all counting as 'no time'. Real files in a real temp directory.
describe("PR-1 R2 — Modified sorts Outside-Vault Folder-source children by their real file mtime", () => {
	function makeOutsideRoot(files: Record<string, number>): string {
		const root = mkdtempSync(join(tmpdir(), "atlas-outside-mtime-"));
		for (const [name, seconds] of Object.entries(files)) {
			writeFileSync(join(root, name), name);
			utimesSync(join(root, name), seconds, seconds);
		}
		mkdirSync(join(root, "Sub"));
		return root;
	}
	const outsideChild = (id: string, ref: ViewNode["ref"]): ViewNode => realNode(id, { ref, folderSourceManaged: true, folderSourceOwnerId: "owner" });
	const outsideFake = (root: string, overrides = {}) =>
		makeFakeExplorer(makeStatusesManager(), {
			isOutsideManagedUnit: vi.fn(() => true),
			plugin: { statusesManager: makeStatusesManager(), settings: {}, viewsManager: { managedRowFilterState: vi.fn(() => "shown") }, folderSourcePathStore: { get: vi.fn(() => root) } } as never,
			...overrides,
		});

	it("sorts newest file first, with a folder child (no time) last — also reversed", async () => {
		const root = makeOutsideRoot({ "old.md": 1_000, "new.md": 3_000, "mid.md": 2_000 });
		try {
			const owner = folderGovernor({ id: "owner", sortMode: "modified" });
			const kids = [outsideChild("sub", { kind: "folder", path: "Sub" }), outsideChild("old", { kind: "file", path: "old.md" }), outsideChild("new", { kind: "file", path: "new.md" }), outsideChild("mid", { kind: "file", path: "mid.md" })];

			const container = document.createElement("div");
			await callRenderNodeList(outsideFake(root), kids, container, view, 1, [owner]);
			expect(rowOrder(container)).toEqual(["new", "mid", "old", "sub"]);

			const reversed = document.createElement("div");
			await callRenderNodeList(outsideFake(root), kids, reversed, view, 1, [{ ...owner, sortReverse: true }]);
			expect(rowOrder(reversed)).toEqual(["old", "mid", "new", "sub"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("an Outside child never reads the vault, and a vault file of the same relative name doesn't share its cached time", async () => {
		const root = makeOutsideRoot({ "note.md": 9_000 });
		try {
			const owner = folderGovernor({ id: "owner", sortMode: "modified" });
			const outside = outsideChild("outside", { kind: "file", path: "note.md" });
			const fake = outsideFake(root, { modifiedTimeForRef: vi.fn(() => 1) });
			// Same ref the vault would key as "file:note.md"; the vault copy is far older.
			const vaultTwin = realNode("vault", { ref: { kind: "file", path: "note.md" } });
			fake.isOutsideManagedUnit = vi.fn((_v: unknown, n: ViewNode) => n.id === "outside");

			const container = document.createElement("div");
			await callRenderNodeList(fake, [vaultTwin, outside], container, view, 1, [owner]);

			expect(rowOrder(container)).toEqual(["outside", "vault"]); // 9_000_000 ms vs the vault's 1 ms
			expect(fake.modifiedTimeForRef).toHaveBeenCalledTimes(1); // only the vault row went through the vault lookup
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("an Outside child whose file has vanished since the last scan counts as no time rather than throwing", async () => {
		const root = makeOutsideRoot({ "here.md": 5_000 });
		try {
			const owner = folderGovernor({ id: "owner", sortMode: "modified" });
			const kids = [outsideChild("gone", { kind: "file", path: "gone.md" }), outsideChild("here", { kind: "file", path: "here.md" })];
			const container = document.createElement("div");
			await callRenderNodeList(outsideFake(root), kids, container, view, 1, [owner]);
			expect(rowOrder(container)).toEqual(["here", "gone"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
