import { DispatchError } from "./model.mjs";

const pageInfo = "pageInfo{hasNextPage endCursor}";
const projectFields = `id title url number closed template viewerCanUpdate
    status:field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}`;
const itemFields = `id createdAt isArchived project{id}
    status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{id optionId updatedAt}}
    content{__typename
      ... on Issue{id number title state repository{nameWithOwner}}
      ... on PullRequest{id number title state repository{nameWithOwner}}
    }`;
const events = `last:30,before:$before,itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT,ADDED_TO_PROJECT_V2_EVENT,REMOVED_FROM_PROJECT_V2_EVENT]`;
const timeline = `timelineItems(${events}){
    pageInfo{hasPreviousPage startCursor}
    nodes{__typename
      ... on ProjectV2ItemStatusChangedEvent{createdAt status project{id}}
      ... on AddedToProjectV2Event{createdAt project{id}}
      ... on RemovedFromProjectV2Event{createdAt project{id}}
    }}`;
const historyQuery = `query($id:ID!,$before:String){node(id:$id){... on Issue{${timeline}} ... on PullRequest{${timeline}}}}`;

const authHelp = "Board uses your stored GitHub CLI login (not GH_TOKEN or GITHUB_TOKEN) and needs its write `project` scope. Use Grant Project access below, or run `gh auth refresh -h github.com -s project`, then retry. For organization Projects, check SSO and Project write access.";
const missingScope = () => new DispatchError("permission_denied", authHelp);
export const suitableProject = project => !!(project && !project.closed && !project.template && project.viewerCanUpdate && project.status?.options?.length);

export async function collectPages(read, label) {
    const nodes = [];
    let after;
    for (let page = 0; page < 50; page++) {
        const connection = await read(after);
        if (!connection) throw new DispatchError("not_found", `${label} is not available.`);
        nodes.push(...connection.nodes.filter(Boolean));
        if (!connection.pageInfo.hasNextPage) return nodes;
        after = connection.pageInfo.endCursor;
    }
    throw new DispatchError("coverage_limit", `Could not read all pages of ${label}.`);
}

// Use the latest event for this Project, not the latest event with a matching label
// (a card might have moved away and back, or been removed and re-added).
export async function exactStatusSince(read, projectId, currentName, itemCreatedAt) {
    let before;
    for (let page = 0; page < 10; page++) {
        const connection = await read(before);
        if (!connection) return null;
        for (const event of [...connection.nodes].reverse()) {
            if (!event || event.project?.id !== projectId) continue;
            const at = Date.parse(event.createdAt);
            return event.__typename === "ProjectV2ItemStatusChangedEvent" && event.status === currentName
                && Number.isFinite(at) && at >= Date.parse(itemCreatedAt) ? event.createdAt : null;
        }
        if (!connection.pageInfo.hasPreviousPage) return null;
        before = connection.pageInfo.startCursor;
    }
    return null;
}

export function createBoardGitHub({ gql, gh }, now = Date.now) {
    let authorizedAt = -Infinity;
    async function projectRequest(read) {
        try { return await read(); }
        catch (error) {
            if (error.code === "permission_denied" || /scope|resource not accessible|permission|forbidden/i.test(error.message)) {
                authorizedAt = -Infinity;
                throw new DispatchError("permission_denied", `${error.message} ${authHelp}`);
            }
            throw error;
        }
    }
    const query = (document, variables) => projectRequest(() => gql(document, variables));
    async function authorize() {
        if (now() - authorizedAt < 5 * 60_000) return;
        const headers = await projectRequest(() => gh(["api", "--hostname", "github.com", "--include", "user"], { json: false }));
        const header = headers.split(/\r?\n\r?\n/, 1)[0].match(/^x-oauth-scopes:[ \t]*([^\r\n]*)/im);
        if (header && !header[1].split(",").some(scope => scope.trim() === "project")) throw missingScope();
        authorizedAt = now();
    }

    async function discover(repos) {
        await authorize();
        const { viewer } = await query("query{viewer{login}}", {});
        const tracked = [...new Map(repos.map(repo => {
            const login = repo.split("/")[0];
            return [login.toLowerCase(), login];
        })).values()];
        const logins = [...new Map([...tracked, viewer.login].map(login => [login.toLowerCase(), login])).values()];
        const list = `projectsV2(first:30,after:$after){${pageInfo} nodes{${projectFields}}}`;
        const ownerQuery = `query($login:String!,$after:String){repositoryOwner(login:$login){__typename id login
            ... on Organization{${list}}
            ... on User{${list}}
        }}`;
        const results = await Promise.all(logins.map(async login => {
            let owner;
            const projects = await collectPages(async after => {
                const data = await query(ownerQuery, { login, after });
                owner = data.repositoryOwner;
                return owner?.projectsV2;
            }, `Projects for ${login}`);
            return {
                projects: projects.filter(suitableProject).map(project => ({ ...project, owner: owner.login })),
                owner: { id: owner.id, login: owner.login, canCreate: owner.__typename === "Organization" ? null : owner.login.toLowerCase() === viewer.login.toLowerCase() },
            };
        }));
        const owners = results.map(result => result.owner).filter(owner => tracked.some(login => login.toLowerCase() === owner.login.toLowerCase()));
        const projects = [...new Map(results.flatMap(result => result.projects).map(project => [project.id, project])).values()];
        return { owners, projects };
    }

    async function project(id) {
        const { node } = await query(`query($id:ID!){node(id:$id){... on ProjectV2{${projectFields}
            fields(first:100){nodes{... on ProjectV2IterationField{id name}}}
        }}}`, { id });
        if (!suitableProject(node)) throw new DispatchError("conflict", `The linked GitHub Project is closed, no longer editable, or missing a single-select Status field. Check the Project and gh account. ${authHelp}`);
        const iterations = node.fields?.nodes.filter(field => field?.id) ?? [];
        return { ...node, iteration: iterations.find(field => field.name === "Iteration") ?? iterations[0] };
    }
    async function create(owner, title) {
        const { createProjectV2 } = await query(`mutation($owner:ID!,$title:String!){
            createProjectV2(input:{ownerId:$owner,title:$title}){projectV2{id title url}}
        }`, { owner, title });
        return createProjectV2.projectV2;
    }
    function items(project) {
        const iteration = project.iteration?.name;
        const iterationField = iteration ? 'iteration:fieldValueByName(name:$iteration){... on ProjectV2ItemFieldIterationValue{title}}' : "";
        return collectPages(async after => {
            const { node } = await query(`query($id:ID!,$after:String${iteration ? ",$iteration:String!" : ""}){node(id:$id){... on ProjectV2{
                items(first:100,after:$after){${pageInfo} nodes{${itemFields} ${iterationField}}}
            }}}`, { id: project.id, after, iteration });
            return node?.items;
        }, "GitHub Project items");
    }
    async function item(id) {
        const { node } = await query(`query($id:ID!){node(id:$id){... on ProjectV2Item{${itemFields}}}}`, { id });
        return node;
    }
    async function add(project, content) {
        const { addProjectV2ItemById } = await query(`mutation($project:ID!,$content:ID!){
            addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}
        }`, { project, content });
        if (!addProjectV2ItemById?.item?.id) throw new DispatchError("github_error", "GitHub did not confirm the item was added.");
    }
    async function move(project, item, field, option) {
        const { updateProjectV2ItemFieldValue } = await query(`mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
            updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){
                projectV2Item{status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{optionId}}}
            }
        }`, { project, item, field, option });
        if (updateProjectV2ItemFieldValue?.projectV2Item?.status?.optionId !== option) {
            throw new DispatchError("conflict", "GitHub did not confirm the new Status. Refresh the board to check the card.");
        }
    }
    async function statusSince(item, name) {
        return exactStatusSince(async before => {
            const { node } = await query(historyQuery, { id: item.content.id, before });
            return node?.timelineItems;
        }, item.project.id, name, item.createdAt);
    }

    return { authorize, discover, project, create, items, item, add, move, statusSince };
}
