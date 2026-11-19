import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { TeamLoadError } from "./model.mjs";
import { createTrackingStore } from "./state.mjs";
import { createGitHub } from "./github.mjs";
import { createHub } from "./hub.mjs";
import { createProjectScan, detectProjectRepos } from "./project.mjs";
import { startServer, perform } from "./server.mjs";

const instances = new Map();
const diagnostics = [];
let session;
let context;
let setup;
let resolveSession;
const sessionReady = new Promise(resolve => { resolveSession = resolve; });
const liveProjectRepos = [];

function log(message) {
    // Background GitHub hiccups are retried on the next refresh, so keep them out of the transcript.
    if (session) session.log(message, { level: "warning", ephemeral: true }).catch(() => {});
    else diagnostics.push(message);
}

// Inside a Copilot Project the canvas tracks that Project's repositories in a tracking file of its own; elsewhere it uses
// the global one. The Project's repos are read from this session's history once, then followed live.
async function createContext() {
    const current = await sessionReady;
    let projectRepos = null;
    try {
        projectRepos = await detectProjectRepos({ sessionId: current.sessionId, getEvents: () => current.getEvents() });
    } catch (error) {
        log(`Team Load: could not read this session's Project repositories (${error.message}); using global tracking.`);
    }
    const project = projectRepos !== null;
    const sendPrompt = async prompt => {
        if (!session?.send) throw new Error("The hosting Copilot session is unavailable.");
        return session.send({ prompt });
    };
    const store = createTrackingStore(undefined, project ? { project: current.sessionId } : {});
    const hub = createHub({ store, github: createGitHub({ log }), sendPrompt, log, project });
    if (project) await syncProjectRepos(hub, [...projectRepos, ...liveProjectRepos.splice(0)]);
    return { hub, project };
}

async function syncProjectRepos(hub, names) {
    const { skipped } = await hub.addProjectRepos(names);
    if (skipped.length) log(`Team Load: this Project has more repositories than can be tracked at once; not tracking ${skipped.join(", ")}. Choose them in the Tracking panel.`);
}

async function configure() {
    if (!setup) setup = createContext().then(value => (context = value), error => { setup = null; throw error; });
    await setup;
    await context.hub.loadTracking();
    return context;
}

function handled(handler) {
    return async ctx => {
        try { return await handler(ctx); }
        catch (error) {
            log(error.message);
            throw new CanvasError(error instanceof TeamLoadError ? error.code : "team_load_error", error.message);
        }
    };
}

const repoRef = { repository: { type: "string", pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$" }, number: { type: "integer", minimum: 1 } };
const action = (name, description, inputSchema) => ({
    name, description, ...(inputSchema ? { inputSchema } : {}),
    handler: handled(async ctx => perform(await configure(), name, ctx.input ?? {})),
});

session = await joinSession({
    canvases: [createCanvas({
        id: "team-load",
        displayName: "Team load",
        description: "See what everyone in your tracked GitHub repos (and Copilot) is working on, how active the team has been, and assign or reassign issues to whoever has capacity.",
        actions: [
            action("get_state", "Read the tracked repos, the team derived from them (assignable users and assignees, minus hidden people), and the open issues and PRs that make up each person's current load."),
            action("refresh", "Refresh live data from GitHub.", { type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false }),
            action("set_tracking", "Choose which repositories the canvas tracks and which people to hide (persisted). `repos` replaces the tracked list and accepts owner/name or owner/prefix* wildcards (e.g. 'octo-org/web-*'). `hidden` replaces the list of logins to hide from the roster. Omit either to keep it unchanged. People are not added directly: everyone assignable in the tracked repos is the team.", {
                type: "object", additionalProperties: false, minProperties: 1,
                properties: {
                    repos: { type: "array", maxItems: 15, items: { type: "string", pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9_.*-]+$" } },
                    hidden: { type: "array", items: { type: "string" } },
                },
            }),
            action("assign", "Assign an issue to someone assignable in the tracked repos, or to Copilot with login 'copilot'. Without `additional` the issue must be unowned; with `additional: true` the person is added alongside existing assignees.", { type: "object", required: ["repository", "number", "login"], additionalProperties: false, properties: { ...repoRef, login: { type: "string" }, additional: { type: "boolean" } } }),
            action("unassign", "Remove an assignee from an issue (also used to undo an assign).", { type: "object", required: ["repository", "number", "login"], additionalProperties: false, properties: { ...repoRef, login: { type: "string" } } }),
            action("reassign", "Move an open issue from one assignee to another, preserving other assignees. The new owner is verified before the old one is removed. Copilot uses login 'copilot'.", { type: "object", required: ["repository", "number", "from", "login"], additionalProperties: false, properties: { ...repoRef, from: { type: "string" }, login: { type: "string" } } }),
            action("start_session", "Assign an issue to the current user and start a focused work session for it in this conversation. Use `additional: true` for an issue that already has other assignees.", { type: "object", required: ["repository", "number"], additionalProperties: false, properties: { ...repoRef, title: { type: "string" }, additional: { type: "boolean" } } }),
            action("start_sessions", "Assign several issues to the current user, then ask this conversation once to start one local Copilot coding session per issue. All or nothing: if anything fails the assignments are undone.", { type: "object", required: ["items"], additionalProperties: false, properties: { items: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", required: ["repository", "number"], additionalProperties: false, properties: { ...repoRef, title: { type: "string" } } } } } }),
            action("get_item", "Read an issue or pull request with its rendered body and recent comments.", { type: "object", required: ["repository", "number"], additionalProperties: false, properties: repoRef }),
            action("comment", "Post a markdown comment on an issue or pull request in a tracked repository.", { type: "object", required: ["repository", "number", "body"], additionalProperties: false, properties: { ...repoRef, body: { type: "string", minLength: 1, maxLength: 65536 } } }),
            action("delete_comment", "Delete one of your own comments on an issue or pull request.", { type: "object", required: ["repository", "number", "commentId"], additionalProperties: false, properties: { ...repoRef, commentId: { type: "integer", minimum: 1 } } }),
            action("get_labels", "List the labels defined in a tracked repository.", { type: "object", required: ["repository"], additionalProperties: false, properties: { repository: repoRef.repository } }),
            action("label", "Add or remove an existing repository label on an issue or pull request.", { type: "object", required: ["repository", "number", "label", "add"], additionalProperties: false, properties: { ...repoRef, label: { type: "string" }, add: { type: "boolean" } } }),
            action("set_item_state", "Close or reopen an issue or pull request. Merged pull requests cannot be reopened.", { type: "object", required: ["repository", "number", "state"], additionalProperties: false, properties: { ...repoRef, state: { type: "string", enum: ["open", "closed"] } } }),
            action("get_momentum", "Read daily activity (commits, PRs opened/merged, issues opened/completed) across the tracked repositories for the whole team, one person, or everyone. `days` defaults to 7. History is cached for an hour; pass `force: true` to refetch it now.", {
                type: "object", additionalProperties: false,
                properties: { days: { type: "integer", enum: [7, 30, 90] }, person: { type: "string" }, everyone: { type: "boolean" }, repository: { type: "string", pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$" }, force: { type: "boolean" } },
            }),
        ],
        open: handled(async ctx => {
            await configure();
            let entry = instances.get(ctx.instanceId);
            if (!entry) {
                entry = startServer(() => context, log);
                instances.set(ctx.instanceId, entry);
            }
            try {
                return { title: "Team load", status: "Who's on what, and who has room", url: (await entry).url };
            } catch (error) {
                if (instances.get(ctx.instanceId) === entry) instances.delete(ctx.instanceId);
                throw error;
            }
        }),
        onClose: handled(async ctx => {
            const entry = instances.get(ctx.instanceId);
            if (entry) {
                instances.delete(ctx.instanceId);
                await (await entry).close();
            }
        }),
    })],
});
resolveSession(session);
const live = createProjectScan({
    onRepo: name => {
        const sync = value => value.project && syncProjectRepos(value.hub, [name]);
        if (context) Promise.resolve(sync(context)).catch(error => log(error.message));
        else if (setup) setup.then(sync).catch(error => log(error.message));
        else liveProjectRepos.push(name);
    },
});
session.on(event => { if (event.type === "tool.execution_start" || event.type === "tool.execution_complete") live.accept(event); });
for (const message of diagnostics.splice(0)) log(message);
