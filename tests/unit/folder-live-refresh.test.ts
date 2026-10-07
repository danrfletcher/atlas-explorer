import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FOLDER_LIVE_REFRESH_DEBOUNCE_MS,
	FOLDER_LIVE_REFRESH_MAX_WAIT_MS,
	FolderLiveRefresh,
} from "../../src/folder-live-refresh";
import { parentFolderPath } from "../../src/folder-source";

/** PR-1 (G5): the per-source trailing debounce with a maximum wait, and the `parentFolderPath` helper
 * the live trigger keys on. Fake timers only. */

describe("PR-1 (G5): FolderLiveRefresh", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses a 300 ms debounce and a 2 s maximum wait", () => {
		expect(FOLDER_LIVE_REFRESH_DEBOUNCE_MS).toBe(300);
		expect(FOLDER_LIVE_REFRESH_MAX_WAIT_MS).toBe(2000);
	});

	it("fires once, 300 ms after a single schedule", () => {
		const onDue = vi.fn();
		const live = new FolderLiveRefresh(onDue);
		live.schedule("src");
		vi.advanceTimersByTime(299);
		expect(onDue).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onDue).toHaveBeenCalledTimes(1);
		expect(onDue).toHaveBeenCalledWith("src");
	});

	it("restarts the debounce on every schedule for the same node", () => {
		const onDue = vi.fn();
		const live = new FolderLiveRefresh(onDue);
		live.schedule("src");
		vi.advanceTimersByTime(200);
		live.schedule("src");
		vi.advanceTimersByTime(200);
		expect(onDue).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(onDue).toHaveBeenCalledTimes(1);
	});

	it("a continuous stream fires at the 2 s maximum wait, not starved", () => {
		const onDue = vi.fn();
		const live = new FolderLiveRefresh(onDue);
		for (let t = 0; t < 2000; t += 100) {
			live.schedule("src");
			vi.advanceTimersByTime(100);
		}
		expect(onDue).toHaveBeenCalledTimes(1);
	});

	it("nodes are independent: each gets its own single refresh", () => {
		const onDue = vi.fn();
		const live = new FolderLiveRefresh(onDue);
		live.schedule("a");
		live.schedule("b");
		live.schedule("a");
		vi.advanceTimersByTime(300);
		expect(onDue.mock.calls.map((call) => call[0]).sort()).toEqual(["a", "b"]);
	});

	it("a node can be scheduled again after it has fired", () => {
		const onDue = vi.fn();
		const live = new FolderLiveRefresh(onDue);
		live.schedule("src");
		vi.advanceTimersByTime(300);
		live.schedule("src");
		vi.advanceTimersByTime(300);
		expect(onDue).toHaveBeenCalledTimes(2);
	});

	it("cancelAll drops every pending refresh and leaves no timers behind", () => {
		const onDue = vi.fn();
		const live = new FolderLiveRefresh(onDue);
		live.schedule("a");
		live.schedule("b");
		live.cancelAll();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(onDue).not.toHaveBeenCalled();
	});

	it("a fired refresh leaves no timers behind", () => {
		const live = new FolderLiveRefresh(vi.fn());
		live.schedule("src");
		vi.advanceTimersByTime(300);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("PR-1 (G5): parentFolderPath", () => {
	it("returns the folder that directly contains a path", () => {
		expect(parentFolderPath("Projects/Clients/Hartley.md")).toBe("Projects/Clients");
		expect(parentFolderPath("Projects/Clients")).toBe("Projects");
	});

	it("returns an empty string for a path at the vault root", () => {
		expect(parentFolderPath("Note.md")).toBe("");
	});
});
