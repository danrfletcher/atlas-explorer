import { TFile, Vault } from "obsidian";
import { isMapError, mapResponseRows } from "./api-mapping";
import { runJsMapping } from "./api-js-mapping";
import { planApiRefresh } from "./api-refresh-plan";
import { detectMarkdownTables, selectMarkdownTable } from "./markdown-table-mapping";
import { ConfirmDeleteAnswer } from "./api-source-controller";
import { ApiCache, MarkdownTableSourceConfig, ViewNode } from "./types";

export interface MarkdownTableRefreshDeps {
	vault: Vault;
	now?: () => number;
	/** Same manual/automatic distinction `ApiSourceController`/`CsvSourceController` use — a file-save
	 * and the view-load/every-N-minutes triggers are "automatic"; the "Refresh now" menu item is
	 * "manual". */
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

/** PR-1 R4 fix: same comparison `CsvSourceController` uses — everything a refresh can write that
 * matters for "did anything actually change". `fetchedAt`/`lastSuccessAt` are deliberately excluded,
 * since they stamp every refresh (including a no-op one) by design. Per-row `lastSeenAt` is the same
 * kind of bookkeeping stamp (`mergeApiItems` touches it on every present row, every refresh — R13),
 * so it's stripped from each entry before comparing too. `notFound` is normalized to a real boolean:
 * `mergeApiItems` leaves it absent on a row's first-ever appearance but writes an explicit `false`
 * once the row has a `prev` to spread — same meaning, different JSON shape, which would otherwise
 * read as a change on every second refresh. */
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
 * PR-8 (G17-G20/G22-G24): the Markdown Table equivalent of `CsvSourceController` — same in-flight
 * dedup, `sourceChanged()` race-guard, and read→parse→map→plan→confirm→apply→persist shape, with
 * `detectMarkdownTables`/`selectMarkdownTable` standing in for `parseCsv`. Deliberately a separate
 * class rather than a shared base, for the same reason `CsvSourceController`'s own doc comment
 * gives: the two pipelines differ only in how they get rows, and sharing a base class for that
 * little logic would cost more clarity than it saves.
 */
export class MarkdownTableSourceController {
	private inFlight = new Map<string, { promise: Promise<void>; sourceKey: string }>();

	refresh(node: ViewNode, source: MarkdownTableSourceConfig, persist: (changed: boolean) => void, deps: MarkdownTableRefreshDeps): Promise<void> {
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

	private runRefresh(
		node: ViewNode,
		source: MarkdownTableSourceConfig,
		persist: (changed: boolean) => void,
		deps: MarkdownTableRefreshDeps,
		sourceKey: string
	): Promise<void> {
		const run = this.doRefresh(node, source, persist, deps);
		this.inFlight.set(node.id, { promise: run, sourceKey });
		void run.finally(() => {
			if (this.inFlight.get(node.id)?.promise === run) this.inFlight.delete(node.id);
		});
		return run;
	}

	private async doRefresh(node: ViewNode, source: MarkdownTableSourceConfig, persist: (changed: boolean) => void, deps: MarkdownTableRefreshDeps): Promise<void> {
		const now = deps.now ?? (() => Date.now());
		const trigger = deps.trigger ?? "manual";
		// Same race-guard `CsvSourceController.doRefresh` uses: re-checked after every await so a
		// refresh that started against a source no longer in place never writes its cache/rows/
		// itemState back onto the node.
		const startingSource = node.markdownTableSource;
		const sourceChanged = (): boolean => {
			if (node.markdownTableSource === startingSource) return false;
			if (node.markdownTableSource === undefined || startingSource === undefined) return true;
			return JSON.stringify(node.markdownTableSource) !== JSON.stringify(startingSource);
		};
		// PR-1 R4 fix: same reasoning as `CsvSourceController.doRefresh` — this now runs on every view
		// load/switch with no toggle, so persisting unconditionally would churn data.json even when the
		// file hadn't changed.
		const before = cacheSnapshot(node);
		const persistIfChanged = () => persist(cacheSnapshot(node) !== before);

		try {
			const file = deps.vault.getAbstractFileByPath(source.path);
			if (!(file instanceof TFile)) {
				// G23/E4: the source file is missing — reported the same way a dead API URL/missing CSV
				// file would be.
				node.apiCache = emptyCache(node.apiCache, now(), `File not found: ${source.path}`);
				persistIfChanged();
				return;
			}

			const text = await deps.vault.cachedRead(file);

			if (sourceChanged()) return;

			// G24/F9: `selectMarkdownTable` is a bare index lookup — no re-validation against whatever
			// table used to be at `source.tableIndex`, by design.
			const tables = detectMarkdownTables(text);
			const table = selectMarkdownTable(tables, source.tableIndex);

			const mapped =
				source.mappingMode === "js" ? await runJsMapping(source.jsSource ?? "", table.rows) : mapResponseRows(table.rows, source.mapping);

			if (sourceChanged()) return;

			if (isMapError(mapped)) {
				node.apiCache = emptyCache(node.apiCache, now(), mapped.error);
				persistIfChanged();
				return;
			}

			// G22: a row skipped by the parser itself (ragged/missing cells) is combined with any
			// mapping-level skip into one total, same as CSV's own `skippedCount` sum.
			const skippedCount = table.skippedCount + mapped.skippedCount;

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
