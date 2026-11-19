---
title: Settings and commands
---

[Atlas Explorer](index.md) › Settings and commands

# Settings and commands

<img src="images/settings.png" alt="The Basic tab of the Atlas Explorer settings" width="860">

Open **Settings → Atlas Explorer**. The panel has two tabs, **Basic** and **Status**. The screenshot shows the top of the Basic tab.

## Basic

| Setting | Default | What it does |
|---|---|---|
| Pool folder | `_pool` | Where [free blocks](concepts.md#free-blocks) live. Created on demand the first time you add a block. Changing it re-indexes and warns about blocks left behind in the old folder. |
| Excluded folders | dot-folders, the pool folder, `_to_delete` (worked out on first load) | One per line. These never appear in the explorer, and their files never appear in any inbox, except files in the pool folder, which still show as free blocks. |
| Never auto-promote from these folders | empty | One per line. Files here still show in the explorer and can be added with **+**, but links and embeds never promote them into the inbox. Promotion by hand, units and placement are unchanged. The pool folder can't be listed. Only matters while **Auto-promote linked items** is on. |
| Auto-promote linked items | off | When off, the inbox holds only what you add with **+** or promote by hand (plus your modules and loose notes); a file, folder or block that another note links to or embeds no longer appears there on its own. Turn it on and linked items appear in the inbox at once, off and they leave again, with no reload. Items you already placed in a view stay where they are either way, and links in your notes resolve as usual. Items a [Folder data source](data-sources.md#folder) manages count as linked too: other views' inboxes leave them out while it's off. Anything the switch keeps out of the inbox is still offered by **+**, unless you dismissed it. |
| Interface note convention | `<Folder>/<Folder>.md` | Toggle to also accept `index.md` / `README.md` as a folder's interface note. |
| Replace native explorer on startup | on | Makes Atlas the active view in the left sidebar on launch. The native explorer stays available as a tab. |
| Block display length | 80 | How many characters of a free block's first line to show in the explorer. |
| Confirm before adding a unit to a module | on | Ask before a drag onto a module's icon physically files something into it. Off skips the confirmation, not the move. |
| Highlight the open note | on | Gives the row(s) for the note open in the editor a visible highlight. |
| Default view on launch | Default | Which view Atlas opens to when the vault loads. |

### MCP server

Off by default, and desktop only. See [MCP server](mcp-server.md) for what it offers. In settings: **Enable MCP server**, **Port** (default `27202`, per device), and **Token** (with a **Regenerate** button). On mobile this section just says the server runs on desktop only.

## Status

Status sets, the shared color palette, and the Glow, Retain icons and Retained icon color options. See [Statuses](statuses.md).

## Tephra

Desktop only. [Tephra](https://github.com/danrfletcher/Tephra) is a local program that indexes any number of folders ("sources") into one link graph. This tab has one switch, **Turn on Tephra multi-data source vault**, off by default. With it off Atlas does nothing Tephra-related: no connection, no background check, no change to your links.

With it on, Atlas asks Tephra for its source list when you turn the switch on, and again every 10 seconds, and shows the state:

- **Tephra isn't running.** The switch stays on. The tab shows the install command (`tephractl daemon install`) and the repo link. Atlas never runs it for you. When the daemon starts, the next check turns the tab to online without reopening settings.
- **Connected.** One row per source: name, folder path and status (online, missing or offline). The vault itself (`notes`) has no options. Every other source has **Show in Obsidian search & graph**, on by default. Turning it off adds `Sources/<name>/` to Obsidian's **Files & links → Excluded files**; turning it on removes exactly that entry and leaves your own entries alone.

### The `Sources/` folder

With the switch on and Tephra running, Atlas keeps one folder link per top-level Tephra source in your vault: `Sources/<name>` is a real symbolic link to the source's folder on disk. Obsidian indexes those files like any others, so they show in search, the Quick Switcher, the graph and the file explorer. Atlas follows Tephra's list: a source added or removed with `tephractl` gains or loses its link at the next check (every 10 seconds, or when the Obsidian window gets focus). A source whose folder is inside another source's folder gets no link, and neither does your vault (`notes`). If a source's folder is moved in Tephra, its link is replaced to point at the new path; if you delete a link by hand, it comes back at the next check.

- **If `Sources` is already yours, the switch refuses to turn on.** Atlas only takes over `Sources/` when every entry in it is a link Atlas made earlier (an empty `Sources/` Atlas left behind counts). If `Sources` is a file, or a folder holding anything else, a notice names the path and the switch goes back to off. Nothing is moved, created or excluded. Rename or move your `Sources` and turn the switch on again. (`Sources.md` is fine; only the exact path `Sources` clashes.) If one source's name clashes with a real file or folder inside `Sources/`, only that one link is skipped, with a notice.
- **`.gitignore`.** Atlas adds the single line `Sources/` to the `.gitignore` at the vault root (creating the file if needed, and keeping your lines). Turning the switch off leaves that line in place.
- **Excluded files.** Source files are not excluded from search by default. Atlas adds, for each source, `Sources/<name>/.git/` and the entries from the source's root `.gitignore` (for example `target/`, `node_modules/`) to **Files & links → Excluded files**, and keeps them in step when that `.gitignore` changes. A plain path becomes a path entry and a glob becomes a `/regex/` entry. Lines starting with `!`, lines that aren't a valid pattern, and anything past 500 entries per source are skipped, and `.gitignore` files in subfolders are never read. Entries you added yourself are never touched.
- **Sources is not a module.** While the switch is on, Atlas ignores `Sources/` in the explorer: it isn't listed as a folder in the vault section, and links to or from files under it don't promote vault units. With the switch off, a `Sources` folder of your own is an ordinary folder again.
- **Deleting a source's files.** If Tephra reports a source as missing (its folder was deleted or its drive unplugged), its link stays and the files vanish from the vault; your views keep their rows, shown greyed as missing, and they return unchanged when the folder comes back. Deletes caused by Atlas itself (switch off, source removed) are not treated as you deleting those notes. A note you delete in Obsidian inside a linked source is an ordinary delete.

### Adding and removing a source

With the switch on and Tephra running, the vault's Inbox **+** button opens a small menu: **Add file…** (the same as always) and **Add source…**. **Add source…** opens your system's folder picker, then asks for a name (prefilled from the folder's name: `My Notes` becomes `my-notes`). The name turns red with the reason while it can't be used: it is empty, has a space, has `/`, `@`, `:` or `*`, has any character outside letters a-z, digits, `.`, `_` and `-` (so no unicode: `[[@name:…]]` links can't carry it), is 200 bytes or longer, matches a source Tephra already has (or your vault's own `notes`, in any capitalisation), or `Sources/<name>` already exists in the vault. Atlas also refuses a folder inside the vault, the vault itself, and anything under `Sources/`, before asking for a name. Confirming sends one request to Tephra. If Tephra refuses (for example the folder overlaps another source), its reason shows in the dialog and you can change the name and try again. If Tephra doesn't answer in time, Atlas does not send the request again: it reads Tephra's list and either shows the new source or says it couldn't confirm.

To remove a source, right-click its Inbox header (`[whoop]`) and choose **Remove**, then confirm. Tephra stops indexing it and Atlas removes the `Sources/<name>` link. Your files in the source's folder are never touched. The vault's own header has no Remove. A real folder or note of yours at `Sources/<name>`, or a link Atlas didn't make, is left alone and a notice says so. If Tephra isn't running, both actions say so and do nothing: Atlas never starts Tephra.

To rename a source, right-click its Inbox header and choose **Rename**. The dialog is prefilled with the current name and applies the same rules as Add (the source's own name is not a clash, so a change of case only is fine; the 200-byte length limit of Add is not applied here, so a very long name goes to Tephra and Tephra's own reason for refusing it shows in the dialog). Confirming sends one request to Tephra. Only after Tephra accepts does Atlas move everything it keeps under `Sources/<old>/…` to `Sources/<new>/…`: view placements, API item notes, Folder, CSV and table sources, manual promotions, dismissed and added items, the module folders you had open, the source's "Show in Obsidian search & graph" choice and its Excluded files lines. These changes are saved to disk straight away, before the link swap, so quitting Obsidian right after a rename loses nothing even if the swap then fails. Statuses, row order and ids stay as they were. Atlas then swaps the `Sources/<old>` link for `Sources/<new>` (the folder it points at is never touched, and nothing is deleted but the old link) and reopens notes you had open in the source at their new path. If Tephra refuses (for example the name is taken) its reason shows in the dialog and nothing in Atlas changes. If Tephra doesn't answer in time, Atlas does not send the request again and nothing changes until Tephra's list says otherwise. If Tephra reports links it could not rewrite yet, a notice says how many. **Rename** is greyed out while Tephra is offline, with "Tephra offline" on hover; it is never queued. The vault's own header has no Rename. If Atlas is closed or the plugin is disabled in the middle of a rename, nothing is rolled back and nothing more is done: Tephra keeps the rename, and the next time Atlas starts it follows Tephra's list (it creates `Sources/<new>` and removes `Sources/<old>`). If the move of your placements hadn't been saved yet, those entries show as missing under the old name and are not deleted. A rename made outside Atlas (`tephractl source rename`) is picked up from Tephra's change notice and gets the same treatment.

### Linking to a source's files with `[[`

With the switch on (desktop only), the `[[` popup knows your sources:

- `[[text` searches only the source the note is in. A note in `Sources/whoop/` sees whoop's files; a note in your vault sees vault files, never anything under `Sources/`.
- `[[@` lists the sources, with **All sources** first. `[[@wh` filters the list by name. A source Tephra reports as missing is listed greyed, with `(missing)`. A name that matches nothing shows "No source named wh".
- Pick a source (or type `[[@whoop:`) and keep typing to search that source. `[[@*:text` searches every source, the vault included, and each row shows which source it is from.
- A hand-typed `[[@whoop:Plan]]` that matches two files in `whoop` (`a/Plan.md` and `b/Plan.md`) shows as broken. Hovering it shows "2 matches in whoop:" and both paths; clicking shows the same text in a notice. The popup never inserts such a link.
- The link that goes in follows one rule. A file in the same source as the note gives `[[Name]]`. A file in another source gives `[[@source:path]]`, using just the file's name when that finds that file and no other. When two files in the source share a name, the link carries the file's full path from the source's root (`[[@tephra:crates/tephrad/README]]`), so a link the popup writes is never ambiguous and Tephra resolves it the same way. Notes drop `.md`; other files keep their extension (`[[@tephra:registry.rs]]`). The file's own name and capitalisation are used.
- After a file in another source, or a non-note file, `#` searches its headings and `^` (or `#^`) its blocks and code symbols through Tephra. A block with no `^id` gets one from Tephra when you pick it. Plain notes in the same source keep Obsidian's own heading and block popup.
- Tephra not running: `[[text`, `[[@` and `[[@name:text` still work from the sources Atlas already knows. `#` and `^` show "Tephra offline". If Tephra reports an error or doesn't answer, the popup shows that and inserts nothing.

With the switch off, the popup is the same as before and Tephra is never called.

### Opening a file from a source

Clicking a file in a source's Inbox section, middle-clicking it, choosing **Open** or **Open in new tab**, or clicking a file in a source module's Module Contents opens the file at its `Sources/<name>/…` path, the same way a vault file opens. Atlas asks Obsidian whether it has a view for the file's extension (case does not matter: `.PDF` is `.pdf`): if it does, the file opens in a tab (a new tab for middle-click and **Open in new tab**); if it doesn't, Atlas hands it to Obsidian's open-in-default-app, which opens it in the Mac app for that type. Notes, canvases, PDFs, images, audio and video are Obsidian's own. Code files open in Obsidian when a plugin such as VS Code Workbench has registered the extension, and in the default app when none has. A file with no extension (`Makefile`, `LICENSE`) follows the same rule.

Word (`.doc`, `.docx`), PowerPoint (`.ppt`, `.pptx`), Excel (`.xls`, `.xlsx`) and Google Docs and Sheets (`.gdoc`, `.gsheet`) files always open in their own app, even if a plugin registers a text view for them, so they are never edited in Obsidian. A PDF opens only in Obsidian's read-only PDF view. Edits to a note are saved by Obsidian through the `Sources/<name>` link to the file in the source's folder; Atlas never writes to a file by opening it. A source's file that is missing does nothing when clicked, and a file Obsidian can't read (no permission on the folder) shows Obsidian's own error and an `[Atlas]` line in the developer console. With the switch off, files open exactly as before.

### Links between sources (backlinks and pop-outs)

Links across sources behave like links in the vault. `[[@whoop:Workout Plan]]` in a note shows in Obsidian's own Backlinks, Outgoing links and graph (Atlas adds no link store of its own). Links Obsidian can't read, from code comments, PDFs and Office files, come from Tephra and appear as **Also linked from (Tephra)** at the bottom of the Backlinks panel: one `path:line` row each, sorted by path then line. Click a row to open the file at that line, middle-click for a new tab (a file Obsidian has no view for opens in its own app, without the line). If the Backlinks panel isn't open or can't be extended, run **Open Links pane** to see the same list in a pane of its own. With Tephra off or unreachable the section is empty and Obsidian's Backlinks is unchanged.

In a source's Inbox section, a deeper file pops out with the **promoted** pill when a link reaches it from outside its own module. A module is the source's top-level folder (`Sources/<name>/<top>`); a link from another source, or from your vault, always counts as from outside, and a link from the same module never does. Links in notes are read from Obsidian; links in code, PDFs and Office files are read from Tephra and kept in memory for the session only, so after a restart with Tephra off they are missing until it is back.

### Renames and Obsidian's link setting

With the switch on, every rename or move you make in Obsidian is sent to Tephra (the old and the new path), so links written from other files can follow. Atlas never rewrites a link or a note itself. While Tephra is offline the renames wait in a small file next to the plugin (`tephra-rename-queue.json`, paths only, never note content) and go out in order once Tephra answers. They survive an Obsidian restart, and turning the switch off keeps them for the next time it is on. If Tephra says the file changed ("file changed, try again"), Atlas retries three times, one second apart, then tells you in a notice. When you rename a free block, Atlas waits for Tephra's answer before it moves the file out of the pool (at most 1.5 seconds when Tephra is offline).

While the switch is on, Atlas turns Obsidian's own **Automatically update internal links** off, so Obsidian and Tephra don't both rewrite links, and remembers your old value. Turning the switch off puts it back exactly as it was (also when it was never set). Quitting Obsidian or disabling Atlas leaves it as it is, because the switch is still on. While the switch is on, Atlas does not show its "links were not updated" notice after a move. If you turn **Automatically update internal links** back on yourself while the switch is on, Atlas switches it off again the next time it loads or you open the Tephra tab.

Obsidian matches link names without regard to case and Tephra matches exactly, so a link such as `[[leg day]]` to `Leg Day.md` shows in Obsidian's Backlinks but not in the Tephra section. To count how many links in a vault differ in case from their target, run `node scripts/report-case-mismatch.mjs <vault-path>` (read-only; add `--json` for JSON).

### The Tephra status bar and offline sections

With the Tephra switch on, the status bar shows what Atlas knows about Tephra: **Tephra · 3 sources** when it answers (click it to open this tab), **Tephra · checking…** until the first answer, **Tephra offline · Start** when it doesn't, and **Tephra starting…** while a start is under way. A refused token also reads "Tephra offline"; hover text says "Tephra refused the token". Hover text is Atlas's own element and shows on hover and on keyboard focus.

**Start** is the only thing that runs a program: a click runs `tephractl daemon start` (no shell), once, and shows one notice if it fails. Atlas never starts Tephra on its own: not when you turn the switch on, not when a check fails, not on focus. With the switch off there is no status-bar item, no timer and no focus check. Atlas checks every 10 seconds and when the window gets focus, and a failed call shows "offline" at once.

While Tephra is offline each source's Inbox section keeps its header, marked **(Tephra offline)**, and shows the last list Atlas held in memory for it. If Atlas started with Tephra down, the sections come from the `Sources/<name>` links it made earlier and show no rows until Tephra answers. "Offline" is not "missing": a source's folder can't be told gone without asking Tephra. Right after load or toggle-on, before Tephra has answered once, only the vault's Inbox shows (the status bar says "checking…"); the source sections, labelled or not, appear with the first answer. Nothing from this is saved to `data.json`.

### Turning it off

Atlas reads Tephra's token from `$XDG_DATA_HOME/tephra/token`, else `~/.local/share/tephra/token`. It re-reads it once if Tephra answers 401, and never stores or logs it.

Advanced, no settings field: to point Atlas at a Tephra on another port (for example a second Tephra on a scratch port), add `"tephraUrl": "http://127.0.0.1:<port>"` to `settings` in the plugin's `data.json` and turn the switch off and on. Only `http://` on `127.0.0.1`, `localhost` or `[::1]` with an explicit port is accepted, because the token is sent to that address; anything else is ignored with a console warning and the default `127.0.0.1:4812` is used. Leave it out for normal use.

**Turn the switch off before uninstalling Atlas.** Atlas's Tephra changes are only undone by the switch. Turning it off removes every `Sources/<name>` link (the link only: your source folders and their files are never touched), removes `Sources/` if it is then empty, removes the Excluded files entries Atlas added, saves the setting and stops checking. The `Sources/` line in `.gitignore` stays. It never unregisters a source in Tephra. Disabling or uninstalling the plugin, or quitting Obsidian, runs no clean-up and changes nothing: the links, the `.gitignore` line and the Excluded files entries all stay.

On mobile the switch is disabled and Atlas behaves as if it were off.

## Commands

Open the command palette and search for "Atlas Explorer".

| Command | What it does |
|---|---|
| `Atlas Explorer: Add block` | Creates a new free block in the pool folder and opens it with the cursor ready to type, with no filename prompt. |
| `Atlas Explorer: Open explorer` | Opens or focuses the Atlas view in the left sidebar. |
| `Atlas Explorer: Switch view…` | Fuzzy-picks another view and makes it active. |
| `Atlas Explorer: Place active file in view…` | Fuzzy-picks a view, then a folder (or the view root) within it, and places the active file there: the keyboard and mobile equivalent of dragging it in. |
| `Atlas Explorer: Reveal active file in Atlas` | Opens the explorer and, if the active file isn't placed anywhere, says so. |
| `Atlas Explorer: New view` | Prompts for a name and creates a new, empty view. |
| `Atlas Explorer: Open Links pane` | With Tephra on: opens a pane in the right sidebar that lists the active file's **Also linked from (Tephra)** rows, for when the Backlinks panel can't show them. |
| `Atlas Explorer: Rebuild index` | Forces a full re-scan of every unit in the vault, and logs timings to the console. |
| `Atlas Explorer: Copy render log` | Copies the render log to the clipboard as JSON and shows a notice with the entry count (`[]` if it is empty). Each entry has only `kind` (what triggered the rebuild), `at` (epoch ms), `durationMs` and `changed`: no note text, labels or paths. The log keeps the last 500 rebuilds in `render-log.json` in the plugin folder, is always on, and has no setting. |

Everything else is on the explorer's right-click menus; see [Using the explorer](using-the-explorer.md). There are no default hotkeys.

## Where Atlas keeps its data

In the plugin's `data.json`: your settings, views and their trees, manual promotions, dismissed and added items, status sets and the data-source configuration and cached rows. Two things are deliberately kept on the device only and never synced: **API headers** and **outside-the-vault folder paths** (both can hold things that are specific to one machine or secret), and the MCP port and token.

The render log is separate: `render-log.json` in the plugin folder (see **Copy render log** above), so log writes never rewrite `data.json`.
