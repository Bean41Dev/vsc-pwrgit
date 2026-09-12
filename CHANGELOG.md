# Changelog

## 1.0.0

Initial release — a Git tool window in the VS Code bottom panel.

- Branch/refs explorer (local, remote, tags) with ahead/behind indicators.
- Commit graph with colored lanes, ref badges, and the current commit highlighted.
- Log filtering: double-click a branch/tag to scope; free-text search by message, author, or hash.
- Configurable commit limit with a "Load more" row.
- Commit → changed files → native diff (with binary/large-file guards).
- Changes view: stage-by-checkbox commit, Commit and Push, Amend, multi-file Rollback,
  Stash (button + Stashes tab: Apply / Pop / Drop).
- Context-menu actions for branches, commits, and tags (checkout, merge, rebase, cherry-pick,
  revert, reset, push, force-push-with-lease, update, create/delete, etc.).
- Multi-select + interactive squash of a contiguous commit range.
- Operation-in-progress banner (merge/rebase/cherry-pick/revert) with Continue / Skip / Abort.
- Merge/Rebase pull-strategy toggle; command Console; live auto-refresh with a status-bar loader.
