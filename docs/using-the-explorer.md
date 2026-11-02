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

- **Click** a row to open its note. A module opens its interface note; a module's **icon** opens [Module contents](#module-contents). A Folder row just folds and unfolds.
- **Middle-click** a bucket or inbox row's label to open it in a new, focused tab, the same as **Open in new tab**. It never changes the selection, does nothing on rows with no note to open (Folders, missing rows, data-source item rows, a module with no interface note), and is ignored when a modifier key is held.
- The row for the note currently open in the editor carries a distinct highlight (the file row, its module's row if it's the interface note, and any of its blocks). It never scrolls or expands anything. Turn it off with **Highlight the open note** in [Settings](settings.md).
- A parent row (any unit or Folder with something nested under it) has a chevron and folds and unfolds, with Space when focused.

### Right-click a unit row (a block, file or module in the bucket)

**Open**, **Open in new tab**, **Reveal in native explorer**, **View module contents** (modules), **Copy link**, then **Sort children…**, **Statuses**, **Data source…** (plus **Refresh now** and **Remove data source** when one is set), **Add under…**, **Duplicate (Meta)**, **Swap with…**, **Swap for Atlas folder**, **Remove from view**, **Place in view…**, and **Create Module** (on a note directly in the vault root).

### Right-click a Folder row

**Rename folder** (or F2), **Add under…**, **Replace with…**, **Swap with…**, **Sort children…**, **Statuses**, **Data source…**, **Duplicate (Meta)** and **Delete folder** (its children move up one level).

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

With a row focused: **Enter** opens it, **Space** folds or unfolds it, **F2** renames a Folder, **Delete** removes the unit from the view (no confirmation, except for a unit holding a data source, which confirms first), **Escape** clears the selection. In the name dialog, Enter confirms and Escape cancels.

## The inbox

The inbox lists every unit not placed in the current view.

- **This view / Global** toggles between the view's own inbox and the global one (units placed in no view at all).
- **+** adds any file or sub-folder from the vault, found with a fuzzy-search box. Added items carry an **added** tag; an added sub-folder is a module. Added items are kept until you remove them.
- **Dismiss** hides an inbox row. Dismissing in a single view hides it in that view; dismissing while the inbox is on **Global** hides it everywhere. A dismissed row stays dismissed even if something later links to it. Right-click the inbox header and choose **Show Dismissed** (or **Hide Dismissed**) to reveal dismissed rows inline, and **Unhide** on one to bring it back. Dismissing never affects manual promotions.
- Status dots can't be assigned to inbox rows. Place the unit in the bucket first.

## Module contents

Click a module's icon (or choose **View module contents**) to see its internals. Internals aren't units until promoted. Right-click an item there for **Reveal in native explorer** or **Promote and place in view…**.

## Writing links: the `[[` suggester

Typing `[[` in a note opens Atlas's own link suggester in place of Obsidian's. It finds files, modules (inserting a link to the interface note, created on demand), and free blocks by their *content* rather than their ID filename, sorting an Atlas unit above a plain file only when its match is at least as good as the best file match. Choosing a free block inserts a link that Atlas displays as the block's text (in Live Preview and in reading view) and shows a hover preview for. Atlas shows at most 50 suggestions.

## Statuses, sorting and data sources

These each have their own page: [Statuses](statuses.md), [Sorting and reordering](sorting.md), [Data sources](data-sources.md).
