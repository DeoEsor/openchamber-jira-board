import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createJiraBoardServer } from './app.ts';
import type { JiraFetch } from './jira.ts';
import { writePreferences } from './preferences.ts';
import { readSources, writeSources } from './sources.ts';
import type { JiraSource } from '../shared/types.ts';

const initialSources: JiraSource[] = [
  { id: 'cloud', name: 'Work Cloud', baseUrl: 'https://cloud.example.test', kind: 'cloud', email: 'me@example.com', token: 'cloud-secret', defaultProjectKey: 'PROJ', defaultBoardId: 7 },
  { id: 'dc', name: 'Internal', baseUrl: 'https://dc.example.test', kind: 'datacenter', token: 'dc-secret' },
];

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
  await writeSources(dataDir, initialSources);
  server = createJiraBoardServer({
    token: 't', dataDir, fetchImpl: fakeJira,
    writePreferencesImpl: async (directory, value) => {
      const hook = preferenceWriteHook;
      if (hook) await hook(value);
      return writePreferences(directory, value);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await writeSources(dataDir, initialSources);
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

  test('requires bearer auth for source create, edit, and delete', async () => {
    const attempts = [
      fetch(`${origin}/api/sources`, { method: 'POST', body: '{}' }),
      fetch(`${origin}/api/sources/cloud`, { method: 'PUT', body: '{}' }),
      fetch(`${origin}/api/sources/cloud`, { method: 'DELETE' }),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(401);
    expect(await readSources(dataDir)).toEqual(initialSources);
  });

  test('bootstrap exposes source metadata and preferences, never credentials', async () => {
    const response = await request('/api/bootstrap');
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain('cloud-secret');
    expect(raw).not.toContain('dc-secret');
    const body = JSON.parse(raw);
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0]).toMatchObject({
      id: 'cloud', email: 'me@example.com', defaultProjectKey: 'PROJ', defaultBoardId: 7,
    });
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

  test('creates sources with unique generated ids and lists public metadata', async () => {
    const input = {
      name: 'My Team Jira', url: 'https://new.example.test/', type: 'datacenter', token: 'new-secret',
      projectKey: 'NEW', boardId: '9',
    };
    const first = await request('/api/sources', { method: 'POST', body: JSON.stringify(input) });
    const firstRaw = await first.text();
    expect(first.status).toBe(201);
    expect(firstRaw).not.toContain('new-secret');
    expect(JSON.parse(firstRaw).source).toEqual({
      id: 'my-team-jira', name: 'My Team Jira', baseUrl: 'https://new.example.test', kind: 'datacenter',
      defaultProjectKey: 'NEW', defaultBoardId: 9,
    });

    const second = await request('/api/sources', {
      method: 'POST', body: JSON.stringify({ ...input, token: 'other-secret' }),
    });
    expect(second.status).toBe(201);
    expect((await second.json()).source.id).toBe('my-team-jira-2');
    const bootstrap = await (await request('/api/bootstrap')).json();
    expect(bootstrap.sources.map((source: { id: string }) => source.id)).toEqual([
      'cloud', 'dc', 'my-team-jira', 'my-team-jira-2',
    ]);
    expect(await readSources(dataDir)).toHaveLength(4);
  });

  test('scopes blank-token preservation to the same normalized origin and auth kind', async () => {
    const created = await (await request('/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'Edit Me', url: 'https://old.example.test/jira', type: 'datacenter', token: 'original-secret' }),
    })).json();
    const id = created.source.id as string;
    const editedInput = {
      id: 'attempted-id-change', name: 'Renamed', url: 'https://OLD.example.test:443/new-base/', type: 'datacenter', token: ' ',
      projectKey: 'EDIT', boardId: 8,
    };
    const edited = await request(`/api/sources/${id}`, { method: 'PUT', body: JSON.stringify(editedInput) });
    const editedRaw = await edited.text();
    expect(edited.status).toBe(200);
    expect(editedRaw).not.toContain('original-secret');
    expect(JSON.parse(editedRaw).source).toMatchObject({ id: 'edit-me', name: 'Renamed', defaultProjectKey: 'EDIT' });

    await request(`/api/sources/${id}/projects`);
    expect(lastAuthorization).toBe('Bearer original-secret');

    const omittedToken = { name: 'Renamed Again', url: 'https://old.example.test/new-base/deeper', type: 'datacenter' };
    expect((await request(`/api/sources/${id}`, { method: 'PUT', body: JSON.stringify(omittedToken) })).status).toBe(200);
    await request(`/api/sources/${id}/projects`);
    expect(lastAuthorization).toBe('Bearer original-secret');

    const changedOrigin = await request(`/api/sources/${id}`, {
      method: 'PUT', body: JSON.stringify({ ...omittedToken, url: 'https://new.example.test', token: '' }),
    });
    expect(changedOrigin.status).toBe(400);
    const originError = await changedOrigin.text();
    expect(originError).toContain('changing the Jira origin or type');
    expect(originError).not.toContain('original-secret');

    const changedKind = await request(`/api/sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...omittedToken, type: 'cloud', email: 'me@example.com', token: '' }),
    });
    expect(changedKind.status).toBe(400);
    expect(await changedKind.text()).toContain('changing the Jira origin or type');
    const unchanged = (await readSources(dataDir)).find((source) => source.id === id);
    expect(unchanged).toMatchObject({
      baseUrl: 'https://old.example.test/new-base/deeper', kind: 'datacenter', token: 'original-secret',
    });

    expect((await request(`/api/sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...omittedToken, url: 'https://new.example.test', token: 'replacement-secret' }),
    })).status).toBe(200);
    await request(`/api/sources/${id}/projects`);
    expect(lastAuthorization).toBe('Bearer replacement-secret');
    expect((await readSources(dataDir)).find((source) => source.id === id)?.name).toBe('Renamed Again');
  });

  test('deletes a selected source and clears only its selection preferences', async () => {
    const created = await (await request('/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'Temporary', url: 'https://temp.example.test', type: 'datacenter', token: 'temp-secret' }),
    })).json();
    const id = created.source.id as string;
    await request('/api/preferences', {
      method: 'PUT', body: JSON.stringify({ sourceId: id, projectKey: 'TMP', boardId: 9, filter: 'unassigned' }),
    });
    const deleted = await request(`/api/sources/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      ok: true,
      preferences: { sourceId: null, projectKey: null, boardId: null, filter: 'unassigned' },
    });
    const bootstrap = await (await request('/api/bootstrap')).json();
    expect(bootstrap.sources.some((source: { id: string }) => source.id === id)).toBe(false);
  });

  test('keeps deletion successful when preference cleanup fails', async () => {
    const created = await (await request('/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cleanup Failure', url: 'https://cleanup.example.test', type: 'datacenter', token: 'cleanup-secret' }),
    })).json();
    const id = created.source.id as string;
    const selected = { sourceId: id, projectKey: 'TMP', boardId: 9, filter: 'mine' };
    await request('/api/preferences', { method: 'PUT', body: JSON.stringify(selected) });
    preferenceWriteHook = async (value) => {
      if ((value as { sourceId?: unknown }).sourceId === null) throw new Error('Injected preference cleanup failure.');
    };
    try {
      const response = await request(`/api/sources/${id}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        preferences: { sourceId: null, projectKey: null, boardId: null, filter: 'mine' },
      });
      expect((await readSources(dataDir)).some((source) => source.id === id)).toBe(false);
      const bootstrap = await (await request('/api/bootstrap')).json();
      expect(bootstrap.preferences).toEqual(selected);
      expect(bootstrap.sources.some((source: { id: string }) => source.id === id)).toBe(false);
    } finally {
      preferenceWriteHook = null;
    }
  });

  test('preserves preferences when deleting an unselected source', async () => {
    await request('/api/preferences', {
      method: 'PUT', body: JSON.stringify({ sourceId: 'cloud', projectKey: 'PROJ', boardId: 7, filter: 'mine' }),
    });
    const response = await request('/api/sources/dc', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      preferences: { sourceId: 'cloud', projectKey: 'PROJ', boardId: 7, filter: 'mine' },
    });
  });

  test('validates new sources without reflecting submitted credentials in errors', async () => {
    const valid = {
      name: 'Valid', url: 'https://valid.example.test', type: 'datacenter', token: 'validation-secret',
    };
    const invalidInputs: unknown[] = [
      [],
      { ...valid, name: '' },
      { ...valid, url: '/relative' },
      { ...valid, url: 'http://remote.example.test' },
      { ...valid, url: 'https://user:password@valid.example.test' },
      { ...valid, url: 'https://valid.example.test?token=validation-secret' },
      { ...valid, url: 'https://valid.example.test#fragment' },
      { ...valid, type: 'other' },
      { ...valid, type: 'cloud' },
      { ...valid, token: ' ' },
      { ...valid, boardId: 0 },
      { ...valid, boardId: 'not-a-number' },
    ];
    for (const input of invalidInputs) {
      const response = await request('/api/sources', { method: 'POST', body: JSON.stringify(input) });
      const raw = await response.text();
      expect(response.status).toBe(400);
      expect(raw).not.toContain('validation-secret');
    }
    expect(await readSources(dataDir)).toHaveLength(2);
  });

  test('enforces the sixteen-source limit without replacing the store', async () => {
    const sources: JiraSource[] = Array.from({ length: 16 }, (_, index) => ({
      id: `source-${index}`, name: `Source ${index}`, baseUrl: 'https://jira.example.test',
      kind: 'datacenter', token: `stored-secret-${index}`,
    }));
    await writeSources(dataDir, sources);
    const response = await request('/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'Overflow', url: 'https://overflow.example.test', type: 'datacenter', token: 'overflow-secret' }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('overflow-secret');
    expect(await readSources(dataDir)).toEqual(sources);
  });

  test('serializes overlapping source mutations across frames', async () => {
    const input = { name: 'Concurrent', url: 'https://concurrent.example.test', type: 'datacenter' };
    const [first, second] = await Promise.all([
      request('/api/sources', { method: 'POST', body: JSON.stringify({ ...input, token: 'first-secret' }) }),
      request('/api/sources', { method: 'POST', body: JSON.stringify({ ...input, token: 'second-secret' }) }),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const ids = [(await first.json()).source.id, (await second.json()).source.id].sort();
    expect(ids).toEqual(['concurrent', 'concurrent-2']);
    expect((await readSources(dataDir)).filter((source) => source.name === 'Concurrent')).toHaveLength(2);
  });

  test('persists sources across server instances without exposing tokens', async () => {
    await request('/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'Persistent', url: 'https://persistent.example.test', type: 'datacenter', token: 'persistent-secret' }),
    });
    const restarted = createJiraBoardServer({ token: 't', dataDir, fetchImpl: fakeJira });
    try {
      await new Promise<void>((resolve) => restarted.listen(0, '127.0.0.1', resolve));
      const port = (restarted.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { authorization: 'Bearer t' } });
      const raw = await response.text();
      expect(response.status).toBe(200);
      expect(raw).not.toContain('persistent-secret');
      expect(JSON.parse(raw).sources.some((source: { id: string }) => source.id === 'persistent')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => restarted.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('reports corrupt source storage through bootstrap and does not overwrite it', async () => {
    const corruptDir = await mkdtemp(join(tmpdir(), 'jira-board-corrupt-test-'));
    const corruptServer = createJiraBoardServer({ token: 't', dataDir: corruptDir, fetchImpl: fakeJira });
    try {
      await writeFile(join(corruptDir, 'sources.json'), '{not-json', { mode: 0o600 });
      await new Promise<void>((resolve) => corruptServer.listen(0, '127.0.0.1', resolve));
      const localOrigin = `http://127.0.0.1:${(corruptServer.address() as AddressInfo).port}`;
      const response = await fetch(`${localOrigin}/api/bootstrap`, { headers: { authorization: 'Bearer t' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sources: [], configError: 'Jira source storage must contain valid JSON.' });

      const created = await fetch(`${localOrigin}/api/sources`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'No Overwrite', url: 'https://safe.example.test', type: 'datacenter', token: 'safe-secret' }),
      });
      expect(created.status).toBe(400);
      expect(await readFile(join(corruptDir, 'sources.json'), 'utf8')).toBe('{not-json');
    } finally {
      await new Promise<void>((resolve, reject) => corruptServer.close((error) => error ? reject(error) : resolve()));
      await rm(corruptDir, { recursive: true, force: true });
    }
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
        token: 't', dataDir, fetchImpl: delayedJira, transitionTimeoutMs: 20,
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
        token: 't', dataDir, fetchImpl: delayedJira, transitionTimeoutMs: 20,
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
