import { describe, expect, it, vi } from "vitest";
import { App, Vault } from "obsidian";
import { USER_IGNORE_FILTERS_KEY, isSourceExcluded, refreshExcludedFilesPane, setSourceExcluded, sourceExcludeEntry } from "../../src/tephra-exclude";

function vaultWith(filters: unknown): Vault {
	const vault = new App().vault;
	if (filters !== undefined) vault.setConfig(USER_IGNORE_FILTERS_KEY, filters);
	return vault;
}
const filtersOf = (vault: Vault) => vault.getConfig(USER_IGNORE_FILTERS_KEY);

describe("Excluded files entry for a source", () => {
	it("is Sources/<name>/", () => {
		expect(sourceExcludeEntry("whoop")).toBe("Sources/whoop/");
		expect(USER_IGNORE_FILTERS_KEY).toBe("userIgnoreFilters");
	});
});

describe("setSourceExcluded (Show in Obsidian search & graph)", () => {
	it("off adds Sources/<name>/ to userIgnoreFilters, through the vault's own getConfig/setConfig", () => {
		const vault = vaultWith([]);
		expect(setSourceExcluded(vault, "whoop", true)).toBe(true);
		expect(filtersOf(vault)).toEqual(["Sources/whoop/"]);
		expect(isSourceExcluded(vault, "whoop")).toBe(true);
	});

	it("works when Obsidian has no list yet (the key was never set)", () => {
		const vault = vaultWith(undefined);
		setSourceExcluded(vault, "whoop", true);
		expect(filtersOf(vault)).toEqual(["Sources/whoop/"]);
	});

	it("on again removes exactly that entry", () => {
		const vault = vaultWith([]);
		setSourceExcluded(vault, "whoop", true);
		expect(setSourceExcluded(vault, "whoop", false)).toBe(true);
		expect(filtersOf(vault)).toEqual([]);
		expect(isSourceExcluded(vault, "whoop")).toBe(false);
	});

	it("keeps Dan's own entries, in order, through an add and a remove", () => {
		const own = ["Private/", "/\\.draft$/", "node_modules"];
		const vault = vaultWith([...own]);
		setSourceExcluded(vault, "whoop", true);
		expect(filtersOf(vault)).toEqual([...own, "Sources/whoop/"]);
		setSourceExcluded(vault, "whoop", false);
		expect(filtersOf(vault)).toEqual(own);
	});

	it("removing leaves other sources' entries, and a look-alike entry, alone", () => {
		const vault = vaultWith(["Sources/tephra/", "Sources/whoop/", "Sources/whoop", "Sources/whoop-old/", "sources/whoop/"]);
		setSourceExcluded(vault, "whoop", false);
		expect(filtersOf(vault)).toEqual(["Sources/tephra/", "Sources/whoop", "Sources/whoop-old/", "sources/whoop/"]);
	});

	it("is idempotent: adding twice never duplicates, removing twice changes nothing more", () => {
		const vault = vaultWith(["Mine/"]);
		expect(setSourceExcluded(vault, "whoop", true)).toBe(true);
		expect(setSourceExcluded(vault, "whoop", true)).toBe(false);
		expect(setSourceExcluded(vault, "whoop", true)).toBe(false);
		expect(filtersOf(vault)).toEqual(["Mine/", "Sources/whoop/"]);
		expect(setSourceExcluded(vault, "whoop", false)).toBe(true);
		expect(setSourceExcluded(vault, "whoop", false)).toBe(false);
		expect(filtersOf(vault)).toEqual(["Mine/"]);
	});

	it("an add or remove that changes nothing never calls setConfig", () => {
		const vault = vaultWith(["Sources/whoop/"]);
		let writes = 0;
		const original = vault.setConfig.bind(vault);
		vault.setConfig = (key: string, value: unknown) => {
			writes++;
			original(key, value);
		};
		setSourceExcluded(vault, "whoop", true);
		setSourceExcluded(vault, "tephra", false);
		expect(writes).toBe(0);
	});

	it("two sources are independent", () => {
		const vault = vaultWith([]);
		setSourceExcluded(vault, "whoop", true);
		setSourceExcluded(vault, "tephra", true);
		setSourceExcluded(vault, "whoop", false);
		expect(filtersOf(vault)).toEqual(["Sources/tephra/"]);
	});

	it("never writes a new array over the user's list in place (the stored array is replaced, not mutated)", () => {
		const stored = ["Mine/"];
		const vault = vaultWith(stored);
		setSourceExcluded(vault, "whoop", true);
		expect(stored).toEqual(["Mine/"]);
	});

	it("a non-list value is replaced only by an add; a removal leaves it alone", () => {
		const bad = vaultWith("not a list");
		expect(setSourceExcluded(bad, "whoop", false)).toBe(false);
		expect(filtersOf(bad)).toBe("not a list");
		setSourceExcluded(bad, "whoop", true);
		expect(filtersOf(bad)).toEqual(["Sources/whoop/"]);
	});

	it("non-string items in the list are dropped when the list is rewritten, not crashed on", () => {
		const vault = vaultWith(["Mine/", 5, null]);
		setSourceExcluded(vault, "whoop", true);
		expect(filtersOf(vault)).toEqual(["Mine/", "Sources/whoop/"]);
	});

	it.each(["", ".", "..", "a/b", "a\\b", "__proto__", "x\ny"])("refuses the unsafe source name %j and writes nothing", (name) => {
		const vault = vaultWith(["Mine/"]);
		expect(setSourceExcluded(vault, name, true)).toBe(false);
		expect(filtersOf(vault)).toEqual(["Mine/"]);
	});

	it("handles Unicode names as one entry", () => {
		const vault = vaultWith([]);
		setSourceExcluded(vault, "ソース ñ", true);
		expect(filtersOf(vault)).toEqual(["Sources/ソース ñ/"]);
		setSourceExcluded(vault, "ソース ñ", false);
		expect(filtersOf(vault)).toEqual([]);
	});

	it("does nothing, and doesn't throw, when the vault has no config API", () => {
		const bare = {} as Vault;
		expect(setSourceExcluded(bare, "whoop", true)).toBe(false);
		expect(isSourceExcluded(bare, "whoop")).toBe(false);
	});
});

/**
 * Obsidian's Files and links tab builds the Excluded files pane from `userIgnoreFilters` when it renders and
 * again only on `update()`: this models that, so a test can see whether the pane lists the current entries.
 */
function appWithExcludedFilesPane(filters: unknown[]) {
	const app = new App();
	app.vault.setConfig(USER_IGNORE_FILTERS_KEY, filters);
	const pane = { listed: [...filters] as unknown[] };
	const fileTab = { id: "file", update: vi.fn(() => { pane.listed = [...(app.vault.getConfig(USER_IGNORE_FILTERS_KEY) as unknown[])]; }) };
	const otherTab = { id: "editor", update: vi.fn() };
	(app as unknown as { setting: unknown }).setting = { settingTabs: [otherTab, fileTab] };
	return { app, pane, fileTab, otherTab };
}

describe("refreshExcludedFilesPane (the pane Obsidian builds once)", () => {
	it("leaves the pane listing the old entries until it is refreshed, then lists the new one", () => {
		const { app, pane } = appWithExcludedFilesPane(["Private/"]);
		setSourceExcluded(app.vault, "whoop", true);
		expect(pane.listed).toEqual(["Private/"]); // what Obsidian does on its own: stale
		refreshExcludedFilesPane(app);
		expect(pane.listed).toEqual(["Private/", "Sources/whoop/"]);
	});

	it("updates only the Files and links tab", () => {
		const { app, fileTab, otherTab } = appWithExcludedFilesPane([]);
		refreshExcludedFilesPane(app);
		expect(fileTab.update).toHaveBeenCalledTimes(1);
		expect(otherTab.update).not.toHaveBeenCalled();
	});

	it("does nothing, and doesn't throw, without a settings API, without the tab, or when update() throws", () => {
		expect(() => refreshExcludedFilesPane(new App())).not.toThrow();
		const noTab = new App();
		(noTab as unknown as { setting: unknown }).setting = { settingTabs: [{ id: "editor" }] };
		expect(() => refreshExcludedFilesPane(noTab)).not.toThrow();
		const { app, fileTab } = appWithExcludedFilesPane([]);
		fileTab.update.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => refreshExcludedFilesPane(app)).not.toThrow();
	});
});
