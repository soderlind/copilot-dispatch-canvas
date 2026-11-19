# Changelog

## Unreleased

### Changed

- Renamed the canvas from **Team load** to **Dispatch**: the display name, the canvas ID (`dispatch`), the extension folder (`~/.copilot/extensions/dispatch`) and the repository (`soderlind/copilot-dispatch-canvas`).
- Renamed internal identifiers to match: `DispatchError`, the `dispatch_error` code, the `x-dispatch-nonce` header, local storage keys and the drag data type.
- Tracking files are now saved in the `dispatch-tracking` format. Files in the old `team-load-tracking` format still load and are rewritten in the new format on the next save.

### Migration

- If you cloned the old repository, run `git remote set-url origin https://github.com/soderlind/copilot-dispatch-canvas.git` (GitHub also redirects the old URL).
- Move `~/.copilot/extensions/team-load` to `~/.copilot/extensions/dispatch` to keep your saved tracking, then reload extensions and open the `dispatch` canvas.

### Added

- **Board tab:** Organize tracked issues and pull requests in one GitHub Project v2 per tracking scope. Link an existing Project or explicitly confirm creating a new one.
- **Card moves:** Drag cards or use the **Move to…** menu. Moves update the Project's `Status` field without closing or reopening the underlying issue or pull request. Select a card title to open its details in the canvas.
- **Open-work sync:** Add new open work on refresh. Untracking a repository hides its cards without removing them from GitHub. Closed and merged cards keep their Project status and display a badge.
- **Board settings:** Set non-blocking WIP limits per column and a status-age highlight threshold (seven days by default). Cards show exact status age when GitHub's timeline provides it, and display existing Iteration values without managing sprints.

- **Grant Project access:** When the `project` scope is missing, the Board runs the GitHub device flow for you and shows the one-time code and link, then reloads after approval.

The Board uses the stored GitHub CLI login (not `GH_TOKEN`/`GITHUB_TOKEN`) and requires its write `project` scope. See [Board setup](README.md#board-setup).
