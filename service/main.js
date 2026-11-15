// service/main.ts
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var GUEST_PROVIDER_LOGO_BYTES_MAX = 1024 * 1024;
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message }),
    setMark: (target, mark) => call("marks.set", { target, mark })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late",
  "microphone-audio",
  "microphone-ended"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// service/app.ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

// service/config.ts
var MAX_SOURCES = 16;
var ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

class ConfigurationError extends Error {
  name = "ConfigurationError";
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function requiredText(value, field, index) {
  const result = text(value);
  if (!result)
    throw new ConfigurationError(`Source ${index + 1}: “${field}” is required.`);
  return result;
}
function normalizeBaseUrl(value, index) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`Source ${index + 1}: “url” must be an absolute Jira address.`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigurationError(`Source ${index + 1}: use HTTPS (HTTP is allowed only for a local Jira server).`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(`Source ${index + 1}: the URL cannot contain credentials, a query, or a fragment.`);
  }
  return value.replace(/\/+$/, "");
}
function optionalBoardId(value, index) {
  if (value === undefined || value === null || value === "")
    return;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConfigurationError(`Source ${index + 1}: “boardId” must be a positive integer.`);
  }
  return id;
}
function parseSources(settings) {
  const raw = settings.sources?.trim();
  if (!raw)
    return [];
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("Sources must be a valid JSON array.");
  }
  if (!Array.isArray(document))
    throw new ConfigurationError("Sources must be a JSON array.");
  if (document.length > MAX_SOURCES) {
    throw new ConfigurationError(`No more than ${MAX_SOURCES} Jira sources are supported.`);
  }
  const ids = new Set;
  return document.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigurationError(`Source ${index + 1}: expected an object.`);
    }
    const value = entry;
    const id = requiredText(value.id, "id", index);
    if (!ID_PATTERN.test(id)) {
      throw new ConfigurationError(`Source ${index + 1}: “id” must be kebab-case (for example, “work-cloud”).`);
    }
    if (ids.has(id))
      throw new ConfigurationError(`Duplicate source id “${id}”.`);
    ids.add(id);
    const kind = requiredText(value.type, "type", index);
    if (kind !== "cloud" && kind !== "datacenter") {
      throw new ConfigurationError(`Source ${index + 1}: “type” must be “cloud” or “datacenter”.`);
    }
    const email = text(value.email);
    if (kind === "cloud" && !email) {
      throw new ConfigurationError(`Source ${index + 1}: Jira Cloud requires “email”.`);
    }
    const projectKey = text(value.projectKey);
    const source = {
      id,
      name: requiredText(value.name, "name", index),
      baseUrl: normalizeBaseUrl(requiredText(value.url, "url", index), index),
      kind,
      token: requiredText(value.token, "token", index),
      ...email ? { email } : {},
      ...projectKey ? { defaultProjectKey: projectKey } : {},
      ...optionalBoardId(value.boardId, index) !== undefined ? { defaultBoardId: optionalBoardId(value.boardId, index) } : {}
    };
    return source;
  });
}
function toPublicSource(source) {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    kind: source.kind,
    ...source.defaultProjectKey ? { defaultProjectKey: source.defaultProjectKey } : {},
    ...source.defaultBoardId !== undefined ? { defaultBoardId: source.defaultBoardId } : {}
  };
}
function findSource(settings, id) {
  const source = parseSources(settings).find((candidate) => candidate.id === id);
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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
    return sanitize(JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}
async function writePreferences(dataDir, value) {
  const preferences = sanitize(value);
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, "preferences.json");
  const temporary = join(dataDir, `preferences-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}
`, { mode: 384 });
  await rename(temporary, target);
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
  const preferenceWrites = new SerialQueue;
  const client = async (sourceId, signal) => {
    const pending = options.readSettings();
    const settings = signal ? await raceWithSignal(pending, signal) : await pending;
    const source = findSource(settings, sourceId);
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
          const sources = parseSources(await options.readSettings());
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
        const preferences = await preferenceWrites.run(() => (options.writePreferencesImpl ?? writePreferences)(options.dataDir, input));
        send(response, 200, { preferences });
        return;
      }
      const parts = pathParts(url.pathname);
      if (parts[0] !== "api" || parts[1] !== "sources" || !parts[2]) {
        send(response, 404, { error: "Not found" });
        return;
      }
      const sourceId = parts[2];
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
var host = createServiceHost({ env: process.env });
var server = createJiraBoardServer({
  token,
  dataDir: process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? join2(tmpdir(), "openchamber-jira-board"),
  readSettings: () => host.readSettings()
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Jira Board service listening on 127.0.0.1:${port}`);
});
function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
