import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { SwapCandidate } from "../../src/swap";
import { ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import { Setup, clone, file, folder, meta, setup } from "./create-from-meta-fixtures";

// PR-2 GP5: a sourced Atlas folder swapped to a unit and back keeps its data source, its rows and their
// order, and its id, and the explorer's refresh walk still finds it. No device-local source state is touched.
const captured = vi.hoisted(() => ({ prompts: [] as { title: string; initial: string; onSubmit: (v: string) => void }[] }));

vi.mock("../../src/modals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modals")>();
	class RecordingPrompt {
		constructor(_app: unknown, public title: string, public initial: string, public onSubmit: (v: string) => void) {
			captured.prompts.push(this);
		}
		open(): void {}
	}
	return { ...actual, TextPromptModal: RecordingPrompt };
});

type Fake = Record<string, any>;
const explorerProto = AtlasExplorerView.prototype as unknown as Record<string, (this: Fake, ...args: unknown[]) => any>;

/** The loader keeps a source only with an id and label mapping, so the fixture matches that shape. */
const apiSource = (url: string): ViewNode["apiSource"] => ({
	type: "api",
	url,
	method: "GET",
	mapping: { idField: "id", labelField: "name" },
	mode: "append",
	refreshOnViewLoad: false,
});

const SOURCE_URL = "https://example.test/issues";

function sourcedFolder(): ViewNode {
	return meta("linear", "Linear issues", [], {
		statusEnabled: true,
		statusSetId: "set1",
		explicitStatusId: "s-doing",
		apiSource: apiSource(SOURCE_URL),
		apiCache: { lastRefreshedAt: "2026-10-05T00:00:00.000Z", status: "ok" } as ViewNode["apiCache"],
		apiItemOrder: ["r1", "r2"],
		apiItemState: {
			r1: { id: "r1", label: "First issue", kind: "placeholder" },
			r2: { id: "r2", label: "Second issue", kind: "placeholder" },
		} as ViewNode["apiItemState"],
	});
}

let s: Setup;
let fake: Fake;
let flushSave: ReturnType<typeof vi.fn>;
let headers: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
let forget: ReturnType<typeof vi.fn>;
let queueRender: ReturnType<typeof vi.fn>;

beforeEach(() => {
	captured.prompts.length = 0;
});

function boot(root: ViewNode[]): void {
	s = setup(root);
	flushSave = vi.fn(async () => void s.persist());
	headers = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
	forget = vi.fn();
	queueRender = vi.fn();
	fake = Object.create(AtlasExplorerView.prototype);
	Object.assign(fake, {
		plugin: {
			app: s.app,
			settings: DEFAULT_SETTINGS,
			viewsManager: s.views,
			unitIndex: s.index,
			statusesManager: s.statuses,
			apiHeadersStore: headers,
			flushSave,
		},
		queueRender,
		forgetDeviceLocalSourceState: forget,
	});
}

const sourceNodes = (): ViewNode[] => explorerProto.collectApiSourceNodes.call(fake, s.views.getView("default")!.root);
const node = (): ViewNode => s.views.getView("default")!.root[0];

/** `Archive` is a folder the fixture vault has; a folder missing from the vault would be refused. */
const pickFolder = (): SwapCandidate => ({ kind: "folder", ref: folder("Archive"), name: "Archive", path: "Archive", known: true });

describe("GP5: a sourced Atlas folder swapped to a unit and back", () => {
	it("the unit keeps the source, rows, order, and id; the refresh walk still finds it", async () => {
		boot([sourcedFolder()]);
		const before = clone(node());
		expect(before.apiSource).toBeDefined();
		expect(Object.keys(before.apiItemState!)).toEqual(["r1", "r2"]);

		await explorerProto.swapPicked.call(fake, s.views.getView("default")!, node(), pickFolder());
		const asUnit = node();
		expect(asUnit).toMatchObject({ id: "linear", type: "unit", ref: folder("Archive") });
		expect(asUnit.apiSource).toEqual(before.apiSource);
		expect(asUnit.apiItemOrder).toEqual(before.apiItemOrder);
		expect(asUnit.apiItemState).toEqual(before.apiItemState);
		expect(asUnit.apiCache).toEqual(before.apiCache);
		expect(sourceNodes().map((n) => n.id)).toEqual(["linear"]);

		explorerProto.openSwapForFolder.call(fake, s.views.getView("default")!, node(), "Boat");
		captured.prompts[0].onSubmit("Boat Projects");
		const back = node();
		expect(back).toMatchObject({ id: "linear", type: "meta", label: "Boat Projects" });
		expect(back.apiSource).toEqual(before.apiSource);
		expect(back.apiItemOrder).toEqual(before.apiItemOrder);
		expect(back.apiItemState).toEqual(before.apiItemState);
		expect(sourceNodes().map((n) => n.id)).toEqual(["linear"]);
	});

	it("the swap saves and never touches device-local source state or header storage", async () => {
		boot([sourcedFolder()]);
		await explorerProto.swapPicked.call(fake, s.views.getView("default")!, node(), pickFolder());
		explorerProto.openSwapForFolder.call(fake, s.views.getView("default")!, node(), "Boat");
		captured.prompts[0].onSubmit("Boat Projects");
		expect(flushSave).toHaveBeenCalledTimes(2);
		expect(forget).not.toHaveBeenCalled();
		expect(headers.set).not.toHaveBeenCalled();
		expect(headers.delete).not.toHaveBeenCalled();
	});

	it("the saved data reloads with the source and rows on the same id", async () => {
		boot([sourcedFolder()]);
		await explorerProto.swapPicked.call(fake, s.views.getView("default")!, node(), pickFolder());
		const saved = clone(s.views.getViews());
		const reloaded = new ViewsManager(s.app, saved, "default", vi.fn());
		const again = reloaded.getView("default")!.root[0];
		expect(again).toMatchObject({ id: "linear", type: "unit", ref: folder("Archive") });
		expect(again.apiSource?.url).toBe(SOURCE_URL);
		expect(Object.keys(again.apiItemState!)).toEqual(["r1", "r2"]);
	});
});

describe("GP5b: a sourced unit swapped to a file keeps its rows", () => {
	it("switching the ref leaves the source fields alone", async () => {
		boot([{ ...sourcedFolder(), type: "unit", ref: folder("Archive"), label: undefined, children: [] } as ViewNode]);
		const before = clone(node());
		await explorerProto.swapPicked.call(fake, s.views.getView("default")!, node(), {
			kind: "file",
			ref: file("Existing.md"),
			name: "Existing.md",
			path: "Existing.md",
			known: true,
		});
		expect(node()).toMatchObject({ id: "linear", ref: file("Existing.md") });
		expect(node().apiItemOrder).toEqual(before.apiItemOrder);
		expect(node().apiSource).toEqual(before.apiSource);
	});
});
