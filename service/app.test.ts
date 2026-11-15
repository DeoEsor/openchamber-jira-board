import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createJiraBoardServer } from './app.ts';
import type { JiraFetch } from './jira.ts';
import { writePreferences } from './preferences.ts';

const settings = {
  sources: JSON.stringify([
    { id: 'cloud', name: 'Work Cloud', url: 'https://cloud.example.test', type: 'cloud', email: 'me@example.com', token: 'cloud-secret', projectKey: 'PROJ', boardId: 7 },
    { id: 'dc', name: 'Internal', url: 'https://dc.example.test', type: 'datacenter', token: 'dc-secret' },
  ]),
};

let server: Server;
let origin: string;
let dataDir: string;
let lastAuthorization: string | null;
let postedTransition: unknown;
let preferenceWriteHook: ((value: unknown) => Promise<void>) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fakeJira: JiraFetch = async (input, init) => {
  const url = new URL(String(input));
  lastAuthorization = new Headers(init?.headers).get('authorization');
  if (url.pathname === '/rest/api/2/project') {
    return json([{ id: '10000', key: 'PROJ', name: 'Product' }]);
  }
  if (url.pathname === '/rest/agile/1.0/board') {
    expect(url.searchParams.get('projectKeyOrId')).toBe('PROJ');
    return json({ values: [{ id: 7, name: 'Product Kanban', type: 'kanban', location: { projectKey: 'PROJ', projectName: 'Product' } }], isLast: true });
  }
  if (url.pathname === '/rest/agile/1.0/board/7/configuration') {
    return json({
      name: 'Product Kanban',
      columnConfig: { columns: [
        { name: 'To Do', statuses: [{ id: '11', name: 'To Do' }] },
        { name: 'In Progress', statuses: [{ id: '31', name: 'In Progress' }] },
      ] },
    });
  }
  if (url.pathname === '/rest/agile/1.0/board/7/issue') {
    return json({ total: 1, issues: [{
      id: '10001', key: 'PROJ-1', fields: {
        summary: 'Build the board', status: { id: '11', name: 'To Do' },
        assignee: { displayName: 'Mona Lisa', accountId: 'mona' },
        priority: { name: 'High' }, issuetype: { name: 'Task' }, updated: '2026-11-15T10:00:00.000Z',
      },
    }] });
  }
  if (url.pathname === '/rest/api/2/myself') {
    return json({ displayName: 'Mona Lisa', accountId: 'mona' });
  }
  if (url.pathname === '/rest/api/2/issue/PROJ-1/transitions' && (!init?.method || init.method === 'GET')) {
    return json({ transitions: [{ id: '301', to: { id: '31', name: 'In Progress' } }] });
  }
  if (url.pathname === '/rest/api/2/issue/PROJ-1/transitions' && init?.method === 'POST') {
    postedTransition = JSON.parse(String(init.body));
    return new Response(null, { status: 204 });
  }
  return json({ errorMessages: [`Unexpected ${url.pathname}`] }, 404);
};

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: 'Bearer t', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jira-board-test-'));
  server = createJiraBoardServer({
    token: 't', dataDir, readSettings: async () => settings, fetchImpl: fakeJira,
    writePreferencesImpl: async (directory, value) => {
      const hook = preferenceWriteHook;
      if (hook) await hook(value);
      return writePreferences(directory, value);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

describe('Jira Board service', () => {
  test('requires bearer auth even on health', async () => {
    expect((await fetch(`${origin}/health`)).status).toBe(401);
    const response = await request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('bootstrap exposes source metadata and preferences, never credentials', async () => {
    const response = await request('/api/bootstrap');
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain('cloud-secret');
    expect(raw).not.toContain('dc-secret');
    expect(raw).not.toContain('me@example.com');
    const body = JSON.parse(raw);
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0]).toMatchObject({ id: 'cloud', defaultProjectKey: 'PROJ', defaultBoardId: 7 });
    expect(body.configError).toBeNull();
  });

  test('loads projects and boards with source-specific credentials', async () => {
    const projects = await request('/api/sources/cloud/projects');
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual({ projects: [{ id: '10000', key: 'PROJ', name: 'Product' }] });
    expect(lastAuthorization).toBe(`Basic ${Buffer.from('me@example.com:cloud-secret').toString('base64')}`);

    const boards = await request('/api/sources/cloud/boards?projectKey=PROJ');
    expect(boards.status).toBe(200);
    expect((await boards.json()).boards[0]).toMatchObject({ id: 7, name: 'Product Kanban', projectKey: 'PROJ' });

    const dcProjects = await request('/api/sources/dc/projects');
    expect(dcProjects.status).toBe(200);
    expect(lastAuthorization).toBe('Bearer dc-secret');
  });

  test('maps Jira issues into configured board columns', async () => {
    const response = await request('/api/sources/cloud/boards/7');
    expect(response.status).toBe(200);
    const board = await response.json();
    expect(board.columns).toHaveLength(2);
    expect(board.issues[0]).toMatchObject({
      key: 'PROJ-1', columnId: 'column-0', summary: 'Build the board',
      url: 'https://cloud.example.test/browse/PROJ-1',
      assignee: { displayName: 'Mona Lisa', accountId: 'mona' },
    });
    expect(board.currentUser).toMatchObject({ accountId: 'mona' });
    expect(board.truncated).toBe(false);
  });

  test('uses the direct Jira transition for the selected target status', async () => {
    const response = await request('/api/sources/cloud/issues/PROJ-1/transitions', {
      method: 'POST', body: JSON.stringify({ boardId: 7, statusId: '31' }),
    });
    expect(response.status).toBe(200);
    expect(postedTransition).toEqual({ transition: { id: '301' } });
  });

  test('rejects a status with no direct workflow transition', async () => {
    const response = await request('/api/sources/cloud/issues/PROJ-1/transitions', {
      method: 'POST', body: JSON.stringify({ boardId: 7, statusId: '11' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('No direct Jira transition');
  });

  test('persists UI preferences outside the package', async () => {
    const response = await request('/api/preferences', {
      method: 'PUT', body: JSON.stringify({ sourceId: 'cloud', projectKey: 'PROJ', boardId: 7, filter: 'mine' }),
    });
    expect(response.status).toBe(200);
    const bootstrap = await (await request('/api/bootstrap')).json();
    expect(bootstrap.preferences).toEqual({ sourceId: 'cloud', projectKey: 'PROJ', boardId: 7, filter: 'mine' });
  });

  test('serializes overlapping preference PUTs across frames', async () => {
    let releaseFirst = (): void => undefined;
    let signalFirst = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let newerCompleted = false;
    preferenceWriteHook = async (value) => {
      if ((value as { boardId?: unknown }).boardId === 1) {
        signalFirst();
        await firstGate;
      }
    };
    try {
      const older = request('/api/preferences', {
        method: 'PUT', body: JSON.stringify({ sourceId: 'cloud', projectKey: null, boardId: 1, filter: 'all' }),
      });
      await firstStarted;
      const newer = request('/api/preferences', {
        method: 'PUT', body: JSON.stringify({ sourceId: 'cloud', projectKey: null, boardId: 2, filter: 'all' }),
      }).then((response) => {
        newerCompleted = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(newerCompleted).toBe(false);
      releaseFirst();
      const [olderResponse, newerResponse] = await Promise.all([older, newer]);
      expect(olderResponse.status).toBe(200);
      expect(newerResponse.status).toBe(200);
      const bootstrap = await (await request('/api/bootstrap')).json();
      expect(bootstrap.preferences.boardId).toBe(2);
    } finally {
      preferenceWriteHook = null;
      releaseFirst();
    }
  });

  test('stops before POST when transition lookup exceeds the overall deadline', async () => {
    let posted = false;
    let transitionServer: Server | undefined;
    try {
      const delayedJira: JiraFetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/rest/api/2/issue/PROJ-1/transitions' && (!init?.method || init.method === 'GET')) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return json({ transitions: [{ id: '301', to: { id: '31', name: 'In Progress' } }] });
        }
        if (url.pathname === '/rest/api/2/issue/PROJ-1/transitions' && init?.method === 'POST') posted = true;
        return fakeJira(input, init);
      };
      transitionServer = createJiraBoardServer({
        token: 't', dataDir, readSettings: async () => settings, fetchImpl: delayedJira, transitionTimeoutMs: 20,
      });
      await new Promise<void>((resolve) => transitionServer!.listen(0, '127.0.0.1', resolve));
      const localOrigin = `http://127.0.0.1:${(transitionServer.address() as AddressInfo).port}`;
      const response = await fetch(`${localOrigin}/api/sources/cloud/issues/PROJ-1/transitions`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ boardId: 7, statusId: '31' }),
      });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ outcome: 'unknown' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(posted).toBe(false);
    } finally {
      if (transitionServer) await new Promise<void>((resolve, reject) => transitionServer!.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('marks a late POST response as an unknown outcome instead of a definite failure', async () => {
    let posted = false;
    let transitionServer: Server | undefined;
    try {
      const delayedJira: JiraFetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/rest/api/2/issue/PROJ-1/transitions' && init?.method === 'POST') {
          posted = true;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return new Response(null, { status: 204 });
        }
        return fakeJira(input, init);
      };
      transitionServer = createJiraBoardServer({
        token: 't', dataDir, readSettings: async () => settings, fetchImpl: delayedJira, transitionTimeoutMs: 20,
      });
      await new Promise<void>((resolve) => transitionServer!.listen(0, '127.0.0.1', resolve));
      const localOrigin = `http://127.0.0.1:${(transitionServer.address() as AddressInfo).port}`;
      const response = await fetch(`${localOrigin}/api/sources/cloud/issues/PROJ-1/transitions`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ boardId: 7, statusId: '31' }),
      });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ outcome: 'unknown' });
      expect(posted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      if (transitionServer) await new Promise<void>((resolve, reject) => transitionServer!.close((error) => error ? reject(error) : resolve()));
    }
  });
});
