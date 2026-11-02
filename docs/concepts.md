---
title: Concepts
---

[Atlas Explorer](index.md) › Concepts

# Concepts

## Three kinds of unit

A **unit** is anything that (a) has an address you can link to, and (b) means the same thing when taken out of its surroundings.

| Kind | Example | Address |
|---|---|---|
| **Block** | one paragraph, one bullet, one heading | `[[file#^id]]`, `[[file#Heading]]`, or a pool file (below) |
| **File** | a note, a document | `[[name]]` |
| **Module** (a real folder) | a system: an agent, a codebase, a course | its interface note (below) |

## Capture at the largest self-contained level; promote on link

You capture a thing at the largest level where it's self-contained. A chat transcript is a file. An agent system is a folder. Anything *inside* a unit is internals, and internals are not units, until something outside links to them. At that point they are **promoted** into a unit in their own right. This applies at every level with no special cases: a module is a unit at capture; a file inside it stays internals until something outside the module links to it; a block inside that file stays internals until something links to *it*.

So `Bets/steps/step-3.md` isn't a unit today. The day something outside `Bets/` links to it, it is. A link from inside the same module never promotes anything, and neither do self-links, links from excluded folders, unresolved links, or links inside code fences.

You can also promote by hand: **Promote and place in view…** in a module's contents (see [Module contents](using-the-explorer.md#module-contents)), or the **+** button on the inbox. Manual promotions are permanent; nothing removes them. To stop a folder's files being promoted by links at all, list it under **Never auto-promote from these folders** in [Settings](settings.md).

## Free blocks

A thought too small to deserve a filename still needs to exist. These are **free blocks**: markdown files in a **pool folder** (default `_pool/`, configurable) whose filenames are auto-generated IDs (`YYYYMMDDHHmmss-xxxx.md`) that you never type or see. The explorer shows a free block by its `title` frontmatter if it has one, otherwise by its first line; an empty block shows *(empty block)*. Under the hood it's a file; to you it's a block. A free block that grows into a full document just keeps growing.

If you rename a free block to a real name, it **graduates**: it moves out of the pool to the vault root under that name. If that name is already taken, a name dialog asks for another, and cancelling restores the original name.

## Modules and interface notes

Every folder is a unit: a **module** whose **interface** is a note saying what the folder is and what it's responsible for, with everything else inside as internals. (The code still calls this a "folder-unit"; the UI says "Module".)

- The interface note is `<Folder>/<Folder>.md` by default. In [Settings](settings.md) you can also accept `index.md` / `README.md`. A module without an interface note is still a unit: an inbox row's menu offers **Create interface note**, and picking the module from the `[[` suggester creates one.
- Clicking a module's name opens its interface note. Clicking its icon opens **Module contents**, a view of its internals.
- A module's properties are its interface note's properties.
- Only folders directly in the vault root are modules at capture. A nested folder appears only if it is promoted, or added with the inbox's **+** (an added sub-folder is a module too).

## Views, bucket, inbox

- A **view** is one arrangement of units into a hierarchy. There can be many; the same unit can sit in many at once; no view is "the real one". View names are unique (ignoring case), and deleting the last view recreates *Default*.
- Inside a view, the **bucket** is the arranged tree. Its branches are **Folders**: labels that exist only in Atlas, not folders on disk (not to be confused with **modules**, which are real folders).
- A view's **inbox** is every unit not placed in that view. Switch the inbox between **This view** and **Global**: the global inbox is every unit placed in no view at all.
- Placing or removing a unit in the bucket never touches disk.
- Any block, file or module can be the organizational parent of any other bucket item, the same way a Folder can: drag one onto another's row to nest it. A parent gets a chevron and folds like a Folder. Duplicates are allowed: the same unit can sit in a view more than once, and **Remove from view** removes only the one you chose.
- Removing or deleting a unit or Folder lifts its children up one level.

## Missing and renamed things

When a file or folder is renamed or moved in Obsidian, Atlas rewrites every reference to it (in every view, in manual promotions, in fold state and in dismissed or added state). The row keeps its identity and position. When something is deleted, rows are never removed for you: they stay as a greyed **(missing)** row with a remove button.

## When Atlas touches your files

Arranging never touches disk. These are the only actions that write to the vault, and each one is something you asked for:

| Action | What it writes |
|---|---|
| Add block, Add file, Add module (toolbar) | Creates a new free block, note or folder. |
| Add under… (right-click a bucket row) | Creates a new block, file, module or Folder and nests it under that row. Never moves an existing file. |
| Replace with… (right-click a Folder) | Creates a new block, file or module and swaps it in for the Folder, in the same spot. |
| Create Module (right-click a root-level note) | Makes a folder with the note's name and moves the note in as its interface note. Rolls back if the move fails. |
| Drop a file or block onto a module's **icon** | Moves it into that module. Always one item at a time, and confirms first (you can turn the confirmation off, which skips the prompt, not the move). |
| Rename a free block | Moves it out of the pool to the vault root (graduation). |
| Create interface note | Creates the module's `<Folder>/<Folder>.md`. |

**One naming rule applies to all of these:** a name is taken if the vault root already has a note `X.md` or a folder `X` (full path, ignoring case). A shared name dialog checks as you type, and shows red when invalid and green when valid.

Data sources only ever read; they never write back to an API, a file or a folder. Atlas never edits the content of your notes.
