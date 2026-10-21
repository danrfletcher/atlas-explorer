# Atlas

A replacement file explorer for Obsidian that shows every meaningful unit in your vault — blocks, files, folders — as one flat list, and lets you arrange those units into as many hierarchies as you like, without ever moving anything on disk.

![The Atlas explorer: a bucket (arranged tree) above an inbox (everything not yet arranged)](docs/images/explorer.png)

**Status: pre-release, under active development.** Not yet on the community plugin store. See [TASKS.md](TASKS.md) for build progress and exactly what's been verified live vs. code-reviewed.

## Why

Folder paths in Obsidian do two jobs at once: they say what a thing *is* (stable) and what status it *has* (changes constantly). Every status change means a move, and every move breaks relative links and anything wired to that path. The fix is to stop using the folder hierarchy as an address book. Atlas separates the two jobs: the folder hierarchy on disk stays fixed, and you arrange things into any number of named **views** — drawings over the vault, not addresses for it. Rearranging becomes editing a drawing; nothing underneath moves.

## The model

### Three kinds of unit

A **unit** is anything that (a) has an address you can link to, and (b) means the same thing when taken out of its surroundings.

| Kind | Example | Address |
|---|---|---|
| **Block** | one paragraph, one bullet, one heading | `[[file#^id]]`, `[[file#Heading]]`, or a pool file (below) |
| **File** | a note, a document | `[[name]]` |
| **Folder** | a system — an agent, a codebase, a course | its interface note (below) |

### Capture at the largest self-contained level; promote on link

You capture a thing at the largest level where it's self-contained. A chat transcript is a file. An agent system is a folder. Anything *inside* a unit is internals, and internals are not units — until something outside links to them, at which point they're **promoted** into a unit in their own right. This applies at every level with no special cases: a folder is a unit at capture; a file inside it stays internals until something outside the folder links to it; a block inside that file stays internals until something links to *it*.

So `Bets/steps/step-3.md` isn't a unit today. The day something outside `Bets/` links to it, it is.

### Free blocks

A thought too small to deserve a filename still needs to exist. These are **free blocks**: markdown files in a **pool folder** (default `_pool/`, configurable) whose filenames are auto-generated IDs the user never types or sees. The explorer shows a free block by its first line, never by its ID. Under the hood it's a file; to the user it's a block. A free block that grows into a full document just keeps growing — nothing has to happen at the moment it crosses from "block" to "file".

### Modules

Every folder is a unit — a **module** whose **interface** is a note saying what the folder is and what it's responsible for, with everything else inside as internals. (Internally the codebase still calls this a "folder-unit" — the model is the same one from the original spec, just renamed in the UI.)

- The interface note is `<Folder>/<Folder>.md` by default. A module without one is still a unit; the explorer offers to create it.
- Clicking a module's name opens its interface note. Clicking its icon opens a "Module contents" view of its internals instead.
- A module's properties are its interface note's properties.
- Atlas never rearranges a module's internal organization on disk — with one deliberate, always-confirmable exception: dragging a file or block directly onto a module's **icon**. Physical moves otherwise stay in Obsidian's native explorer (still available as a tab).

### Views, bucket, inbox

- A **view** is one arrangement of units into a hierarchy. There can be many; the same unit can sit in many at once; no view is "the real one."
- Inside a view, the **bucket** is the arranged tree, and **folders** are its branches — labels, not folders on disk (not to be confused with modules, which *are* real folders on disk).
- A view's **inbox** is every unit not placed in that view. The **global inbox** is every unit placed in no view at all.
- Placing or removing a unit in the bucket never touches disk.
- Any block, file, or module can become the organizational parent of any other bucket item too, the same way a folder can — drag one onto another's row (anywhere except a module's icon, which stays reserved for the on-disk move above) to nest it underneath. Nothing on disk moves; a unit just gains a chevron and can be folded/unfolded like a folder can.
- **Multi-select**: shift-click for a range, cmd/ctrl-click to toggle one row in or out — in either the bucket or the inbox (selecting in one clears the other). Dragging any selected row moves the whole selection together; dragging a row that isn't selected drags just that row instead. Escape clears the selection; Delete removes every selected unit from the view at once. The one exception: dropping onto a module's **icon** (the real disk-move gesture above) only ever acts on a single item — a multi-item drag there is a no-op, not a bulk file move.

## Installing (development)

This plugin is not yet published to the community plugin store. To try it:

```bash
npm install
npm run build   # or `npm run dev` to watch
```

Then enable "Atlas" under Settings → Community plugins, in a vault where this folder is `.obsidian/plugins/atlas`.

## Settings

![Atlas settings tab](docs/images/settings.png)

The settings panel has two tabs: **Basic** and **Status**.

### Basic

| Setting | Default | What it does |
|---|---|---|
| Pool folder | `_pool` | Where free blocks live. Created on demand the first time you add a block. |
| Excluded folders | pool folder, `_to_delete` | Never appear in the explorer or any inbox — except files in the pool folder, which still show as free blocks. |
| Interface note convention | `<Folder>/<Folder>.md` | Toggle to also accept `index.md` / `README.md` as a folder's interface note. |
| Replace native explorer on startup | on | Makes Atlas the active view in the left sidebar on launch. The native explorer stays available as a tab. |
| Block display length | 80 | How many characters of a free block's first line to show in the explorer. |
| Confirm before adding a unit to a module | on | Ask before a drag onto a module's icon physically files something into it. Off skips the confirmation, not the move. |
| Default view on launch | — | Which view Atlas opens to when the vault loads. |

### MCP server

Off by default. When turned on, Atlas runs a small MCP (Model Context Protocol) server on `127.0.0.1` so a local agent (e.g. Titan) can call it over HTTP with JSON-RPC 2.0, including the standard `initialize`/`tools/list` handshake. The toggle itself is a synced setting; the port and the bearer token every request must present are both device-local — they never sync to another device, the same way Folder/API source credentials don't. The port defaults to `27202` and is editable per vault per device (so two vaults open on the same machine can use different ports): type a value from 1024–65535, committed on blur or Enter (not on every keystroke, so a multi-digit value never binds-then-rebinds through every prefix along the way), which restarts the server immediately if it's enabled. The settings panel shows the current token (copyable) and a **Regenerate** button; regenerating writes a new token immediately and the old one stops working at once. The server ships `atlas_status`, which returns the vault's name, absolute path, the plugin's version and the list of enabled tools — enough for an agent to confirm it reached the right vault before anything else — plus five tools for reading and writing node statuses: `list_views` (every view's id, name and inbox mode), `list_nodes` (a view's node tree — id, type, label/ref, explicit and resolved status, children — defaulting to the currently-open view), `list_status_sets` (every status set's id, name, ordered statuses and default), `get_node_status` (a node's own explicit status, its resolved/inherited status and governing status set; `null` resolved status when nothing governs the node is a normal reply, not an error), and `set_node_status` (writes a status by label, case-insensitive, against the node's governing set; always requires an explicit `view`, never falls back to the active one). A node is addressed by its id, or by vault path only when that path matches exactly one node in the view — an ambiguous path is refused, listing every match and its id. Status writes go through the same save path as clicking a status dot in the explorer; they never touch file/folder content or placement. The server also ships five arranging tools, which operate on the view tree the same way the explorer's own drag-and-drop and context menus do: `add_node` (places an existing vault unit — file, block or module — under a parent node, or the view root, in a named view; a module-internal file/folder/block that merely hasn't been promoted into the explorer yet is promoted automatically, the same thing "Promote and place in view…" does by hand), `move_node` (reparents or reorders an existing node within one view, refusing a drop into the node's own descendant or onto itself — `ViewsManager.moveNode`'s own guard), `remove_node` (removes one node instance, lifting its children into its old slot — the same thing "Remove from view" does, including clearing a removed sourced node's device-local headers/Outside-Vault path), `create_folder` (creates an Atlas-only meta folder — a label, not a real folder on disk — under a named parent or the view root) and `rename_folder` (renames an existing meta folder's label; refused, pointing at the Obsidian CLI, if the target is a real file, block or module). All five take only vault paths and node ids that already exist — `add_node`'s `path` must already exist in the vault and resolve to (or be eligible for automatic promotion to) an actual Atlas unit, never something Atlas would render as a greyed-out "(missing)" row; create or rename real files and folders with the Obsidian CLI, never through these tools. None of the five ever calls `vault.create`/`rename`/`createFolder`/`delete`/`modify`, touches `explicitStatusId`/`apiItemState`/any other status field, or performs the confirmable drag-onto-a-module-icon disk move the UI offers elsewhere; they also refuse an Outside-Vault-managed row as either a target or a parent, the same way the UI's own drag-and-drop never drags one or drops onto one. The server only ever binds the loopback address, never creates/renames/moves/deletes a file, and never runs on mobile.

### Status

- **Status sets** — create any number of named sets, each holding an ordered list of statuses (label, color, optionally flagged "Completed" and/or "Cancelled"). Each status row's "more actions" menu handles making it the set's default, marking it completed/cancelled, reordering, and removing it.
- **Color palette** — a shared set of swatches offered by every status color picker, in addition to a fully custom color.
- **Glow** — a soft glow around status dots.
- **Retain icons** — when a status is assigned, keeps the item's normal type icon visible, shrunk down inside the status dot, instead of replacing it outright.
- **Retained icon color** — only matters when "Retain icons" is on: match the icon to normal text color, or to the app's background color.

A bucket item with children (unit or meta folder — the option only appears when there's something underneath it) gets a **Statuses** entry on its right-click menu, and the **view name** itself gets the same entry for assigning statuses at the root level of the whole view (also only offered when the bucket has something in it). Both open the same modal:

- **Enable statuses** — master toggle. Everything else below is greyed out (but not discarded) while it's off.
- **Status set** — which set governs this item's (or the view's) children.
- **Inherit to subfolders** — off by default. When on, the assignment cascades past direct children all the way down the tree, until a *closer* item has its own separate assignment, which then takes over for its own subtree.
- **Hide completed** / **Hide cancelled** — hide items whose current status is flagged as one or the other, entirely (not just folded) — an item matching the active filter box search is shown anyway, regardless of this setting, same as a truncated item below.
- **Apply statuses to** — which kinds of items underneath actually receive a dot: blocks, files, modules (real folders on disk), or meta folders (the organizational, no-disk-presence kind).
- **Sort children by status** — orders the governed children by their own status instead of the manually-arranged order, ranked by each status's own position in the status set (top of the set = sorts first). Items sharing the same status keep their existing relative order (a stable sort, not re-alphabetized). **Reverse order** — only available once sort-by-status is on — flips that rank order.
- **Truncate statuses** — once at least two of a governor's children share a truncation-enabled status, they collapse into a single placeholder row (the status's dot plus a count and label — a custom label if set, otherwise a pluralized form of the status's own label) instead of listing each individually. Click the placeholder to expand it back to the individual rows (plus a "Collapse" row in its place to fold them again) — expand/collapse state resets on reload, same as any other fold state in the explorer. An item matching the active filter box search is always shown on its own, never folded into a placeholder. The placeholder's dot always looks exactly like a real status dot (color, glow) except it never shows a retained type icon, even with "Retain icons" on — a group can mix types with no single icon to truthfully show.

When enabled, the governed children each show a colored dot for the set's status — the governing item itself is unaffected, only what's underneath it. Inbox items (not yet placed in any view) can't have a status assigned until they're placed in a bucket. Hide always takes precedence over truncate — a hidden item is never counted toward, or shown as part of, a truncated group's placeholder either.

**Clicking a status dot directly** opens a small popup listing every status in the governing set, with its own color swatch — pick one to change that specific item's status (e.g. Triage → Complete), independent of its siblings. The item's own row click (open) and right-click (full menu) are unaffected — only the dot itself has this behavior. For a module whose icon is currently a status dot, viewing its contents moves to the right-click menu ("View module contents") instead of the plain click, which now means "change status" like everywhere else.

## Sorting

Any folder's or unit's right-click menu, and the Bucket root's own header menu, offer a **Sort children…** submenu for arranging what's directly underneath it: **Manual** (the default — your drag-and-drop order, see Reordering by drag below), **A-Z**, **Modified**, **Time added**, and **Status** (only offered when this item, or an ancestor reaching down to it, governs a status set — see Statuses above). A-Z, Modified and Time added apply to this item's direct children only, never to its subfolders' own children; Status is the one mode that keeps applying as you go deeper, following the same governor an explicit setting further down doesn't override. **Reverse order** flips the current mode's direction — Z-A, oldest-first, oldest-added-first, or reversed rank — and is disabled (greyed out) while the mode is Manual, since Manual has no direction to flip. Choosing any mode resets Reverse back off. Ties (equal rank, same mtime, and so on) keep their existing manual order among themselves, in either direction; Folders, API rows and anything else with no file time of its own always sort after everything that has one.

A folder or unit that's actually sorted by anything other than Manual shows a small icon next to its name (and the Bucket root shows the same icon in its own header) — hover it for a tooltip naming the mode and direction. Sorting is purely about render order: it never moves, renames or touches any file, and never rewrites the stored manual order underneath — switch back to Manual at any time and the original arrangement is exactly as it was.

Modified-sort's file-time snapshot only refreshes when the explorer actually has a reason to — the pane regaining focus, switching to that view, or something about the tree or a sort setting changing — not on every autosave keystroke, and never mid-drag (a trigger that fires while you're dragging an item is deferred until the drag ends). When the pane regains focus because you clicked a row, the refresh waits until that click or drag finishes, so the click still lands. Modified also works for the files an Outside-Vault Folder source lists (their real file times); an Outside-Vault sub-folder, like any Folder or module with no file time of its own, sorts after everything that has one.

**Reordering by drag.** Drop on a row's top or bottom quarter to place the dragged item next to that row, in the same list; drop on the middle to nest it inside the row, as before. A row that's expanded and already showing its children has no bottom quarter (that quarter nests instead) — drop on the next row's top edge to place something after it.

- **Manual list:** a line shows where the item will land, and it lands there. If you drag several rows and the row you drop on is one of them, the selection still lands together beside that row, in the order you dragged it (dropping on the middle nests the others into it and leaves that row where it is).
- **Sorted list (anything but Manual):** dragging an item that is already in that list onto one of its edges is refused with a notice ("<Folder> is sorted A-Z. Set it to Manual to reorder."), since the sort would only undo the move. Dragging in an item from anywhere else — the Inbox, another folder, a deeper sub-folder — is allowed: the whole list is outlined (no line), the item is stored at the slot you dropped on, and it displays in its sorted place. Switching the list back to Manual shows the stored slot.
- API rows, truncation placeholders and Outside-Vault children have no edge zones and can't be dropped on this way. A manually-added child of an Outside-Vault Folder still reorders, whatever sort the Folder has.
- Arranging never touches disk; "Place in…" onto the folder an item is already in leaves its Time added stamp alone.

## Commands

| Command | What it does |
|---|---|
| `Atlas: Add block` | Creates a new free block in the pool folder and opens it with the cursor ready to type — no filename prompt. |
| `Atlas: Open explorer` | Opens/focuses the Atlas view in the left sidebar. |
| `Atlas: Switch view…` | Fuzzy-picks another view and makes it active. |
| `Atlas: Place active file in view…` | Fuzzy-picks a view, then a folder (or the bucket root) within it, and places the active file there — the keyboard/mobile equivalent of dragging it in. |
| `Atlas: Reveal active file in Atlas` | Opens the explorer and, if the active file isn't placed anywhere, says so. |
| `Atlas: New view` | Prompts for a name and creates a new, empty view. |
| `Atlas: Rebuild index` | Forces a full re-scan of every unit in the vault; logs timings to the console. |

Every row in the explorer also has a right-click menu (Open, Open in new tab, Reveal in native explorer, Copy link, Duplicate (Meta), Remove from view, Place in view…), and folders can be renamed or deleted from the same menu. "Duplicate (Meta)" places a second reference to the same item — and, if it's a parent, a copy of everything nested under it — right next to the original, without touching disk; the copy is free to be organized independently from then on. Bucket rows (units and meta folders) also get a **Statuses** option — see the Status settings section above.

## Documentation

See [`docs/decisions.md`](docs/decisions.md) for the judgement calls made during the build, the alternatives considered, and why — kept current as the plugin evolves.

## License

MIT — see [LICENSE](LICENSE).
