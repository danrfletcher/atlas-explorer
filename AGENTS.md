# AGENTS.md

Guidance for coding agents working in this repo.

## What it is

- An Obsidian plugin that replaces the file explorer. It shows every meaningful unit in a vault (blocks, files, folders) as one flat list.
- Users arrange those units into any number of hierarchies (views) without moving files on disk.
- Pre-release; not yet on the community plugin store.

## Stack and commands

- TypeScript, type-checked with `tsc`, then bundled with esbuild. Targets the `obsidian` API, ES2022, CJS output.
- ESLint (`eslint.config.mjs`) with `@typescript-eslint`.
- Tests run on vitest. Fixtures live in `tests/fixtures/` (e.g. `data-v0.2.1.json`).
- Install: `npm install`. Dev watch: `npm run dev`. Lint: `npm run lint` (`eslint src`).
- Production build: `npm run build` (`tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`).

## Where things live

- `src/main.ts`: entry point. `src/types.ts`: shared types.
- `src/explorer-view.ts`, `src/views.ts`: explorer UI and view logic (view/inbox rendering, data-source setters).
- `src/unit-index.ts`: scans and indexes vault units.
- `src/statuses.ts`, `src/status-popup.ts`: status sets, governance, status-dot popup.
- `src/settings.ts`: settings tab (Basic, Status). `src/modals.ts`: modals (Module Contents, Statuses).
- `src/commands.ts`, `src/f10-commands.ts`: registered commands.
- `src/link-suggest.ts`, `src/suggester-precedence.ts`: `[[` suggester integration.
- `src/block-link-display.ts`, `src/display-text.ts`, `src/unit-display.ts`: render free blocks and links by title or first line.
- `src/interface-notes.ts`: module interface notes (`<Folder>/<Folder>.md`).
- `src/api-http.ts`, `src/api-source-modal.ts`, `src/api-merge.ts`: API data sources (HTTP, Data source modal, merge).
- `src/folder-source.ts`: Folder data sources (inside and outside the vault). `src/csv-parsing.ts`: CSV parsing.
- `src/swap.ts`: the Swap with… picker.
- `styles.css`: plugin styles. `manifest.json`, `versions.json`, `version-bump.mjs`: manifest and versioning.
- `esbuild.config.mjs`: bundles `src/main.ts` to `main.js`. It externalizes `obsidian`, `electron`, CodeMirror/Lezer and Node builtins.
- `tsconfig.json`: strict null checks, ES2022/DOM libs, `src/**/*.ts` only.
- `docs/`: GitHub Pages docs. `README.md`: product model, settings and commands. `TASKS.md`: build progress.

## Conventions

- `main.js` is a generated bundle; edit `src/` only.
- Free block files live in a pool folder (default `_pool/`) named `<pool>/<YYYYMMDDHHmmss-xxxx>.md`.
- Free block IDs are never shown to users; display the title frontmatter or the first line instead.
- A module's interface note defaults to `<Folder>/<Folder>.md`; `index.md`/`README.md` are optionally also accepted.
- Keep internal/legacy names (`meta`, `folder-unit`) in code even though the UI says Folder/Module.
- Persistent state lives in `data.json`: settings, manualPromotions, views, activeViewId, expandedModuleFolders, statusSets, colorPalette.
- Prefix commands with `Atlas:` (e.g. `Atlas: Add block`, `Atlas: Rebuild index`).
- Never change the shared `.atlas-row-text` rule for one row kind; scope CSS fixes to a modifier class.
- Keep `overflow-anchor: none` on `.atlas-explorer-scroll`; browser scroll anchoring overshoots expands.
- Flush the `data.json` save synchronously after structural conversions; the 500 ms debounced persist loses state on a quick reload.
- `save()` is the only trigger for `viewsManager.onChange`; call `notifyChange()` on no-change refreshes instead of gating re-render on `save()`.
- Atlas fires unawaited `void this.render()` calls; test overlapping renders and carry the in-flight scroll target.
- Dedup inbox units by file-kind `UnitRef`, never by bare path; promoted blocks share their file's path.
- API item rows are synthetic (no `ViewNode`); route their status dot through `setApiItemStatus`.
- `ApiHeadersStore` is device-local and keyed by node id: Duplicate must copy the original node's entry to the clone's id, and "Remove data source" must delete the node's entry so tokens don't linger.
- Vault rename handling must rewrite every stored ref, including `apiItemState` `noteRef`, not just `ViewNode.ref`.
- Clamp user-entered refresh intervals below 2^31-1 ms (~35791 min) before passing them to `setTimeout`.

## Product rules

- Arranging units never touches disk. The one exception is a confirmable single-item drag onto a module's icon, which does a real move via `renameFile`.
- Atlas never edits file content otherwise. A multi-item drag onto a module icon is a no-op.
- Dropping onto any row nests the unit as a child; there is no sibling-insert.
- Promotion by link is computed live, never cached. A subpath link promotes only that block.
- Self-links, excluded folders, unresolved links and code fences never promote.
- Manual promotions (made via the Module Contents modal) are permanent.
- Removing or deleting a unit or Folder lifts its children up one level.
- A governor's status applies to descendants only, never to itself. The nearest governor wins. Inherit-to-subfolders is off by default.
- View names are unique (case-insensitive). Deleting the last view recreates Default. Cycles are refused.
- Only vault-root folders are base units; nested folders appear only when promoted.
- Converting a file to a module must rewrite every referencing view node, duplicate and manual promotion. A bare `Foo/Foo.md` is not a unit ref and shows as missing.
- Free blocks already count as the 'file' kind for status apply-to switches. Only meta-folder→item and file→module conversions change the kind.
- Inbox items cannot have a status.
- Hide beats truncate. A truncation group forms only when 2+ children share a truncation-enabled status.
- Items matching an active filter always show individually, bypassing fold, hide and truncate.
- Bucket and inbox selections are mutually exclusive.
- Do not persist bucket or inbox open state; both open at the top on every load. Item folds stay persisted.
- Show the 'promoted' and 'added' pills only in the inbox. Bucket rows never show a pill, even for the same item.
- Dismiss is the only way to remove an inbox item. A dismissed added folder stays in `getUnits()`, so check dismiss state.
- Dismiss-menu wording depends on provenance: Remove for manually-added rows, Unhide for revealed-dismissed rows. Don't collapse to one label.
- Unhide currently clears both the global and the current view's dismiss flag, so it un-hides in every view. Not yet confirmed as final; check before relying on it.
- An added sub-folder is a module: folder icon, the icon opens Module Contents, and it never expands inline.
- Missing refs are never auto-removed; they render as a greyed missing row with a Remove button. This includes deleted added items in the inbox.
- On a rename, refs are rewritten by exact path or `old/` prefix across views, manualPromotions and fold state. Node id and position stay stable. A folder rename triggers a full rebuild.
- A stale explicit status falls back to the set default.
- API source modes are append, overwrite and merge. Overwrite deletes vanished items. Only merge keeps them as 'not found, last seen <date>'.
- An API-backed Folder has the same status options as any Folder with children. There is no derived status; configured statuses apply to API rows like normal children.
- API items need a proper icon, not the generic hollow-circle fallback.
- Data source modal actions (Fetch sample, Test, drops) must not reset scroll.
- Swap keeps the spot's own explicit status. If the parent set doesn't apply to the new type, hide the status rather than deleting it.
- Placing a duplicated item moves its first copy. This is a known limitation tracked separately; don't fix it inside Swap.
- YAML rule matching ignores case of keys and values (`Status: Active` matches `status = active`).

## Obsidian API gotchas

- Obsidian drops a leading-dot file from its index ~100 ms after a rename and fires `delete`. Handle dot-file renames as a distinct hidden case.
- In Obsidian 1.13.7, `vault.delete(folder)` throws EISDIR without force. Pass force in rollback paths.
- Use `requestUrl`, not window `fetch`. Fetch hits app:// CORS, and auth headers trigger preflights.
- Modals belong to the app, not the leaf. Close any open modal in the view's `onClose`.
- Resync `ButtonComponent` via `setDisabled()`, never via the raw `.disabled` attribute.
- A modal's scrolling element is `.modal` (`modalEl`), not `.modal-content`. Preserve `modalEl.scrollTop`.
- Modal state changes usually rebuild via `contentEl.empty()` + re-render, which lets the browser's scroll anchoring reset `.modal`. Save and restore `modalEl.scrollTop` inside `render()` itself (as `StatusesModal` does), never in an opt-in wrapper some call sites forget. For a single field, mutate the component (`setDisabled`) instead of re-rendering.
- Don't validate a field just because a toggle turned on: pre-fill it with its canonical default (e.g. `MIN_REFRESH_MINUTES`) so the toggled-on state starts valid.
- Test mocks of `obsidian` that zero `modalEl.scrollTop` on `contentEl.empty()` don't model real scroll anchoring; assert on `render()` behaviour across every render-triggering interaction.
- A prompt-style `FuzzySuggestModal` never renders `setTitle`. Use `setPlaceholder`.
- Don't wait on metadataCache 'resolved' alone. After a plugin reload it never re-fires, so seed from the idle state.
- A child's rename event can arrive before its parent folder's; check the source folder still exists before treating a child as moved out.
- Ref rewrites run only on Obsidian rename events. A shell `mv` arrives as delete+create and leaves refs stale; test moves in-app or handle delete+create explicitly.
- Linux inotify emits no `fs.watch` 'error' on folder deletion. Close the watcher when a changed path no longer resolves.
- Don't use fixed-timeout waits on real `fs.watch` in tests; they flake. Trigger events deterministically or retry within a bound.
- Obsidian's `input[type=text]:not(:disabled):hover` (specificity 0,3,1) beats two-class rules. Match or exceed its specificity for input border styles.

## Testing in a real Obsidian

- Visual checks run in an Obsidian desktop container (image `obsidian-development-template`) with the worktree bind-mounted as the plugin folder. Build on the host first (`npm run build`); the container only runs the built `main.js`.
- Enumerate the examples and edge cases for each acceptance criterion and check each one visually, not only in unit tests.
- If a bug won't reproduce in the test vault, reproduce it against a copy of a real vault rather than guessing.
- Update `docs/` (GitHub Pages) and `README.md` in the same PR when user-facing behaviour changes.

## Environment and workflow

- On macOS, sed is BSD sed: use `sed -i ''`, not `sed -i`.
- esbuild/rollup binaries installed on macOS are darwin-only; run `npm run build` and vitest on the host, not in a Linux container that mounts the same checkout.
- Never `pkill -f` a pattern that appears in the same `docker exec` command string; it kills the calling shell. Kill by PID from `pgrep`.
- Check the branch merge-base against `origin/main` before opening a PR; a stale base pulls in unrelated files.
- Revert incidental `package-lock.json` changes from `npm install` when they're outside the PR's scope.
