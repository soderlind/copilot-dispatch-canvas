import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { repoPattern } from "./model.mjs";

// A persistent Project in the Copilot app is an ordinary session whose system prompt carries this section, and whose
// repositories come from the kickoff selection plus later `add_repository` calls. Both are read from the session's own
// history; nothing here writes to it. Detection is best effort: any failure means "not a Project".
const PROJECT_MARKER = "<copilot_persistent_agent>";
const SELECTION = /<agent_repository_selection>([\s\S]*?)<\/agent_repository_selection>/g;
const SELECTED = /selected these GitHub repositories[^:\n]*:([^\n]*)/i;
const CLONE_URL = /^(?:https:\/\/|git@)github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

export function selectedRepos(content) {
    const names = [];
    for (const [, block] of String(content ?? "").matchAll(SELECTION)) {
        const line = SELECTED.exec(block)?.[1] ?? "";
        names.push(...line.split(/[\s,]+/).map(name => name.replace(/[.;]+$/, "")).filter(name => repoPattern.test(name)));
    }
    return names;
}

export function addedRepo(args) {
    if (typeof args?.github_repo === "string" && repoPattern.test(args.github_repo.trim())) return args.github_repo.trim();
    const match = typeof args?.clone_url === "string" ? CLONE_URL.exec(args.clone_url.trim()) : null;
    return match && repoPattern.test(match[1]) ? match[1] : null;
}

// Feed session events in order. `onRepo` fires for each repository as soon as it is known (used for live updates).
export function createProjectScan({ onRepo = () => {} } = {}) {
    let project = false;
    const repos = new Map();
    const pending = new Map(); // toolCallId -> repo, for add_repository calls that have not completed yet

    const add = name => {
        const key = name.toLowerCase();
        if (repos.has(key)) return;
        repos.set(key, name);
        onRepo(name);
    };

    // Cheap prefilter so a large history only parses the few lines that can matter.
    function wants(line) {
        if (line.includes("\"system.message\"")) return line.includes(PROJECT_MARKER);
        if (line.includes("<agent_repository_selection>") || line.includes("\"add_repository\"")) return true;
        if (!pending.size || !line.includes("\"tool.execution_complete\"")) return false;
        for (const id of pending.keys()) if (line.includes(id)) return true;
        return false;
    }

    function accept(event) {
        const data = event?.data ?? {};
        switch (event?.type) {
            case "system.message":
                if (String(data.content ?? "").includes(PROJECT_MARKER)) project = true;
                break;
            case "user.message":
                for (const name of selectedRepos(data.content)) add(name);
                break;
            case "tool.execution_start":
                if (data.toolName === "add_repository" && data.toolCallId) {
                    const name = addedRepo(data.arguments);
                    if (name) pending.set(data.toolCallId, name);
                }
                break;
            case "tool.execution_complete": {
                const name = pending.get(data.toolCallId);
                if (name) {
                    pending.delete(data.toolCallId);
                    if (data.success !== false) add(name);
                }
                break;
            }
        }
    }

    return { wants, accept, isProject: () => project, repos: () => [...repos.values()] };
}

// Returns null for non-Project sessions, otherwise the Project's repositories (possibly empty).
export async function detectProjectRepos({ sessionId, home = process.env.COPILOT_HOME || join(homedir(), ".copilot"), getEvents = null }) {
    const scan = createProjectScan();
    const path = join(home, "session-state", String(sessionId), "events.jsonl");
    try {
        const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
        for await (const line of lines) {
            if (!scan.wants(line)) continue;
            try { scan.accept(JSON.parse(line)); } catch {}
        }
    } catch (error) {
        if (error.code !== "ENOENT" || !getEvents) throw error;
        for (const event of await getEvents()) scan.accept(event);
    }
    return scan.isProject() ? scan.repos() : null;
}
