# TODO

## Next version

### GitHub Projects board (implemented)

See the [Unreleased changelog](CHANGELOG.md#unreleased) for the Board summary.

- [x] Add a kanban Board tab for tracked issues and pull requests.
- [x] Map columns to the GitHub Project v2 single-select `Status` field and persist card moves there.
- [x] Prefer an existing editable Project; if no candidate fits, offer creation only with explicit confirmation.
- [x] Share one GitHub Project across tracked repos in each tracking scope.
- [x] Infer the Project creation owner from tracked repos or ask when owners differ.
- [x] Add open work at setup and on refresh; hide untracked work without removing it from GitHub.
- [x] Support drag-and-drop and keyboard-accessible status moves; open card details in the canvas.
- [x] Keep closed and merged cards in their Project status and show a badge.
- [x] Display the Project's existing Iteration field without managing sprints.
- [x] Document and validate the required `project` token scope.
- [x] Grant the `project` scope from the canvas: run the GitHub device flow against the stored GitHub CLI login and show the one-time code and link.
- [x] Add optional, non-blocking WIP limits per status column.
- [x] Show time in status from GitHub's Project timeline, with a configurable highlight threshold.

### Board follow-up

- [ ] Verify Project setup, open-work sync, and status moves against a live GitHub Project using a token with write `project` scope.

### Attention queue

- [ ] Add a queue for work needing attention: failing CI, requested changes, pending reviews, blocked issues, and stale work.
- [ ] Explain why each item is surfaced and make the staleness threshold configurable.

### Copilot session status

- [ ] Replace the temporary session-starting indicator with confirmed running, waiting-for-input, finished, and failed states.
- [ ] Link each status to its Copilot session.
- [ ] Verify which session lifecycle details are available through supported host APIs; show an explicit unavailable state when they are not.

### Capacity and workload

- [ ] Add per-person work-in-progress limits and availability controls in the UI.
- [ ] Separate implementation work from review requests in workload summaries.
- [ ] If estimates are added, read them from optional GitHub Project fields rather than inferring effort from activity counts.
- [ ] Keep workload metrics as planning signals, not individual productivity scores.

### Saved views

- [ ] Let users save named filters, such as "My reviews", "Copilot work", "Unassigned bugs", or selected repositories.
- [ ] Persist and restore the active view across reloads.

### Dependencies and blockers

- [ ] Show known issue dependencies and blockers.
- [ ] Identify work that cannot start until a dependency is resolved.

### Settings and data health

- [ ] Add UI settings for refresh interval and workload limits, replacing hand-edited JSON for common configuration.
- [ ] Show whether tracking is global or Project-scoped.
- [ ] Show last successful refresh and actionable permission or fetch errors.
- [ ] Clearly indicate when Project repository detection falls back to global tracking.
