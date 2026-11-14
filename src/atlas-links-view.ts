import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { ATLAS_LINKS_VIEW_TYPE } from "./backlinks-section";

/**
 * G10 fallback: the "Atlas Links" pane. It holds no logic. `TephraBacklinksSection` finds this view's `contentEl`
 * among the `atlas-links` leaves and puts the same "Also linked from (Tephra)" list in it that the Backlinks panel
 * would get. With the Tephra toggle off it stays empty. Opened by `Atlas: Open Links pane`.
 */
export class AtlasLinksView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly onOpened: () => void) {
		super(leaf);
	}

	getViewType(): string {
		return ATLAS_LINKS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Atlas Links";
	}

	getIcon(): string {
		return "links-coming-in";
	}

	onOpen(): Promise<void> {
		this.contentEl.addClass("atlas-links-pane");
		this.onOpened();
		return Promise.resolve();
	}
}
