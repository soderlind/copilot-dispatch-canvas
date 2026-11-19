import { spawn as nodeSpawn } from "node:child_process";
import { ghEnv } from "./github.mjs";
import { extensionRoot } from "./state.mjs";

const CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_PATTERN = /https:\/\/github\.com\/login\/device\b[^\s]*/;
const redact = text => String(text).replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[redacted]").trim().slice(-600);

// Runs `gh auth refresh -s project` against gh's stored login (never GH_TOKEN, which cannot be refreshed).
// Without a TTY, gh prints a one-time device code and URL, then polls until the user approves in the browser.
export function createScopeAuth({ spawn = nodeSpawn, timeoutMs = 15 * 60_000, onDone = () => {} } = {}) {
    let state = { status: "idle" };
    let child = null;

    function snapshot() {
        return { ...state };
    }

    function start() {
        if (child) return Promise.resolve(snapshot());
        state = { status: "starting" };
        let output = "";
        let settle;
        const ready = new Promise(resolve => { settle = () => resolve(snapshot()); });
        try {
            child = spawn("gh", ["auth", "refresh", "--hostname", "github.com", "--scopes", "project"], {
                cwd: extensionRoot, windowsHide: true, env: ghEnv({ storedLogin: true }), stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            child = null;
            state = { status: "failed", error: error.message };
            return Promise.resolve(snapshot());
        }
        const current = child;
        const timer = setTimeout(() => current.kill(), timeoutMs);
        const read = chunk => {
            output += chunk;
            const code = CODE.exec(output)?.[1];
            const url = URL_PATTERN.exec(output)?.[0];
            if (code && url && state.status === "starting") {
                state = { status: "waiting", code, url };
                settle();
            }
        };
        current.stdout.setEncoding("utf8").on("data", read);
        current.stderr.setEncoding("utf8").on("data", read);
        const finish = (ok, message) => {
            clearTimeout(timer);
            if (child === current) child = null;
            state = ok ? { status: "done" } : { status: "failed", error: message };
            if (ok) { try { onDone(); } catch {} }
            settle();
        };
        current.on("error", error => finish(false, error.code === "ENOENT" ? "GitHub CLI (gh) is not installed or is not on PATH." : error.message));
        current.on("close", (code, signal) => {
            if (code === 0) return finish(true);
            const detail = redact(output);
            const hint = /not logged in|gh auth login/i.test(detail) ? " Run `gh auth login` in a terminal first." : "";
            finish(false, signal ? "The authorization timed out or was cancelled." : `gh auth refresh failed.${hint}${detail ? ` ${detail}` : ""}`);
        });
        return ready;
    }

    function cancel() {
        child?.kill();
        return snapshot();
    }

    return { start, cancel, status: snapshot };
}
