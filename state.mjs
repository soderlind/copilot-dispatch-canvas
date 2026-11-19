import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMIT, DEFAULT_REFRESH_SECONDS, DispatchError, normalizeTracking } from "./model.mjs";
import { normalizeBoardSettings } from "./board.mjs";

export const MAX_KNOWN_REPOS = 30;
export const extensionRoot = dirname(fileURLToPath(import.meta.url));

const FORMAT = "dispatch-tracking";
// Files written before the rename from Team load are still read, and rewritten in the new format on the next save.
const LEGACY_FORMATS = new Set([FORMAT, "team-load-tracking"]);

const settingsOf = data => ({
    limit: Number.isInteger(data.limit) && data.limit >= 1 && data.limit <= 20 ? data.limit : DEFAULT_LIMIT,
    refreshSeconds: Number.isInteger(data.refreshSeconds) && data.refreshSeconds >= 60 ? data.refreshSeconds : DEFAULT_REFRESH_SECONDS,
});

const MAX_PROJECT_REPOS = 100;
const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Persists which repositories the canvas tracks, which people are hidden, and every repo ever tracked (so it stays in the picker).
// `limit` and `refreshSeconds` are optional hand-edited settings in the global tracking.json; they are preserved across writes.
// With `project`, tracking lives in its own file for that Copilot Project and also records `projectRepos`: every repository the
// Project has brought in, so a repo the user stops tracking is not re-added. A new Project file starts from the global hidden
// people and known repos, and always uses the global settings.
export function createTrackingStore(home = process.env.COPILOT_HOME || join(homedir(), ".copilot"), { project = null } = {}) {
    if (project !== null && !projectIdPattern.test(String(project))) throw new DispatchError("invalid_input", "Invalid Project id.");
    const directory = join(home, "extensions", "dispatch", "artifacts");
    const globalPath = join(directory, "tracking.json");
    const path = project ? join(directory, "projects", `${project}.json`) : globalPath;
    const defaults = () => ({ repos: [], hidden: [], knownRepos: [], ...settingsOf({}), ...(project ? { projectRepos: [] } : {}) });
    let queue = Promise.resolve();

    async function load(file) {
        let raw;
        try { raw = await readFile(file, "utf8"); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            throw new DispatchError("storage_error", `Cannot read tracking at ${file}: ${error.message}`);
        }
        try {
            const data = JSON.parse(raw);
            if (!LEGACY_FORMATS.has(data.format) || data.version !== 1) throw new Error("unknown format or version");
            const tracking = normalizeTracking({ repos: data.repos, hidden: data.hidden ?? [] });
            const known = normalizeTracking({ repos: data.knownRepos ?? [] }, { maxRepos: MAX_KNOWN_REPOS });
            const seen = normalizeTracking({ repos: data.projectRepos ?? [] }, { maxRepos: MAX_PROJECT_REPOS });
            const board = data.board == null ? {} : { board: normalizeBoardSettings(data.board) };
            return { ...tracking, knownRepos: known.repos, ...settingsOf(data), ...board, projectRepos: seen.repos };
        } catch (error) {
            throw new DispatchError("storage_error", `Tracking file ${file} is invalid (${error.message}). Move or delete it to reset.`);
        }
    }

    async function read() {
        const own = await load(path);
        if (!project) {
            if (!own) return defaults();
            const { projectRepos, ...value } = own;
            return value;
        }
        const shared = await load(globalPath).catch(() => null);
        const settings = settingsOf(shared ?? {});
        if (own) return { ...own, ...settings };
        return { ...defaults(), hidden: shared?.hidden ?? [], knownRepos: shared?.knownRepos ?? [], ...settings };
    }

    function write(next) {
        const operation = queue.then(async () => {
            const current = await read();
            const tracking = normalizeTracking({ repos: next.repos, hidden: next.hidden ?? [] });
            const projectRepos = project ? normalizeTracking({ repos: next.projectRepos ?? current.projectRepos }, { maxRepos: MAX_PROJECT_REPOS }).repos : null;
            const knownRepoMap = new Map([...current.knownRepos, ...(projectRepos ?? []), ...current.repos, ...tracking.repos].map(repo => [repo.toLowerCase(), repo]));
            const knownRepos = [...knownRepoMap.values()].slice(-MAX_KNOWN_REPOS);
            const board = Object.hasOwn(next, "board") ? next.board : current.board;
            const boardSettings = board == null ? {} : { board: normalizeBoardSettings(board) };
            const value = { ...tracking, knownRepos, limit: current.limit, refreshSeconds: current.refreshSeconds, ...boardSettings, ...(project ? { projectRepos } : {}) };
            // Workload and refresh settings stay global; Board settings belong to this scope.
            const saved = project ? { project, ...tracking, knownRepos, projectRepos, ...boardSettings } : value;
            const temporary = join(dirname(path), `tracking.${randomUUID()}.tmp`);
            let created = false;
            try {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(temporary, `${JSON.stringify({ format: FORMAT, version: 1, ...saved }, null, 2)}\n`, { flag: "wx" });
                created = true;
                await rename(temporary, path);
                created = false;
            } catch (error) {
                if (created) await unlink(temporary).catch(() => {});
                throw new DispatchError("storage_error", `Cannot save tracking at ${path}: ${error.message}`);
            }
            return value;
        });
        queue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    return { read, write, path, project };
}
