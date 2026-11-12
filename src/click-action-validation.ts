import { validateCommand } from "./command-argv";
import { ClickActionKind } from "./types";

export type ClickActionValidation = { ok: true } | { ok: false; error: string };

/** Atlas-18 (G4/G5/G6, E4/E5): whether `value` may be saved as a Click action of `kind`. Pure: no DOM, no
 * app, no platform. The value is only checked, never changed, so what is stored is exactly what was typed.
 *
 * - `terminal`: a command line, checked with the same tokenizer the terminal runner uses (no shell).
 *   Blank or whitespace-only, and unbalanced quotes, are refused. `{field}` placeholders are deliberately
 *   not checked here: on a module, Folder or item override there is no field list to check them against,
 *   and the existing resolve-error notice belongs to the click, not to Save.
 * - `command`: a command id; it only has to be non-blank. Whether it is registered right now is not a
 *   save-time rule (a synced id for a plugin missing on this device must still save unchanged, E1/G5).
 * - `uri`: accepted by `new URL()`, which for a string with no base already requires a scheme. Any scheme
 *   passes (`obsidian:`, `https:`, `mailto:` and so on). */
export function validateClickActionValue(kind: ClickActionKind, value: string): ClickActionValidation {
	if (kind === "terminal") {
		const result = validateCommand(value);
		return result.ok ? { ok: true } : { ok: false, error: result.error };
	}
	if (kind === "command") {
		return value.trim() === "" ? { ok: false, error: "Choose a command" } : { ok: true };
	}
	if (value.trim() === "") return { ok: false, error: "Enter a URI" };
	try {
		if (new URL(value).protocol.length > 1) return { ok: true };
	} catch {
		// falls through to the shared message below
	}
	return { ok: false, error: "Enter a full URI with a scheme, such as obsidian://open?vault=Notes or https://example.com" };
}
