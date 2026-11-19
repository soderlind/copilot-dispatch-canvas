import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createHub } from "../hub.mjs";
import { startServer } from "../server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const repo = "octo/demo";
const title = "Fix the Board layout";
const date = "2026-01-02T10:00:00Z";
const project = {
    id: "p-team", number: 2, title: "Dispatch", viewerCanUpdate: true,
    status: { id: "field", options: [{ id: "todo", name: "Todo" }, { id: "done", name: "Done" }] },
};
const unrelated = { ...project, id: "p-personal", number: 1, title: "Personal errands" };
const connection = (...nodes) => ({ nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false } });

function fixture() {
    let tracking = { repos: [repo], knownRepos: [], hidden: [] };
    const store = { read: async () => tracking, write: async next => (tracking = next) };
    const issue = {
        __typename: "Issue", id: "issue", nodeId: "issue", repository: { nameWithOwner: repo },
        number: 1, title, state: "OPEN",
    };
    const mutations = [];
    let item;
    const github = {
        gh: async () => "HTTP/2 200 OK\nX-OAuth-Scopes: project, repo\n\n{}",
        fetchRepo: async () => [{ ...issue, repository: repo, kind: "issue", assignees: [], reviewers: [], labels: [], updatedAt: date }],
        repoInfo: async () => ({ nameWithOwner: repo, open: 1 }),
        viewerRepos: async () => [],
        me: async () => "octo",
        history: async () => ({ events: [], truncated: false }),
        detail: async ref => ({
            ...ref, kind: "issue", title, state: "open", author: null, labels: [], assignees: [],
            comments: { total: 0, nodes: [] }, createdAt: date, bodyHTML: "<p>Example issue description.</p>",
        }),
        async gql(query, values) {
            if (query.includes("repositoryOwner")) return {
                repositoryOwner: { __typename: "User", login: "octo", id: "owner", projectsV2: connection(unrelated) },
            };
            if (query.includes("viewer{login}")) return { viewer: { login: "octo" } };
            if (query.includes("createProjectV2")) {
                mutations.push(["create", values]);
                return { createProjectV2: { projectV2: project } };
            }
            if (query.includes("addProjectV2ItemById")) {
                mutations.push(["add", values]);
                item = { id: "card", createdAt: date, status: { id: "status", optionId: "todo", updatedAt: date }, project, content: issue };
                return { addProjectV2ItemById: { item } };
            }
            if (query.includes("updateProjectV2ItemFieldValue")) {
                mutations.push(["move", values]);
                item.status = { ...item.status, optionId: values.option };
                return { updateProjectV2ItemFieldValue: { projectV2Item: item } };
            }
            if (query.includes("timelineItems")) return { node: { timelineItems: connection() } };
            if (query.includes("items(first")) return { node: { items: connection(...(item ? [item] : [])) } };
            if (query.includes("... on ProjectV2Item{")) return { node: item };
            if (query.includes("... on ProjectV2{")) return { node: project };
            throw new Error(`Unexpected stub query: ${query}`);
        },
    };
    return { hub: createHub({ store, github }), mutations };
}

test("Board browser: tabs, confirmed creation, populated columns, status move and details/back", { timeout: 20_000 }, async () => {
    const { hub, mutations } = fixture();
    const server = await startServer(() => ({ hub }));
    try {
        const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROME_CHANNEL });
        try {
            const page = await browser.newPage();
            page.setDefaultTimeout(3000);
            await page.route("**/*", route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
            const errors = [];
            page.on("pageerror", error => errors.push(error.message));
            await page.goto(server.url);
            const tab = name => page.getByRole("tab", { name, exact: true });
            const panel = name => page.getByRole("tabpanel", { name, exact: true, includeHidden: true });
            const expectVisible = async (target, visible = true) => {
                await target.waitFor({ state: visible ? "visible" : "hidden", timeout: 3000 });
                assert.equal(await target.evaluate(el => getComputedStyle(el).visibility === "visible" && !!el.getClientRects().length), visible);
            };
            await expectVisible(panel("Workload"));
            await tab("Board").click();
            await expectVisible(panel("Workload"), false);
            await expectVisible(panel("Board"));
            const linkProject = page.getByRole("button", { name: "Link Project", exact: true });
            await linkProject.waitFor({ state: "visible", timeout: 3000 });
            assert.match(await page.getByRole("combobox", { name: "GitHub Project", exact: true }).textContent(), /Personal errands/);
            await tab("Workload").click();
            await expectVisible(panel("Workload"));
            await expectVisible(panel("Board"), false);
            await tab("Board").click();
            await page.getByText("None of these Projects fit? Create a new Project").click();
            const confirm = page.getByRole("checkbox", { name: "I confirm creating and populating this Project on GitHub." });
            assert.equal(await confirm.isChecked(), false);
            await page.getByRole("button", { name: "Create Project", exact: true }).click();
            assert.deepEqual(mutations, []);
            await confirm.check();
            await page.getByRole("button", { name: "Create Project", exact: true }).click();

            const todo = page.getByRole("region", { name: "Todo", exact: true });
            const done = page.getByRole("region", { name: "Done", exact: true });
            const cardIn = column => column.getByRole("link", { name: title, exact: true });
            await expectVisible(cardIn(todo));
            await expectVisible(done);
            await todo.getByRole("combobox", { name: `Move ${repo}#1 to Status` }).selectOption({ label: "Done" });
            await expectVisible(cardIn(done));
            await cardIn(done).click();
            await page.getByText("Example issue description.", { exact: true }).waitFor({ state: "visible", timeout: 3000 });
            await expectVisible(panel("Board"), false);
            await page.getByRole("button", { name: "Back", exact: true }).click();
            await expectVisible(panel("Board"));
            await expectVisible(panel("Workload"), false);
            await expectVisible(cardIn(done));
            assert.equal(await tab("Board").getAttribute("aria-selected"), "true");
            assert.deepEqual(mutations, [
                ["create", { owner: "owner", title: "Dispatch" }],
                ["add", { project: "p-team", content: "issue" }],
                ["move", { project: "p-team", item: "card", field: "field", option: "done" }],
            ]);
            assert.deepEqual(errors, []);
        } finally { await browser.close(); }
    } finally { await server.close(); }
});
