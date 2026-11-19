import { DispatchError } from "./model.mjs";

const invalid = message => new DispatchError("invalid_input", message);
const conflict = message => new DispatchError("conflict", message);
const idPattern = /^[A-Za-z0-9_+=:/-]{1,250}$/;
const openWorkSync = Symbol("openWorkSync");
const positiveInt = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const trackedKeys = tracking => new Set(tracking.repos.map(repo => repo.toLowerCase()));
const inScope = (item, keys) => keys.has(item.content?.repository?.nameWithOwner.toLowerCase());
const scopeKey = tracking => JSON.stringify([tracking.board?.projectId, ...trackedKeys(tracking)]);

export function normalizeBoardSettings(settings) {
    const { projectId, highlightDays = 7, limits = {} } = settings ?? {};
    if (typeof projectId !== "string" || !idPattern.test(projectId) || !positiveInt(highlightDays, 365)
        || !limits || typeof limits !== "object" || Array.isArray(limits)
        || Object.entries(limits).some(([id, limit]) => !idPattern.test(id) || !positiveInt(limit, 9999))) {
        throw invalid("Invalid Board settings.");
    }
    return { projectId, highlightDays, limits };
}

export function createBoard({ github, tracking, save, openWork, now = Date.now, log = () => {} }) {
    const ages = new Map();
    const ageQueue = [];
    const AGE_CONCURRENCY = 2;
    let activeAges = 0;
    let tail = Promise.resolve();
    let cache = null;
    let pending = null;
    const workSyncs = new Map();
    const serial = fn => {
        const run = tail.then(fn);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };

    function pumpAges() {
        while (activeAges < AGE_CONCURRENCY && ageQueue.length) {
            const job = ageQueue.shift();
            if (ages.get(job.item.id)?.key !== job.key) continue;
            activeAges++;
            Promise.resolve().then(() => github.statusSince(job.item, job.statusName))
                .then(since => {
                    if (ages.get(job.item.id)?.key !== job.key) return;
                    Object.assign(ages.get(job.item.id), { since, pending: false, at: now() });
                    const card = cache?.value?.cards.find(candidate => candidate.id === job.item.id);
                    if (card?._ageKey === job.key) Object.assign(card, { since, statusPending: false });
                })
                .catch(error => {
                    if (ages.get(job.item.id)?.key !== job.key) return;
                    Object.assign(ages.get(job.item.id), { pending: false, at: now() });
                    const card = cache?.value?.cards.find(candidate => candidate.id === job.item.id);
                    if (card?._ageKey === job.key) card.statusPending = false;
                    log(`Team Load Board history: ${error.message}`);
                })
                .finally(() => {
                    activeAges--;
                    pumpAges();
                });
        }
    }

    function syncOpenWork(snapshot, projectId, knownIds) {
        const key = scopeKey(snapshot);
        if (workSyncs.has(key)) return;
        const run = (async () => {
            let warnings = [];
            let added = 0;
            try {
                const work = await openWork(snapshot.repos);
                warnings.push(...work.warnings);
                const seen = new Set(knownIds);
                for (const { repository, nodeId } of work.items) {
                    if (!nodeId || seen.has(nodeId) || !trackedKeys(await tracking()).has(repository.toLowerCase())) continue;
                    try {
                        await github.add(projectId, nodeId);
                        seen.add(nodeId);
                        added++;
                    } catch (error) {
                        warnings.push(`Could not sync all open work from ${repository}: ${error.message}`);
                        break;
                    }
                }
            } catch (error) {
                warnings.push(`Could not sync open work: ${error.message}`);
            }
            if (scopeKey(await tracking()) === key && added) {
                let activeRead = pending?.key === key ? pending.run : null;
                while (activeRead) {
                    await activeRead.catch(() => {});
                    await new Promise(resolve => setTimeout(resolve, 0));
                    activeRead = pending?.key === key ? pending.run : null;
                }
                try { await refresh({ force: true }); }
                catch (error) { warnings.push(`Could not refresh the Board after syncing open work: ${error.message}`); }
            }
            const current = cache?.key === key ? cache.value : null;
            if (current?.project?.id === projectId) {
                current.syncing = false;
                current.warnings.push(...warnings);
            }
        })();
        workSyncs.set(key, run);
        run.catch(error => log(`Team Load Board sync: ${error.message}`))
            .finally(() => workSyncs.delete(key));
    }

    async function read(current) {
        const settings = current.board;
        const repos = current.repos;
        if (!settings) {
            return { repos, setup: repos.length ? await github.discover(repos) : { owners: [], projects: [] } };
        }
        await github.authorize();
        const project = await github.project(settings.projectId);
        let items = await github.items(project);
        const known = new Set(items.map(item => item.content?.id).filter(Boolean));
        const warnings = [];
        const keys = trackedKeys(await tracking());
        const options = project.status.options;
        const names = new Map(options.map(option => [option.id, option.name]));
        const visible = items.filter(item => inScope(item, keys));
        const cards = visible.map(item => {
            const { content, status } = item;
            const statusName = names.get(status?.optionId);
            const ageKey = JSON.stringify([item.id, status?.id, status?.updatedAt, status?.optionId, statusName]);
            let since = null;
            let statusPending = false;
            if (statusName) {
                const cached = ages.get(item.id);
                if (cached?.key === ageKey && (cached.pending || now() - cached.at < (cached.since ? 3600_000 : 60_000))) {
                    since = cached.since;
                    statusPending = cached.pending;
                } else {
                    ages.set(item.id, { key: ageKey, at: now(), since: null, pending: true });
                    ageQueue.push({ item, statusName, key: ageKey });
                    statusPending = true;
                }
            }
            return {
                id: item.id, repository: content.repository.nameWithOwner, number: content.number, title: content.title,
                kind: content.__typename === "PullRequest" ? "pr" : "issue", state: content.state, archived: item.isArchived,
                option: statusName ? status.optionId : null, since, statusPending, _ageKey: ageKey, iteration: item.iteration?.title ?? null,
            };
        });
        const live = await tracking();
        const liveKeys = trackedKeys(live);
        const liveCards = cards.filter(card => liveKeys.has(card.repository.toLowerCase()));
        const visibleIds = new Set(liveCards.map(card => card.id));
        for (const id of ages.keys()) if (!visibleIds.has(id)) ages.delete(id);
        return {
            repos: live.repos, project: { id: project.id, title: project.title, url: project.url },
            options, settings, cards: liveCards, warnings, syncing: repos.length > 0,
            [openWorkSync]: repos.length ? { projectId: project.id, knownIds: [...known] } : null,
        };
    }

    async function refresh({ force = false } = {}) {
        const current = await tracking();
        const key = scopeKey(current);
        if (pending?.key === key) return pending.run;
        if (!force && cache?.key === key && now() - cache.at < 5_000) return cache.value;
        const generation = cache?.generation ?? 0;
        const run = (async () => {
            const snapshot = await tracking();
            const value = await read(snapshot);
            const sync = value[openWorkSync];
            delete value[openWorkSync];
            // A tracking change during the read must not cache incomplete data under the new scope.
            if (scopeKey(snapshot) === scopeKey(await tracking()) && (cache?.generation ?? 0) === generation) {
                cache = { key: scopeKey(snapshot), at: now(), value, generation };
            }
            pumpAges();
            if (sync) syncOpenWork(snapshot, sync.projectId, new Set(sync.knownIds));
            return value;
        })();
        pending = { key, run };
        try { return await run; }
        finally { if (pending?.run === run) pending = null; }
    }

    const write = fn => input => serial(async () => {
        cache = { generation: (cache?.generation ?? 0) + 1 };
        const current = await tracking();
        try { return await fn(input, current); }
        finally { cache = { generation: (cache?.generation ?? 0) + 1 }; }
    });

    const connect = write(async (input, current) => {
        if (current.board) throw conflict("This tracking scope already has a GitHub Project.");
        if (!current.repos.length) throw invalid("Track at least one repository before setting up the Board.");
        const creating = Object.hasOwn(input, "ownerId");
        if (creating) {
            if (Object.keys(input).some(key => !["ownerId", "title", "confirmed"].includes(key))
                || input.confirmed !== true || typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 100) {
                throw invalid("Explicitly confirm creation and provide a Project title (1–100 characters) and owner.");
            }
        } else if (Object.keys(input).length !== 1 || typeof input.projectId !== "string") {
            throw invalid("Choose an existing GitHub Project.");
        }
        const setup = await github.discover(current.repos);
        let projectId;
        if (creating) {
            const owner = setup.owners.find(owner => owner.id === input.ownerId && owner.canCreate !== false);
            if (!owner) throw invalid("Choose a tracked repository owner where you can create GitHub Projects.");
            if (scopeKey(current) !== scopeKey(await tracking())) throw conflict("Tracked repositories changed. Review Board setup again.");
            let created;
            try { created = await github.create(owner.id, input.title.trim()); }
            catch (error) {
                if (error.code !== "permission_denied" || owner.canCreate !== null) throw error;
                throw new DispatchError(error.code, `GitHub denied Project creation for ${owner.login}. Ask an organization owner to check its Project creation policy, or link a Project they create for you. ${error.message}`);
            }
            projectId = created?.id;
            if (!projectId) throw new DispatchError("github_error", "GitHub did not confirm creation. Check the owner's Projects before retrying.");
        } else {
            projectId = setup.projects.find(project => project.id === input.projectId)?.id;
            if (!projectId) throw conflict("That Project is not an editable candidate for this tracking scope.");
            if (scopeKey(current) !== scopeKey(await tracking())) throw conflict("Tracked repositories changed. Review Board setup again.");
        }
        await save(normalizeBoardSettings({ projectId }));
    });

    const configure = write(async (input, current) => {
        if (!current.board || input.projectId !== current.board.projectId) throw conflict("The linked GitHub Project changed. Refresh the Board.");
        if (Object.keys(input).some(key => !["projectId", "highlightDays", "limits"].includes(key))
            || !Object.hasOwn(input, "highlightDays") || !Object.hasOwn(input, "limits")) throw invalid("Provide a highlight threshold and column limits.");
        const settings = normalizeBoardSettings(input);
        const project = await github.project(settings.projectId);
        const options = new Set(project.status.options.map(option => option.id));
        if (Object.keys(settings.limits).some(id => !options.has(id))) throw conflict("Project Status columns changed. Refresh the Board.");
        await save(settings);
    });

    const move = write(async (input, current) => {
        const { projectId, itemId, optionId } = input;
        if (Object.keys(input).length !== 3 || ![projectId, itemId, optionId].every(id => typeof id === "string" && idPattern.test(id))) {
            throw invalid("Provide a Project card and destination Status.");
        }
        if (current.board?.projectId !== projectId) throw conflict("The linked GitHub Project changed. Refresh the Board.");
        await github.authorize();
        const project = await github.project(projectId);
        if (!project.status.options.some(option => option.id === optionId)) throw conflict("That Status no longer exists. Refresh the Board.");
        const item = await github.item(itemId);
        if (item?.project?.id !== projectId || item.isArchived || !inScope(item, trackedKeys(await tracking()))) {
            throw conflict("This card is archived, untracked, or no longer on the linked Project.");
        }
        if (item.status?.optionId !== optionId) await github.move(projectId, itemId, project.status.id, optionId);
        ages.delete(itemId);
    });

    const disconnect = write(async (input, current) => {
        if (Object.keys(input).length !== 1 || !current.board || current.board.projectId !== input.projectId) {
            throw conflict("The linked GitHub Project changed. Refresh the Board.");
        }
        await save(null);
        ages.clear();
    });

    return { refresh, cached: () => cache?.value ?? null, connect, configure, move, disconnect };
}
