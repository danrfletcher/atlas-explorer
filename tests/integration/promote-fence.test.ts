import { readFileSync } from "node:fs";
import fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { getPromotedRoots } from "../../src/source-links";
import { makeSourcesRig, type SourcesRig } from "../sources-explorer-fixture";

// PR-12 (F1, F2, F3, F7): a promote and a return write nothing: no vault write API, no symlink, no unlink, no file
// content edit, and they never start Tephra. Every rewrite comes from Tephra. Two ways: spies on the write APIs
// during the real flow, and a look at the source of every file that holds the promote/return code.

const VAULT = "/Users/dan/Vault";
let rig: SourcesRig | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	await rig?.teardown();
	rig = null;
	Platform.isMobile = false;
});

const FS_WRITERS = ["symlink", "symlinkSync", "unlink", "unlinkSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync", "rename", "renameSync", "rm", "rmSync", "mkdir", "mkdirSync", "copyFile", "copyFileSync", "truncate", "truncateSync"] as const;

describe("a promote and a return make no write of any kind (F2, F3)", () => {
	it("no vault write, no fs write, no symlink or unlink, through the real flow", async () => {
		let r!: SourcesRig;
		rig = await makeSourcesRig({
			promote: { vaultPath: VAULT },
			methods: {
				"source.promote": (params) => {
					const { name, root } = params as { name: string; root: string };
					r.daemon.sources = [...r.daemon.sources, { name, path: root, status: "online" }];
					return { result: { status: "applied", deferred: 0 } };
				},
				"source.unpromote": (params) => {
					r.daemon.sources = r.daemon.sources.filter((s) => s.name !== (params as { name: string }).name);
					return { result: { status: "applied", deferred: 0 } };
				},
			},
		});
		r = rig;
		const spies = FS_WRITERS.map((name) => vi.spyOn(fs as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(() => { throw new Error(`fs.${name} called during promote/return`); }));
		const promiseSpies = (["symlink", "unlink", "writeFile", "rename", "rm", "mkdir"] as const).map((name) => vi.spyOn(fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(async () => { throw new Error(`fs.promises.${name} called during promote/return`); }));
		const vaultCalls = [...rig.app.vault.calls];
		const sourcesBefore = rig.app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith("Sources/") && p.split("/").length === 2);
		const folderEntries = (rig.app.vault.getAbstractFileByPath("Sources") as unknown as { children: Array<{ name: string }> }).children.map((c) => c.name).sort();

		await rig.promoter!.makeOwnSource("Sources/tephra/docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toHaveLength(1));
		await rig.settle();
		await rig.promoter!.returnToParent("docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toEqual([]));
		await rig.settle();

		expect(rig.notices).toEqual([]);
		expect(rig.app.vault.calls).toEqual(vaultCalls); // no create, modify, delete, rename or renameFile
		for (const spy of [...spies, ...promiseSpies]) expect(spy).not.toHaveBeenCalled();
		// `Sources/` holds exactly what it held (no `Sources/docs`), before, after the promote and after the return.
		expect((rig.app.vault.getAbstractFileByPath("Sources") as unknown as { children: Array<{ name: string }> }).children.map((c) => c.name).sort()).toEqual(folderEntries);
		expect(rig.app.vault.getAbstractFileByPath("Sources/docs")).toBeNull();
		expect(rig.app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith("Sources/") && p.split("/").length === 2)).toEqual(sourcesBefore);
	});

	it("Sources/ has no new entry while the source is promoted either", async () => {
		let r!: SourcesRig;
		rig = await makeSourcesRig({
			promote: { vaultPath: VAULT },
			methods: {
				"source.promote": (params) => {
					const { name, root } = params as { name: string; root: string };
					r.daemon.sources = [...r.daemon.sources, { name, path: root, status: "online" }];
					return { result: { status: "applied", deferred: 0 } };
				},
			},
		});
		r = rig;
		const before = (rig.app.vault.getAbstractFileByPath("Sources") as unknown as { children: Array<{ name: string }> }).children.map((c) => c.name).sort();
		await rig.promoter!.makeOwnSource("Sources/tephra/docs");
		await vi.waitFor(() => expect(getPromotedRoots()).toHaveLength(1));
		await rig.settle();
		expect((rig.app.vault.getAbstractFileByPath("Sources") as unknown as { children: Array<{ name: string }> }).children.map((c) => c.name).sort()).toEqual(before);
		expect(before).not.toContain("docs");
	});
});

describe("the promote code holds no write call (F3), no start of Tephra (F7), and keeps no index (F1)", () => {
	const FILES = ["source-promote.ts", "promote-ui.ts", "promote-offer.ts", "promote-name.ts", "source-roots.ts", "promoted-roots.ts"];
	const read = (name: string) => readFileSync(join(__dirname, "..", "..", "src", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

	it.each(FILES)("%s has no vault.modify/process/create/delete/rename, adapter.write, symlink, unlink or fs write", (name) => {
		expect(read(name)).not.toMatch(/\.(modify|process|create|createFolder|delete|trash|rename|renameFile|append)\(|adapter\.|symlink\(|unlink\(|writeFile|nodeSourcesFs|saveData|saveSettings|persistDebounced|flushSave/);
	});

	it.each(FILES)("%s never starts Tephra (no daemon start)", (name) => {
		expect(read(name)).not.toMatch(/daemon start|startDaemon|spawn|exec\(|tephractl/);
	});

	it("the promoted roots are written nowhere: `data.json` is saved by none of the files above, and settings hold no promoted key", () => {
		const settings = readFileSync(join(__dirname, "..", "..", "src", "settings.ts"), "utf8");
		expect(settings).not.toMatch(/promotedRoots|promotedSources/);
		const mainSource = readFileSync(join(__dirname, "..", "..", "src", "main.ts"), "utf8");
		expect(mainSource).not.toMatch(/promotedRoots\s*:/);
	});
});
