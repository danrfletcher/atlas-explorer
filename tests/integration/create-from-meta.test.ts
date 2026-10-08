import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { CreateKind, createFromMeta } from "../../src/create-from-meta";
import { getFreeBlockDisplayTextFromContent } from "../../src/display-text";
import { LINKS_NOT_UPDATED_MESSAGE } from "../../src/links-notice";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, CsvSourceConfig, FolderSourceConfig, UnitRef, View, ViewNode } from "../../src/types";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ApiSourceController } from "../../src/api-source-controller";
import { CsvSourceController } from "../../src/csv-source-controller";
import { obsidianRequestImpl } from "../../src/api-request-obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { CARRIED, clone, file, folder, meta, setup, subtreeIds, tEmpty, tGov, tMany, tNested, unit, walk, Setup } from "./create-from-meta-fixtures";

vi.mock("../../src/api-request-obsidian", () => ({ obsidianRequestImpl: vi.fn() }));

const KINDS: CreateKind[] = ["block", "file", "module"];
const POOL_ID = /^_pool\/\d{14}-[0-9a-z]{4}\.md$/;
const notices = () => Notice.instances.map((n) => n.message);

beforeEach(() => Notice.reset());

describe("UT-1/UT-2 replaceMetaNodeWithUnit on T-many", () => {
	it.each<[string, UnitRef]>([
		["file", file("Field tech.md")],
		["module", folder("Field tech")],
		["block (a file-kind ref)", file("_pool/20260925143012-k3xq.md")],
	])("%s: same length, unit at index 1, same children, no meta node left, one persist", (_label, ref) => {
		const s = setup(tMany());
		const before = s.views.getView("default")!.root;
		const childIds = subtreeIds(before[1]);
		const children = before[1].children.slice();
		expect(s.views.replaceMetaNodeWithUnit("default", "ft", ref)).toBe(true);
		const root = s.views.getView("default")!.root;
		expect(root).toHaveLength(3);
		expect(root[1].type).toBe("unit");
		expect(root[1].ref).toEqual(ref);
		expect(root[1].children).toEqual(children);
		expect(subtreeIds(root[1])).toEqual(childIds);
		let metaWithId = 0;
		walk(root, (n) => n.id === "ft" && n.type === "meta" && metaWithId++);
		expect(metaWithId).toBe(0);
		expect(s.persist).toHaveBeenCalledTimes(1);
	});
});

describe("UT-3 field carry-over on T-gov", () => {
	it("every governance field, explicit status and fold state equal the meta node's; the label goes", () => {
		const s = setup(tGov());
		const original = clone(s.views.getNode("default", "ft")!);
		s.views.replaceMetaNodeWithUnit("default", "ft", file("Field tech.md"));
		const after = s.views.getNode("default", "ft")!;
		for (const key of CARRIED) expect(after[key], key).toEqual(original[key]);
		expect(after.applyTo).toEqual({ block: false, file: true, module: true, metaFolder: false });
		expect(after.truncatedStatuses).toEqual({ done: { enabled: true, label: "Finished" } });
		expect(after.type).toBe("unit");
		expect("label" in after).toBe(false);
		// every key the meta node had, bar the two that change, is still there with the same value
		for (const key of Object.keys(original) as (keyof ViewNode)[]) {
			if (key === "type" || key === "label" || key === "ref") continue;
			expect(after[key], key).toEqual(original[key]);
		}
	});
});

describe("UT-4 position exactness", () => {
	const cases: Array<[string, () => ViewNode[], (root: ViewNode[]) => ViewNode[], number]> = [
		["first", () => [meta("ft", "F"), unit("x", file("Existing.md")), unit("y", file("MixedCase.md"))], (r) => r, 0],
		["last", () => [unit("x", file("Existing.md")), unit("y", file("MixedCase.md")), meta("ft", "F")], (r) => r, 2],
		["only child", () => [meta("p", "P", [meta("ft", "F")])], (r) => r[0].children, 0],
		["depth 4", () => [meta("a", "A", [meta("b", "B", [meta("c", "C", [unit("x", file("Existing.md")), meta("ft", "F"), unit("y", file("MixedCase.md"))])])])], (r) => r[0].children[0].children[0].children, 1],
	];
	it.each(cases)("%s", (_label, make, siblingsOf, index) => {
		const s = setup(make());
		const beforeIds = siblingsOf(s.views.getView("default")!.root).map((n) => n.id);
		s.views.replaceMetaNodeWithUnit("default", "ft", folder("Field tech"));
		const siblings = siblingsOf(s.views.getView("default")!.root);
		expect(siblings.findIndex((n) => n.id === "ft")).toBe(index);
		expect(siblings.map((n) => n.id)).toEqual(beforeIds);
	});
});

describe("UT-5 missing target", () => {
	it("an unknown id or a unit node is a no-op and never persists", () => {
		const s = setup(tMany());
		const before = JSON.stringify(s.views.getViews());
		expect(s.views.replaceMetaNodeWithUnit("default", "nope", file("X.md"))).toBe(false);
		expect(s.views.replaceMetaNodeWithUnit("default", "c-existing", file("X.md"))).toBe(false);
		expect(JSON.stringify(s.views.getViews())).toBe(before);
		expect(s.persist).not.toHaveBeenCalled();
	});
});

describe("UT-6 inherited status follows the parent's apply-to for the new kind", () => {
	const flags = [true, false];
	const combos = flags.flatMap((metaFolder) => flags.flatMap((file) => flags.flatMap((module) => flags.map((block) => ({ metaFolder, file, module, block })))));
	const switchFor: Record<CreateKind, "file" | "module"> = { block: "file", file: "file", module: "module" };
	const refFor: Record<CreateKind, UnitRef> = { block: file("_pool/20260925143012-k3xq.md"), file: file("Field tech.md"), module: folder("Field tech") };

	it.each(combos.flatMap((applyTo) => KINDS.map((kind) => [JSON.stringify(applyTo), applyTo, kind] as const)))("%s as %s", (_label, applyTo, kind) => {
		const s = setup(tGov(applyTo));
		const projects = s.views.getNode("default", "projects")!;
		const view = s.views.getView("default")!;
		s.views.replaceMetaNodeWithUnit("default", "ft", refFor[kind]);
		const node = s.views.getNode("default", "ft")!;
		const dot = s.statuses.resolveNodeStatus([projects, view], node);
		const expectDot = applyTo[switchFor[kind]];
		expect(dot?.label ?? null).toBe(expectDot ? "Doing" : null);
	});

	it("an unset parent apply-to gives a dot before and after for every kind", () => {
		for (const kind of KINDS) {
			const s = setup(tGov(undefined));
			const projects = s.views.getNode("default", "projects")!;
			const view = s.views.getView("default")!;
			expect(s.statuses.resolveNodeStatus([projects, view], s.views.getNode("default", "ft")!)?.label).toBe("Doing");
			s.views.replaceMetaNodeWithUnit("default", "ft", refFor[kind]);
			expect(s.statuses.resolveNodeStatus([projects, view], s.views.getNode("default", "ft")!)?.label).toBe("Doing");
		}
	});

	it("an explicit status the set doesn't contain degrades to the default, a missing set to no dot, no error", () => {
		const s = setup(tGov());
		const projects = s.views.getNode("default", "projects")!;
		const view = s.views.getView("default")!;
		s.views.getNode("default", "ft")!.explicitStatusId = "gone";
		s.views.replaceMetaNodeWithUnit("default", "ft", file("Field tech.md"));
		expect(s.statuses.resolveNodeStatus([projects, view], s.views.getNode("default", "ft")!)?.label).toBe("Idea");
		projects.statusSetId = "deleted";
		expect(s.statuses.resolveNodeStatus([projects, view], s.views.getNode("default", "ft")!)).toBeNull();
	});

	it("the view root as governor, and a parent with statuses off (explicit status still stored)", () => {
		const s = setup([meta("ft", "Field tech", [], { explicitStatusId: "doing" })]);
		const view = s.views.getView("default")!;
		Object.assign(view, { statusEnabled: true, statusSetId: "S", applyTo: { metaFolder: false, file: true, module: false, block: false } });
		s.views.replaceMetaNodeWithUnit("default", "ft", file("Field tech.md"));
		expect(s.statuses.resolveNodeStatus([view], s.views.getNode("default", "ft")!)?.label).toBe("Doing");
		const off = setup(tGov());
		off.views.getNode("default", "projects")!.statusEnabled = false;
		off.views.replaceMetaNodeWithUnit("default", "ft", file("Field tech.md"));
		expect(off.statuses.resolveNodeStatus([off.views.getNode("default", "projects")!, off.views.getView("default")!], off.views.getNode("default", "ft")!)).toBeNull();
		expect(off.views.getNode("default", "ft")!.explicitStatusId).toBe("doing");
	});

	it("a governor's status never applies to itself: its own dot comes from the parent, its children's from its own governance", () => {
		const s = setup(tGov());
		const projects = s.views.getNode("default", "projects")!;
		const view = s.views.getView("default")!;
		const childDots = () => {
			const ft = s.views.getNode("default", "ft")!;
			return ft.children.map((c) => s.statuses.resolveNodeStatus([ft, projects, view], c)?.label ?? null);
		};
		const before = childDots();
		s.views.replaceMetaNodeWithUnit("default", "ft", folder("Field tech"));
		expect(childDots()).toEqual(before);
		expect(before).toEqual(["Done", "Todo", null]);
	});

	it("nearest governor wins: same dots as a hand-built tree", () => {
		const build = () => [
			meta("g", "G", [meta("mid", "Mid", [meta("ft", "Field tech", [unit("k", file("Existing.md"))], { explicitStatusId: "doing" })])], {
				statusEnabled: true,
				statusSetId: "S",
				inheritToSubfolders: true,
			}),
		];
		const created = setup(build());
		created.views.replaceMetaNodeWithUnit("default", "ft", folder("Field tech"));
		const byHand = setup([
			meta("g", "G", [meta("mid", "Mid", [unit("ft", folder("Field tech"), { explicitStatusId: "doing", children: [unit("k", file("Existing.md"))] })])], {
				statusEnabled: true,
				statusSetId: "S",
				inheritToSubfolders: true,
			}),
		]);
		const dots = (s: ReturnType<typeof setup>) => {
			const g = s.views.getNode("default", "g")!;
			const mid = s.views.getNode("default", "mid")!;
			const ft = s.views.getNode("default", "ft")!;
			return [ft, ...ft.children].map((n, i) => s.statuses.resolveNodeStatus(i === 0 ? [mid, g] : [ft, mid, g], n)?.label ?? null);
		};
		expect(dots(created)).toEqual(dots(byHand));
		expect(dots(created)[0]).toBe("Doing");
	});
});

describe("createFromMeta on T-many (mock vault, real views and index)", () => {
	it("IT-1 File: the disk diff is exactly one note with `# Field tech`, one node replaced at index 1", async () => {
		const s = setup(tMany());
		const before = s.listing();
		const treeBefore = clone(s.views.getView("default")!.root);
		const result = await createFromMeta(s.deps, "file", "default", "ft", "Field tech");
		expect(result).toEqual({ ok: true, ref: file("Field tech.md"), path: "Field tech.md" });
		expect(s.listing().filter((p) => !before.includes(p))).toEqual(["Field tech.md"]);
		expect(before.filter((p) => !s.listing().includes(p))).toEqual([]);
		expect(s.contentOf("Field tech.md")).toBe("# Field tech\n");
		const root = s.views.getView("default")!.root;
		expect(root.map((n) => n.id)).toEqual(["a", "ft", "b"]);
		expect(root[1]).toEqual({ ...treeBefore[1], type: "unit", ref: file("Field tech.md"), label: undefined });
		expect(s.index.getUnits().some((u) => u.type === "root-file" && u.path === "Field tech.md")).toBe(true);
		expect(notices()).toEqual([]);
	});

	it("IT-2 Module: exactly the folder and its note; the index has the folder unit; nothing pulled in", async () => {
		const s = setup(tMany());
		const before = s.listing();
		await createFromMeta(s.deps, "module", "default", "ft", "Field tech");
		expect(s.listing().filter((p) => !before.includes(p))).toEqual(["Field tech/", "Field tech/Field tech.md"]);
		expect(s.contentOf("Field tech/Field tech.md")).toBe("# Field tech\n");
		expect(s.views.getNode("default", "ft")!.ref).toEqual(folder("Field tech"));
		expect(s.index.getUnits().some((u) => u.type === "folder-unit" && u.path === "Field tech")).toBe(true);
		expect(s.listing().filter((p) => p.startsWith("Field tech/") && !p.endsWith("/"))).toEqual(["Field tech/Field tech.md"]);
	});

	it("IT-3 Block: one new `_pool/<ID>.md` with first line `# Field tech`, indexed as a free block", async () => {
		const s = setup(tMany());
		const before = s.listing();
		const result = await createFromMeta(s.deps, "block", "default", "ft", "Field tech");
		const added = s.listing().filter((p) => !before.includes(p));
		expect(added).toHaveLength(1);
		expect(added[0]).toMatch(POOL_ID);
		expect(result).toMatchObject({ ok: true, ref: file(added[0]) });
		expect(s.contentOf(added[0])).toBe("# Field tech\n");
		expect(s.index.getUnits().some((u) => u.type === "free-block" && u.path === added[0])).toBe(true);
		expect(getFreeBlockDisplayTextFromContent(s.contentOf(added[0])!, 80)).toBe("Field tech");
		expect(s.contentOf(added[0])).not.toMatch(/^---/); // no frontmatter, no title
	});

	it("IT-4/F-1 nothing nested moves: every child ref still exists at its path, and no write touches an existing file", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			const modify = vi.spyOn(s.app.vault, "modify");
			const paths: string[] = [];
			walk(s.views.getView("default")!.root[1].children, (n) => n.ref && paths.push(n.ref.path));
			const contents = new Map(paths.map((p) => [p, s.contentOf(p)]));
			await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			for (const p of paths) {
				expect(s.app.vault.getAbstractFileByPath(p), p).not.toBeNull();
				expect(s.contentOf(p)).toBe(contents.get(p));
			}
			expect(modify).not.toHaveBeenCalled();
			expect((s.app.vault as unknown as { calls: string[] }).calls.filter((c) => !["create", "createFolder"].includes(c))).toEqual([]);
			expect(s.listing().filter((p) => p.startsWith("Field tech/") && !p.endsWith("/"))).toEqual(kind === "module" ? ["Field tech/Field tech.md"] : []);
		}
	});

	it("AC-6/EC-7 never opens the new item, whatever the kind", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			const getLeaf = vi.fn();
			(s.app as unknown as { workspace: Record<string, unknown> }).workspace.getLeaf = getLeaf;
			(s.app as unknown as { workspace: Record<string, unknown> }).workspace.openLinkText = getLeaf;
			await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			expect(getLeaf).not.toHaveBeenCalled();
		}
	});

	it("AC-5 the chosen name is used everywhere and the meta label is not kept", async () => {
		const expected: Record<CreateKind, string> = { block: "_pool", file: "Field ops.md", module: "Field ops/Field ops.md" };
		for (const kind of KINDS) {
			const s = setup(tMany());
			const before = s.listing();
			await createFromMeta(s.deps, kind, "default", "ft", "Field ops");
			const added = s.listing().filter((p) => !before.includes(p));
			const note = added.find((p) => p.endsWith(".md"))!;
			expect(note.startsWith(expected[kind].split("/")[0]) || kind === "block").toBe(true);
			expect(s.contentOf(note)).toBe("# Field ops\n");
			const json = JSON.stringify(s.views.getViews());
			expect(json).not.toContain("Field tech");
		}
	});

	it("EC-19 surrounding spaces never reach the file name or the heading; inner text and case are kept", async () => {
		const s = setup(tMany());
		const before = s.listing();
		await createFromMeta(s.deps, "file", "default", "ft", "  Field  Tech Ünï  ");
		expect(s.listing().filter((p) => !before.includes(p))).toEqual(["Field  Tech Ünï.md"]);
		expect(s.contentOf("Field  Tech Ünï.md")).toBe("# Field  Tech Ünï\n");
		const b = setup(tMany());
		await createFromMeta(b.deps, "block", "default", "ft", "  Notes  ");
		expect([...b.app.vault.contents.values()].pop()).toBe("# Notes\n");
	});

	it("EC-9 once Create is done the index lists the unit, the node points at it and the inbox is unchanged", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			const inbox = () => s.views.getInboxUnits(s.index.getUnits(), "default", "view").map((u) => u.path);
			const before = inbox();
			const result = await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			expect(result.ok).toBe(true);
			const ref = (result as { ref: UnitRef }).ref;
			expect(s.index.getUnits().map((u) => (u.type === "folder-unit" ? `folder:${u.path}` : `file:${u.path}`))).toContain(`${ref.kind}:${ref.path}`);
			expect(s.views.getNode("default", "ft")!.ref).toEqual(ref);
			expect(inbox()).toEqual(before);
		}
	});

	it("EC-9 the new unit is never in the inbox while the disk step is still running (after the folder exists, before the note resolves)", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			const inboxPaths = () => s.views.getInboxUnits(s.index.getUnits(), "default", "view").map((u) => u.path);
			const before = inboxPaths();
			const samples: string[][] = [];
			// every index notification is a chance for the explorer to redraw: sample the inbox at each one
			s.index.onChange(() => samples.push(inboxPaths()));
			const originalCreate = s.app.vault.create.bind(s.app.vault);
			s.app.vault.create = async (path: string, data: string) => {
				// the folder's create event has already fired; the note is still being written
				samples.push(inboxPaths());
				await new Promise((resolve) => setTimeout(resolve, 5));
				samples.push(inboxPaths());
				return originalCreate(path, data);
			};
			const result = await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			expect(result.ok).toBe(true);
			expect(samples.length).toBeGreaterThan(0);
			for (const sample of samples) expect(sample, kind).toEqual(before);
			expect(inboxPaths()).toEqual(before);
		}
	});

	it("EC-9 control: without the hold, the module folder is listed as unplaced mid-create (the check above can fail)", async () => {
		const s = setup(tMany());
		s.deps.holdUnit = () => () => {};
		const inboxPaths = () => s.views.getInboxUnits(s.index.getUnits(), "default", "view").map((u) => u.path);
		let midCreate: string[] = [];
		const originalCreate = s.app.vault.create.bind(s.app.vault);
		s.app.vault.create = async (path: string, data: string) => {
			midCreate = inboxPaths();
			return originalCreate(path, data);
		};
		await createFromMeta(s.deps, "module", "default", "ft", "Field tech");
		expect(midCreate).toContain("Field tech");
	});

	it("EC-9/EC-10 the hold is released after a failed create, so nothing stays hidden", async () => {
		const s = setup(tMany());
		const release = vi.fn();
		s.deps.holdUnit = vi.fn(() => release);
		s.app.vault.create = async () => {
			throw new Error("disk full");
		};
		const result = await createFromMeta(s.deps, "module", "default", "ft", "Field tech");
		expect(result.ok).toBe(false);
		expect(s.deps.holdUnit).toHaveBeenCalledWith("Field tech");
		expect(release).toHaveBeenCalledTimes(1);
		expect(s.views.getNode("default", "ft")!.type).toBe("meta");
	});

	it("EC-13 flushes data.json once, holding the new node and no meta node", async () => {
		const s = setup(tMany());
		await createFromMeta(s.deps, "module", "default", "ft", "Field tech");
		expect(s.saved).toHaveLength(1);
		const flushed = s.saved[0][0].root;
		expect(flushed[1]).toMatchObject({ id: "ft", type: "unit", ref: folder("Field tech") });
		expect(JSON.stringify(flushed)).not.toContain('"label":"Field tech"');
	});

	it("EC-14 links off: no links notice for Create (that one belongs to moves)", async () => {
		const s = setup(tMany(), { links: false });
		for (const kind of KINDS) {
			const t = setup(tMany(), { links: false });
			await createFromMeta(t.deps, kind, "default", "ft", "Field tech");
		}
		await createFromMeta(s.deps, "file", "default", "ft", "Field tech");
		expect(notices()).not.toContain(LINKS_NOT_UPDATED_MESSAGE);
		expect(notices()).toEqual([]);
	});
});

describe("EC-1 empty and many children", () => {
	it("an empty meta folder becomes an item with no children, for every kind; dropping a row on it later nests", async () => {
		for (const kind of KINDS) {
			const s = setup([...tEmpty(), unit("x", file("Existing.md"))]);
			await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			const node = s.views.getNode("default", "ft")!;
			expect(node.children).toEqual([]);
			expect(node.collapsed).toBeUndefined();
			expect(s.views.moveNode("default", "x", "ft", 0)).toBe(true);
			expect(s.views.getNode("default", "ft")!.children.map((c) => c.id)).toEqual(["x"]);
		}
	});

	it("nested metas stay metas, nested units keep their refs, ids and order", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			const before = clone(s.views.getNode("default", "ft")!.children);
			await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			expect(s.views.getNode("default", "ft")!.children).toEqual(before);
			expect(s.views.getNode("default", "c-sub")!.type).toBe("meta");
			expect(s.views.getNode("default", "c-deep")!.label).toBe("Deep");
		}
	});

	it("a missing ref child stays as it is; a duplicate placement elsewhere is untouched", async () => {
		const s = setup([meta("ft", "Field tech", [unit("gone", file("Deleted.md"))]), unit("twin", file("Existing.md"))]);
		s.views.getNode("default", "ft")!.children.push(unit("dup", file("Existing.md")));
		await createFromMeta(s.deps, "file", "default", "ft", "Field tech");
		expect(s.views.getNode("default", "gone")!.ref).toEqual(file("Deleted.md"));
		expect(s.views.getNode("default", "dup")!.ref).toEqual(file("Existing.md"));
		expect(s.views.getNode("default", "twin")!.ref).toEqual(file("Existing.md"));
	});

	it("200 direct children over 4 levels: one create, the documented writes only, well under a second", async () => {
		const wide = (level: number): ViewNode[] =>
			Array.from({ length: level === 0 ? 200 : 3 }, (_, i) => (level < 3 ? meta(`n${level}-${i}`, `M${level}-${i}`, level === 0 ? [] : wide(level + 1)) : unit(`u${i}`, file("Existing.md"))));
		const kids = wide(0).map((m, i) => ({ ...m, children: wide(1) }) as ViewNode).map((m, i) => ({ ...m, id: `w${i}` }));
		const s = setup([meta("ft", "Field tech", kids)]);
		const t0 = performance.now();
		await createFromMeta(s.deps, "module", "default", "ft", "Field tech");
		expect(performance.now() - t0).toBeLessThan(1000);
		expect(s.views.getNode("default", "ft")!.children).toHaveLength(200);
		expect((s.app.vault as unknown as { calls: string[] }).calls).toEqual(["createFolder", "create"]);
	});
});

describe("EC-2 nested position", () => {
	it("keeps the index inside Mid, and leaves Mid and Outer as metas", async () => {
		const s = setup(tNested());
		await createFromMeta(s.deps, "file", "default", "ft", "Field tech");
		const mid = s.views.getNode("default", "mid")!;
		expect(mid.type).toBe("meta");
		expect(mid.children.map((c) => c.id)).toEqual(["ft"]);
		expect(s.views.getNode("default", "outer")!.type).toBe("meta");
		expect(s.views.getNode("default", "outer")!.children.map((c) => c.id)).toEqual(["mid", "c-mixed"]);
	});
});

describe("EC-3 a meta folder that is a governor", () => {
	it("keeps the governance for every kind and the children's dots", async () => {
		for (const kind of KINDS) {
			const s = setup(tGov());
			const original = clone(s.views.getNode("default", "ft")!);
			await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
			const after = s.views.getNode("default", "ft")!;
			for (const key of CARRIED) expect(after[key], key).toEqual(original[key]);
			expect(after.children.map((c) => c.id)).toEqual(original.children.map((c) => c.id));
			expect(after.collapsed).toBe(true);
		}
	});
});

describe("EC-8 duplicates and second views", () => {
	function dupSetup() {
		const second = { id: "second", name: "Second", inboxMode: "view" as const, root: [meta("s-ft", "Field tech", [unit("s-e", file("Existing.md"))])] };
		const s = setup(tMany(), { extraViews: [second] });
		s.views.duplicateNode("default", "ft");
		return s;
	}

	it("only the chosen node is replaced; the duplicate and the other view keep their metas and children", async () => {
		const s = dupSetup();
		const root = s.views.getView("default")!.root;
		const dupId = root[2].id;
		expect(root[2].label).toBe("Field tech");
		await createFromMeta(s.deps, "file", "default", "ft", "Field tech");
		expect(s.views.getNode("default", "ft")!.type).toBe("unit");
		expect(s.views.getNode("default", dupId)!.type).toBe("meta");
		expect(s.views.getNode("default", dupId)!.children).toHaveLength(4);
		expect(s.views.getNode("second", "s-ft")!.type).toBe("meta");
		expect(s.views.getNode("second", "s-e")!.ref).toEqual(file("Existing.md"));
	});

	it("creating from the duplicate with the same name is refused (clash), nothing changes, and another name works", async () => {
		const s = dupSetup();
		const dupId = s.views.getView("default")!.root[2].id;
		await createFromMeta(s.deps, "file", "default", "ft", "Field tech");
		const before = JSON.stringify(s.views.getViews());
		Notice.reset();
		const result = await createFromMeta(s.deps, "file", "default", dupId, "Field tech");
		expect(result.ok).toBe(false);
		expect(notices()).toEqual(['Atlas: couldn\'t create file "Field tech": A note or folder called \'Field tech\' already exists at the vault root']);
		expect(JSON.stringify(s.views.getViews())).toBe(before);
		expect(s.contentOf("Field tech.md")).toBe("# Field tech\n");
		expect((await createFromMeta(s.deps, "file", "default", dupId, "Field tech 2")).ok).toBe(true);
		expect(s.views.getNode("default", dupId)!.children).toHaveLength(4);
	});
});

describe("clash and name rules at submit (AC-9/AC-10/AC-11)", () => {
	it.each([["Existing"], ["existing"], ["EXISTING"], ["Existing Folder"], ["existing folder"], ["mixedcase"], ["ärger"], ["Archive"]])("File and Module refuse %s, create nothing, leave the meta folder", async (name) => {
		for (const kind of ["file", "module"] as const) {
			const s = setup(tMany());
			const before = s.listing();
			const tree = JSON.stringify(s.views.getViews());
			expect((await createFromMeta(s.deps, kind, "default", "ft", name)).ok).toBe(false);
			expect(s.listing()).toEqual(before);
			expect(JSON.stringify(s.views.getViews())).toBe(tree);
			expect(notices().length).toBe(1);
			Notice.reset();
		}
	});

	it("Report, Nested Note and Existing 2 are not clashes", async () => {
		for (const name of ["Report", "Nested Note", "Existing 2"]) {
			const s = setup(tMany());
			expect((await createFromMeta(s.deps, "module", "default", "ft", name)).ok).toBe(true);
		}
	});

	it("the pool folder and the other excluded default are refused as a module name, even when the pool doesn't exist", async () => {
		for (const name of ["_pool", "_to_delete"]) {
			const s = setup(tMany());
			expect((await createFromMeta(s.deps, "module", "default", "ft", name)).ok).toBe(false);
		}
	});

	it("Block takes clashing and file-illegal names as typed, and refuses only empty", async () => {
		for (const name of ["Existing", "existing", "Existing Folder", "Q3: plans / ideas", ".hidden", "Notes.", "A#B [x]", "CON", "x".repeat(300)]) {
			const s = setup(tMany());
			const before = s.listing();
			const result = await createFromMeta(s.deps, "block", "default", "ft", name);
			expect(result.ok, name).toBe(true);
			const added = s.listing().filter((p) => !before.includes(p));
			expect(added).toHaveLength(1);
			expect(s.contentOf(added[0])).toBe(`# ${name}\n`);
		}
		for (const name of ["", "   "]) {
			const s = setup(tMany());
			expect((await createFromMeta(s.deps, "block", "default", "ft", name)).ok).toBe(false);
		}
	});
});

describe("EC-10 failure while creating on disk", () => {
	function failing(s: ReturnType<typeof setup>, method: "create" | "createFolder", onCall = 1) {
		const original = s.app.vault[method].bind(s.app.vault) as (...a: unknown[]) => Promise<unknown>;
		let calls = 0;
		vi.spyOn(s.app.vault, method).mockImplementation((async (...a: unknown[]) => {
			if (++calls === onCall) throw new Error("disk says no");
			return original(...a);
		}) as never);
	}
	const unchanged = async (s: ReturnType<typeof setup>, kind: CreateKind, before: string[]) => {
		const tree = JSON.stringify(s.views.getViews());
		const result = await createFromMeta(s.deps, kind, "default", "ft", "Field tech");
		expect(result.ok).toBe(false);
		expect(JSON.stringify(s.views.getViews())).toBe(tree);
		expect(s.listing()).toEqual(before);
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("disk says no");
		expect(s.persist).not.toHaveBeenCalled();
		expect(s.saved).toEqual([]);
	};

	it("File: the create throws", async () => {
		const s = setup(tMany());
		const before = s.listing();
		failing(s, "create");
		await unchanged(s, "file", before);
	});

	it("Module: the folder is made, the note throws, the empty folder is deleted again", async () => {
		const s = setup(tMany());
		const before = s.listing();
		failing(s, "create");
		await unchanged(s, "module", before);
		expect(s.app.vault.getAbstractFileByPath("Field tech")).toBeNull();
	});

	it("Module: the folder itself can't be made", async () => {
		const s = setup(tMany());
		const before = s.listing();
		failing(s, "createFolder");
		await unchanged(s, "module", before);
	});

	it("Block: the pool folder can't be made (pool absent) or the file can't be written", async () => {
		const s = setup(tMany(), { pool: "Pool2" });
		const before = s.listing();
		failing(s, "createFolder");
		await unchanged(s, "block", before);
		const t = setup(tMany(), { pool: "Pool2" });
		Notice.reset();
		failing(t, "create");
		await unchanged(t, "block", t.listing());
	});

	it.each([[""], ["/"], ["."], ["  "]])("Block with the pool setting %j never makes a path or node outside a real folder", async (pool) => {
		const s = setup(tMany());
		s.deps.getPoolFolder = () => pool;
		const before = s.listing();
		const tree = JSON.stringify(s.views.getViews());
		expect((await createFromMeta(s.deps, "block", "default", "ft", "Field tech")).ok).toBe(false);
		expect(s.listing()).toEqual(before);
		expect(JSON.stringify(s.views.getViews())).toBe(tree);
		expect(notices()).toHaveLength(1);
	});

	it("Block creates the pool on demand, exactly as Add block does", async () => {
		const s = setup(tMany(), { pool: "Fresh pool" });
		const result = await createFromMeta(s.deps, "block", "default", "ft", "Field tech");
		expect(result.ok).toBe(true);
		expect(s.app.vault.getAbstractFileByPath("Fresh pool")).not.toBeNull();
		expect(s.listing().filter((p) => p.startsWith("Fresh pool/") && !p.endsWith("/"))).toHaveLength(1);
	});
});

describe("AC-2 ID collision", () => {
	it("a new ID is generated and the existing file is never overwritten", async () => {
		const s = setup(tMany());
		const now = new Date(2026, 8, 25, 14, 30, 12);
		let calls = 0;
		const random = () => (calls++ < 4 ? 0 : 0.5); // first ID "0000", second "iiii"
		s.app.vault.seedFile("_pool/20260925143012-0000.md");
		s.app.vault.contents.set("_pool/20260925143012-0000.md", "keep me");
		const result = await createFromMeta({ ...s.deps, now: () => now, random }, "block", "default", "ft", "Field tech");
		expect(result).toMatchObject({ ok: true, path: "_pool/20260925143012-iiii.md" });
		expect(s.contentOf("_pool/20260925143012-0000.md")).toBe("keep me");
	});
});

describe("EC-11 state changed under the dialog", () => {
	it("the meta folder is gone before Create: nothing on disk, one notice", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			s.views.deleteMetaFolder("default", "ft");
			Notice.reset();
			const before = s.listing();
			expect((await createFromMeta(s.deps, kind, "default", "ft", "Field tech")).ok).toBe(false);
			expect(s.listing()).toEqual(before);
			expect(notices()).toEqual([`Atlas: couldn't create ${kind} "Field tech": the folder no longer exists`]);
		}
	});

	it("the node vanishes while the disk step runs: what Atlas made is removed again", async () => {
		for (const kind of KINDS) {
			const s = setup(tMany());
			const before = s.listing();
			s.deps.replaceMetaNodeWithUnit = () => false;
			expect((await createFromMeta(s.deps, kind, "default", "ft", "Field tech")).ok).toBe(false);
			expect(s.listing()).toEqual(before);
		}
	});

	it("a unit node under that id (not a meta folder) is refused too", async () => {
		const s = setup(tMany());
		const before = s.listing();
		expect((await createFromMeta(s.deps, "file", "default", "c-existing", "Field tech")).ok).toBe(false);
		expect(s.listing()).toEqual(before);
	});
});

describe("EC-15 the block is a real free block", () => {
	it("Remove from view unplaces it and lifts any children; it does not graduate by itself", async () => {
		const s = setup(tMany());
		const result = (await createFromMeta(s.deps, "block", "default", "ft", "Field tech")) as { path: string };
		expect(s.app.vault.getAbstractFileByPath(result.path)).not.toBeNull();
		s.views.unplaceNode("default", "ft");
		expect(s.views.getView("default")!.root.map((n) => n.id)).toEqual(["a", "c-existing", "c-archive", "c-sub", "c-report", "b"]);
		expect((s.app.vault as unknown as { calls: string[] }).calls).toEqual(["create"]); // no rename, no delete
		expect(s.views.getInboxUnits(s.index.getUnits(), "default", "view").map((u) => u.path)).toContain(result.path);
	});
});

describe("F-4/EC-12 a repeated submit makes one item", () => {
	it("two overlapping Create calls on one folder create one item; the second is refused", async () => {
		const s = setup(tMany());
		const [a, b] = await Promise.all([createFromMeta(s.deps, "file", "default", "ft", "Field tech"), createFromMeta(s.deps, "file", "default", "ft", "Field tech")]);
		expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
		expect(s.listing().filter((p) => p === "Field tech.md")).toHaveLength(1);
	});
});

describe("views manager type check", () => {
	it("the helper this PR reuses is the PR-1 one (no second replace method)", () => {
		expect(Object.getOwnPropertyNames(ViewsManager.prototype).filter((n) => /replaceMeta|replaceUnit/.test(n))).toEqual(["replaceMetaNodeWithUnit"]);
	});
});

// R1 (F2 regression): Create on a sourced Atlas folder must leave a unit whose source rows still
// render, and still refresh, through the real explorer paths (renderNode, refreshApiSource,
// refreshCsvSource, refreshFolderSource), not only through the data layer.
type Fake = Record<string, any>;
const explorerProto = AtlasExplorerView.prototype as unknown as Record<string, (this: Fake, ...args: unknown[]) => any>;

/** A real `AtlasExplorerView` method set bound to a plain object: `Object.create` keeps every real
 * prototype method reachable through `this`, so `renderNode` and the refresh wrappers run unstubbed. */
function explorerFor(s: Setup): Fake {
	const fake: Fake = Object.create(AtlasExplorerView.prototype);
	Object.assign(fake, {
		plugin: {
			app: s.app,
			settings: DEFAULT_SETTINGS,
			statusesManager: s.statuses,
			viewsManager: s.views,
			apiSourceController: new ApiSourceController(),
			csvSourceController: new CsvSourceController(),
			apiHeadersStore: { get: () => [] },
			folderSourcePathStore: { get: () => undefined },
		},
		filterText: "",
		expandedTruncationGroups: new Set<string>(),
		selectedBucketNodeIds: new Set<string>(),
		selectedInboxRefKeys: new Set<string>(),
		unitsByRefKey: new Map(),
		openConfirmDeleteModals: [],
	});
	return fake;
}

async function renderRow(fake: Fake, node: ViewNode, view: View): Promise<HTMLElement> {
	const container = document.createElement("div");
	await explorerProto.renderNode.call(fake, node, container, view, 0, []);
	return container;
}

const apiRowTexts = (c: HTMLElement) => Array.from(c.querySelectorAll(".atlas-row-api-item .atlas-row-text")).map((el) => el.textContent);

/** The Atlas folder "Field tech" as the user left it: rows fetched, two of them with a status and a note. */
function sourcedFolder(extra: Partial<ViewNode>): ViewNode {
	return meta("ft", "Field tech", [], {
		apiItemState: {
			"1": { id: "1", label: "One", explicitStatusId: "doing", noteRef: { kind: "file", path: "Notes/one.md" } },
			"2": { id: "2", label: "Two", explicitStatusId: "idea" },
		},
		apiItemOrder: ["1", "2"],
		...extra,
	});
}

const cacheOf = (rows: { id: string; label: string }[]) => ({ fetchedAt: 1000, ok: true, error: null, rows, skippedCount: 0, truncated: false, lastSuccessAt: 1000 });

const API_SOURCE: ApiSourceConfig = { url: "https://api.example.com/issues", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false };
const CSV_SOURCE: CsvSourceConfig = { path: "Data.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false };
const FOLDER_SOURCE: FolderSourceConfig = { location: "inside", path: "Archive", showFiles: true, showFolders: true, refreshOnViewLoad: false };

describe.each(KINDS)("F2a/F2b — Create (%s) on a sourced Atlas folder with an API source", (kind) => {
	it("the unit still renders its rows with status and notes, and a refresh updates them and keeps both", async () => {
		const s = setup([sourcedFolder({ apiSource: API_SOURCE, apiCache: cacheOf([{ id: "1", label: "One" }, { id: "2", label: "Two" }]) })]);
		const fake = explorerFor(s);
		const view = s.views.getView("default")!;

		expect(await createFromMeta(s.deps, kind, "default", "ft", "Field tech")).toMatchObject({ ok: true });
		const node = s.views.getNode("default", "ft")!;
		expect(node.type).toBe("unit");
		expect(apiRowTexts(await renderRow(fake, node, view))).toEqual(["One", "Two"]);

		vi.mocked(obsidianRequestImpl).mockResolvedValue({
			status: 200,
			text: JSON.stringify([{ id: "1", name: "One renamed" }, { id: "2", name: "Two" }, { id: "3", name: "Three" }]),
		});
		explorerProto.refreshApiSource.call(fake, view, node, "manual");
		await vi.waitFor(() => expect(node.apiCache?.rows).toHaveLength(3));

		expect(node.apiItemState?.["1"]).toMatchObject({ label: "One renamed", explicitStatusId: "doing", noteRef: { kind: "file", path: "Notes/one.md" } });
		expect(node.apiItemState?.["2"]).toMatchObject({ explicitStatusId: "idea" });
		expect(apiRowTexts(await renderRow(fake, node, view))).toEqual(["One renamed", "Two", "Three"]);
	});
});

describe.each(KINDS)("F2a/F2b — Create (%s) on a sourced Atlas folder with a CSV source", (kind) => {
	it("the unit still renders its CSV rows, and a refresh from the vault file updates them and keeps status and notes", async () => {
		const s = setup([sourcedFolder({ csvSource: CSV_SOURCE, apiCache: cacheOf([{ id: "1", label: "One" }, { id: "2", label: "Two" }]) })]);
		await s.app.vault.create("Data.csv", "id,name\n1,One\n2,Two\n");
		const fake = explorerFor(s);
		const view = s.views.getView("default")!;

		expect(await createFromMeta(s.deps, kind, "default", "ft", "Field tech")).toMatchObject({ ok: true });
		const node = s.views.getNode("default", "ft")!;
		expect(node.type).toBe("unit");
		expect(apiRowTexts(await renderRow(fake, node, view))).toEqual(["One", "Two"]);

		await s.app.vault.modify(s.app.vault.getAbstractFileByPath("Data.csv") as never, "id,name\n1,One renamed\n2,Two\n3,Three\n");
		explorerProto.refreshCsvSource.call(fake, view, node, "manual");
		await vi.waitFor(() => expect(node.apiCache?.rows).toHaveLength(3));

		expect(node.apiItemState?.["1"]).toMatchObject({ label: "One renamed", explicitStatusId: "doing", noteRef: { kind: "file", path: "Notes/one.md" } });
		expect(node.apiItemState?.["2"]).toMatchObject({ explicitStatusId: "idea" });
		expect(apiRowTexts(await renderRow(fake, node, view))).toEqual(["One renamed", "Two", "Three"]);
	});
});

describe.each(KINDS)("F2a/F2b — Create (%s) on a sourced Atlas folder with a linked-folder source", (kind) => {
	it("the unit still renders its linked children, and a refresh adds a new file from the linked folder", async () => {
		const s = setup([sourcedFolder({})]);
		s.views.setFolderSource("default", "ft", FOLDER_SOURCE);
		s.views.refreshFolderSource("default", "ft");
		const fake = explorerFor(s);
		const view = s.views.getView("default")!;
		expect(s.views.getNode("default", "ft")!.children.map((c) => c.ref.path)).toEqual(["Archive/Archive.md"]);

		expect(await createFromMeta(s.deps, kind, "default", "ft", "Field tech")).toMatchObject({ ok: true });
		const node = s.views.getNode("default", "ft")!;
		expect(node.type).toBe("unit");
		expect(node.folderSource).toEqual(FOLDER_SOURCE);
		const rendered = await renderRow(fake, node, view);
		expect(rendered.querySelectorAll(".atlas-row-unit").length).toBeGreaterThan(1);

		await s.app.vault.create("Archive/New.md", "");
		explorerProto.refreshFolderSource.call(fake, view, node);
		expect(node.children.map((c) => c.ref.path)).toEqual(["Archive/Archive.md", "Archive/New.md"]);
		const after = await renderRow(fake, node, view);
		expect(after.querySelectorAll(".atlas-row-unit").length).toBeGreaterThan(rendered.querySelectorAll(".atlas-row-unit").length);
	});
});
