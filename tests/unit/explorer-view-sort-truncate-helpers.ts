/** G25: shared scaffolding for exercising `AtlasExplorerView`'s private `renderNodeList` (and,
 * directly, `renderApiItemRow`) without constructing a full Obsidian `ItemView` — same
 * `(AtlasExplorerView.prototype as ...).method.call(fake, ...)` pattern already used by
 * `create-module.test.ts`/`create-from-meta.test.ts`, just with a `fake` shaped for the
 * sort/truncate/merge pass specifically. Not itself a `*.test.ts` file, so vitest's
 * `tests/**\/*.test.ts` include glob skips it. */
import { vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { StatusesManager, StatusSet } from "../../src/statuses";
import { StatusGovernance, View, ViewNode } from "../../src/types";

export const STATUS_SET: StatusSet = {
	id: "S",
	name: "S",
	defaultStatusId: "todo",
	statuses: [
		{ id: "todo", label: "Todo", color: "#888888" },
		{ id: "doing", label: "Doing", color: "#0088ff" },
		{ id: "done", label: "Done", color: "#00cc00", isCompleted: true },
		{ id: "cancelled", label: "Cancelled", color: "#cc0000", isCancelled: true },
	],
};

export function makeStatusesManager(sets: StatusSet[] = [STATUS_SET]): StatusesManager {
	return new StatusesManager(JSON.parse(JSON.stringify(sets)) as StatusSet[], [], () => {});
}

export const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

export const realNode = (id: string, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", children: [], ...extra });

export const folderGovernor = (extra: Partial<ViewNode> = {}): ViewNode => ({
	id: "folder",
	type: "meta",
	label: "Folder",
	children: [],
	statusEnabled: true,
	statusSetId: "S",
	...extra,
});

type ProtoMethods = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as ProtoMethods;
/** Exposed so a test that needs to call a real (non-stubbed) private method directly — e.g. the
 * api-items regression test calling the real `renderApiItemRow`/`renderRowIcon` instead of the
 * order-recording stubs `makeFakeExplorer` installs by default — can do so via the same
 * `.call(fake, ...)` pattern without re-deriving the prototype cast itself. */
export { proto };

export interface FakeExplorer {
	plugin: { statusesManager: StatusesManager; settings: typeof DEFAULT_SETTINGS; viewsManager: { setApiItemStatus: ReturnType<typeof vi.fn>; managedRowFilterState: ReturnType<typeof vi.fn> } };
	filterText: string;
	expandedTruncationGroups: Set<string>;
	resolveRef: ReturnType<typeof vi.fn>;
	subtreeHasMatch: ReturnType<typeof vi.fn>;
	apiItemsMatchFilter: (...args: unknown[]) => unknown;
	matchesFilter: (...args: unknown[]) => unknown;
	pseudoNodeForApiItem: (...args: unknown[]) => unknown;
	renderRowIcon: (...args: unknown[]) => unknown;
	renderTruncationGroupHeader: ReturnType<typeof vi.fn>;
	renderNode: ReturnType<typeof vi.fn>;
	renderConnectionDots: (...args: unknown[]) => unknown;
	renderApiItemRow: ((...args: unknown[]) => unknown) | ReturnType<typeof vi.fn>;
	isOutsideManagedAndUnresolved: ReturnType<typeof vi.fn>;
	visibleFolderSourceRows: (...args: unknown[]) => unknown;
}

/** Builds a fake `this` for `renderNodeList`. `renderNode`/`renderApiItemRow` are stubbed with
 * markers that record id + render order, not full row content — content fidelity is instead
 * covered directly in `explorer-view-api-items.test.ts` by calling the real `renderApiItemRow`. */
export function makeFakeExplorer(sm: StatusesManager, overrides: Partial<FakeExplorer> = {}): FakeExplorer {
	const fake: FakeExplorer = {
		plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: { setApiItemStatus: vi.fn(), managedRowFilterState: vi.fn(() => "shown") } },
		filterText: "",
		expandedTruncationGroups: new Set<string>(),
		resolveRef: vi.fn(),
		subtreeHasMatch: vi.fn(async () => false),
		apiItemsMatchFilter: proto.apiItemsMatchFilter,
		matchesFilter: proto.matchesFilter,
		pseudoNodeForApiItem: proto.pseudoNodeForApiItem,
		renderRowIcon: proto.renderRowIcon,
		renderTruncationGroupHeader: vi.fn((container: HTMLElement, _view: View, key: string) => {
			container.createDiv({ cls: "marker-group", attr: { "data-key": key } });
		}),
		renderNode: vi.fn(async (node: ViewNode, container: HTMLElement) => {
			container.createDiv({ cls: "marker-node", attr: { "data-id": node.id } });
		}),
		renderConnectionDots: proto.renderConnectionDots,
		renderApiItemRow: vi.fn((item: { id: string }, container: HTMLElement) => {
			container.createDiv({ cls: "marker-api", attr: { "data-id": item.id } });
		}),
		isOutsideManagedAndUnresolved: vi.fn(() => false),
		visibleFolderSourceRows: proto.visibleFolderSourceRows,
		...overrides,
	};
	return fake;
}

export async function callRenderNodeList(
	fake: FakeExplorer,
	nodes: ViewNode[],
	container: HTMLElement,
	v: View,
	depth: number,
	ancestors: StatusGovernance[],
	apiOwner?: ViewNode
): Promise<void> {
	const method = proto.renderNodeList as unknown as (
		nodes: ViewNode[],
		container: HTMLElement,
		v: View,
		depth: number,
		ancestors: StatusGovernance[],
		apiOwner?: ViewNode
	) => Promise<void>;
	await method.call(fake, nodes, container, v, depth, ancestors, apiOwner);
}

/** Calls the real (unstubbed) `renderApiItemRow` directly — pass `{ renderApiItemRow: proto.renderApiItemRow, renderRowIcon: proto.renderRowIcon }`
 * via `makeFakeExplorer`'s overrides, or rely on its `renderRowIcon` default, which is already real. */
export function callRenderApiItemRow(
	fake: FakeExplorer,
	item: import("../../src/types").ApiItemState,
	container: HTMLElement,
	v: View,
	folderNode: ViewNode,
	depth: number,
	ancestors: StatusGovernance[]
): void {
	const method = proto.renderApiItemRow as unknown as (
		item: import("../../src/types").ApiItemState,
		container: HTMLElement,
		v: View,
		folderNode: ViewNode,
		depth: number,
		ancestors: StatusGovernance[]
	) => void;
	method.call(fake, item, container, v, folderNode, depth, ancestors);
}

/** Render order as a flat list of marker ids — `"group:<key>"` for a truncation-group header,
 * the node/item id itself for an individual row. */
export function rowOrder(container: HTMLElement): string[] {
	return Array.from(container.children).map((el) => {
		const e = el as HTMLElement;
		return e.dataset.key ? `group:${e.dataset.key}` : (e.dataset.id as string);
	});
}
