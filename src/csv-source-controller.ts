import { TFile, Vault } from "obsidian";
import { isMapError, mapResponseRows } from "./api-mapping";
import { runJsMapping } from "./api-js-mapping";
import { planApiRefresh } from "./api-refresh-plan";
import { parseCsv } from "./csv-parsing";
import { ConfirmDeleteAnswer } from "./api-source-controller";
import { ApiCache, CsvSourceConfig, ViewNode } from "./types";

export interface CsvRefreshDeps {
	vault: Vault;
	now?: () => number;
	/** Same manual/automatic distinction `ApiSourceController` uses (G5/G6b) — a file-save (G21) and
	 * the view-load/every-N-minutes triggers are "automatic"; the "Refresh now" menu item is "manual". */
	trigger?: "manual" | "automatic";
	confirmDelete?: (count: number) => Promise<ConfirmDeleteAnswer>;
}

function emptyCache(prev: ApiCache | undefined, fetchedAt: number, error: string): ApiCache {
	return {
		fetchedAt,
		ok: false,
		error,
		rows: prev?.rows ?? [],
		skippedCount: prev?.skippedCount ?? 0,
		truncated: prev?.truncated ?? false,
		lastSuccessAt: prev?.lastSuccessAt,
	};
}

/** PR-1 R4 fix: everything a refresh can write that matters for "did anything actually change" —
 * `fetchedAt`/`lastSuccessAt` are deliberately excluded, since they stamp every refresh (including
 * a no-op one) by design and would make every refresh look "changed". Per-row `lastSeenAt` is the
 * same kind of bookkeeping stamp (`mergeApiItems` touches it on every present row, every refresh —
 * R13), so it's stripped from each entry before comparing too. `notFound` is normalized to a real
 * boolean: `mergeApiItems` leaves it absent on a row's first-ever appearance but writes an explicit
 * `false` once the row has a `prev` to spread (R13's `{ ...prev, notFound: false, ... }`) — same
 * meaning, different JSON shape, which would otherwise read as a change on every second refresh. */
function cacheSnapshot(node: ViewNode): string {
	const itemState = node.apiItemState;
	const comparableItemState = itemState
		? Object.fromEntries(
				Object.entries(itemState).map(([id, item]) => [id, { ...item, lastSeenAt: undefined, notFound: item.notFound ?? false }])
			)
		: itemState;
	return JSON.stringify([
		node.apiCache?.ok,
		node.apiCache?.error,
		node.apiCache?.rows,
		node.apiCache?.skippedCount,
		node.apiCache?.truncated,
		comparableItemState,
		node.apiItemOrder,
		node.apiAwaitingConfirmation,
	]);
}

/**
 * PR-7 (G17-G19/G21-G23): the CSV equivalent of `ApiSourceController` — same in-flight dedup,
 * `sourceChanged()` race-guard, and fetch→map→plan→confirm→apply→persist shape, with a vault file
 * read standing in for the HTTP fetch and `parseCsv` standing in for "the response is already JSON".
 * Deliberately a separate class rather than a shared base: the two pipelines differ only in how they
 * get bytes (network vs. vault) and in the parse-level `skippedCount` CSV adds on top of the mapping
 * layer's own — sharing a base class for that little logic would cost more clarity than it saves.
 */
export class CsvSourceController {
	private inFlight = new Map<string, { promise: Promise<void>; sourceKey: string }>();

	refresh(node: ViewNode, source: CsvSourceConfig, persist: (changed: boolean) => void, deps: CsvRefreshDeps): Promise<void> {
		const sourceKey = JSON.stringify(source);
		const existing = this.inFlight.get(node.id);
		if (existing) {
			if (existing.sourceKey === sourceKey) return existing.promise;
			const queued = existing.promise.then(() => this.runRefresh(node, source, persist, deps, sourceKey));
			this.inFlight.set(node.id, { promise: queued, sourceKey });
			return queued;
		}
		return this.runRefresh(node, source, persist, deps, sourceKey);
	}

	private runRefresh(node: ViewNode, source: CsvSourceConfig, persist: (changed: boolean) => void, deps: CsvRefreshDeps, sourceKey: string): Promise<void> {
		const run = this.doRefresh(node, source, persist, deps);
		this.inFlight.set(node.id, { promise: run, sourceKey });
		void run.finally(() => {
			if (this.inFlight.get(node.id)?.promise === run) this.inFlight.delete(node.id);
		});
		return run;
	}

	private async doRefresh(node: ViewNode, source: CsvSourceConfig, persist: (changed: boolean) => void, deps: CsvRefreshDeps): Promise<void> {
		const now = deps.now ?? (() => Date.now());
		const trigger = deps.trigger ?? "manual";
		// Same race-guard `ApiSourceController.doRefresh` uses: re-checked after every await so a
		// refresh that started against a source no longer in place (Remove data source, a later save,
		// Delete folder) never writes its cache/rows/itemState back onto the node.
		const startingCsvSource = node.csvSource;
		const sourceChanged = (): boolean => {
			if (node.csvSource === startingCsvSource) return false;
			if (node.csvSource === undefined || startingCsvSource === undefined) return true;
			return JSON.stringify(node.csvSource) !== JSON.stringify(startingCsvSource);
		};
		// PR-1 R4 fix: this now runs on every view load/switch with no toggle (PR-1 removed CSV's
		// refresh-every setting), so persisting unconditionally would write data.json on every one of
		// those even when the file hadn't changed — against F2's "a refresh that finds no change
		// writes nothing". `persistIfChanged` reports whether anything comparable actually moved so the
		// caller can still re-render (the dot's "just now" is real) without saving a no-op.
		const before = cacheSnapshot(node);
		const persistIfChanged = () => persist(cacheSnapshot(node) !== before);

		try {
			const file = deps.vault.getAbstractFileByPath(source.path);
			if (!(file instanceof TFile)) {
				// G23/E4: the source file is missing — reported the same way a dead API URL would be.
				node.apiCache = emptyCache(node.apiCache, now(), `File not found: ${source.path}`);
				persistIfChanged();
				return;
			}

			const text = await deps.vault.cachedRead(file);

			if (sourceChanged()) return;

			const parsed = parseCsv(text);
			if (!parsed.ok) {
				node.apiCache = emptyCache(node.apiCache, now(), parsed.error);
				persistIfChanged();
				return;
			}

			// PR-4/G3: same drag-vs-JS split `ApiSourceController` uses — JS mode replaces only the
			// mapping step with `runJsMapping`, treating the CSV's already-flat row array exactly like a
			// top-level-array API response (no `arrayField` involved either way).
			const mapped =
				source.mappingMode === "js" ? await runJsMapping(source.jsSource ?? "", parsed.rows) : mapResponseRows(parsed.rows, source.mapping);

			if (sourceChanged()) return;

			if (isMapError(mapped)) {
				node.apiCache = emptyCache(node.apiCache, now(), mapped.error);
				persistIfChanged();
				return;
			}

			// G22: a row skipped by the parser itself (an unterminated quote cutting the file short) is
			// combined with any mapping-level skip (missing/duplicate id) into one total, same as the dot
			// tooltip already reports for API sources.
			const skippedCount = parsed.skippedCount + mapped.skippedCount;

			const fetchedAt = now();
			const plan = planApiRefresh({
				prevState: node.apiItemState ?? {},
				prevOrder: node.apiItemOrder ?? [],
				rows: mapped.rows,
				mode: source.mode,
				truncated: mapped.truncated,
				nowIso: new Date(fetchedAt).toISOString(),
				keepOnEmpty: source.keepOnEmpty ?? true,
				confirmBeforeDelete: source.confirmBeforeDelete ?? true,
			});

			const applyCacheSuccess = () => {
				node.apiCache = {
					fetchedAt,
					ok: true,
					error: null,
					rows: mapped.rows,
					skippedCount,
					truncated: mapped.truncated,
					lastSuccessAt: fetchedAt,
				};
			};

			if (!plan.needsConfirmation) {
				node.apiItemState = plan.result.itemState;
				node.apiItemOrder = plan.result.order;
				node.apiAwaitingConfirmation = false;
				applyCacheSuccess();
				persistIfChanged();
				return;
			}

			if (trigger === "automatic" && node.apiAwaitingConfirmation) {
				return;
			}

			const answer: ConfirmDeleteAnswer = deps.confirmDelete ? await deps.confirmDelete(plan.deletedCount) : "dismissed";

			if (sourceChanged()) return;

			if (answer === "confirmed") {
				node.apiItemState = plan.result.itemState;
				node.apiItemOrder = plan.result.order;
				node.apiAwaitingConfirmation = false;
				applyCacheSuccess();
				persistIfChanged();
				return;
			}

			if (answer === "cancelled" || trigger === "manual") {
				node.apiAwaitingConfirmation = false;
				applyCacheSuccess();
				persistIfChanged();
				return;
			}

			node.apiAwaitingConfirmation = true;
			persistIfChanged();
		} catch (err) {
			node.apiCache = emptyCache(node.apiCache, now(), err instanceof Error ? err.message : "Unexpected error");
			persistIfChanged();
		}
	}
}
