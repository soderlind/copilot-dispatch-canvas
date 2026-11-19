# Changelog

## Unreleased

### Changed

- Renamed the canvas from **Team load** to **Dispatch**. The canvas ID (`team-load`), extension folder and saved tracking data are unchanged.

### Added

- **Board tab:** Organize tracked issues and pull requests in one GitHub Project v2 per tracking scope. Link an existing Project or explicitly confirm creating a new one.
- **Card moves:** Drag cards or use the **Move to…** menu. Moves update the Project's `Status` field without closing or reopening the underlying issue or pull request. Select a card title to open its details in the canvas.
- **Open-work sync:** Add new open work on refresh. Untracking a repository hides its cards without removing them from GitHub. Closed and merged cards keep their Project status and display a badge.
- **Board settings:** Set non-blocking WIP limits per column and a status-age highlight threshold (seven days by default). Cards show exact status age when GitHub's timeline provides it, and display existing Iteration values without managing sprints.

- **Grant Project access:** When the `project` scope is missing, the Board runs the GitHub device flow for you and shows the one-time code and link, then reloads after approval.

The Board uses the stored GitHub CLI login (not `GH_TOKEN`/`GITHUB_TOKEN`) and requires its write `project` scope. See [Board setup](README.md#board-setup).
