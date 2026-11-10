---
title: Using the explorer
---

[Atlas Explorer](index.md) › Using the explorer

# Using the explorer

Open Atlas from the left sidebar (by default it replaces the native file explorer on startup; the native explorer stays available as a tab), or run **Atlas Explorer: Open explorer**.

## Layout

The panel is a fixed **toolbar** above **one scroll area** holding the **Bucket** (the arranged tree for the current view) and the **Inbox** (every unit not placed in this view). Neither has its own scrollbar. The two section headers are sticky and stack, Bucket on top and Inbox under it, so either header is always one click away. A header's **title** scrolls you to that section; its **chevron** collapses it. Both sections start open on every load.

### Toolbar

| Control | What it does |
|---|---|
| View name | Click to switch views. Right-click for **New view**, **Rename view**, **Delete view** (units placed only in that view return to the inbox; nothing on disk changes) and **Statuses** for the whole view. |
| Add block | Creates a new [free block](concepts.md#free-blocks) and opens it, cursor ready, with no filename prompt. |
| Add file | Creates an `Untitled` note in the vault root and opens it. |
| Add module | Creates a `New module` folder in the vault root. |
| Add folder | Adds a **Folder** (an Atlas-only label) to the bucket. |
| Sort | Toggles the whole list between manual and A-Z order. (For per-item sorting, see [Sorting](sorting.md).) |
| Collapse all | Folds every Folder and parent in the view. |
| Filter | Reveals a filter box. Matching rows, and the parents of matching rows, always show, even if they would otherwise be folded, hidden or truncated. Closing the box clears the filter. |

## Rows

- **Click** a row to open its note. A module opens its interface note; a module's **icon**, or pressing and holding the row, opens [Module contents](#module-contents). A Folder has no note, so a click does nothing and never folds it: its chevron and **Space** do that. Any module, Folder or [API item](data-sources.md#api) can instead run something when clicked: see [Click actions](#click-actions).
- **Middle-click** a bucket or inbox row's label to open it in a new, focused tab, the same as **Open in new tab**. It never changes the selection, does nothing on rows with no note to open (Folders, missing rows, data-source item rows, a module with no interface note), and is ignored when a modifier key is held.
- The row for the note currently open in the editor carries a distinct highlight (the file row, its module's row if it's the interface note, and any of its blocks). It never scrolls or expands anything. Turn it off with **Highlight the open note** in [Settings](settings.md).
- A parent row (any unit or Folder with something nested under it) has a chevron and folds and unfolds, with Space when focused.

### Right-click a unit row (a block, file or module in the bucket)

**Open**, **Open in new tab**, **Click action…** (modules only), **Reveal in native explorer**, **View module contents** (modules), **Copy link**, then **Sort children…**, **Statuses**, **Data source…** (plus **Refresh now** and **Remove data source** when one is set), **Add under…**, **Duplicate (Meta)**, **Swap with…**, **Swap for Atlas folder**, **Remove from view**, **Place in view…**, and **Create Module** (on a note directly in the vault root).

### Right-click a Folder row

**Click action…**, **Rename folder** (or F2), **Add under…**, **Replace with…**, **Swap with…**, **Sort children…**, **Statuses**, **Data source…**, **Duplicate (Meta)** and **Delete folder** (its children move up one level).

### Right-click an API item row

A row that an [API source](data-sources.md#api) filled in: **Click action…** (and **Clear click action** once one is set), then the row's note and attachment items described on the [Data sources](data-sources.md#api) page. Rows from a Table, CSV or Folder source have no **Click action…**.

### Right-click the Bucket header

**Sort children…** for the bucket's top level.

### Right-click an inbox row

**Open**, **Open in new tab**, **Reveal in native explorer**, **Create interface note** (a module with none), **Copy link**, **Place in view…**, and **Dismiss** (or **Remove** for a row you added with **+**; or **Unhide** for a dismissed row you've revealed).

## Creating, replacing and swapping

All of these are on the row's right-click menu. Choosing one that offers several kinds pops a small second menu at the same spot.

- **Add under…** creates a new **Block**, **File**, **Module** or **Folder** and nests it as the last child of the row you clicked. It writes the new file (to the pool or the vault root) and never moves an existing one. It isn't offered on a row that has a data source, or on children of an outside-the-vault source.
- **Replace with…** (on a Folder) creates a new **Block**, **File** or **Module** and swaps it in for the Folder, in the same position, with the same fold state, status settings and children. Nothing nested moves on disk.
- **Swap with…** replaces what a bucket item points at with something else, in the same spot, without touching the disk. A search box lists every file, folder and known block in the vault (up to 50 results; excluded folders and dot-folders are left out, and the item being replaced isn't offered). Pick one and the spot keeps its position, its children, its status and its data source. If the old item is no longer placed anywhere, it returns to the inbox. The same item can still sit elsewhere in the view.
- **Swap for Atlas folder** turns any item that isn't already a Folder into a Folder with a name you choose (prefilled with the item's name), keeping its children and data source.
- **Create Module** on a note in the vault root makes a folder with the name you choose and moves the note in as its interface note. Every place that note appears in every view is converted to a module. If the move fails, the new folder is removed again.
- **Duplicate (Meta)** places a second reference to the same item (and a copy of everything nested under it) right next to the original. Nothing is copied on disk, and the copy is free to be organized independently.

Data-source item rows (see [Data sources](data-sources.md)) can't be swapped, but the item that holds the source can, and the source moves with the spot.

## Drag and drop

Everything below only edits Atlas's data, except dropping on a module icon.

- **Drop on a row's middle** to nest the dragged item inside it as its last child. **Drop on its top or bottom quarter** to place it next to that row. An expanded parent has no bottom edge (that area nests), so drop on the next row's top edge to place something after it. See [Sorting](sorting.md#reordering-by-drag) for how this interacts with sorted lists.
- **Drag from the inbox into the bucket** to place a unit. **Drag from the bucket to the inbox** to remove it from the view.
- **Drop on a module's icon** to physically move a file or block into that module. This is the one drop that touches disk: it's one item at a time (a multi-item drag there does nothing), and it asks to confirm unless you turn that off in Settings.

## Multi-select

In the bucket or the inbox (selecting in one clears the other): **shift-click** for a range, **cmd/ctrl-click** to toggle one row. Dragging a selected row moves the whole selection; dragging an unselected row drags just that row. **Escape** clears the selection; **Delete** removes every selected unit from the view at once.

## Keyboard

With a row focused: **Enter** does what a click does (opens a module's or file's note, or runs the row's [Click action](#click-actions) if it has one, including on a Folder or an API item), **Space** folds or unfolds it, **F2** renames a Folder, **Delete** removes the unit from the view (no confirmation, except for a unit holding a data source, which confirms first), **Escape** clears the selection. In the name dialog, Enter confirms and Escape cancels.

## Click actions

A **Click action** makes a row run something when you click it: a terminal command, an Obsidian command or an Obsidian URI. Only modules, Folders and API items (rows filled in by an [API source](data-sources.md#api)) can have one, and only in the Bucket. Inbox rows, Module contents rows and the native explorer are unchanged.

Which kinds each row offers in the **Kind** dropdown:

| Row | Kinds |
|---|---|
| Module | **Default (open the interface note)**, **Run terminal command (desktop only)**, **Run Obsidian command**, **Open Obsidian URI** |
| Folder | **None**, **Run terminal command (desktop only)**, **Run Obsidian command**, **Open Obsidian URI** |
| API item | **Use source setting**, **None**, **Run terminal command (desktop only)**, **Run Obsidian command**, **Open Obsidian URI** |

### Set one

Right-click the row, choose **Click action…**, pick a **Kind**, enter or pick a value, and press **Save**. For example, to start an app from a module: right-click the module, choose **Click action…** (the Kind reads **Default (open the interface note)**), pick **Run Obsidian command**, press **Choose command…**, search for the command, choose it, and **Save**. Clicking the module now runs that command and its note does not open. For a Folder, the same steps with **Run terminal command (desktop only)** and the value `open -a Docker` make a click open Docker, and the Folder stays folded or unfolded as it was.

To clear one, pick **Default (open the interface note)** (module) or **None** (Folder) and Save. On an API item, **Clear click action** on its right-click menu removes the override (it appears only while one is set). An API item's **None** is different: it is an action that does nothing, and it stops the source's Click function and click setting from running for that row. See [Data sources](data-sources.md#item-override).

### What each kind needs

- **Run terminal command (desktop only)**: a command line, such as `open -a Docker`. It runs directly, without a shell, so pipes, redirects, `&&`, globbing, `~` and environment variables do not work, and a shell form such as `sh -c` is not supported. `{field}` placeholders work only in an API source's own static command (see [Data sources](data-sources.md#api)); in a module, Folder or item action a placeholder gives a notice when you click. Save is blocked on an empty value or unbalanced quotes.
- **Run Obsidian command**: chosen from a picker of the commands registered right now, by display name. Atlas stores the command's id. If that id is not registered when you click (a plugin is off, or the setting synced to a device without it), a notice says `Atlas: command not found: <id>` and the setting is kept.
- **Open Obsidian URI**: any URI that `new URL()` accepts and that carries a scheme (`obsidian://…`, `https://…`, `mailto:…`). It runs exactly as typed: Atlas adds nothing and rewrites nothing, not even a vault name. If it cannot be opened, a notice says `Atlas: couldn't open URI`.

### When it runs

A plain click on the row, or **Enter** on the focused row, runs the action. Nothing else does: not cmd/ctrl-click, shift-click, drag or middle-click, and not a click on a module's icon, a status dot or the chevron. A modifier-click keeps its usual selection meaning.

A long press on a module does not run it either (it opens Module contents). Only a module has that guard: a long press on a Folder or an API item counts as a click and runs the action.

Only a module's icon is a control of its own (it opens Module contents). A Folder's icon and an API item's icon have no job of their own, so a click on either runs the action.

- A failure shows a notice and changes nothing. Success is silent.
- A second run of the same row within 1 second of the first is ignored, with no feedback.
- A **Folder** click runs the action only and does not fold. The chevron and **Space** still fold, and **Enter** on a Folder runs its action.
- A module with an action runs it instead of opening its note; the module's icon and a long press still open Module contents. A module with no action keeps opening its interface note on click and **Enter**. Either way the note stays reachable through right-click **Open** and middle-click.
- An API item runs the first thing that applies: its own override, then the source's Click function, then the source's click setting. See [Data sources](data-sources.md#click-function).

### On mobile

Terminal commands are desktop only. The terminal kind is hidden when you set a new action on mobile. A terminal action that synced from desktop is shown read-only, and clicking it shows `Atlas: terminal actions are desktop only`; the setting is kept. The command and URI kinds work.

## The inbox

The inbox lists every unit not placed in the current view. With **Auto-promote linked items** off (the default), items that only a link or embed promoted are left out; see [Settings](settings.md).

- **This view / Global** toggles between the view's own inbox and the global one (units placed in no view at all).
- **+** adds any file or sub-folder from the vault, found with a fuzzy-search box. That includes a linked item that **Auto-promote linked items** (or a hide in Module contents) keeps out of the inbox; items already in the inbox, placed in a view or dismissed are left out of the list. To get a dismissed linked item back, turn **Auto-promote linked items** on, choose **Show Dismissed** and **Unhide** it, then turn the switch off again: while the switch is off, **Show Dismissed** doesn't list items the switch keeps out. Added items carry an **added** tag; an added sub-folder is a module. Added items are kept until you remove them.
- **Dismiss** hides an inbox row. Dismissing in a single view hides it in that view; dismissing while the inbox is on **Global** hides it everywhere. A dismissed row stays dismissed even if something later links to it. Right-click the inbox header and choose **Show Dismissed** (or **Hide Dismissed**) to reveal dismissed rows inline, and **Unhide** on one to bring it back. Dismissing never affects manual promotions.
- Status dots can't be assigned to inbox rows. Place the unit in the bucket first.

## Module contents

Click a module's icon (or choose **View module contents**) to see its internals, or press and hold anywhere on a module row for half a second. Moving the pointer more than 5 pixels, or releasing early, cancels the hold; a right-click never starts one. Internals aren't units until promoted. Right-click an item there for **Reveal in native explorer**, **Promote and place in view…** or **Promote to inbox**.

- **Hide / unhide**: the eye button on each row hides that item (a folder hides what's under it). Hidden rows are dimmed, and the choice is remembered per module. An item hidden from one module also shows as hidden when you reach it through an added sub-folder's own module, and unhiding it from either place unhides it everywhere. If the added sub-folder itself (or a folder above it) is hidden, its module opens dimmed with a notice and an **Unhide** button. A hidden item that only a link promoted stays out of the inbox; items you promoted, added or placed yourself are not affected. Nothing on disk changes, and links to the item still resolve.
- **Drag out**: drag an item out of the modal and the modal fades so what's behind it can take the drop. Drop it on the Inbox to add it there (with the **added** pill), or on the view to promote and place it. Dropping anywhere else, or back inside the modal, cancels and changes nothing, and so does pressing **Escape** mid-drag: the modal returns to full opacity and stays open.

## Writing links: the `[[` suggester

Typing `[[` in a note opens Atlas's own link suggester in place of Obsidian's. It finds files, modules (inserting a link to the interface note, created on demand), and free blocks by their *content* rather than their ID filename, sorting an Atlas unit above a plain file only when its match is at least as good as the best file match. Choosing a free block inserts a link that Atlas displays as the block's text (in Live Preview and in reading view) and shows a hover preview for. Atlas shows at most 50 suggestions.

## Statuses, sorting and data sources

These each have their own page: [Statuses](statuses.md), [Sorting and reordering](sorting.md), [Data sources](data-sources.md).
