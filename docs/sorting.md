---
title: Sorting and reordering
---

[Atlas Explorer](index.md) › Sorting and reordering

# Sorting and reordering

## Sort children…

Right-click a Folder, a block, file or module, or the **Bucket header** and choose **Sort children…** to order what's directly underneath it:

| Mode | Order |
|---|---|
| **Manual** | Your own drag-and-drop order. The default. |
| **A-Z** | By name. |
| **Modified** | By the file's last-modified time. |
| **Time added** | By when the item was placed under its parent. |
| **Status** | By each status's position in the governing set. Offered only when this item, or an ancestor reaching down to it, governs a [status set](statuses.md). Shown as **Status (inherited)** when the set belongs to an ancestor. |

**Reverse order** flips the direction (Z-A, oldest first, and so on). It's greyed out in Manual mode, which has no direction. Choosing any mode resets Reverse to off.

- A-Z, Modified and Time added apply to an item's **direct children** only, never to its subfolders' own children. Status is the one mode that keeps applying as you go deeper, following the same governor rules as statuses.
- Ties (same rank, same modified time) keep their existing manual order, in either direction. Folders, data-source rows and anything else with no file time of its own sort after everything that has one.
- A row that's sorted by anything other than Manual shows a small icon next to its name (the Bucket header shows it too). Hover it for a tooltip naming the mode and direction.
- **Sorting only changes how the list is drawn.** It never moves, renames or edits a file, and it never rewrites the stored manual order underneath. Switch back to Manual and your arrangement is exactly as you left it. Placing, removing and dropping into a sorted list edit the manual order underneath.

**Modified** uses a snapshot of file times that refreshes only when the explorer has a reason to: the pane regains focus, you switch view, or the tree or a sort setting changes. It never refreshes in the middle of a drag, and when focus returns because you clicked a row, the refresh waits until the click finishes. Modified also works for files listed by an outside-the-vault Folder source (their real file times); an outside sub-folder, like any item with no file time, sorts after the rest.

The toolbar's own **Sort** button is separate: it just flips the whole list between manual and A-Z order.

## Reordering by drag

Drop on a row's **top or bottom quarter** to place the dragged item next to that row in the same list. Drop on the **middle** to nest it inside the row. A row that's expanded and already showing its children has no bottom quarter (that quarter nests instead), so drop on the next row's top edge to place something after it.

- **Manual list:** a line shows where the item will land, and it lands there. If you drag several rows and drop on one of them, the selection still lands together beside that row, in the order you dragged it. Dropping on its middle nests the others into it and leaves that row where it is.
- **Sorted list (anything but Manual):** dragging an item that's already in that list onto one of its edges is refused with a notice ("<Folder> is sorted A-Z. Set it to Manual to reorder."), since the sort would only undo the move. Dragging in an item from anywhere else (the inbox, another folder, a deeper sub-folder) is allowed: the whole list is outlined (no line), the item is stored at the slot you dropped on, and it displays in its sorted place. Switching the list back to Manual shows the stored slot.
- Data-source rows, truncation placeholders and outside-the-vault children have no edge zones and can't be dropped on this way. A child you added by hand to an outside-the-vault Folder source still reorders, whatever sort that Folder has.
- Arranging never touches disk. **Place in view…** onto the folder an item is already in leaves its Time added stamp alone.
