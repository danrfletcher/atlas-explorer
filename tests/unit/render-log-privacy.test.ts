import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSectionHarness, SectionHarness } from "../explorer-header-fixtures";
import { RenderLog, RenderLogAdapter } from "../../src/render-log";
import { PressEnv, openExplorer } from "./explorer-view-press-helpers";

/** Renders a pane that shows a promoted block with the text "hunter2", a file `Secret/Plan.md` and a
 * folder `Private`, through the real `render()`, and checks that none of it reaches the log: not in
 * memory, not on the clipboard text, not in the file written to disk. */

const SECRETS = ["hunter2", "Secret", "Plan.md", "Private"];

const writes = new Map<string, string>();
const adapter: RenderLogAdapter = {
	exists: async (p) => writes.has(p),
	read: async (p) => writes.get(p) ?? "",
	write: async (p, d) => void writes.set(p, d),
};

type Internals = {
	plugin: {
		renderLog: RenderLog;
		unitIndex: { getUnits: () => unknown[] };
		viewsManager: { getInboxUnits: () => unknown[] };
	};
	render: () => Promise<void>;
	renderNodeList: (nodes: unknown, container: HTMLElement) => Promise<void>;
	resolveRef: (ref: { path: string }) => Promise<{ text: string; icon: string }>;
};

let h: SectionHarness;
let env: PressEnv;
let ex: Internals;
let log: RenderLog;

beforeEach(async () => {
	vi.useFakeTimers();
	writes.clear();
	h = makeSectionHarness({ bucketRows: 1, inboxRows: 1 });
	ex = h.explorer as unknown as Internals;
	log = new RenderLog(adapter, ".obsidian/plugins/atlas-explorer/render-log.json");
	ex.plugin.renderLog = log;

	const units = [
		{ type: "file", path: "Secret/Plan.md" },
		{ type: "meta-folder", path: "Private" },
		{ type: "promoted-block", path: "Notes/Daily.md", text: "hunter2" },
	];
	ex.plugin.unitIndex.getUnits = () => units;
	ex.plugin.viewsManager.getInboxUnits = () => units;
	ex.renderNodeList = async (_nodes, container) => {
		container.createDiv({ cls: "atlas-row atlas-row-unit" }).createSpan({ cls: "atlas-row-text", text: "hunter2" });
		container.createDiv({ cls: "atlas-row atlas-row-unit" }).createSpan({ cls: "atlas-row-text", text: "Secret/Plan.md" });
		container.createDiv({ cls: "atlas-row atlas-row-unit" }).createSpan({ cls: "atlas-row-text", text: "Private" });
	};
	ex.resolveRef = async (ref) => ({ text: ref.path, icon: "file" });
	env = await openExplorer(h);
});

afterEach(() => {
	env.teardown();
	h.teardown();
	vi.useRealTimers();
});

describe("render log privacy", () => {
	it("the strings really are on screen after a render, so the checks below mean something", async () => {
		await ex.render();
		const shown = h.panel().textContent ?? "";
		expect(shown).toContain("hunter2");
		expect(shown).toContain("Secret/Plan.md");
		expect(shown).toContain("Private");
	});

	it("none of them appears in the serialised log, the in-memory entries or the file on disk", async () => {
		await ex.render();
		await ex.render();
		await log.flush();

		expect(log.entries().length).toBeGreaterThanOrEqual(2);
		const onDisk = [...writes.values()].join("\n");
		expect(onDisk).not.toBe("");
		for (const text of [log.serialize(), JSON.stringify(log.entries()), onDisk]) {
			for (const secret of SECRETS) expect(text).not.toContain(secret);
		}
	});

	it("every entry has only the four allowed keys, with the right types", async () => {
		await ex.render();
		await ex.render();

		for (const e of log.entries()) {
			expect(Object.keys(e).sort()).toEqual(["at", "changed", "durationMs", "kind"]);
			expect(typeof e.kind).toBe("string");
			expect(typeof e.at).toBe("number");
			expect(typeof e.durationMs).toBe("number");
			expect(typeof e.changed).toBe("boolean");
		}
		for (const e of JSON.parse(log.serialize()) as Record<string, unknown>[]) {
			expect(Object.keys(e).sort()).toEqual(["at", "changed", "durationMs", "kind"]);
		}
	});
});
