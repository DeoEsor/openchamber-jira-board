// service/main.ts
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";

// service/app.ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

// service/config.ts
var MAX_SOURCES = 16;
var MAX_NAME_LENGTH = 120;
var MAX_URL_LENGTH = 2048;
var MAX_EMAIL_LENGTH = 320;
var MAX_TOKEN_LENGTH = 8192;
var MAX_PROJECT_KEY_LENGTH = 128;
var ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

class ConfigurationError extends Error {
  name = "ConfigurationError";
}
function fail(message, label = "") {
  throw new ConfigurationError(`${label}${message}`);
}
function requiredText(value, field, label, maxLength) {
  if (typeof value !== "string" || !value.trim())
    fail(`“${field}” is required.`, label);
  const result = value.trim();
  if (result.length > maxLength)
    fail(`“${field}” must be at most ${maxLength} characters.`, label);
  return result;
}
function optionalText(value, field, label, maxLength) {
  if (value === undefined || value === null)
    return "";
  if (typeof value !== "string")
    fail(`“${field}” must be a string.`, label);
  const result = value.trim();
  if (result.length > maxLength)
    fail(`“${field}” must be at most ${maxLength} characters.`, label);
  return result;
}
function normalizeBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("“url” must be an absolute Jira address.", label);
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    fail("use HTTPS (HTTP is allowed only for a local Jira server).", label);
  }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value)) {
    fail("the URL cannot contain credentials, a query, or a fragment.", label);
  }
  return value.replace(/\/+$/, "");
}
function optionalBoardId(value, label) {
  if (value === undefined || value === null || value === "")
    return;
  if (typeof value === "string" && !value.trim())
    return;
  if (typeof value !== "number" && typeof value !== "string") {
    fail("“boardId” must be a positive integer.", label);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    fail("“boardId” must be a positive integer.", label);
  return id;
}
function normalizeSource(value, existing, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("expected an object.", label);
  const input = value;
  const name = requiredText(input.name, "name", label, MAX_NAME_LENGTH);
  const url = requiredText(input.url, "url", label, MAX_URL_LENGTH);
  const kind = requiredText(input.type, "type", label, 32);
  if (kind !== "cloud" && kind !== "datacenter")
    fail("“type” must be “cloud” or “datacenter”.", label);
  const email = optionalText(input.email, "email", label, MAX_EMAIL_LENGTH);
  if (kind === "cloud" && !email)
    fail("Jira Cloud requires “email”.", label);
  const baseUrl = normalizeBaseUrl(url, label);
  const suppliedToken = optionalText(input.token, "token", label, MAX_TOKEN_LENGTH);
  const canRetainToken = existing !== undefined && existing.kind === kind && new URL(existing.baseUrl).origin === new URL(baseUrl).origin;
  const token = suppliedToken || (canRetainToken ? existing?.token : "") || "";
  if (!token) {
    if (existing)
      fail("“token” must be non-empty when changing the Jira origin or type.", label);
    fail("“token” is required for a new source.", label);
  }
  if (token.length > MAX_TOKEN_LENGTH)
    fail(`“token” must be at most ${MAX_TOKEN_LENGTH} characters.`, label);
  const projectKey = optionalText(input.projectKey, "projectKey", label, MAX_PROJECT_KEY_LENGTH);
  const boardId = optionalBoardId(input.boardId, label);
  return {
    name,
    baseUrl,
    kind,
    token,
    ...kind === "cloud" && email ? { email } : {},
    ...projectKey ? { defaultProjectKey: projectKey } : {},
    ...boardId !== undefined ? { defaultBoardId: boardId } : {}
  };
}
function parseSourceInput(value, existing) {
  return normalizeSource(value, existing, "");
}
function parseSourceDocument(document) {
  if (!Array.isArray(document))
    throw new ConfigurationError("Sources must be a JSON array.");
  if (document.length > MAX_SOURCES) {
    throw new ConfigurationError(`No more than ${MAX_SOURCES} Jira sources are supported.`);
  }
  const ids = new Set;
  return document.map((entry, index) => {
    const label = `Source ${index + 1}: `;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      fail("expected an object.", label);
    const value = entry;
    const id = requiredText(value.id, "id", label, 64);
    if (!ID_PATTERN.test(id))
      fail("“id” must be kebab-case (for example, “work-cloud”).", label);
    if (ids.has(id))
      throw new ConfigurationError(`Duplicate source id “${id}”.`);
    ids.add(id);
    return {
      id,
      ...normalizeSource({
        name: value.name,
        url: value.baseUrl,
        type: value.kind,
        email: value.email,
        token: value.token,
        projectKey: value.defaultProjectKey,
        boardId: value.defaultBoardId
      }, undefined, label)
    };
  });
}
function generateSourceId(name, existingIds) {
  const ids = new Set(existingIds);
  let base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  if (!base)
    base = "source";
  if (!/^[a-z]/.test(base))
    base = `source-${base}`.slice(0, 64).replace(/-+$/g, "");
  let id = base;
  for (let suffix = 2;ids.has(id); suffix += 1) {
    const ending = `-${suffix}`;
    id = `${base.slice(0, 64 - ending.length).replace(/-+$/g, "")}${ending}`;
  }
  return id;
}
function toPublicSource(source) {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    kind: source.kind,
    ...source.email ? { email: source.email } : {},
    ...source.defaultProjectKey ? { defaultProjectKey: source.defaultProjectKey } : {},
    ...source.defaultBoardId !== undefined ? { defaultBoardId: source.defaultBoardId } : {}
  };
}

// service/sources.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
var SOURCES_FILE = "sources.json";
function sourcesPath(dataDir) {
  return join(dataDir, SOURCES_FILE);
}
async function readSources(dataDir) {
  let raw;
  try {
    raw = await readFile(sourcesPath(dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return [];
    throw new ConfigurationError("Jira source storage could not be read.");
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("Jira source storage must contain valid JSON.");
  }
  return parseSourceDocument(document);
}
async function writeSources(dataDir, sources) {
  const validated = parseSourceDocument(sources);
  await mkdir(dataDir, { recursive: true });
  const target = sourcesPath(dataDir);
  const temporary = join(dataDir, `sources-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}
`, { mode: 384, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {
      return;
    });
    throw error;
  }
  return validated;
}
async function findSource(dataDir, id) {
  const source = (await readSources(dataDir)).find((candidate) => candidate.id === id);
  if (!source)
    throw new ConfigurationError(`Jira source “${id}” was not found.`);
  return source;
}

// service/jira.ts
var ISSUE_LIMIT = 200;
var BOARD_LIMIT = 500;
var REQUEST_TIMEOUT_MS = 20000;

class JiraError extends Error {
  name = "JiraError";
  status;
  outcomeUnknown;
  constructor(message, status = 502, outcomeUnknown = false) {
    super(message);
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}
function transitionDeadlineError() {
  return new JiraError("Jira did not confirm the transition within 12 seconds. Its outcome is unknown; refresh the board.", 504, true);
}
async function raceWithSignal(promise, signal) {
  if (signal.aborted)
    throw transitionDeadlineError();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(transitionDeadlineError());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener)
      signal.removeEventListener("abort", listener);
  }
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function string(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function errorMessage(body, status) {
  const value = object(body);
  const messages = array(value.errorMessages).filter((item) => typeof item === "string");
  const fieldErrors = Object.entries(object(value.errors)).map(([field, message]) => `${field}: ${String(message)}`);
  const detail = [...messages, ...fieldErrors, string(value.message)].filter(Boolean).join("; ").slice(0, 500);
  return detail || `Jira returned HTTP ${status}.`;
}
function statusOf(value) {
  const status = object(value);
  return { id: string(status.id), name: string(status.name, "Unknown") };
}
function assigneeOf(value) {
  const assignee = object(value);
  const displayName = string(assignee.displayName);
  if (!displayName)
    return null;
  return {
    displayName,
    ...string(assignee.accountId) ? { accountId: string(assignee.accountId) } : {},
    ...string(assignee.key) ? { key: string(assignee.key) } : {},
    ...string(assignee.name) ? { name: string(assignee.name) } : {}
  };
}

class JiraClient {
  source;
  fetchImpl;
  constructor(source, fetchImpl = fetch) {
    this.source = source;
    this.fetchImpl = fetchImpl;
  }
  async request(path, init = {}) {
    const authorization = this.source.kind === "cloud" ? `Basic ${Buffer.from(`${this.source.email}:${this.source.token}`).toString("base64")}` : `Bearer ${this.source.token}`;
    let response;
    let raw;
    const signal = init.signal ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), init.signal]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const pending = this.fetchImpl(`${this.source.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization,
          ...init.body !== undefined ? { "content-type": "application/json" } : {}
        },
        ...init.body !== undefined ? { body: JSON.stringify(init.body) } : {},
        signal
      });
      response = init.signal ? await raceWithSignal(pending, init.signal) : await pending;
      raw = init.signal ? await raceWithSignal(response.text(), init.signal) : await response.text();
    } catch (error) {
      if (error instanceof JiraError)
        throw error;
      const message = error instanceof Error && error.name === "TimeoutError" ? "Jira did not answer within 20 seconds." : `Could not reach Jira: ${error instanceof Error ? error.message : String(error)}`;
      throw new JiraError(message, 502, init.method === "POST");
    }
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        if (!response.ok)
          throw new JiraError(`Jira returned HTTP ${response.status}.`, 502, init.method === "POST" && response.status >= 500);
        throw new JiraError("Jira returned a non-JSON response. Check the source URL and Jira Software API.", 502, init.method === "POST");
      }
    }
    if (!response.ok) {
      throw new JiraError(`Jira HTTP ${response.status}: ${errorMessage(body, response.status)}`, 502, init.method === "POST" && response.status >= 500);
    }
    return body;
  }
  async projects() {
    const body = await this.request("/rest/api/2/project");
    return array(body).map((entry) => {
      const project = object(entry);
      return { id: string(project.id), key: string(project.key), name: string(project.name) };
    }).filter((project) => project.id && project.key && project.name).slice(0, 300);
  }
  async boards(projectKey) {
    const result = [];
    let startAt = 0;
    while (result.length < BOARD_LIMIT) {
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: "100" });
      if (projectKey)
        query.set("projectKeyOrId", projectKey);
      const body = object(await this.request(`/rest/agile/1.0/board?${query}`));
      const values = array(body.values);
      for (const entry of values) {
        const board = object(entry);
        const location = object(board.location);
        const id = Number(board.id);
        if (!Number.isSafeInteger(id) || !string(board.name))
          continue;
        result.push({
          id,
          name: string(board.name),
          type: string(board.type, "board"),
          ...string(location.projectKey) ? { projectKey: string(location.projectKey) } : {},
          ...string(location.projectName) ? { projectName: string(location.projectName) } : {}
        });
      }
      const isLast = body.isLast === true || values.length === 0;
      startAt += values.length;
      if (isLast)
        break;
    }
    return result;
  }
  async configuration(boardId, signal) {
    const body = object(await this.request(`/rest/agile/1.0/board/${boardId}/configuration`, { ...signal ? { signal } : {} }));
    const configuration = object(body.columnConfig);
    const columns = array(configuration.columns).map((entry, index) => {
      const column = object(entry);
      return {
        id: `column-${index}`,
        name: string(column.name, `Column ${index + 1}`),
        statuses: array(column.statuses).map(statusOf).filter((status) => status.id),
        canDrop: true
      };
    });
    if (!columns.length)
      throw new JiraError("This board has no column configuration in Jira.", 400);
    return {
      board: { id: boardId, name: string(body.name, `Board ${boardId}`), type: "board" },
      columns
    };
  }
  async issues(boardId) {
    const issues = [];
    let startAt = 0;
    let reportedTotal = 0;
    while (issues.length < ISSUE_LIMIT) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(Math.min(100, ISSUE_LIMIT - issues.length)),
        fields: "summary,status,assignee,priority,issuetype,updated"
      });
      const body = object(await this.request(`/rest/agile/1.0/board/${boardId}/issue?${query}`));
      const values = array(body.issues);
      issues.push(...values);
      reportedTotal = Number(body.total);
      startAt += values.length;
      if (!values.length || Number.isFinite(reportedTotal) && startAt >= reportedTotal)
        break;
    }
    return { issues: issues.slice(0, ISSUE_LIMIT), truncated: reportedTotal > ISSUE_LIMIT };
  }
  async currentUser() {
    try {
      const user = object(await this.request("/rest/api/2/myself"));
      const displayName = string(user.displayName);
      if (!displayName)
        return null;
      return {
        displayName,
        ...string(user.accountId) ? { accountId: string(user.accountId) } : {},
        ...string(user.key) ? { key: string(user.key) } : {},
        ...string(user.name) ? { name: string(user.name) } : {}
      };
    } catch {
      return null;
    }
  }
  async board(boardId) {
    const [{ board, columns }, page, currentUser] = await Promise.all([
      this.configuration(boardId),
      this.issues(boardId),
      this.currentUser()
    ]);
    const statusColumn = new Map;
    for (const column of columns) {
      for (const status of column.statuses)
        statusColumn.set(status.id, column.id);
    }
    const issues = page.issues.map((entry) => {
      const issue = object(entry);
      const fields = object(issue.fields);
      const status = statusOf(fields.status);
      const key = string(issue.key);
      return {
        id: string(issue.id, key),
        key,
        summary: string(fields.summary, key),
        url: `${this.source.baseUrl}/browse/${encodeURIComponent(key)}`,
        columnId: statusColumn.get(status.id) ?? "other",
        status,
        assignee: assigneeOf(fields.assignee),
        priority: string(object(fields.priority).name) || null,
        issueType: string(object(fields.issuetype).name) || null,
        updated: string(fields.updated) || null
      };
    }).filter((issue) => issue.key);
    const otherStatuses = new Map;
    for (const issue of issues) {
      if (issue.columnId === "other")
        otherStatuses.set(issue.status.id, issue.status);
    }
    if (otherStatuses.size) {
      columns.push({ id: "other", name: "Other statuses", statuses: [...otherStatuses.values()], canDrop: false });
    }
    return { board, columns, issues, currentUser, truncated: page.truncated };
  }
  async moveIssue(boardId, issueKey, statusId, signal) {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey))
      throw new JiraError("Invalid Jira issue key.", 400);
    const [{ columns }, transitionsBody] = await Promise.all([
      this.configuration(boardId, signal),
      this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, { ...signal ? { signal } : {} })
    ]);
    const target = columns.flatMap((column) => column.statuses).find((status) => status.id === statusId);
    if (!target)
      throw new JiraError("The target status does not belong to this board.", 400);
    const transition = array(object(transitionsBody).transitions).find((entry) => {
      const value = object(entry);
      return string(object(value.to).id) === statusId;
    });
    if (!transition) {
      throw new JiraError(`No direct Jira transition to “${target.name}” is available for ${issueKey}.`, 409);
    }
    const transitionId = string(object(transition).id);
    await this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: transitionId } },
      ...signal ? { signal } : {}
    });
  }
}

// service/preferences.ts
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var DEFAULT_PREFERENCES = {
  sourceId: null,
  projectKey: null,
  boardId: null,
  filter: "all"
};
function nullableText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : null;
}
function sanitize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...DEFAULT_PREFERENCES };
  const input = value;
  const boardId = Number(input.boardId);
  const filter = input.filter === "mine" || input.filter === "unassigned" ? input.filter : "all";
  return {
    sourceId: nullableText(input.sourceId),
    projectKey: nullableText(input.projectKey),
    boardId: Number.isSafeInteger(boardId) && boardId > 0 ? boardId : null,
    filter
  };
}
async function readPreferences(dataDir) {
  try {
    return sanitize(JSON.parse(await readFile2(join2(dataDir, "preferences.json"), "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}
async function writePreferences(dataDir, value) {
  const preferences = sanitize(value);
  await mkdir2(dataDir, { recursive: true });
  const target = join2(dataDir, "preferences.json");
  const temporary = join2(dataDir, `preferences-${randomUUID2()}.tmp`);
  await writeFile2(temporary, `${JSON.stringify(preferences, null, 2)}
`, { mode: 384 });
  await rename2(temporary, target);
  return preferences;
}

// shared/serial-queue.ts
class SerialQueue {
  tail = Promise.resolve();
  run(task) {
    const result = this.tail.then(task);
    this.tail = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  }
}

// service/app.ts
var BODY_LIMIT = 32768;
var TRANSITION_TIMEOUT_MS = 12000;
function authorized(request, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function send(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store"
  });
  response.end(json);
}
async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT)
      throw new JiraError("Request body is too large.", 413);
    chunks.push(buffer);
  }
  if (!chunks.length)
    return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new JiraError("Request body must be valid JSON.", 400);
  }
}
function pathParts(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}
function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new JiraError(`${label} must be a positive integer.`, 400);
  return result;
}
function createJiraBoardServer(options) {
  const mutations = new SerialQueue;
  const persistPreferences = options.writePreferencesImpl ?? writePreferences;
  const client = async (sourceId, signal) => {
    const pending = findSource(options.dataDir, sourceId);
    const source = signal ? await raceWithSignal(pending, signal) : await pending;
    return new JiraClient(source, options.fetchImpl);
  };
  return createServer(async (request, response) => {
    try {
      if (!authorized(request, options.token)) {
        send(response, 401, { error: "Unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") {
        send(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && url.pathname === "/api/bootstrap") {
        const preferences = await readPreferences(options.dataDir);
        try {
          const sources = await readSources(options.dataDir);
          send(response, 200, { sources: sources.map(toPublicSource), preferences, configError: null });
        } catch (error) {
          if (!(error instanceof ConfigurationError))
            throw error;
          send(response, 200, { sources: [], preferences, configError: error.message });
        }
        return;
      }
      if (method === "PUT" && url.pathname === "/api/preferences") {
        const input = await body(request);
        const preferences = await mutations.run(() => persistPreferences(options.dataDir, input));
        send(response, 200, { preferences });
        return;
      }
      const parts = pathParts(url.pathname);
      if (parts[0] !== "api" || parts[1] !== "sources") {
        send(response, 404, { error: "Not found" });
        return;
      }
      if (method === "POST" && parts.length === 2) {
        const input = objectBody(await body(request));
        const source = await mutations.run(async () => {
          const sources = await readSources(options.dataDir);
          if (sources.length >= MAX_SOURCES) {
            throw new ConfigurationError(`No more than ${MAX_SOURCES} Jira sources are supported.`);
          }
          const details = parseSourceInput(input);
          const created = {
            id: generateSourceId(details.name, sources.map((candidate) => candidate.id)),
            ...details
          };
          await writeSources(options.dataDir, [...sources, created]);
          return created;
        });
        send(response, 201, { source: toPublicSource(source) });
        return;
      }
      if (!parts[2]) {
        send(response, 404, { error: "Not found" });
        return;
      }
      const sourceId = parts[2];
      if (method === "PUT" && parts.length === 3) {
        const input = objectBody(await body(request));
        const source = await mutations.run(async () => {
          const sources = await readSources(options.dataDir);
          const index = sources.findIndex((candidate) => candidate.id === sourceId);
          const existing = sources[index];
          if (index < 0 || !existing)
            throw new ConfigurationError(`Jira source “${sourceId}” was not found.`);
          const updated = { id: existing.id, ...parseSourceInput(input, existing) };
          const next = [...sources];
          next[index] = updated;
          await writeSources(options.dataDir, next);
          return updated;
        });
        send(response, 200, { source: toPublicSource(source) });
        return;
      }
      if (method === "DELETE" && parts.length === 3) {
        const preferences = await mutations.run(async () => {
          const sources = await readSources(options.dataDir);
          if (!sources.some((candidate) => candidate.id === sourceId)) {
            throw new ConfigurationError(`Jira source “${sourceId}” was not found.`);
          }
          await writeSources(options.dataDir, sources.filter((candidate) => candidate.id !== sourceId));
          let current = { ...DEFAULT_PREFERENCES };
          try {
            current = await readPreferences(options.dataDir);
            if (current.sourceId === sourceId) {
              current = { ...current, sourceId: null, projectKey: null, boardId: null };
              current = await persistPreferences(options.dataDir, current);
            }
          } catch {}
          return current;
        });
        send(response, 200, { ok: true, preferences });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[3] === "projects") {
        send(response, 200, { projects: await (await client(sourceId)).projects() });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[3] === "boards") {
        send(response, 200, { boards: await (await client(sourceId)).boards(url.searchParams.get("projectKey")) });
        return;
      }
      if (method === "GET" && parts.length === 5 && parts[3] === "boards") {
        const boardId = positiveInteger(parts[4], "Board id");
        send(response, 200, await (await client(sourceId)).board(boardId));
        return;
      }
      if (method === "POST" && parts.length === 6 && parts[3] === "issues" && parts[5] === "transitions") {
        const deadline = new AbortController;
        const timer = setTimeout(() => deadline.abort(), options.transitionTimeoutMs ?? TRANSITION_TIMEOUT_MS);
        try {
          const input = objectBody(await body(request));
          const boardId = positiveInteger(String(input.boardId ?? ""), "Board id");
          const statusId = typeof input.statusId === "string" ? input.statusId.trim() : "";
          if (!statusId)
            throw new JiraError("Target statusId is required.", 400);
          await (await client(sourceId, deadline.signal)).moveIssue(boardId, parts[4] ?? "", statusId, deadline.signal);
          send(response, 200, { ok: true });
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      send(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof ConfigurationError ? 400 : error instanceof JiraError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected service error.";
      send(response, status, {
        error: message,
        ...error instanceof JiraError && error.outcomeUnknown ? { outcome: "unknown" } : {}
      });
    }
  });
}
function objectBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new JiraError("Expected a JSON object.", 400);
  return value;
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  throw new Error("OPENCHAMBER_SERVICE_PORT is required.");
}
if (!token)
  throw new Error("OPENCHAMBER_SERVICE_TOKEN is required.");
var server = createJiraBoardServer({
  token,
  dataDir: process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? join3(tmpdir(), "openchamber-jira-board")
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Jira Board service listening on 127.0.0.1:${port}`);
});
function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
