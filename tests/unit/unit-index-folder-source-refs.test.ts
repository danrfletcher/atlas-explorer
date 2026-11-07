import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";
import type { UnitRef } from "../../src/types";

/** PR-2 (S3): `setFolderSourceRefs` is called with the complete managed-ref list after every views change,
 * so the same list again must not tell the explorer anything; a different one must, once. */

function makeIndex(): { index: UnitIndex; listener: ReturnType<typeof vi.fn> } {
	const app = new App();
	seedRoot(app, ["Ideas/Quarry Drones.md", "Ideas/Other.md"], ["Ideas"]);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, [], {}, [], []);
	index.rebuild();
	const listener = vi.fn();
	index.onChange(listener);
	return { index, listener };
}

const file = (path: string): UnitRef => ({ kind: "file", path });

describe("PR-2 (S3): UnitIndex.setFolderSourceRefs notifies only when the refs changed", () => {
	it("the same refs notify nobody, however often they are set", () => {
		const { index, listener } = makeIndex();
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md"), { kind: "folder", path: "Ideas" }]);
		listener.mockClear();

		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md"), { kind: "folder", path: "Ideas" }]);
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md"), { kind: "folder", path: "Ideas" }]);

		expect(listener).not.toHaveBeenCalled();
	});

	it("the same refs in another order notify nobody", () => {
		const { index, listener } = makeIndex();
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md"), file("Ideas/Other.md")]);
		listener.mockClear();

		index.setFolderSourceRefs([file("Ideas/Other.md"), file("Ideas/Quarry Drones.md")]);

		expect(listener).not.toHaveBeenCalled();
	});

	it("an added ref notifies once, and the unit then resolves", () => {
		const { index, listener } = makeIndex();
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md")]);
		listener.mockClear();

		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md"), { kind: "block", path: "Ideas/Other.md", subpath: "^abc" }]);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(index.getUnits().some((u) => u.type === "promoted-block" && u.path === "Ideas/Other.md")).toBe(true);
	});

	it("a dropped ref notifies once", () => {
		const { index, listener } = makeIndex();
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md"), file("Ideas/Other.md")]);
		listener.mockClear();

		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md")]);

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("clearing a non-empty set notifies once; setting an empty set again notifies nobody", () => {
		const { index, listener } = makeIndex();
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md")]);
		listener.mockClear();

		index.setFolderSourceRefs([]);
		expect(listener).toHaveBeenCalledTimes(1);
		index.setFolderSourceRefs([]);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("a swap of one ref for another of the same count notifies once", () => {
		const { index, listener } = makeIndex();
		index.setFolderSourceRefs([file("Ideas/Quarry Drones.md")]);
		listener.mockClear();

		index.setFolderSourceRefs([file("Ideas/Other.md")]);

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
