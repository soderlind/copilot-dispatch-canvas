# TODO

## Next version

### GitHub Projects board

- [ ] Add a scrum / kanban board tab for tracked issues and pull requests.
- [ ] Use GitHub Projects v2 as the backend; map columns to the Project's single-select `Status` field and persist card moves there.
- [ ] When no suitable Project exists, offer to create one and add open issues and pull requests from tracked repositories.
- [ ] Decide whether to use one Project for all tracked repos or one per repo.
- [ ] Decide whether the Project is user-owned or org-owned.
- [ ] Define how the Project is linked to tracked repos and how repo changes are synchronized.
- [ ] Decide whether to support a sprint / iteration field or start with kanban only.
- [ ] Document and validate the required `project` token scope (`gh auth refresh -s project`).
- [ ] Add configurable WIP limits per board column.
- [ ] Show time in status so the team can spot bottlenecks.

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
