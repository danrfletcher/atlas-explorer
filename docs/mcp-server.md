---
title: MCP server
---

[Atlas Explorer](index.md) › MCP server

# MCP server

Atlas can run a small [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server so an agent on the same machine can read your views and statuses and arrange them. It is **off by default** and **desktop only**: on mobile there is no listener, port or token at all.

## Turning it on

In **Settings → Atlas Explorer → Basic → MCP server**, switch on **Enable MCP server**.

- The server speaks HTTP with JSON-RPC 2.0 (including the standard `initialize` and `tools/list` handshake) and binds **only** `127.0.0.1`, never another address.
- **Port:** defaults to `27202`, editable per vault per device (so two vaults open on one machine can use different ports). Type a value from 1024 to 65535; it's committed on blur or Enter, and restarts the server straight away if it's enabled.
- **Token:** every request must present a bearer token. The settings panel shows the current token (copyable) and a **Regenerate** button; regenerating writes a new one immediately and the old one stops working at once.
- The on/off toggle syncs with your other settings, but the port and token are device-local and never sync.

## What it offers

Every write names a **view** explicitly (it never falls back to the open one) and is serialised. A node is addressed by its **id**, or by its vault path only when that path matches exactly one node in the view. An ambiguous path is refused, listing every match and its id.

| Tool | What it does |
|---|---|
| `atlas_status` | The vault's name and absolute path, the plugin's version and the list of enabled tools. Enough for an agent to confirm it reached the right vault. |
| `list_views` | Every view's id, name and inbox mode. |
| `list_nodes` | A view's node tree: id, type, label or ref, explicit and resolved status, children. Defaults to the open view. |
| `list_status_sets` | Every status set's id, name, ordered statuses and default. |
| `get_node_status` | A node's own status, its resolved (inherited) status and its governing set. A `null` resolved status means nothing governs the node, which is a normal reply, not an error. |
| `set_node_status` | Writes a status by label (ignoring case) against the node's governing set. Goes through the same save path as clicking a status dot. |
| `add_node` | Places an existing vault unit (file, block or module) under a parent node or the view root. A path inside a module that isn't yet a unit is promoted automatically, the same as **Promote and place in view…**. |
| `move_node` | Reparents or reorders a node within one view. Refuses a drop onto itself or into its own descendant. |
| `remove_node` | Removes one node instance, lifting its children into its old slot, the same as **Remove from view** (including clearing a sourced node's device-local headers and path). |
| `create_folder` | Creates a Folder (an Atlas-only label) under a named parent or the view root. |
| `rename_folder` | Renames a Folder's label. Refused, pointing at the Obsidian CLI, if the target is a real file, block or module. |

## What it never does

- It never creates, renames, moves, deletes or modifies a file or folder. Create or rename real files with the Obsidian CLI, never through these tools. `add_node` only accepts a path that already exists and resolves to (or can be promoted to) an actual unit, never one that would show as *(missing)*.
- It never performs the confirmable drag-onto-a-module-icon move.
- The arranging tools refuse an outside-the-vault data-source row as either a target or a parent, as the explorer's own drag and drop does.
