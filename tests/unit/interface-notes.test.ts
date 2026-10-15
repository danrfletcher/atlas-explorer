import { describe, expect, it } from "vitest";
import { App, TFolder } from "obsidian";
import { findInterfaceNote } from "../../src/interface-notes";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { seedRoot } from "../helpers";

function vaultWith(folders: string[], files: string[] = []): App {
	const app = new App();
	const seeded = new Set<string>();
	for (const folder of folders) {
		const parts = folder.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i).join("/");
			if (!seeded.has(path)) {
				seeded.add(path);
				app.vault.seedFolder(path);
			}
		}
	}
	seedRoot(app, files);
	return app;
}

function getFolder(app: App, path: string): TFolder {
	const folder = app.vault.getAbstractFileByPath(path);
	if (!(folder instanceof TFolder)) throw new Error(`not a folder: ${path}`);
	return folder;
}

describe("findInterfaceNote case-variant rule (PR-1 R3)", () => {
	it("the exact-case conventional note is used when it exists, even alongside a case-variant sibling", () => {
		const app = vaultWith(["Deep"], ["Deep/deep.md", "Deep/Deep.md"]);
		const note = findInterfaceNote(app, getFolder(app, "Deep"), DEFAULT_SETTINGS);
		expect(note?.path).toBe("Deep/Deep.md");
	});

	it("a lowercase case-variant sibling is adopted as the interface note when the exact-case name is missing", () => {
		const app = vaultWith(["Deep"], ["Deep/deep.md"]);
		const note = findInterfaceNote(app, getFolder(app, "Deep"), DEFAULT_SETTINGS);
		expect(note?.path).toBe("Deep/deep.md");
	});

	it("an uppercase case-variant sibling is also adopted when the exact-case name is missing", () => {
		const app = vaultWith(["deep"], ["deep/Deep.md"]);
		const note = findInterfaceNote(app, getFolder(app, "deep"), DEFAULT_SETTINGS);
		expect(note?.path).toBe("deep/Deep.md");
	});

	it("returns null when neither the exact name nor a case-variant sibling exists", () => {
		const app = vaultWith(["Deep"], ["Deep/other.md"]);
		const note = findInterfaceNote(app, getFolder(app, "Deep"), DEFAULT_SETTINGS);
		expect(note).toBeNull();
	});
});
