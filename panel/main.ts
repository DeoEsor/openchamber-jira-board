import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSelect,
  mountSpinner,
  mountTabs,
} from '@openchamber/sdk/ui';
import type {
  BoardData,
  BoardPreferences,
  BootstrapData,
  IssueFilter,
  JiraBoard,
  JiraIssue,
  JiraProject,
  JiraStatus,
  PublicJiraSource,
} from '../shared/types.ts';
import {
  applyOptimisticMove,
  clearReconciledOperations,
  isCurrentUserAssignee,
  resolveBoardSelection,
  rollbackOptimisticMove,
  type OptimisticMove,
} from '../shared/board-state.ts';
import { SerialQueue } from '../shared/serial-queue.ts';

const host = connectHost();
const TRANSITION_RECONCILE_DELAY_MS = 13_000;
const ALL_PROJECTS = '__all__';

type LoadStage = 'bootstrap' | 'projects' | 'boards' | 'board' | null;
type State = {
  sources: PublicJiraSource[];
  projects: JiraProject[];
  boards: JiraBoard[];
  sourceId: string | null;
  projectKey: string | null;
  boardId: number | null;
  board: BoardData | null;
  filter: IssueFilter;
  query: string;
  loading: LoadStage;
  error: string | null;
  configError: string | null;
  pending: Set<string>;
  uncertain: Map<string, number>;
};

const state: State = {
  sources: [],
  projects: [],
  boards: [],
  sourceId: null,
  projectKey: null,
  boardId: null,
  board: null,
  filter: 'all',
  query: '',
  loading: null,
  error: null,
  configError: null,
  pending: new Set(),
  uncertain: new Map(),
};

class ServiceRequestError extends Error {
  readonly outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown = false) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
  }
}

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element #${id}`);
  return result as T;
};

let sourceSelect: ReturnType<typeof mountSelect>;
let projectSelect: ReturnType<typeof mountSelect>;
let boardSelect: ReturnType<typeof mountSelect>;
let searchField: ReturnType<typeof mountSearchField>;
let filterTabs: ReturnType<typeof mountTabs>;
let refreshButton: ReturnType<typeof mountButton>;
let mounted = false;
let initialized = false;
let selectionVersion = 0;
let boardVersion = 0;
let draggedIssue: JiraIssue | null = null;
let stateView: { dispose: () => void } | null = null;
let noticeView: { dispose: () => void } | null = null;
let previousViewKey = '';
let previousNoticeKey = '';
const preferenceWrites = new SerialQueue();

function currentSource(): PublicJiraSource | null {
  return state.sources.find((source) => source.id === state.sourceId) ?? null;
}

async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const transitionRequest = method === 'POST' && path.endsWith('/transitions');
  const result = await host.serviceRequest({
    method,
    path,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: unknown = {};
  try {
    parsed = result.body ? JSON.parse(result.body) : {};
  } catch {
    throw new ServiceRequestError('The Jira Board service returned an invalid response.', transitionRequest);
  }
  if (result.status < 200 || result.status >= 300) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `Jira Board service returned HTTP ${result.status}.`;
    const outcomeUnknown = transitionRequest && parsed && typeof parsed === 'object' && 'outcome' in parsed
      && (parsed as { outcome: unknown }).outcome === 'unknown';
    throw new ServiceRequestError(message, Boolean(outcomeUnknown));
  }
  return parsed as T;
}

function preferences(): BoardPreferences {
  return {
    sourceId: state.sourceId,
    projectKey: state.projectKey,
    boardId: state.boardId,
    filter: state.filter,
  };
}

function savePreferences(): void {
  const snapshot = preferences();
  void preferenceWrites.run(() => api('PUT', '/api/preferences', snapshot)).catch(() => undefined);
}

function setNotice(key: string, render: (root: HTMLElement) => { dispose: () => void } | null): void {
  if (key === previousNoticeKey) return;
  previousNoticeKey = key;
  noticeView?.dispose();
  noticeView = null;
  const root = element('notice');
  root.replaceChildren();
  noticeView = render(root);
}

function setView(key: string, render: (root: HTMLElement) => { dispose: () => void } | null): void {
  if (key === previousViewKey) return;
  previousViewKey = key;
  stateView?.dispose();
  stateView = null;
  const root = element('state-view');
  root.replaceChildren();
  stateView = render(root);
}

function filteredIssues(): { all: JiraIssue[]; mine: JiraIssue[]; unassigned: JiraIssue[]; visible: JiraIssue[] } {
  const query = state.query.trim().toLocaleLowerCase();
  const searched = (state.board?.issues ?? []).filter((issue) => {
    if (!query) return true;
    return [issue.key, issue.summary, issue.assignee?.displayName ?? '', issue.issueType ?? '']
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
  const user = state.board?.currentUser;
  const mine = searched.filter((issue) => Boolean(
    user && issue.assignee && isCurrentUserAssignee(issue.assignee, user),
  ));
  const unassigned = searched.filter((issue) => !issue.assignee);
  return {
    all: searched,
    mine,
    unassigned,
    visible: state.filter === 'mine' ? mine : state.filter === 'unassigned' ? unassigned : searched,
  };
}

function render(): void {
  if (!mounted) return;
  const source = currentSource();
  const busy = state.loading !== null || state.pending.size > 0 || state.uncertain.size > 0;
  const filters = filteredIssues();

  sourceSelect.update({
    value: state.sourceId,
    options: state.sources.map((item) => ({ id: item.id, label: item.name, hint: item.kind === 'cloud' ? 'Cloud' : 'Data Center' })),
    disabled: busy || !state.sources.length,
  });
  projectSelect.update({
    value: state.projectKey ?? ALL_PROJECTS,
    options: [
      { id: ALL_PROJECTS, label: 'All projects' },
      ...state.projects.map((project) => ({ id: project.key, label: project.name, hint: project.key })),
    ],
    disabled: busy || !state.sourceId,
  });
  boardSelect.update({
    value: state.boardId === null ? null : String(state.boardId),
    options: state.boards.map((board) => ({ id: String(board.id), label: board.name, hint: board.type })),
    disabled: busy || !state.sourceId || !state.boards.length,
  });
  searchField.update({ value: state.query });
  filterTabs.update({
    activeId: state.filter,
    items: [
      { id: 'all', label: 'All issues', count: filters.all.length },
      { id: 'mine', label: 'My issues', count: filters.mine.length },
      { id: 'unassigned', label: 'Unassigned', count: filters.unassigned.length },
    ],
  });
  refreshButton.update({
    loading: state.loading !== null,
    disabled: state.loading !== null || (state.pending.size > 0 && state.uncertain.size === 0),
  });
  element('source-caption').textContent = source ? `${source.name} · ${source.baseUrl}` : 'Your work, at a glance';
  element('issue-count').textContent = `${filters.visible.length} of ${state.board?.issues.length ?? 0} issues`;

  const truncated = state.board?.truncated ?? false;
  setNotice(truncated ? 'truncated' : '', (root) => truncated
    ? mountBanner(root, {
      tone: 'warning',
      title: 'Showing the first 200 issues',
      body: 'Narrow the board in Jira or choose a specific project to keep the panel fast.',
    })
    : null);

  if (state.error && state.board) {
    setView(`board-error:${state.error}`, (root) => mountBanner(root, {
      tone: 'error',
      title: 'Could not refresh the board',
      body: state.error ?? undefined,
      action: { label: 'Try again', onClick: () => void refresh() },
    }));
  } else if (state.error) {
    setView(`error:${state.error}`, (root) => mountBanner(root, {
      tone: 'error',
      title: 'Jira Board could not load',
      body: state.error ?? undefined,
      action: { label: 'Try again', onClick: () => void refresh() },
    }));
  } else if (state.configError) {
    setView(`config-error:${state.configError}`, (root) => {
      const banner = mountBanner(root, { tone: 'error', title: 'Check the sources JSON', body: state.configError ?? undefined });
      const help = document.createElement('p');
      help.className = 'config-help';
      help.textContent = 'Edit Settings → Integrations → Jira Board → Sources, then retry. See the extension README for a two-source example.';
      root.append(help);
      return banner;
    });
  } else if (!state.sources.length && state.loading !== 'bootstrap') {
    setView('no-sources', (root) => {
      const empty = mountEmpty(root, {
        title: 'Connect your first Jira source',
        body: 'Open Settings → Integrations → Jira Board and paste a JSON array into Sources. Cloud uses email + API token; Data Center uses a personal access token.',
        action: { label: 'Check again', onClick: () => void refresh() },
      });
      const help = document.createElement('p');
      help.className = 'config-help';
      help.textContent = 'The generic Access token field can stay empty: each source in the JSON has its own credentials.';
      root.append(help);
      return empty;
    });
  } else if (state.loading && !state.board) {
    setView(`loading:${state.loading}`, (root) => mountSpinner(root, {
      label: state.loading === 'projects' ? 'Loading Jira projects…'
        : state.loading === 'boards' ? 'Loading boards…'
          : state.loading === 'board' ? 'Loading issues…'
            : 'Reading Jira sources…',
    }));
  } else if (!state.boards.length && state.sourceId) {
    setView('no-boards', (root) => mountEmpty(root, {
      title: 'No Jira boards found',
      body: 'Try another project or check that this account can use Jira Software boards.',
      action: { label: 'Check again', onClick: () => void refresh() },
    }));
  } else if (state.board) {
    setView('board', () => null);
  }

  renderBoard(filters.visible);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase() ?? '').join('') || '?';
}

function createCard(issue: JiraIssue): HTMLElement {
  const card = document.createElement('article');
  card.className = 'issue';
  const unavailable = state.pending.has(issue.key) || state.uncertain.has(issue.key);
  card.draggable = !unavailable;
  card.dataset.dragging = 'false';
  card.dataset.pending = String(unavailable);
  card.setAttribute('aria-label', `${issue.key}: ${issue.summary}`);

  const top = document.createElement('div');
  top.className = 'issue-top';
  const key = document.createElement('span');
  key.className = 'issue-key';
  key.textContent = issue.key;
  top.append(key);
  if (issue.priority) {
    const priority = document.createElement('span');
    priority.className = 'priority';
    priority.dataset.priority = issue.priority;
    priority.textContent = issue.priority;
    top.append(priority);
  }

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'issue-summary';
  summary.textContent = issue.summary;
  summary.title = 'Open in Jira';
  summary.addEventListener('click', () => void host.openUrl(issue.url));

  const footer = document.createElement('div');
  footer.className = 'issue-footer';
  if (issue.issueType) {
    const type = document.createElement('span');
    type.className = 'issue-type';
    type.textContent = issue.issueType;
    footer.append(type);
  }
  const assignee = document.createElement('div');
  assignee.className = 'assignee';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = initials(issue.assignee?.displayName ?? '?');
  const name = document.createElement('span');
  name.className = 'assignee-name';
  name.textContent = issue.assignee?.displayName ?? 'Unassigned';
  assignee.append(avatar, name);
  footer.append(assignee);
  card.append(top, summary, footer);

  card.addEventListener('dragstart', (event) => {
    draggedIssue = issue;
    card.dataset.dragging = 'true';
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', issue.key);
    }
  });
  card.addEventListener('dragend', () => {
    draggedIssue = null;
    card.dataset.dragging = 'false';
    document.querySelectorAll('[data-drop-active="true"]').forEach((node) => {
      (node as HTMLElement).dataset.dropActive = 'false';
    });
  });
  return card;
}

function attachDropZone(zone: HTMLElement, status: JiraStatus): void {
  zone.addEventListener('dragover', (event) => {
    if (!draggedIssue || draggedIssue.status.id === status.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    zone.dataset.dropActive = 'true';
  });
  zone.addEventListener('dragleave', (event) => {
    if (!(event.relatedTarget instanceof Node) || !zone.contains(event.relatedTarget)) zone.dataset.dropActive = 'false';
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.dataset.dropActive = 'false';
    const issue = draggedIssue;
    draggedIssue = null;
    if (issue && issue.status.id !== status.id) void moveIssue(issue, status);
  });
}

function renderBoard(visible: JiraIssue[]): void {
  const root = element('board');
  root.replaceChildren();
  if (!state.board || state.error && !state.board) return;
  for (const column of state.board.columns) {
    const columnElement = document.createElement('section');
    columnElement.className = 'column';
    columnElement.dataset.dropActive = 'false';
    columnElement.setAttribute('aria-label', column.name);

    const header = document.createElement('header');
    header.className = 'column-header';
    const title = document.createElement('h2');
    title.className = 'column-title';
    title.textContent = column.name;
    title.title = column.name;
    const count = document.createElement('span');
    count.className = 'column-count';
    const issues = visible.filter((issue) => issue.columnId === column.id);
    count.textContent = String(issues.length);
    header.append(title, count);
    columnElement.append(header);

    if (column.canDrop && column.statuses.length === 1 && column.statuses[0]) {
      attachDropZone(columnElement, column.statuses[0]);
    } else if (column.canDrop && column.statuses.length > 1) {
      const zones = document.createElement('div');
      zones.className = 'status-zones';
      const note = document.createElement('span');
      note.className = 'status-note';
      note.textContent = 'Drop on a status:';
      zones.append(note);
      for (const status of column.statuses) {
        const zone = document.createElement('span');
        zone.className = 'status-zone';
        zone.dataset.dropActive = 'false';
        zone.textContent = status.name;
        attachDropZone(zone, status);
        zones.append(zone);
      }
      columnElement.append(zones);
    }

    const cards = document.createElement('div');
    cards.className = 'cards';
    if (issues.length) {
      for (const issue of issues) cards.append(createCard(issue));
    } else {
      const empty = document.createElement('div');
      empty.className = 'column-empty';
      empty.textContent = column.canDrop ? 'Drop an issue here' : 'No issues';
      cards.append(empty);
    }
    columnElement.append(cards);
    root.append(columnElement);
  }
}

function isUnknownTransitionOutcome(error: unknown): boolean {
  return error instanceof ServiceRequestError && error.outcomeUnknown
    || error instanceof HostRequestError && (error.code === 'HOST_TIMEOUT' || error.code === 'REQUEST_FAILED');
}

async function moveIssue(issue: JiraIssue, status: JiraStatus): Promise<void> {
  if (!state.board || !state.sourceId || !state.boardId || state.pending.has(issue.key) || state.uncertain.has(issue.key)) return;
  const sourceId = state.sourceId;
  const boardId = state.boardId;
  const notBefore = Date.now() + TRANSITION_RECONCILE_DELAY_MS;
  const original = state.board.issues.find((candidate) => candidate.key === issue.key) ?? issue;
  const optimistic = applyOptimisticMove(state.board, issue.key, status);
  const optimisticIssue = optimistic.issues.find((candidate) => candidate.key === issue.key);
  if (!optimisticIssue) return;
  const operation: OptimisticMove = {
    issueKey: issue.key,
    fromStatus: original.status,
    fromColumnId: original.columnId,
    optimisticIssue,
  };
  state.board = optimistic;
  state.pending.add(issue.key);
  render();
  try {
    await api('POST', `/api/sources/${encodeURIComponent(sourceId)}/issues/${encodeURIComponent(issue.key)}/transitions`, {
      boardId,
      statusId: status.id,
    });
    state.pending.delete(issue.key);
    void host.toast({ kind: 'success', message: `${issue.key} moved to ${status.name}.` });
    await loadBoard();
  } catch (error) {
    state.pending.delete(issue.key);
    if (isUnknownTransitionOutcome(error)) {
      state.uncertain.set(issue.key, notBefore);
      render();
      void host.toast({ kind: 'info', message: `${issue.key}: transition outcome is not confirmed. Waiting to reconcile with Jira…` });
      const delay = Math.max(0, notBefore - Date.now());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const reconciled = await loadBoard();
      if (!reconciled && state.uncertain.has(issue.key) && state.loading === null) {
        void host.toast({
          kind: 'error',
          message: `${issue.key} is locked until Refresh confirms its Jira status.`,
          dismiss: true,
        });
      }
      return;
    }
    if (state.board) state.board = rollbackOptimisticMove(state.board, operation);
    render();
    void host.toast({
      kind: 'error',
      message: error instanceof Error ? error.message : `Could not move ${issue.key}.`,
      dismiss: true,
    });
  }
}

async function loadBoard(): Promise<boolean> {
  if (!state.sourceId || state.boardId === null) {
    state.board = null;
    state.loading = null;
    render();
    return false;
  }
  const version = ++boardVersion;
  const sourceId = state.sourceId;
  const boardId = state.boardId;
  const loadStartedAt = Date.now();
  state.loading = 'board';
  state.error = null;
  render();
  try {
    const board = await api<BoardData>('GET', `/api/sources/${encodeURIComponent(sourceId)}/boards/${boardId}`);
    if (version !== boardVersion) return false;
    state.board = board;
    clearReconciledOperations(state.uncertain, loadStartedAt);
    state.loading = null;
    savePreferences();
    render();
    return true;
  } catch (error) {
    if (version !== boardVersion) return false;
    state.loading = null;
    state.error = error instanceof Error ? error.message : String(error);
    render();
    return false;
  }
}

async function loadBoards(): Promise<void> {
  if (!state.sourceId) return;
  const version = ++selectionVersion;
  const sourceId = state.sourceId;
  const projectKey = state.projectKey;
  state.loading = 'boards';
  state.error = null;
  state.board = null;
  render();
  try {
    const result = await api<{ boards: JiraBoard[] }>('GET', `/api/sources/${encodeURIComponent(sourceId)}/boards${projectKey ? `?projectKey=${encodeURIComponent(projectKey)}` : ''}`);
    if (version !== selectionVersion) return;
    state.boards = result.boards;
    const source = currentSource();
    const preferred = state.boardId ?? source?.defaultBoardId ?? null;
    state.boardId = result.boards.some((board) => board.id === preferred) ? preferred : result.boards[0]?.id ?? null;
    state.loading = null;
    savePreferences();
    await loadBoard();
  } catch (error) {
    if (version !== selectionVersion) return;
    state.loading = null;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function loadProjects(): Promise<void> {
  if (!state.sourceId) return;
  const version = ++selectionVersion;
  const sourceId = state.sourceId;
  state.loading = 'projects';
  state.error = null;
  state.projects = [];
  state.boards = [];
  state.board = null;
  render();
  try {
    const result = await api<{ projects: JiraProject[] }>('GET', `/api/sources/${encodeURIComponent(sourceId)}/projects`);
    if (version !== selectionVersion) return;
    state.projects = result.projects;
    const preferred = state.projectKey;
    state.projectKey = preferred && result.projects.some((project) => project.key === preferred) ? preferred : null;
    state.loading = null;
    savePreferences();
    await loadBoards();
  } catch (error) {
    if (version !== selectionVersion) return;
    state.loading = null;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function initialize(preserved?: BoardPreferences): Promise<void> {
  const version = ++selectionVersion;
  ++boardVersion;
  state.loading = 'bootstrap';
  state.error = null;
  state.configError = null;
  state.board = null;
  render();
  try {
    const result = await api<BootstrapData>('GET', '/api/bootstrap');
    if (version !== selectionVersion) return;
    state.sources = result.sources;
    state.configError = result.configError;
    const selection = resolveBoardSelection(result.sources, result.preferences, preserved);
    state.filter = selection.filter;
    state.sourceId = selection.sourceId;
    state.projectKey = selection.projectKey;
    state.boardId = selection.boardId;
    state.loading = null;
    if (state.sourceId && !state.configError) await loadProjects();
    else render();
  } catch (error) {
    if (version !== selectionVersion) return;
    state.loading = null;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

function refresh(): Promise<void> {
  return initialize(preferences());
}

function mount(): void {
  if (mounted) return;
  mounted = true;
  sourceSelect = mountSelect(element('source-control'), {
    label: 'Source',
    value: null,
    options: [],
    placeholder: 'Choose a Jira source',
    onChange: (id) => {
      state.sourceId = id;
      state.projectKey = currentSource()?.defaultProjectKey ?? null;
      state.boardId = currentSource()?.defaultBoardId ?? null;
      state.board = null;
      savePreferences();
      void loadProjects();
    },
  });
  projectSelect = mountSelect(element('project-control'), {
    label: 'Project',
    value: ALL_PROJECTS,
    options: [{ id: ALL_PROJECTS, label: 'All projects' }],
    searchable: true,
    onChange: (id) => {
      state.projectKey = id === ALL_PROJECTS ? null : id;
      state.boardId = null;
      state.board = null;
      savePreferences();
      void loadBoards();
    },
  });
  boardSelect = mountSelect(element('board-control'), {
    label: 'Board',
    value: null,
    options: [],
    searchable: true,
    placeholder: 'Choose a board',
    onChange: (id) => {
      state.boardId = Number(id);
      state.board = null;
      savePreferences();
      void loadBoard();
    },
  });
  searchField = mountSearchField(element('search-control'), {
    value: '',
    placeholder: 'Search by key, summary, or assignee…',
    onChange: (value) => {
      state.query = value;
      searchField.update({ value });
      render();
    },
  });
  filterTabs = mountTabs(element('filter-control'), {
    activeId: 'all',
    items: [{ id: 'all', label: 'All issues' }, { id: 'mine', label: 'My issues' }, { id: 'unassigned', label: 'Unassigned' }],
    trackBackground: true,
    onChange: (id) => {
      state.filter = id === 'mine' || id === 'unassigned' ? id : 'all';
      filterTabs.update({ activeId: state.filter });
      savePreferences();
      render();
    },
  });
  refreshButton = mountButton(element('refresh-control'), {
    label: 'Refresh',
    variant: 'outline',
    size: 'sm',
    onClick: () => void refresh(),
  });
  render();
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  mount();
  if (!initialized) {
    initialized = true;
    void initialize();
  }
});
