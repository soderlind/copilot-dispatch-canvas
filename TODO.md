# TODO

## Next version

- [ ] **Board tab (scrum / kanban).** Add a tab to the canvas that shows the tracked work as a board.
  - Use a GitHub Project (Projects v2) as the backend. Columns come from the Project's single-select `Status` field, and moving a card updates that field.
  - If the tracked repos have no GitHub Project yet, create one for them and add the repos' open issues and PRs.
  - Open questions:
    - Should there be one Project for all tracked repos, or one per repo?
    - Should the Project be owned by the user or by the org?
    - How should a Project be linked to a set of tracked repos (stored in the tracking file?), and what happens when the repos change?
    - Should the board offer a sprint/iteration field for scrum, or kanban only?
    - Creating Projects needs the `project` token scope (`gh auth refresh -s project`).
