import { beforeEach, describe, expect, it } from "vitest";
import { App, Notice } from "obsidian";
import { LINKS_NOT_UPDATED_MESSAGE, isAutoUpdateLinksOn, noticeIfLinksNotUpdated, readAlwaysUpdateLinks } from "../../src/links-notice";

const app = new App();

beforeEach(() => Notice.reset());

describe("links notice", () => {
	it("UT-N1/N2 reads the setting", () => {
		expect(isAutoUpdateLinksOn(app, () => true)).toBe(true);
		expect(isAutoUpdateLinksOn(app, () => false)).toBe(false);
	});

	it("UT-N3 a throwing reader or a non-boolean counts as on", () => {
		expect(isAutoUpdateLinksOn(app, () => { throw new Error("boom"); })).toBe(true);
		for (const value of [undefined, null, "false", 0, {}]) expect(isAutoUpdateLinksOn(app, () => value)).toBe(true);
		expect(noticeIfLinksNotUpdated(app, () => { throw new Error("boom"); })).toBe(false);
		expect(Notice.instances).toHaveLength(0);
	});

	it("UT-N4 off: exactly one notice with the exact text and a few seconds' duration", () => {
		expect(noticeIfLinksNotUpdated(app, () => false)).toBe(true);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toBe(
			"Links to this note weren't updated (Obsidian's 'Automatically update internal links' is off)"
		);
		expect(Notice.instances[0].message).toBe(LINKS_NOT_UPDATED_MESSAGE);
		expect(Notice.instances[0].duration).toBeGreaterThanOrEqual(4000);
		expect(Notice.instances[0].duration).toBeLessThanOrEqual(10000);
	});

	it("UT-N5 on: no notice", () => {
		expect(noticeIfLinksNotUpdated(app, () => true)).toBe(false);
		expect(Notice.instances).toHaveLength(0);
	});

	it("R3-6 a toggle-on predicate suppresses the notice even though the setting is off; a toggle-off predicate changes nothing", () => {
		expect(noticeIfLinksNotUpdated(app, () => false, () => true)).toBe(false);
		expect(Notice.instances).toHaveLength(0);
		expect(noticeIfLinksNotUpdated(app, () => false, () => false)).toBe(true);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toBe(LINKS_NOT_UPDATED_MESSAGE);
		Notice.reset();
		expect(noticeIfLinksNotUpdated(app, () => true, () => false)).toBe(false); // setting on, toggle off: still no notice
		expect(noticeIfLinksNotUpdated(app, () => false, undefined)).toBe(true); // no predicate: today's behaviour
	});

	it("R3-6 the predicate is read at call time, so a toggle flipped between two moves is honoured", () => {
		let toggleOn = true;
		expect(noticeIfLinksNotUpdated(app, () => false, () => toggleOn)).toBe(false);
		toggleOn = false;
		expect(noticeIfLinksNotUpdated(app, () => false, () => toggleOn)).toBe(true);
	});

	it("the default reader uses the vault's alwaysUpdateLinks config", () => {
		const a = new App();
		expect(readAlwaysUpdateLinks(a)).toBeUndefined();
		a.vault.config.alwaysUpdateLinks = false;
		expect(isAutoUpdateLinksOn(a)).toBe(false);
		a.vault.config.alwaysUpdateLinks = true;
		expect(isAutoUpdateLinksOn(a)).toBe(true);
	});
});
