import { Notice } from "obsidian";
import type AtlasPlugin from "./main";

/** `Atlas Explorer: Copy render log` — puts the render log on the clipboard as JSON. No hotkey, no
 * setting, no other UI: this is the log's only surface. */
export function registerRenderLogCommand(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "copy-render-log",
		name: "Copy render log",
		callback: () => void copyRenderLog(plugin),
	});
}

async function copyRenderLog(plugin: AtlasPlugin): Promise<void> {
	const count = plugin.renderLog.entries().length;
	try {
		await navigator.clipboard.writeText(plugin.renderLog.serialize());
	} catch {
		new Notice("Atlas: couldn't copy the render log to the clipboard.");
		return;
	}
	new Notice(count === 0 ? "Atlas: render log is empty — copied [] to the clipboard." : `Atlas: copied ${count} render log entries to the clipboard.`);
}
