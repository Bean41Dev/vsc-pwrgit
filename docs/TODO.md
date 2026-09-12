# TODO / Roadmap

Planned features and known limitations, gathered during development. Roughly ordered by
value.

## Features

All originally-planned features are implemented (see **Done**). Ideas welcome.

## Robustness / polish

All tracked robustness items are done (see **Done**). Only **Quality** remains.

## Quality

- [ ] **Tests.** No automated tests yet; add unit coverage for `buildGraph` and the git
      service parsers (status/branches/log), and a smoke test for the webview protocol.

## Done

- [x] Bottom-panel webview with activity rail (Git Log / Changes / Fetch / Console / Refresh).
- [x] Branch explorer (local/remote) + commit graph with colored lanes.
- [x] Ahead/behind badges, including outgoing counts for unpushed branches.
- [x] Commit → changed files → native diff.
- [x] Branch & commit context menus (checkout, merge, rebase, cherry-pick, revert, reset,
      rename, delete, push, force-push-with-lease, …).
- [x] Changes view: stage-by-checkbox commit, Commit and Push, Amend, multi-file Rollback.
- [x] Command Console with stdout/stderr and error indicator.
- [x] Live auto-refresh via filesystem watchers + manual Refresh.
- [x] Log filtering: double-click branch/tag + free-text (message/author/hash) search with Clear.
- [x] Multi-select (Ctrl/Shift click) + interactive squash of a contiguous range.
- [x] Operation-in-progress banner (merge/rebase/cherry-pick/revert) with Continue/Skip/Abort.
- [x] Configurable commit limit (header input) + "Load more" row when more history exists.
- [x] Stash support: Stash button + Stashes tab with Apply / Pop / Drop.
- [x] Tags in the refs explorer with Checkout / New Branch / Push / Delete; Create Tag on a commit.
- [x] Push-after-amend warning when amending an already-pushed commit.
- [x] Worktree refs watcher: also watch the common git dir so shared-ref updates refresh.
- [x] Changes/details header: commit hash + message with copy icons and a close button.
- [x] Narrowed the working-tree watcher to a reused string-glob watcher (honors files.watcherExclude).
- [x] Binary/large-file diffs: size + NUL guard returns a placeholder (with blob id) instead of raw bytes.
- [x] Filter stray remote refs (symbolic/HEAD/bare) from the Remote group.
- [x] Status-only refresh on working-tree file saves (full reload only on .git changes).
- [x] Packaging: icon, LICENSE, CHANGELOG, marketplace metadata, and `npm run package` (vsce).
