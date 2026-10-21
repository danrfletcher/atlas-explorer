---
title: Atlas
---

# Atlas

A replacement file explorer for Obsidian that shows every meaningful unit in your vault — blocks, files, folders — as one flat list, and lets you arrange those units into as many hierarchies as you like, without ever moving anything on disk.

![The Atlas explorer](images/explorer.png)

**Status: pre-release, under active development.** Not yet on the community plugin store.

For the full model write-up, settings, commands, and install instructions, see the [README on GitHub](https://github.com/danrfletcher/atlas#readme).

For every judgement call made during the build, the alternatives considered, and why, see [decisions.md](decisions.md).

## Sorting and reordering

Right-click a Folder, a block, file or module, or the Bucket header and choose **Sort children…** to order what's directly underneath it: **Manual** (your own drag order), **A-Z**, **Modified**, **Time added**, or **Status** (when a status set governs it). **Reverse order** flips the direction. A sorted row shows a small icon next to its name; hover it to see the mode. Sorting only changes how the list is drawn: it never moves or edits a file, and switching back to Manual restores your arrangement exactly.

Modified-sort's file times refresh when the explorer has a reason to (the pane regains focus, you switch view, or the tree or a sort setting changes), never while you are dragging, and never in the middle of a click.

To reorder, drag an item onto the top or bottom quarter of a row to place it next to that row, or onto the middle to nest it (if you drag several rows and drop on one of them, the selection lands together beside that row). In a **sorted** list, dragging one of its own items onto an edge is refused with a notice (set the list to Manual first); dragging in an item from elsewhere is allowed, outlines the whole list, and shows the item in its sorted place. See the [README](https://github.com/danrfletcher/atlas#sorting) for the full rules.
