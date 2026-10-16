import { isMapError, mapResponseRows } from "./api-mapping";
import { runJsMapping } from "./api-js-mapping";
import { planApiRefresh } from "./api-refresh-plan";
import { MergeResult, applyMergeResult, splitFolderSourceDeleted } from "./api-merge";
import { httpGetJson, HTTP_TIMEOUT_MS, RequestFn, ScheduleTimeout } from "./api-http";
import { ApiCache, ApiHeader, ApiItemState, ApiSourceConfig, ViewNode } from "./types";

/** The outcome of a confirm-delete prompt (G6b(ii)): "confirmed"/"cancelled" are both an *answer* —
 * either button, deliberately clicked; "dismissed" is Escape or the view/modal closing with neither
 * button clicked (edge case: "dismissed ... counts as unanswered on an automatic refresh and as Cancel
 * on a manual one" — `ApiSourceController` applies that distinction, not the confirm function itself). */
export type ConfirmDeleteAnswer = "confirmed" | "cancelled" | "dismissed";

export interface RefreshDeps {
	/** R1: how to actually issue the request — production wiring supplies an adapter around
	 * Obsidian's `requestUrl` (see `api-request-obsidian.ts`); tests supply their own stub. Required,
	 * not defaulted to `fetch`, so nothing here can silently fall back to a CORS-subject request. */
	requestImpl: RequestFn;
	timeoutMs?: number;
	scheduleTimeout?: ScheduleTimeout;
	now?: () => number;
	/** G5/G6b: which of the three independent refresh controls triggered this call — "manual" (the
	 * "Refresh now" menu item) always asks again when confirmation is needed, ignoring any existing
	 * "awaiting confirmation" state; "automatic" (the view-load or every-X-minutes triggers) asks at
	 * most once per Folder and otherwise leaves it amber and unchanged. Defaults to "manual" so every
	 * existing (pre-PR-3) caller keeps behaving exactly as it always did. */
	trigger?: "manual" | "automatic";
	/** G6b(ii): asks the user to confirm deleting `count` rows. Required only when a refresh actually
	 * needs to ask (Overwrite, guard on, would delete rows) — a refresh that never needs confirmation
	 * never touches this. Absent where one is needed is treated the same as "dismissed" (the safe
	 * default: never delete without having actually asked). */
	confirmDelete?: (count: number) => Promise<ConfirmDeleteAnswer>;
}

export type DotState = "green" | "grey" | "red" | "amber";

/** G11: green = last refresh ok; grey = never refreshed; red = last refresh failed; amber (PR-3) =
 * an automatic refresh's delete confirmation went unanswered — takes priority over whatever the cache
 * itself says, since nothing from that refresh was actually applied. */
export function dotStateFor(cache: ApiCache | undefined, awaitingConfirmation?: boolean): DotState {
	if (awaitingConfirmation) return "amber";
	if (!cache || cache.fetchedAt === null) return "grey";
	return cache.ok ? "green" : "red";
}

function relativeTime(fromMs: number, nowMs: number): string {
	const diffMs = Math.max(0, nowMs - fromMs);
	const hours = Math.floor(diffMs / (1000 * 60 * 60));
	if (hours >= 1) return `${hours} h ago`;
	const minutes = Math.floor(diffMs / (1000 * 60));
	if (minutes >= 1) return `${minutes} m ago`;
	return "just now";
}

/** G11 tooltip: error + time of last success. E2/E4: also surfaces skipped/truncated counts. PR-3:
 * amber takes over the whole tooltip — the cache's own state is moot since nothing from the refresh
 * that triggered it was actually applied. */
export function dotTooltip(cache: ApiCache | undefined, nowMs: number, awaitingConfirmation?: boolean): string {
	if (awaitingConfirmation) return "Waiting for confirmation to delete rows";
	if (!cache || cache.fetchedAt === null) return "Never refreshed";
	const parts: string[] = [];
	if (cache.ok) {
		parts.push(`Last refresh ok, ${relativeTime(cache.fetchedAt, nowMs)}`);
	} else {
		const lastSuccess =
			cache.lastSuccessAt !== undefined
				? `last updated ${relativeTime(cache.lastSuccessAt, nowMs)}`
				: "never refreshed successfully";
		parts.push(`${cache.error ?? "unreachable"}, ${lastSuccess}`);
	}
	if (cache.skippedCount > 0) parts.push(`${cache.skippedCount} item(s) skipped (missing/duplicate id)`);
	if (cache.truncated) parts.push("Response truncated at 5,000 rows");
	return parts.join(" — ");
}

function emptyCache(prev: ApiCache | undefined, fetchedAt: number, error: string): ApiCache {
	return {
		fetchedAt,
		ok: false,
		error,
		rows: prev?.rows ?? [],
		skippedCount: prev?.skippedCount ?? 0,
		truncated: prev?.truncated ?? false,
		// R3: a failed attempt's own time must never overwrite the time of the *last success* — that's
		// what the dot's tooltip ("unreachable, last updated 3 h ago") actually reports.
		lastSuccessAt: prev?.lastSuccessAt,
	};
}

/** PR-6 (R7 fix): writes a `planApiRefresh` result back onto `node`, with any Folder-source-deleted
 * placeholders (set aside by `splitFolderSourceDeleted` before the plan was computed, via
 * `applyMergeResult`) folded back in exactly as they were — never reconciled, reordered or dropped
 * by the API refresh that just ran. */
function applyApiMergeResult(node: ViewNode, result: MergeResult, deletedState: Record<string, ApiItemState>, deletedOrder: string[]): void {
	const merged = applyMergeResult(result, deletedState, deletedOrder);
	node.apiItemState = merged.itemState;
	node.apiItemOrder = merged.order;
}

/**
 * PR-2: owns the "one request per Folder at a time" guard (E9: a refresh while one's already in
 * flight for the same node collapses into the same promise, rather than firing a second request)
 * and the actual fetch → map → merge → persist pipeline. A fresh instance has no memory of anything
 * in flight, so tests don't leak state between cases the way a module-level singleton would.
 */
export class ApiSourceController {
	private inFlight = new Map<string, { promise: Promise<void>; sourceKey: string }>();

	/**
	 * R15: the in-flight guard used to be keyed only by node.id, so a save that changed the URL/
	 * mapping/headers while a refresh for the *old* config was still in flight would collapse into
	 * that stale request — the new config was never fetched. Now the guard also tracks which config
	 * a request was built from: a matching config still collapses into the same request, but a
	 * changed one queues exactly one follow-up refresh (with the new config) to run once the in-flight
	 * one finishes, instead of firing concurrently or being dropped.
	 */
	refresh(node: ViewNode, source: ApiSourceConfig, headers: ApiHeader[], persist: () => void, deps: RefreshDeps): Promise<void> {
		const sourceKey = ApiSourceController.sourceKeyFor(source, headers);
		const existing = this.inFlight.get(node.id);
		if (existing) {
			if (existing.sourceKey === sourceKey) return existing.promise;
			const queued = existing.promise.then(() => this.runRefresh(node, source, headers, persist, deps, sourceKey));
			this.inFlight.set(node.id, { promise: queued, sourceKey });
			return queued;
		}
		return this.runRefresh(node, source, headers, persist, deps, sourceKey);
	}

	private runRefresh(node: ViewNode, source: ApiSourceConfig, headers: ApiHeader[], persist: () => void, deps: RefreshDeps, sourceKey: string): Promise<void> {
		const run = this.doRefresh(node, source, headers, persist, deps);
		this.inFlight.set(node.id, { promise: run, sourceKey });
		void run.finally(() => {
			if (this.inFlight.get(node.id)?.promise === run) this.inFlight.delete(node.id);
		});
		return run;
	}

	private static sourceKeyFor(source: ApiSourceConfig, headers: ApiHeader[]): string {
		return JSON.stringify({ source, headers });
	}

	private async doRefresh(node: ViewNode, source: ApiSourceConfig, headers: ApiHeader[], persist: () => void, deps: RefreshDeps): Promise<void> {
		const now = deps.now ?? (() => Date.now());
		const trigger = deps.trigger ?? "manual";
		// R5/R8: `node` is a live reference into the view tree, so another call (Remove data source, a
		// later save, Delete folder) can mutate `node.apiSource` out from under this refresh while it's
		// awaiting the fetch or a confirm-delete answer. Re-checked after every await below — a refresh
		// that started against a source no longer in place must never write its cache/rows/itemState
		// back onto the node, or "Remove data source" (G4: rows survive as static, source+cache dropped)
		// could be silently undone by a refresh that was already in flight when it ran.
		//
		// R8: a *different reference* is not necessarily a *changed* source. Saving the Data source
		// modal without changing anything still calls `setApiSource` with a brand-new object
		// (src/views.ts), so `node.apiSource` becomes a different reference even though nothing
		// changed. `ApiSourceController.refresh` already merges that unchanged-config Save into this
		// same in-flight promise (matching `sourceKey`, which also covers headers, for the purpose of
		// deduping requests) rather than starting a second request — so if this bail were purely
		// identity-based, the one run everybody is waiting on would quietly no-op, dropping the fetch
		// result or a just-confirmed delete with nothing to replace it. Only fall back to a content
		// comparison (never involving headers — `node.apiSource` doesn't hold them) once the reference
		// has actually moved; one side becoming/staying `undefined` while the other isn't is always a
		// real change (the source was added or removed).
		const startingApiSource = node.apiSource;
		const sourceChanged = (): boolean => {
			if (node.apiSource === startingApiSource) return false;
			if (node.apiSource === undefined || startingApiSource === undefined) return true;
			return JSON.stringify(node.apiSource) !== JSON.stringify(startingApiSource);
		};
		try {
			const headerRecord: Record<string, string> = {};
			for (const header of headers) if (header.key) headerRecord[header.key] = header.value;

			const result = await httpGetJson(source.url, headerRecord, {
				requestImpl: deps.requestImpl,
				timeoutMs: deps.timeoutMs ?? HTTP_TIMEOUT_MS,
				scheduleTimeout: deps.scheduleTimeout,
			});

			if (sourceChanged()) return;

			if (!result.ok) {
				node.apiCache = emptyCache(node.apiCache, now(), result.error.message);
				persist();
				return;
			}

			// PR-4/G3: JS mode replaces the mapping step only — everything above (fetch) and below
			// (plan/merge/persist) is identical for both modes. `runJsMapping` awaits a Promise-
			// returning function, a genuine async gap unlike `mapResponseRows`'s synchronous mapping, so
			// `sourceChanged()` is re-checked once more right after it, same as after the fetch.
			const mapped = source.mappingMode === "js" ? await runJsMapping(source.jsSource ?? "", result.json) : mapResponseRows(result.json, source.mapping);

			if (sourceChanged()) return;

			if (isMapError(mapped)) {
				node.apiCache = emptyCache(node.apiCache, now(), mapped.error);
				persist();
				return;
			}

			const fetchedAt = now();
			// PR-6 (R7 fix): a Folder-source-deleted placeholder on this same node is set aside before
			// the plan is computed and folded back in untouched below, whatever this refresh's mode is.
			const { apiState, apiOrder, deletedState, deletedOrder } = splitFolderSourceDeleted(node.apiItemState, node.apiItemOrder);
			const plan = planApiRefresh({
				prevState: apiState,
				prevOrder: apiOrder,
				rows: mapped.rows,
				mode: source.mode,
				truncated: mapped.truncated,
				nowIso: new Date(fetchedAt).toISOString(),
				// G6b: absent/`undefined` means the guard is on — only an explicit `false` turns it off.
				keepOnEmpty: source.keepOnEmpty ?? true,
				confirmBeforeDelete: source.confirmBeforeDelete ?? true,
			});

			const applyCacheSuccess = () => {
				node.apiCache = {
					fetchedAt,
					ok: true,
					error: null,
					rows: mapped.rows,
					skippedCount: mapped.skippedCount,
					truncated: mapped.truncated,
					lastSuccessAt: fetchedAt,
				};
			};

			if (!plan.needsConfirmation) {
				applyApiMergeResult(node, plan.result, deletedState, deletedOrder);
				node.apiAwaitingConfirmation = false;
				applyCacheSuccess();
				persist();
				return;
			}

			// G6b(ii): this refresh would delete `plan.deletedCount` row(s) and the guard is on.
			if (trigger === "automatic" && node.apiAwaitingConfirmation) {
				// Already asked once for this Folder and got no answer — G6b: ask at most once per
				// Folder until answered or dismissed. Leave everything exactly as it is; only a manual
				// "Refresh now" (which always asks again) or an actual answer changes this.
				return;
			}

			const answer: ConfirmDeleteAnswer = deps.confirmDelete ? await deps.confirmDelete(plan.deletedCount) : "dismissed";

			if (sourceChanged()) return;

			if (answer === "confirmed") {
				applyApiMergeResult(node, plan.result, deletedState, deletedOrder);
				node.apiAwaitingConfirmation = false;
				applyCacheSuccess();
				persist();
				return;
			}

			if (answer === "cancelled" || trigger === "manual") {
				// Explicit Cancel, or a manual refresh's dismiss (edge case: counts as Cancel on manual)
				// — keep every row and all itemState exactly as it was; the fetch itself still succeeded.
				node.apiAwaitingConfirmation = false;
				applyCacheSuccess();
				persist();
				return;
			}

			// Dismissed on an automatic trigger: unanswered — keep rows untouched, go amber, and leave
			// the cache alone (nothing from this refresh was actually applied).
			node.apiAwaitingConfirmation = true;
			persist();
		} catch (err) {
			// R17/E9: `ViewsManager` sanitizes `apiSource`/`apiItemOrder`/`apiItemState` on load, but this
			// is the last line of defense against any other corrupt/unexpected shape reaching this
			// pipeline — without it, a thrown error here (rather than a rejected `RequestResult`) would
			// reject this whole promise. That would leave the dot in its stale previous state (never
			// red, per the caller's `void` refresh call turning it into an unhandled rejection instead of
			// a shown error), and — since `refresh()`'s R15 follow-up chains onto this promise with
			// `.then` — would silently drop any queued follow-up refresh for a newer config too.
			node.apiCache = emptyCache(node.apiCache, now(), err instanceof Error ? err.message : "Unexpected error");
			persist();
		}
	}
}

/**
 * G5a: "Refresh when Atlas view loads" fires on opening or returning to an Atlas view — not on
 * every re-render the view does for unrelated reasons (a status change, a drag, a filter keystroke),
 * and not a second time while the view stays continuously active. One instance per open explorer
 * leaf; `activate()`/`deactivate()` bracket a real "the leaf became active" / "the leaf stopped being
 * active" transition (wired to `workspace.on("active-leaf-change")` by the caller).
 */
export class ViewLoadTrigger {
	private active = false;

	/** Returns true only on the transition into active — the caller should refresh then, and only then. */
	activate(): boolean {
		if (this.active) return false;
		this.active = true;
		return true;
	}

	deactivate(): void {
		this.active = false;
	}
}
