export function statusAge(since, threshold, now = Date.now()) {
    const elapsed = now - Date.parse(since);
    if (!Number.isFinite(elapsed) || elapsed < 0) return { text: "Status age unavailable", highlighted: false };
    const hours = Math.floor(elapsed / 3600_000);
    return {
        text: hours >= 24 ? `${Math.floor(hours / 24)}d in status` : hours ? `${hours}h in status` : "<1h in status",
        highlighted: elapsed >= threshold * 86400_000,
    };
}

export function createBoardPanel({ host, content, errorElement, announcement, post, context, onChange, esc, hashFor }) {
    let data, key, pending, dragged;
    let version = 0;
    let writing = false;
    const currentKey = () => {
        const state = context();
        return state && JSON.stringify([state.boardProjectId, state.tracking.repos.map(repo => repo.toLowerCase())]);
    };
    const error = message => {
        errorElement.textContent = message ?? "";
        errorElement.hidden = !message;
    };
    const announce = message => { announcement.textContent = message; };
    const opts = entries => entries.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("");

    function setup({ repos, setup: { projects, owners } }) {
        if (!repos.length) return `<p class="empty-note">Track a repository to set up the Board.</p>`;
        const existing = projects.length ? `<form class="board-form box" data-action="connect_board">
          <h2>Link a GitHub Project</h2>
          <p>Reuse an existing Project if it fits these repos. Open issues and pull requests from your tracked repos will be added to the Project you choose.</p>
          <label>GitHub Project <select name="projectId" aria-label="GitHub Project" required>${projects.length > 1 ? '<option value="">Choose a Project</option>' : ""}
            ${opts(projects.map(p => [p.id, `${p.owner} #${p.number}: ${p.title}`]))}</select></label>
          <button type="submit" class="btn">Link Project</button>
        </form>` : "";
        const writable = owners.filter(owner => owner.canCreate !== false);
        if (existing && !writable.length) return existing;
        if (!writable.length) return `<p class="empty-note">No editable Project with a Status field was found, and this account cannot create a Project under any tracked repo owner. Check owner permissions or use an account with Project write access.</p>`;
        const create = `<form class="board-form box" data-action="connect_board">
          <h2>Create a GitHub Project</h2>
          <p>The new Project will receive open issues and pull requests from all tracked repos.</p>
          ${owners.length === 1 ? `<p>Owner: <strong>${esc(writable[0].login)}</strong></p><input type="hidden" name="ownerId" value="${esc(writable[0].id)}">`
            : `<label>Owner <select name="ownerId" aria-label="Owner" required><option value="">Choose a tracked repo owner</option>${opts(writable.map(o => [o.id, o.login]))}</select></label>`}
          ${writable.some(owner => owner.canCreate === null) ? `<p class="dim">GitHub checks organization creation permissions when you submit.</p>` : ""}
          <label>Title <input name="title" value="Team load" maxlength="100" required></label>
          <label><input name="confirmed" type="checkbox" required> I confirm creating and populating this Project on GitHub.</label>
          <button type="submit" class="btn">Create Project</button>
        </form>`;
        return existing ? `${existing}<details class="board-settings"><summary>None of these Projects fit? Create a new Project</summary>${create}</details>` : create;
    }

    function cardHTML(card) {
        const item = `${card.repository}#${card.number}`;
        const age = statusAge(card.since, data.settings.highlightDays);
        const badge = card.state === "MERGED" ? "Merged" : card.state === "CLOSED" ? "Closed" : "";
        return `<li class="board-card" data-card="${esc(card.id)}"${card.archived ? "" : ' draggable="true"'}>
          <span class="dim">${card.kind === "pr" ? "PR" : "Issue"} · ${esc(item)}</span>
          <a data-item="${esc(item)}" href="${esc(hashFor(item))}">${esc(card.title)}</a>
          <div class="board-card-meta">${badge ? `<span class="board-badge">${badge}</span>` : ""}${card.archived ? '<span class="board-badge">Archived</span>' : ""}
            ${card.iteration ? `<span class="board-badge">Iteration: ${esc(card.iteration)}</span>` : ""}
            <span class="${age.highlighted ? "board-warning" : "dim"}">${esc(age.text)}</span></div>
          ${card.archived ? "" : `<select data-move aria-label="Move ${esc(item)} to Status">
            <option value="">Move to…</option>${opts(data.options.filter(o => o.id !== card.option).map(o => [o.id, o.name]))}
          </select>`}
        </li>`;
    }

    function boardHTML() {
        const { cards, options, settings, project, warnings } = data;
        const unassigned = cards.some(card => !card.option);
        const columns = [...(unassigned ? [{ id: "", name: "No status" }] : []), ...options];
        const url = /^https:\/\/github\.com\//.test(project.url) ? project.url : null;
        return `<header class="board-header">
          <h2>${esc(project.title)}</h2>
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open on GitHub</a>` : ""}
        </header>
        ${warnings.length ? `<div class="notice" role="status">${warnings.map(esc).join("<br>")}</div>` : ""}
        <div class="board-columns" tabindex="0" aria-label="Status columns">${columns.map(({ id, name }) => {
            const here = cards.filter(card => (card.option ?? "") === id);
            const count = here.filter(card => card.state === "OPEN" && !card.archived).length;
            const limit = Object.hasOwn(settings.limits, id) ? settings.limits[id] : null;
            return `<section class="board-column box" ${id ? `data-option="${esc(id)}"` : ""} aria-label="${esc(name)}">
              <header><h3>${esc(name)} <span class="Counter">${here.length}</span></h3>
                ${limit ? `<p class="${count >= limit ? "board-warning" : "dim"}">WIP ${count}/${limit}${count > limit ? " · over limit" : count === limit ? " · limit reached" : ""}</p>` : ""}
              </header><ul>${here.map(cardHTML).join("")}</ul>
            </section>`;
        }).join("")}</div>
        <details class="board-settings"><summary>Board settings</summary>
          <form class="board-form" data-action="configure_board">
            <label>Highlight after (days) <input name="highlightDays" type="number" min="1" max="365" value="${settings.highlightDays}" required></label>
            <p class="dim">WIP counts open, unarchived cards. Leave a limit blank to turn its warning off.</p>
            ${options.map(({ id, name }) => `<label>${esc(name)} WIP limit <input type="number" min="1" max="9999" data-limit="${esc(id)}" value="${Object.hasOwn(settings.limits, id) ? settings.limits[id] : ""}"></label>`).join("")}
            <button type="submit" class="btn">Save Board settings</button>
          </form>
          ${disconnectHTML()}
        </details>`;
    }
    const disconnectHTML = () => `<button type="button" class="btn" data-disconnect>Unlink Project</button><p class="dim">Unlinking does not remove any items or change the Project on GitHub.</p>`;

    function render() {
        const settingsOpen = content.querySelector(".board-settings")?.open;
        content.innerHTML = data?.setup ? setup(data) : data ? boardHTML()
            : `<p class="empty-note">Board data is unavailable.</p>${context()?.boardProjectId ? disconnectHTML() : ""}`;
        if (settingsOpen && content.querySelector(".board-settings")) content.querySelector(".board-settings").open = true;
    }

    async function sync({ force = false } = {}) {
        const nextKey = currentKey();
        if (!nextKey || host.hidden || writing) return;
        if (key === nextKey && (pending || (!force && data))) return pending;
        if (key !== nextKey) {
            key = nextKey;
            data = null;
            error(null);
            content.textContent = "Loading Board…";
        }
        const token = ++version;
        if (!data) content.setAttribute("aria-busy", "true");
        const run = (async () => {
            try {
                const next = await post("get_board", { force });
                if (token !== version || nextKey !== currentKey()) return;
                const changed = !data || JSON.stringify(data) !== JSON.stringify(next);
                data = next;
                error(null);
                if (changed || !content.querySelector("form input:focus, form select:focus, .board-card :focus")) render();
            } catch (failure) {
                if (token !== version || nextKey !== currentKey()) return;
                data = null;
                error(failure.message);
                render();
            } finally {
                if (token === version) {
                    pending = null;
                    content.removeAttribute("aria-busy");
                }
            }
        })();
        pending = run;
        return run;
    }

    async function write(action, input, message) {
        if (writing) return;
        writing = true;
        version++;
        pending = null;
        error(null);
        content.setAttribute("aria-busy", "true");
        const controls = [...content.querySelectorAll("button, input, select")].filter(control => !control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try {
            await post(action, input);
            await onChange();
            announce(message);
        } catch (failure) {
            error(failure.message);
            return;
        } finally {
            writing = false;
            controls.forEach(control => { control.disabled = false; });
            content.removeAttribute("aria-busy");
        }
        await sync({ force: true });
        if (input.itemId) {
            const card = content.querySelector(`[data-card="${CSS.escape(input.itemId)}"]`);
            if (!host.hidden && document.activeElement === document.body) (card?.querySelector("[data-move]") ?? card?.querySelector("a"))?.focus();
        }
    }

    function move(itemId, optionId) {
        if (itemId && optionId && data?.project && data.cards.some(card => card.id === itemId && !card.archived && card.option !== optionId)) {
            write("move_board_card", { projectId: data.project.id, itemId, optionId }, "Card moved.");
        }
    }
    host.addEventListener("submit", event => {
        const form = event.target.closest("form[data-action]");
        if (!form) return;
        event.preventDefault();
        const fields = new FormData(form);
        if (form.dataset.action === "configure_board") {
            const limits = Object.fromEntries([...form.querySelectorAll("[data-limit]")].filter(input => input.value).map(input => [input.dataset.limit, Number(input.value)]));
            write("configure_board", { projectId: data.project.id, highlightDays: Number(fields.get("highlightDays")), limits }, "Board settings saved.");
        } else if (fields.has("projectId")) {
            write("connect_board", { projectId: fields.get("projectId") }, "GitHub Project linked.");
        } else if (fields.has("confirmed")) {
            write("connect_board", { ownerId: fields.get("ownerId"), title: fields.get("title"), confirmed: true }, "GitHub Project created.");
        }
    });
    host.addEventListener("click", event => {
        if (event.target.closest("[data-disconnect]")) {
            const projectId = context()?.boardProjectId;
            if (projectId) write("disconnect_board", { projectId }, "GitHub Project unlinked.");
        }
    });
    host.addEventListener("change", event => {
        const menu = event.target.closest("[data-move]");
        if (!menu) return;
        const { value } = menu;
        menu.value = "";
        move(menu.closest("[data-card]").dataset.card, value);
    });
    function endDrag() {
        dragged = null;
        content.querySelectorAll(".board-drop").forEach(column => column.classList.remove("board-drop"));
    }
    host.addEventListener("dragstart", event => {
        const card = event.target.closest('[data-card][draggable="true"]');
        if (!card || writing) return;
        dragged = card.dataset.card;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragged);
    });
    host.addEventListener("dragover", event => {
        const column = event.target.closest("[data-option]");
        if (!dragged || !column) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        content.querySelectorAll("[data-option]").forEach(el => el.classList.toggle("board-drop", el === column));
    });
    host.addEventListener("drop", event => {
        const column = event.target.closest("[data-option]");
        if (!dragged || !column) return;
        event.preventDefault();
        const item = dragged;
        endDrag();
        move(item, column.dataset.option);
    });
    host.addEventListener("dragend", endDrag);
    return { sync };
}
