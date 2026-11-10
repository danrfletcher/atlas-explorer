---
title: Data sources
---

[Atlas Explorer](index.md) › Data sources

# Data sources

A **data source** fills a Folder (or any other bucket item) with rows pulled from somewhere else. Right-click the item and choose **Data source…**, pick a **Source type**, and save. There are four types:

| Type | Rows come from |
|---|---|
| **API** | A JSON HTTP endpoint. |
| **Folder** | The direct contents of a folder, inside or outside the vault. |
| **Markdown table** | A table inside a note in your vault. |
| **CSV** | A `.csv` file in your vault. |

A data source can sit on a Folder **or on any bucket item** (a module, a file, a block), and an item that holds one can still have its own nested children. Rows from a source behave like any other child of that item: they can have a [status](statuses.md), a note, be [sorted](sorting.md), and be nested under each other.

**A source only ever reads.** It never writes back to the API, the file or the folder. A source's output is always one flat list of rows.

On the item's right-click menu, a sourced item also offers **Refresh now** and **Remove data source**. Removing a source keeps its current rows as plain rows and just stops refreshing. Removing an item that holds a source from the view asks you to confirm first.

## Fill mode

Every source type has a **Fill mode** deciding what happens to a row that is no longer in the source:

| Mode | Behaviour |
|---|---|
| **Merge** (the default) | Rows are matched by ID. New rows arrive untriaged. A row that vanished stays, marked *not found, last seen <date>*, with its status and note kept, and a **Remove** button. |
| **Append** | Only adds new rows. Nothing is ever removed or marked. |
| **Overwrite** | Replaces every row on each refresh. Vanished rows are deleted, taking their statuses with them. |

For API, CSV and Markdown table sources in Overwrite mode there are two safeguards: **Keep current rows if the response is empty** (on by default) and **Confirm before deleting rows** (on by default).

A row that comes back after being *not found* is a normal row again with its old status and note. A refresh never changes a status; label and secondary text always follow the source.

## API

Pulls rows from a JSON endpoint.

1. Enter the **URL** and **Method** (GET or POST). Add any **Headers**: these are stored on this device only, never synced, and kept as plain text (they are not encrypted).
2. Click **Fetch sample**. The response appears as draggable fields. (Fetching isn't available on mobile.)
3. Map the fields: drag a field onto **ID** (required), **Label** (required), **Secondary** (optional), and onto any number of named **extra fields**. If the response is an object, pick **Array field**, the one that holds the list of rows.
4. Choose a **Fill mode** and the refresh options below.

**JavaScript mapping.** The mapping mode toggle switches to a function `(response) => [{ id, label, secondary, extra }]` (`secondary` and `extra` optional). Switching pre-fills the equivalent code; switching back to drag mapping warns that the code will be discarded. The function runs with Atlas's full trust, with no sandbox, and only the request itself has a time limit.

**Refresh.** Two independent toggles, both off by default: **Refresh when Atlas view loads**, and **Refresh every** N minutes (minimum 5, runs only while the view is open; stale views refresh on next visit). **Refresh now** is always on the menu. A connection dot on the item shows the last result; if the endpoint is unreachable, the dot goes red with a tooltip ("unreachable, last updated 3 h ago") and rows still show from the cache. On mobile, API sources show their cached rows and don't fetch.

### Source click action

What happens when an API row is clicked, as far as the source itself is concerned: **Open attachment** (the default), **None**, or **Run terminal command in background** (desktop only). A command is run directly, not through a shell, so pipes, redirects, `&&`, globbing, `~` and environment variables don't work. Use `{field}` for the value of an extra mapped field. Commands run with your trust, and the dialog says so.

This is the layer below the [Click function](#click-function) and the [Item override](#item-override): a row with neither follows this setting exactly as before. Those two run first, and this setting applies only to a row they leave alone.

### Click function

An API source can also hold a **Click function**: JavaScript that runs each time you click one of its rows (or press Enter on it) and decides what that row does. Set it in the Data source modal, under the **Click function** heading below the click action. Because it runs at click time, a row added by a refresh works with nothing set by hand. It is available on every API source, whether its fields are drag-mapped or mapped with JavaScript.

When you click an API row, Atlas runs the first of these that applies:

1. The row's [Item override](#item-override).
2. The Click function's result.
3. The source click action.
4. Open attachment, which applies only when the source click action is **Open attachment** or unset (and the row has an attached note).

The modal shows this helper text under the code box, and this is the whole contract:

> Runs when you click a row (or press Enter on it), unless the row has its own Click action. It decides what the row does, so rows added by a refresh work with nothing set by hand.
>
> item is { id, label, secondary, extra }. extra holds the row's extra mapped fields and is empty on a not-found row, so guard it (item.extra.path may be undefined).
>
> Return { kind: "terminal", argv: [...] } to run a command (no shell, no {field} placeholders), { kind: "command", id } to run an Obsidian command, { kind: "uri", uri } to open a URI, { kind: "none" } to do nothing, or return nothing to fall through to the click action above.
>
> The function must be synchronous: an async function or a returned Promise is rejected with a notice. Any other return value, or an error thrown, also shows a notice and runs nothing.

An empty box means no function. Details the helper text leaves out:

- `argv` goes straight to the runner with no tokenizing and no `{field}` resolution. Each element reaches the program exactly as returned, and nothing goes through a shell.
- `{ kind: "none" }` stops everything: nothing runs and no attachment opens. Returning nothing falls through to the source click action.
- An invalid shape (an unknown `kind`, a missing or non-string `id` or `uri`, an `argv` that is not a non-empty array of strings), a Promise return or a throw shows a notice with the reason and runs nothing, and the source click action does not run either.
- A row whose cache was cleared, or a *not found* row, gets `extra = {}`. Its `id`, `label` and `secondary` come from the stored row, and `secondary` is `undefined` when the row has none. Guard `item.extra` before reading from it.
- A second click on the same row within 1 second is ignored, as for any [click action](using-the-explorer.md#click-actions). This is decided before the function is called, so it applies even when the first click's function returned nothing: that second click does not fall through to the source click action either.
- A click with a modifier key, or on the row's status dot, does not call the function; it does whatever the source click action does (or nothing, if the row has an Item override). So with the source click action set to **Run terminal command in background**, a plain click runs whatever the function chose, while a shift-click runs the source's static command.
- Save compiles the code but never runs it: the function itself is never called. While you type, the box is only syntax-checked, and a syntax error blocks Save with an inline error. Save evaluates the box once to check that it is a function, so code outside the function (an immediately-invoked function, say) runs at that one moment and never as you type; code that is not a function is refused with an inline error.

**The Click function is unsandboxed and has no timeout.** It runs with Atlas's full trust, like the JavaScript mapping above, and an infinite loop in it freezes Obsidian. Only paste code you wrote or have read.

For example, to open an app by its path when the row has one, and otherwise run an Obsidian command named after the row's id:

```js
(item) => item.extra.path ? { kind: "terminal", argv: ["open", "-a", item.extra.path] } : { kind: "command", id: "app-runner:open-" + item.id }
```

A row with `extra.path` set to `Docker` runs `open -a Docker`. A row with no `path` runs the command `app-runner:open-<its id>`. The command id here is only sample text: Atlas runs whatever id the function returns and does not depend on any particular plugin.

### Item override

Any one API row can have its own click action, called an **Item override**. Right-click the row, choose **Click action…**, pick a **Kind** and **Save**. Besides the three kinds, the dropdown offers **Use source setting** (no override) and **None** (the row does nothing: no Click function, source click action or attachment runs for it). The override is the first thing a click checks, so it beats the Click function; **Clear click action** on the row's menu removes it, and the row returns to the function.

- **Merge** refresh keeps an override, including on a row that has gone *not found*. **Overwrite** drops it along with the row; a row that later returns starts fresh.
- Duplicating the item that holds the source does not copy overrides: they belong to the rows, not to the copy.
- An override on a row whose source was removed, or on a Table or CSV row, does nothing; the setting is kept.

### Attaching notes

Right-click a row for **Add note**, **Add block** or **Add module** to create a note and link it to the row (one attachment per row). **Remove attachment** unlinks it. If the linked note is deleted or renamed, Atlas clears or follows it.

Removing a *not found* row is per row (**Remove**), with no bulk action and no undo.

## Folder

Fills the item with the **direct children** of a folder. One level only: there's no recursion or depth control.

- **Location**: **Inside vault** (pick a vault folder with the search box) or **Outside vault** (an absolute path on this device; a connection dot shows green when the path resolves and red when it doesn't).
- **Show files** / **Show folders**: which kinds of child to list.
- **Fill mode**: governs what happens when a child file is deleted. Merge shows the row as *not found* with Remove; Append keeps the row but clears its link; Overwrite removes it immediately.
- Rows from an inside-the-vault source are real file and module units with their normal behavior (open, drag, nest, rename). Rows from an outside-the-vault source have no vault file behind them, so they can't be dragged, nested into other places or renamed, and the Open and Reveal menu items are hidden.
- An outside-the-vault path is stored on this device only and never synced, so a synced vault can legitimately show it green on one device and red on another. The connection is checked on load and when the pane gains focus, with no background polling. If it becomes unavailable, the rows render empty with no error and come back on their own.
- If the target folder is deleted or renamed away, the item falls back to the normal *missing* look.

### File filters (YAML)

With **Show files** on (inside-the-vault sources only), a **File filters** section appears at the bottom of the dialog. Click **+ Add YAML rule** to add a `key` and `value` (the key field suggests frontmatter keys from across your vault; free text is allowed). A file is listed only if **every** rule matches its frontmatter.

- Keys are matched ignoring case. Values are trimmed and compared ignoring case; a list matches if any item equals the value; a link `[[X]]` or `[[X|alias]]` compares as `X`; an empty value means "the key is present"; numbers, booleans and dates compare as their text. Files with no (or malformed) frontmatter, including PDFs and images, fail every rule.
- Filters are re-checked live as you edit frontmatter. A row that stops matching follows the fill mode: **Merge** greys it as *filtered out* with a **Remove** button; **Append** leaves it alone; **Overwrite** hides it (its data is kept and it returns exactly as it was when it matches again). Saving new rules hides non-matching rows silently in Merge and Overwrite, and never hides existing rows in Append.
- Folders listed by **Show folders** are never filtered.

## Markdown table

Reads a table from a note. Pick the **Markdown file** (a search box of your vault's `.md` files). If the note has more than one table, choose which one. Then map columns to ID, Label, Secondary and extra fields with the same drag-or-JavaScript mapping as an API source (use **Load sample** to see the table's columns). Atlas doesn't detect that the table's position shifted if you later add a table above it.

## CSV

Reads a `.csv` file from your vault (pick it with the **CSV file** search box). The first row is always treated as column headers. Map columns exactly as for a Markdown table. Rows that can't be parsed are skipped and counted.

**Markdown table and CSV sources have no refresh settings:** they refresh as soon as the backing file changes. If the file is deleted, the item shows the same *missing* look as a dead API URL.
