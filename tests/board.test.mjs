import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardPanel, statusAge } from "../assets/board.mjs";
import { createBoardGitHub, exactStatusSince } from "../board-github.mjs";
import { createBoard } from "../board.mjs";
import { createHub } from "../hub.mjs";
import { startServer } from "../server.mjs";
import { createTrackingStore } from "../state.mjs";
import { TeamLoadError } from "../model.mjs";

const createdAt = "2026-01-01T10:00:00Z";
const movedAt = "2026-01-02T10:00:00Z";
const project = { id: "project", title: "Test", status: { id: "field", options: [{ id: "todo", name: "Todo" }, { id: "done", name: "Done" }] } };
const card = (id, repo, state = "OPEN", type = "Issue") => ({
    id: `item-${id}`, createdAt, project, status: { optionId: "todo", updatedAt: movedAt },
    content: { id, number: 1, title: id, state, __typename: type, repository: { nameWithOwner: repo } },
});

function fixture() {
    let current = { repos: ["a/repo", "b/repo"] };
    const calls = [];
    const candidates = { projects: [project, { ...project, id: "other-project" }], owners: [{ id: "a", canCreate: true }, { id: "b", canCreate: true }] };
    const items = [card("existing", "a/repo"), card("closed", "a/repo", "CLOSED"), card("merged", "b/repo", "MERGED", "PullRequest")];
    items[2].iteration = { title: "Cycle 1" };
    const work = [{ repository: "a/repo", nodeId: "existing" }, { repository: "b/repo", nodeId: "new" }];
    const github = {
        authorize: async () => {},
        discover: async () => candidates,
        project: async () => project,
        create: async (owner, title) => { calls.push(["create", owner, title]); return project; },
        items: async () => [...items],
        item: async id => items.find(i => i.id === id),
        add: async (id, content) => { calls.push(["add", id, content]); items.push(card(content, work.find(i => i.nodeId === content).repository)); },
        move: async (...args) => { calls.push(["move", ...args]); },
        statusSince: async item => item.content.id === "existing" ? movedAt : null,
    };
    const board = createBoard({
        github, tracking: async () => current, save: async board => { current = { ...current, board }; },
        openWork: async repos => ({ warnings: [], items: work.filter(item => repos.includes(item.repository)) }),
    });
    return { board, github, candidates, items, work, calls, setRepos: repos => { current = { ...current, repos }; } };
}

test("Board can create a Project despite unrelated candidates, only with a confirmed, available owner", async () => {
    const { board, calls } = fixture();
    assert.deepEqual((await board.refresh()).setup.projects.map(p => p.id), ["project", "other-project"]);
    await assert.rejects(board.connect({ ownerId: "b", title: "Board" }), /Explicitly confirm/);
    await assert.rejects(board.connect({ ownerId: "elsewhere", title: "Board", confirmed: true }), /tracked repository owner/);
    assert.deepEqual(calls, []);
    await board.connect({ ownerId: "b", title: " Board ", confirmed: true });
    assert.deepEqual(calls, [["create", "b", "Board"]]);
});

test("organization creation is attempted only with confirmation and exposes GitHub policy denials", async () => {
    const { board, github, candidates } = fixture();
    candidates.owners[1] = { id: "b", login: "team-org", canCreate: null };
    let attempts = 0;
    github.create = async () => {
        attempts++;
        throw new TeamLoadError("permission_denied", "GitHub refused the mutation.");
    };
    await assert.rejects(board.connect({ ownerId: "b", title: "Board" }), /Explicitly confirm/);
    assert.equal(attempts, 0);
    await assert.rejects(board.connect({ ownerId: "b", title: "Board", confirmed: true }),
        { code: "permission_denied", message: /team-org.*organization owner.*Project creation policy/ });
    assert.equal(attempts, 1);
});

test("Board seeds open work, syncs new work, preserves closed cards and never removes untracked items", async () => {
    const { board, items, work, calls, setRepos } = fixture();
    await board.connect({ projectId: "project" });
    const first = await board.refresh();
    assert.deepEqual(first.cards.map(c => [c.id, c.state, c.option, c.iteration, c.since]), [
        ["item-existing", "OPEN", "todo", null, movedAt],
        ["item-closed", "CLOSED", "todo", null, null],
        ["item-merged", "MERGED", "todo", "Cycle 1", null],
        ["item-new", "OPEN", "todo", null, null],
    ]);
    work.push({ repository: "a/repo", nodeId: "later" });
    await board.refresh({ force: true });
    setRepos(["a/repo"]);
    assert.deepEqual((await board.refresh()).cards.map(c => c.id), ["item-existing", "item-closed", "item-later"]);
    assert.ok(items.some(c => c.id === "item-merged") && items.some(c => c.id === "item-new"));
    assert.deepEqual(calls, [["add", "project", "new"], ["add", "project", "later"]]);
});

test("status moves are scoped to current Project, item and option and do not enforce WIP limits", async () => {
    const { board, calls, setRepos } = fixture();
    await board.connect({ projectId: "project" });
    assert.deepEqual((await board.refresh()).settings, { projectId: "project", highlightDays: 7, limits: {} });
    await board.configure({ projectId: "project", highlightDays: 3, limits: { todo: 1 } });
    await assert.rejects(board.move({ projectId: "other-project", itemId: "item-existing", optionId: "done" }), /Project changed/);
    await assert.rejects(board.move({ projectId: "project", itemId: "item-existing", optionId: "removed" }), /Status no longer exists/);
    setRepos(["b/repo"]);
    await assert.rejects(board.move({ projectId: "project", itemId: "item-existing", optionId: "done" }), /untracked/);
    await board.move({ projectId: "project", itemId: "item-merged", optionId: "done" });
    // The WIP warning does not prevent an open card from entering the limited column.
    setRepos(["a/repo", "b/repo"]);
    await board.configure({ projectId: "project", highlightDays: 3, limits: { done: 1 } });
    await board.move({ projectId: "project", itemId: "item-existing", optionId: "done" });
    assert.deepEqual(calls.filter(([op]) => op === "move"), [
        ["move", "project", "item-merged", "field", "done"],
        ["move", "project", "item-existing", "field", "done"],
    ]);
});

test("Board settings persist separately across global and Copilot Project tracking writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "team-load-board-"));
    try {
        const global = createTrackingStore(home);
        const local = createTrackingStore(home, { project: "scope-a" });
        await global.write({ repos: ["a/repo"], board: { projectId: "one", limits: { todo: 2 } } });
        assert.equal((await local.read()).board, undefined);
        await local.write({ repos: ["b/repo"], board: { projectId: "two", highlightDays: 9 } });
        await local.write({ repos: [] });
        assert.deepEqual((await local.read()).board, { projectId: "two", highlightDays: 9, limits: {} });
        await local.write({ repos: [], board: null });
        assert.equal((await local.read()).board, undefined);
        assert.deepEqual((await global.read()).board, { projectId: "one", highlightDays: 7, limits: { todo: 2 } });
    } finally { await rm(home, { recursive: true, force: true }); }
});

test("exact age pages past other Projects but rejects overwritten, missing, or previous-membership events", async () => {
    const event = (id, status, date = movedAt) => ({ __typename: "ProjectV2ItemStatusChangedEvent", project: { id }, status, createdAt: date });
    const last = nodes => ({ nodes, pageInfo: { hasPreviousPage: false } });
    assert.equal(await exactStatusSince(async before => before ? last([event("project", "Todo")])
        : { nodes: [event("other", "Done")], pageInfo: { hasPreviousPage: true, startCursor: "earlier" } }, "project", "Todo", createdAt), movedAt);
    for (const events of [[], [event("project", "Todo"), event("project", "Done")],
        [event("project", "Todo", "2025-12-01T10:00:00Z")],
        [event("project", "Todo"), { ...event("project", ""), __typename: "AddedToProjectV2Event" }]]) {
        assert.equal(await exactStatusSince(async () => last(events), "project", "Todo", createdAt), null);
    }
    assert.deepEqual(statusAge(null, 7), { text: "Status age unavailable", highlighted: false });
    assert.equal(statusAge(movedAt, 7, Date.parse(movedAt) + 7 * 86400_000 - 1).highlighted, false);
    assert.deepEqual(statusAge(movedAt, 7, Date.parse(movedAt) + 7 * 86400_000), { text: "7d in status", highlighted: true });
});

test("GitHub adapter requires write project scope and sends only a Status field value", async () => {
    let scope = "read:project, repo";
    const calls = [];
    const api = createBoardGitHub({
        gh: async () => `HTTP/2 200 OK\r\nX-OAuth-Scopes: ${scope}\r\n\r\n{}`,
        gql: async (query, values) => {
            calls.push([query, values]);
            return { updateProjectV2ItemFieldValue: { projectV2Item: { status: { optionId: "done" } } } };
        },
    });

    await assert.rejects(api.authorize(), { code: "permission_denied", message: /gh auth refresh -h github.com -s project/ });
    scope = "project, repo";
    await api.authorize();
    await api.move("project", "item-existing", "field", "done");
    const [[query, values]] = calls;
    assert.match(query, /updateProjectV2ItemFieldValue\(input:\{projectId:\$project,itemId:\$item,fieldId:\$field,value:\{singleSelectOptionId:\$option\}\}/);
    assert.deepEqual(values, { project: "project", item: "item-existing", field: "field", option: "done" });
});

test("GitHub discovery lists organization Projects without assuming a creation permission", async () => {
    const api = createBoardGitHub({
        gh: async () => "HTTP/2 200 OK\nX-OAuth-Scopes: project, repo\n\n{}",
        gql: async (query, { login }) => {
            if (query.includes("viewer{login}")) return { viewer: { login: "me" } };
            assert.match(query, /\.\.\. on Organization\{projectsV2/);
            assert.doesNotMatch(query, /viewerCanCreateProjects/);
            const org = login === "org";
            return { repositoryOwner: {
                __typename: org ? "Organization" : "User", login, id: login,
                projectsV2: { nodes: org ? [{ ...project, viewerCanUpdate: true }] : [], pageInfo: { hasNextPage: false } },
            } };
        },
    });
    const setup = await api.discover(["org/repo", "me/repo"]);
    assert.deepEqual(setup.owners, [{ id: "org", login: "org", canCreate: null }, { id: "me", login: "me", canCreate: true }]);
    assert.deepEqual(setup.projects.map(p => p.id), ["project"]);
});

test("Board renderer shows a soft WIP warning, badges, and the same issue detail route", async () => {
    const element = () => ({ innerHTML: "", addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null });
    const content = element();
    const { board } = fixture();
    await board.connect({ projectId: "project" });
    await board.configure({ projectId: "project", highlightDays: 7, limits: { todo: 2 } });
    const panel = createBoardPanel({
        host: element(), content, errorElement: element(), announcement: element(),
        post: () => board.refresh(), context: () => ({ boardProjectId: "project", tracking: { repos: ["a/repo", "b/repo"] } }),
        esc: String, hashFor: key => `#item/${key.replace("#", "/")}`,
    });
    await panel.sync();
    assert.match(content.innerHTML, /WIP 2\/2 · limit reached/);
    assert.match(content.innerHTML, /data-item="a\/repo#1" href="#item\/a\/repo\/1"/);
    assert.match(content.innerHTML, />Merged</);
    assert.match(content.innerHTML, />Closed</);
    assert.match(content.innerHTML, /Iteration: Cycle 1/);
    assert.match(content.innerHTML, /<select data-move/);
});

test("linked Board adds newly fetched open work when the hub refreshes, even on the Workload tab", async () => {
    let nodeId = "first";
    const items = [];
    const added = [];
    const store = { read: async () => ({ repos: ["a/repo"], knownRepos: [], hidden: [], board: { projectId: "project", highlightDays: 7, limits: {} } }) };
    const github = {
        fetchRepo: async repository => [{ repository, nodeId }],
        repoInfo: async () => ({ nameWithOwner: "a/repo" }),
        viewerRepos: async () => [],
        me: async () => "a",
        gh: async () => "HTTP/2 200 OK\nX-OAuth-Scopes: project, repo\n\n{}",
        gql: async (query, values) => {
            if (query.includes("mutation")) {
                assert.match(query, /addProjectV2ItemById/);
                added.push(values.content);
                const item = { ...card(values.content, "a/repo"), status: null };
                items.push(item);
                return { addProjectV2ItemById: { item } };
            }
            if (query.includes("items(first")) return { node: { items: { nodes: [...items], pageInfo: { hasNextPage: false } } } };
            return { node: { ...project, viewerCanUpdate: true } };
        },
    };
    const hub = createHub({ store, github });
    const server = await startServer(() => ({ hub }));
    try {
        const html = await (await fetch(server.url)).text();
        const [, nonce] = /name="team-load-nonce" content="([^"]+)"/.exec(html);
        assert.match(html, /id="board-tab"/);
        assert.equal((await fetch(new URL("board.mjs", server.url))).status, 200);
        const post = (action, input = {}) => fetch(new URL("api/action", server.url), {
            method: "POST", headers: { "content-type": "application/json", "x-team-load-nonce": nonce },
            body: JSON.stringify({ action, input }),
        });
        const read = async () => {
            const response = await post("get_board");
            assert.equal(response.status, 200);
            return (await response.json()).cards.map(c => c.title);
        };
        assert.equal((await post("refresh", { force: true })).status, 200);
        assert.deepEqual(await read(), ["first"]);
        nodeId = "second";
        assert.equal((await post("refresh", { force: true })).status, 200);
        assert.deepEqual(await read(), ["first", "second"]);
        assert.deepEqual(added, ["first", "second"]);
    } finally { await server.close(); }
});
