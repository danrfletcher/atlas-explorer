/** PR-3: the pure geometry behind "drag to reorder" — turns a pointer's vertical offset inside a
 * row, plus that row's own height, into one of three drop zones. Kept free of the DOM/Obsidian so
 * the 25/50/25 split (and the one exception to it, G1/Q7) is unit-testable with plain numbers; the
 * caller (`AtlasExplorerView.wireRowDrop`, `explorer-view.ts`) is the only thing that ever reads a
 * real `getBoundingClientRect()`/`clientY`. */
import { EffectiveSort } from "./sort";

export type DropZone = "before" | "nest" | "after";

/** G1/G2/G20/Q7: resolves a pointer's offset within a row (0 at the top, `rowHeight` at the
 * bottom) into a zone:
 * - below 25% of the row's height -> `"before"` (insert as a sibling above the row)
 * - 25% to 75% (inclusive both ends) -> `"nest"` (append as the row's last child)
 * - above 75% -> `"after"` (insert as a sibling below the row) — but only when `hasBottomZone` is
 *   true. An expanded row that's already showing its own real children immediately underneath it
 *   (Q7) has no visual gap there for an "insert after" line to sit against, so its lower quarter
 *   folds into the nest zone instead (nesting then covers 75% of that row) — the next row's own
 *   top edge is where "insert after this expanded row" lives instead. A collapsed row, and a
 *   childless row (nothing rendered below it either way), both keep the plain 25/50/25 split.
 *
 * Deterministic at the 25%/75% boundaries themselves, and for a degenerate (zero- or
 * near-zero-height) row: every comparison is a plain `<`/`>` against a fixed fraction of
 * `rowHeight`, so the same `(offsetY, rowHeight)` pair always resolves to the same zone, with no
 * floating-point-order or event-timing dependence. */
export function resolveDropZone(offsetY: number, rowHeight: number, hasBottomZone: boolean): DropZone {
	const topEdge = rowHeight * 0.25;
	const bottomEdge = rowHeight * 0.75;
	if (offsetY < topEdge) return "before";
	if (hasBottomZone && offsetY > bottomEdge) return "after";
	return "nest";
}

/** PR-4 (G4/G5/G22): what an edge/nest drop over a row actually does, once the row's own target
 * list's effective sort is known —
 * - `"nest"`: the zone itself is `"nest"` — unaffected by sort, same as before this PR.
 * - `"reorder"`: the target list is effectively Manual (`effectiveSort` is `null`) — a plain
 *   edge-drop sibling-insert, same as PR-3.
 * - `"refuse"`: the target list *is* sorted, and the drag is a row already a child of that same
 *   list — reordering it by dropping on an edge would only be undone by the next render's sort
 *   pass, so it's refused outright (the caller shows a Notice pointing at Manual instead).
 * - `"sorted-insert"`: the target list is sorted, but the drag is from anywhere else (a different
 *   parent, the inbox, or a batch with no row already in this list) — still allowed; it lands at
 *   the dropped slot same as a Manual list's edge drop, the render pass's own sort pass then
 *   decides *display* order on top.
 *
 * `sourceParentId`/`targetParentId` identify a bucket parent by node id, or `null` for the bucket
 * root. `sourceParentId` is `undefined` for a drag that isn't a row already sitting in *some*
 * bucket parent (an Inbox ref, or one representative id chosen by the caller for a mixed-parent
 * batch) — it then never equals any `targetParentId`, including the root's own `null`, so it
 * always counts as "from elsewhere". */
export type DropDecision = "nest" | "reorder" | "refuse" | "sorted-insert";

export function resolveDropDecision(
	zone: DropZone,
	sourceParentId: string | null | undefined,
	targetParentId: string | null,
	effectiveSort: EffectiveSort | null
): DropDecision {
	if (zone === "nest") return "nest";
	if (!effectiveSort) return "reorder";
	return sourceParentId === targetParentId ? "refuse" : "sorted-insert";
}
