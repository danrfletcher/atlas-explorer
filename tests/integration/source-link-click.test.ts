import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, MetadataCache, Notice } from "obsidian";
import { LinkResolutionHook } from "../../src/link-resolution-hook";
import { obsidianFirstLinkpathDest, seedPaths, sourcesVaultPaths } from "../sources-vault";

/**
 * Clicking a link in Obsidian ends in `workspace.openLinkText(linktext, sourcePath)`; the real one
 * creates a note when the link doesn't resolve. `workspace.openLinkText` is mocked here (it is the
 * stand-in for Obsidian's create-and-open); the hook's guard sits in front of it, as it does live.
 */

let app: App;
let realOpen: ReturnType<typeof vi.fn>;
let hook: LinkResolutionHook;

beforeEach(() => {
	Notice.reset();
	app = new App();
	seedPaths(app, sourcesVaultPaths());
	app.metadataCache.getFirstLinkpathDest = obsidianFirstLinkpathDest(app) as MetadataCache["getFirstLinkpathDest"];
	// Like Obsidian: an unresolved link creates `<linktext>.md`; a resolved one just opens.
	realOpen = vi.fn(async (linktext: string, sourcePath: string) => {
		if (!app.metadataCache.getFirstLinkpathDest(linktext.split("#")[0], sourcePath)) await app.vault.create(`${linktext}.md`, "");
	});
	(app.workspace as unknown as Record<string, unknown>).openLinkText = realOpen;
	hook = new LinkResolutionHook(app, vi.fn());
	expect(hook.install()).toBe("installed");
});

const notices = () => Notice.instances.map((n) => n.message);

describe("clicking a broken @ link", () => {
	it("[[@whoop:Nope]] shows \"No file Nope in whoop\" and creates nothing", async () => {
		await app.workspace.openLinkText("@whoop:Nope", "Weekly Review.md", false);
		expect(notices()).toEqual(["No file Nope in whoop"]);
		expect(app.vault.calls).not.toContain("create");
		expect(realOpen).not.toHaveBeenCalled();
		expect(app.vault.getAbstractFileByPath("@whoop:Nope.md")).toBeNull();
	});

	it("[[@nosuch:x]] shows \"No file x in nosuch\"", async () => {
		await app.workspace.openLinkText("@nosuch:x", "Weekly Review.md", false);
		expect(notices()).toEqual(["No file x in nosuch"]);
		expect(app.vault.calls).not.toContain("create");
	});

	it("a broken heading or block link is broken too", async () => {
		await app.workspace.openLinkText("@whoop:Nope#Week 1", "Weekly Review.md", false);
		await app.workspace.openLinkText("@whoop:Nope#^abc", "Weekly Review.md", false);
		expect(notices()).toEqual(["No file Nope in whoop", "No file Nope in whoop"]);
		expect(app.vault.calls).not.toContain("create");
	});

	it("malformed @ links notice and never create a file", async () => {
		for (const link of ["@:x", "@whoop:", "@who op:x", "@a*:x", "@whoop:sub/../x"]) await app.workspace.openLinkText(link, "Weekly Review.md", false);
		expect(notices()).toHaveLength(5);
		expect(app.vault.calls).not.toContain("create");
		expect(realOpen).not.toHaveBeenCalled();
	});

	it("E3: a tie lists both paths in the notice", async () => {
		seedPaths(app, ["Sources/whoop/a/Plan2.md", "Sources/whoop/b/Plan2.md"]);
		hook.invalidate();
		await app.workspace.openLinkText("@whoop:Plan2", "Weekly Review.md", false);
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("2 matches in whoop");
		expect(notices()[0]).toContain("Sources/whoop/a/Plan2.md");
		expect(notices()[0]).toContain("Sources/whoop/b/Plan2.md");
		expect(app.vault.calls).not.toContain("create");
	});

	it("a symlinked source folder whose target is missing is an empty folder: broken, nothing created", async () => {
		app.vault.seedFolder("Sources/gone");
		await app.workspace.openLinkText("@gone:x", "Weekly Review.md", false);
		expect(notices()).toEqual(["No file x in gone"]);
		expect(app.vault.calls).not.toContain("create");
	});
});

describe("clicking links that should go through unchanged", () => {
	it("a resolved @ link opens normally, with no notice", async () => {
		await app.workspace.openLinkText("@whoop:Workout Plan", "Weekly Review.md", false);
		await app.workspace.openLinkText("@whoop:Workout Plan#^plan1", "Weekly Review.md", true);
		expect(realOpen).toHaveBeenCalledTimes(2);
		expect(realOpen).toHaveBeenLastCalledWith("@whoop:Workout Plan#^plan1", "Weekly Review.md", true);
		expect(notices()).toEqual([]);
		expect(app.vault.calls).not.toContain("create");
	});

	it("plain links, [[@home]] (no colon) and an unresolved plain link behave as before", async () => {
		await app.workspace.openLinkText("Leg Day", "Weekly Review.md", false);
		expect(realOpen).toHaveBeenCalledWith("Leg Day", "Weekly Review.md", false);
		await app.workspace.openLinkText("@home", "Weekly Review.md", false); // Obsidian's own behaviour: creates "@home.md"
		expect(notices()).toEqual([]);
		expect(app.vault.getAbstractFileByPath("@home.md")).not.toBeNull();
	});

	it("after uninstall the guard is gone: Obsidian's original runs for every link", async () => {
		hook.uninstall();
		expect((app.workspace as unknown as Record<string, unknown>).openLinkText).toBe(realOpen);
		await app.workspace.openLinkText("@whoop:Nope", "Weekly Review.md", false);
		expect(notices()).toEqual([]);
		expect(realOpen).toHaveBeenCalledTimes(1);
	});
});
