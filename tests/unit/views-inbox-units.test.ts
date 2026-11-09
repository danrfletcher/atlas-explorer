import { describe, expect, it } from "vitest";
import { BASE_KEYS, LINK_ONLY_KEYS, USER_CHOICE_KEYS, buildFixture, inboxKeys, keysOf } from "../auto-promotion-fixtures";
import { unitRefKey, unitToRef } from "../../src/types";

/** PR-1 (G1): `ViewsManager.getInboxUnits` against the real `UnitIndex`, with the auto-promotion
 * setting on and off, for every unit kind the inbox can hold. */

interface Row {
	kind: string;
	unitType: string;
	key: string;
	/** Does the unit reach the inbox with auto-promotion on / off. */
	whenOn: boolean;
	whenOff: boolean;
}

const TABLE: Row[] = [
	{ kind: "promoted-file (link only)", unitType: "promoted-file", key: "file:Alpha/linked.md", whenOn: true, whenOff: false },
	{ kind: "promoted-file (linked from two notes)", unitType: "promoted-file", key: "file:Alpha/dup.md", whenOn: true, whenOff: false },
	{ kind: "promoted-file (attachment, link only)", unitType: "promoted-file", key: "file:Attachments/scan.png", whenOn: true, whenOff: false },
	{ kind: "promoted-folder (link only)", unitType: "promoted-folder", key: "folder:Beta/Sub", whenOn: true, whenOff: false },
	{ kind: "promoted-block (link only)", unitType: "promoted-block", key: "block:Beta/page.md#^linked", whenOn: true, whenOff: false },
	{ kind: "promoted-file (manual promotion, not linked)", unitType: "promoted-file", key: "file:Alpha/manual.md", whenOn: true, whenOff: true },
	{ kind: "promoted-file (linked and manually promoted)", unitType: "promoted-file", key: "file:Alpha/both.md", whenOn: true, whenOff: true },
	{ kind: "promoted-block (linked and manually promoted)", unitType: "promoted-block", key: "block:Beta/page.md#^manual", whenOn: true, whenOff: true },
	{ kind: "added-file (linked and added)", unitType: "added-file", key: "file:Alpha/addedLinked.md", whenOn: true, whenOff: true },
	{ kind: "added-file", unitType: "added-file", key: "file:Beta/addedOnly.md", whenOn: true, whenOff: true },
	{ kind: "added-folder", unitType: "added-folder", key: "folder:Beta/Sub2", whenOn: true, whenOff: true },
	{ kind: "folder-unit", unitType: "folder-unit", key: "folder:Alpha", whenOn: true, whenOff: true },
	{ kind: "root-file", unitType: "root-file", key: "file:Hub.md", whenOn: true, whenOff: true },
];

describe.each(["view", "global"] as const)("ViewsManager.getInboxUnits — autoPromotion, %s mode", (mode) => {
	describe.each(TABLE)("$kind", (row) => {
		it(`is a ${row.unitType} unit in the index`, () => {
			const fx = buildFixture({ autoPromotion: true });
			const unit = fx.index.getUnits().find((u) => unitRefKey(unitToRef(u)) === row.key);
			expect(unit?.type).toBe(row.unitType);
		});

		it(`autoPromotion on: ${row.whenOn ? "in" : "not in"} the inbox`, () => {
			expect(inboxKeys(buildFixture({ autoPromotion: true }), mode).includes(row.key)).toBe(row.whenOn);
		});

		it(`autoPromotion off: ${row.whenOff ? "in" : "not in"} the inbox`, () => {
			expect(inboxKeys(buildFixture({ autoPromotion: false }), mode).includes(row.key)).toBe(row.whenOff);
		});
	});

	it("the default settings leave link-only units out (the switch is off by default)", () => {
		const fx = buildFixture();
		const keys = inboxKeys(fx, mode);
		for (const key of LINK_ONLY_KEYS) expect(keys, key).not.toContain(key);
		for (const key of USER_CHOICE_KEYS) expect(keys, key).toContain(key);
	});

	it("turning the switch on adds exactly the link-only units and removes nothing", () => {
		const fx = buildFixture({ autoPromotion: false });
		const off = inboxKeys(fx, mode);
		fx.settings.autoPromotion = true;
		const on = inboxKeys(fx, mode);
		expect(on.filter((k) => !off.includes(k))).toEqual([...LINK_ONLY_KEYS].sort());
		expect(off.filter((k) => !on.includes(k))).toEqual([]);
	});

	it("a placed unit is not in the inbox with the switch on or off", () => {
		const fx = buildFixture({ autoPromotion: true });
		expect(inboxKeys(fx, mode)).not.toContain("file:Alpha/placed.md");
		fx.settings.autoPromotion = false;
		expect(inboxKeys(fx, mode)).not.toContain("file:Alpha/placed.md");
	});

	it("empty inbox: with the switch off and nothing promoted or added, the inbox holds only base units and does not throw", () => {
		const fx = buildFixture({ autoPromotion: false });
		for (const key of USER_CHOICE_KEYS) {
			const ref = key.startsWith("folder:")
				? { kind: "folder" as const, path: key.slice(7) }
				: key.startsWith("block:")
					? { kind: "block" as const, path: key.slice(6).split("#")[0], subpath: key.split("#")[1] }
					: { kind: "file" as const, path: key.slice(5) };
			fx.index.removeManualPromotion(ref);
			fx.index.removeAdded(ref);
		}
		let keys: string[] = [];
		expect(() => (keys = inboxKeys(fx, mode))).not.toThrow();
		expect(keys).toEqual([...BASE_KEYS].sort());
	});

	it("the dismissed list never reveals a link-only unit while the switch is off", () => {
		const fx = buildFixture({ autoPromotion: false });
		fx.index.setDismissed({ kind: "file", path: "Alpha/linked.md" }, "global", true);
		fx.index.setDismissed({ kind: "file", path: "Alpha/manual.md" }, "global", true);
		const dismissed = keysOf(fx.views.getDismissedInboxUnits(fx.index.getUnits(), fx.viewId, mode, fx.index));
		expect(dismissed).toEqual(["file:Alpha/manual.md"]);
		fx.settings.autoPromotion = true;
		const dismissedOn = keysOf(fx.views.getDismissedInboxUnits(fx.index.getUnits(), fx.viewId, mode, fx.index));
		expect(dismissedOn).toEqual(["file:Alpha/linked.md", "file:Alpha/manual.md"]);
	});
});
