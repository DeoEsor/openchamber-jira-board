import type {
  BoardData,
  JiraAssignee,
  JiraBoard,
  JiraColumn,
  JiraCurrentUser,
  JiraIssue,
  JiraProject,
  JiraSource,
  JiraStatus,
} from '../shared/types.ts';

const ISSUE_LIMIT = 200;
const BOARD_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 20_000;

export class JiraError extends Error {
  override readonly name = 'JiraError';
  readonly status: number;
  readonly outcomeUnknown: boolean;

  constructor(message: string, status = 502, outcomeUnknown = false) {
    super(message);
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function transitionDeadlineError(): JiraError {
  return new JiraError('Jira did not confirm the transition within 12 seconds. Its outcome is unknown; refresh the board.', 504, true);
}

export async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw transitionDeadlineError();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(transitionDeadlineError());
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

export type JiraFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function errorMessage(body: unknown, status: number): string {
  const value = object(body);
  const messages = array(value.errorMessages).filter((item): item is string => typeof item === 'string');
  const fieldErrors = Object.entries(object(value.errors)).map(([field, message]) => `${field}: ${String(message)}`);
  const detail = [...messages, ...fieldErrors, string(value.message)].filter(Boolean).join('; ').slice(0, 500);
  return detail || `Jira returned HTTP ${status}.`;
}

function statusOf(value: unknown): JiraStatus {
  const status = object(value);
  return { id: string(status.id), name: string(status.name, 'Unknown') };
}

function assigneeOf(value: unknown): JiraAssignee | null {
  const assignee = object(value);
  const displayName = string(assignee.displayName);
  if (!displayName) return null;
  return {
    displayName,
    ...(string(assignee.accountId) ? { accountId: string(assignee.accountId) } : {}),
    ...(string(assignee.key) ? { key: string(assignee.key) } : {}),
    ...(string(assignee.name) ? { name: string(assignee.name) } : {}),
  };
}

export class JiraClient {
  readonly source: JiraSource;
  private readonly fetchImpl: JiraFetch;

  constructor(source: JiraSource, fetchImpl: JiraFetch = fetch) {
    this.source = source;
    this.fetchImpl = fetchImpl;
  }

  private async request(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const authorization = this.source.kind === 'cloud'
      ? `Basic ${Buffer.from(`${this.source.email}:${this.source.token}`).toString('base64')}`
      : `Bearer ${this.source.token}`;
    let response: Response;
    let raw: string;
    const signal = init.signal
      ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), init.signal])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const pending = this.fetchImpl(`${this.source.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          authorization,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal,
      });
      response = init.signal ? await raceWithSignal(pending, init.signal) : await pending;
      raw = init.signal ? await raceWithSignal(response.text(), init.signal) : await response.text();
    } catch (error) {
      if (error instanceof JiraError) throw error;
      const message = error instanceof Error && error.name === 'TimeoutError'
        ? 'Jira did not answer within 20 seconds.'
        : `Could not reach Jira: ${error instanceof Error ? error.message : String(error)}`;
      throw new JiraError(message, 502, init.method === 'POST');
    }
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        if (!response.ok) throw new JiraError(`Jira returned HTTP ${response.status}.`, 502, init.method === 'POST' && response.status >= 500);
        throw new JiraError('Jira returned a non-JSON response. Check the source URL and Jira Software API.', 502, init.method === 'POST');
      }
    }
    if (!response.ok) {
      throw new JiraError(
        `Jira HTTP ${response.status}: ${errorMessage(body, response.status)}`,
        502,
        init.method === 'POST' && response.status >= 500,
      );
    }
    return body;
  }

  async projects(): Promise<JiraProject[]> {
    const body = await this.request('/rest/api/2/project');
    return array(body).map((entry) => {
      const project = object(entry);
      return { id: string(project.id), key: string(project.key), name: string(project.name) };
    }).filter((project) => project.id && project.key && project.name).slice(0, 300);
  }

  async boards(projectKey?: string | null): Promise<JiraBoard[]> {
    const result: JiraBoard[] = [];
    let startAt = 0;
    while (result.length < BOARD_LIMIT) {
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: '100' });
      if (projectKey) query.set('projectKeyOrId', projectKey);
      const body = object(await this.request(`/rest/agile/1.0/board?${query}`));
      const values = array(body.values);
      for (const entry of values) {
        const board = object(entry);
        const location = object(board.location);
        const id = Number(board.id);
        if (!Number.isSafeInteger(id) || !string(board.name)) continue;
        result.push({
          id,
          name: string(board.name),
          type: string(board.type, 'board'),
          ...(string(location.projectKey) ? { projectKey: string(location.projectKey) } : {}),
          ...(string(location.projectName) ? { projectName: string(location.projectName) } : {}),
        });
      }
      const isLast = body.isLast === true || values.length === 0;
      startAt += values.length;
      if (isLast) break;
    }
    return result;
  }

  private async configuration(boardId: number, signal?: AbortSignal): Promise<{ board: JiraBoard; columns: JiraColumn[] }> {
    const body = object(await this.request(`/rest/agile/1.0/board/${boardId}/configuration`, { ...(signal ? { signal } : {}) }));
    const configuration = object(body.columnConfig);
    const columns = array(configuration.columns).map((entry, index) => {
      const column = object(entry);
      return {
        id: `column-${index}`,
        name: string(column.name, `Column ${index + 1}`),
        statuses: array(column.statuses).map(statusOf).filter((status) => status.id),
        canDrop: true,
      };
    });
    if (!columns.length) throw new JiraError('This board has no column configuration in Jira.', 400);
    return {
      board: { id: boardId, name: string(body.name, `Board ${boardId}`), type: 'board' },
      columns,
    };
  }

  private async issues(boardId: number): Promise<{ issues: unknown[]; truncated: boolean }> {
    const issues: unknown[] = [];
    let startAt = 0;
    let reportedTotal = 0;
    while (issues.length < ISSUE_LIMIT) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(Math.min(100, ISSUE_LIMIT - issues.length)),
        fields: 'summary,status,assignee,priority,issuetype,updated',
      });
      const body = object(await this.request(`/rest/agile/1.0/board/${boardId}/issue?${query}`));
      const values = array(body.issues);
      issues.push(...values);
      reportedTotal = Number(body.total);
      startAt += values.length;
      if (!values.length || (Number.isFinite(reportedTotal) && startAt >= reportedTotal)) break;
    }
    return { issues: issues.slice(0, ISSUE_LIMIT), truncated: reportedTotal > ISSUE_LIMIT };
  }

  async currentUser(): Promise<JiraCurrentUser | null> {
    try {
      const user = object(await this.request('/rest/api/2/myself'));
      const displayName = string(user.displayName);
      if (!displayName) return null;
      return {
        displayName,
        ...(string(user.accountId) ? { accountId: string(user.accountId) } : {}),
        ...(string(user.key) ? { key: string(user.key) } : {}),
        ...(string(user.name) ? { name: string(user.name) } : {}),
      };
    } catch {
      return null;
    }
  }

  async board(boardId: number): Promise<BoardData> {
    const [{ board, columns }, page, currentUser] = await Promise.all([
      this.configuration(boardId),
      this.issues(boardId),
      this.currentUser(),
    ]);
    const statusColumn = new Map<string, string>();
    for (const column of columns) {
      for (const status of column.statuses) statusColumn.set(status.id, column.id);
    }

    const issues = page.issues.map((entry): JiraIssue => {
      const issue = object(entry);
      const fields = object(issue.fields);
      const status = statusOf(fields.status);
      const key = string(issue.key);
      return {
        id: string(issue.id, key),
        key,
        summary: string(fields.summary, key),
        url: `${this.source.baseUrl}/browse/${encodeURIComponent(key)}`,
        columnId: statusColumn.get(status.id) ?? 'other',
        status,
        assignee: assigneeOf(fields.assignee),
        priority: string(object(fields.priority).name) || null,
        issueType: string(object(fields.issuetype).name) || null,
        updated: string(fields.updated) || null,
      };
    }).filter((issue) => issue.key);

    const otherStatuses = new Map<string, JiraStatus>();
    for (const issue of issues) {
      if (issue.columnId === 'other') otherStatuses.set(issue.status.id, issue.status);
    }
    if (otherStatuses.size) {
      columns.push({ id: 'other', name: 'Other statuses', statuses: [...otherStatuses.values()], canDrop: false });
    }
    return { board, columns, issues, currentUser, truncated: page.truncated };
  }

  async moveIssue(boardId: number, issueKey: string, statusId: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) throw new JiraError('Invalid Jira issue key.', 400);
    const [{ columns }, transitionsBody] = await Promise.all([
      this.configuration(boardId, signal),
      this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, { ...(signal ? { signal } : {}) }),
    ]);
    const target = columns.flatMap((column) => column.statuses).find((status) => status.id === statusId);
    if (!target) throw new JiraError('The target status does not belong to this board.', 400);
    const transition = array(object(transitionsBody).transitions).find((entry) => {
      const value = object(entry);
      return string(object(value.to).id) === statusId;
    });
    if (!transition) {
      throw new JiraError(`No direct Jira transition to “${target.name}” is available for ${issueKey}.`, 409);
    }
    const transitionId = string(object(transition).id);
    await this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
      ...(signal ? { signal } : {}),
    });
  }
}
