import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  ConfigurationError,
  MAX_SOURCES,
  generateSourceId,
  parseSourceInput,
  toPublicSource,
} from './config.ts';
import { findSource, readSources, writeSources } from './sources.ts';
import { JiraClient, JiraError, raceWithSignal, type JiraFetch } from './jira.ts';
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from './preferences.ts';
import { SerialQueue } from '../shared/serial-queue.ts';

const BODY_LIMIT = 32_768;
const TRANSITION_TIMEOUT_MS = 12_000;

type AppOptions = {
  token: string;
  dataDir: string;
  fetchImpl?: JiraFetch;
  transitionTimeoutMs?: number;
  writePreferencesImpl?: typeof writePreferences;
};

function authorized(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  response.end(json);
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new JiraError('Request body is too large.', 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new JiraError('Request body must be valid JSON.', 400);
  }
}

function pathParts(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function positiveInteger(value: string | undefined, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new JiraError(`${label} must be a positive integer.`, 400);
  return result;
}

export function createJiraBoardServer(options: AppOptions): Server {
  const mutations = new SerialQueue();
  const persistPreferences = options.writePreferencesImpl ?? writePreferences;
  const client = async (sourceId: string, signal?: AbortSignal): Promise<JiraClient> => {
    const pending = findSource(options.dataDir, sourceId);
    const source = signal ? await raceWithSignal(pending, signal) : await pending;
    return new JiraClient(source, options.fetchImpl);
  };

  return createServer(async (request, response) => {
    try {
      if (!authorized(request, options.token)) {
        send(response, 401, { error: 'Unauthorized' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/bootstrap') {
        const preferences = await readPreferences(options.dataDir);
        try {
          const sources = await readSources(options.dataDir);
          send(response, 200, { sources: sources.map(toPublicSource), preferences, configError: null });
        } catch (error) {
          if (!(error instanceof ConfigurationError)) throw error;
          send(response, 200, { sources: [], preferences, configError: error.message });
        }
        return;
      }
      if (method === 'PUT' && url.pathname === '/api/preferences') {
        const input = await body(request);
        const preferences = await mutations.run(() => persistPreferences(options.dataDir, input));
        send(response, 200, { preferences });
        return;
      }

      const parts = pathParts(url.pathname);
      if (parts[0] !== 'api' || parts[1] !== 'sources') {
        send(response, 404, { error: 'Not found' });
        return;
      }

      if (method === 'POST' && parts.length === 2) {
        const input = objectBody(await body(request));
        const source = await mutations.run(async () => {
          const sources = await readSources(options.dataDir);
          if (sources.length >= MAX_SOURCES) {
            throw new ConfigurationError(`No more than ${MAX_SOURCES} Jira sources are supported.`);
          }
          const details = parseSourceInput(input);
          const created = {
            id: generateSourceId(details.name, sources.map((candidate) => candidate.id)),
            ...details,
          };
          await writeSources(options.dataDir, [...sources, created]);
          return created;
        });
        send(response, 201, { source: toPublicSource(source) });
        return;
      }

      if (!parts[2]) {
        send(response, 404, { error: 'Not found' });
        return;
      }
      const sourceId = parts[2];

      if (method === 'PUT' && parts.length === 3) {
        const input = objectBody(await body(request));
        const source = await mutations.run(async () => {
          const sources = await readSources(options.dataDir);
          const index = sources.findIndex((candidate) => candidate.id === sourceId);
          const existing = sources[index];
          if (index < 0 || !existing) throw new ConfigurationError(`Jira source “${sourceId}” was not found.`);
          const updated = { id: existing.id, ...parseSourceInput(input, existing) };
          const next = [...sources];
          next[index] = updated;
          await writeSources(options.dataDir, next);
          return updated;
        });
        send(response, 200, { source: toPublicSource(source) });
        return;
      }

      if (method === 'DELETE' && parts.length === 3) {
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
          } catch {
            // The source deletion is already committed; preference cleanup is best effort.
          }
          return current;
        });
        send(response, 200, { ok: true, preferences });
        return;
      }

      if (method === 'GET' && parts.length === 4 && parts[3] === 'projects') {
        send(response, 200, { projects: await (await client(sourceId)).projects() });
        return;
      }
      if (method === 'GET' && parts.length === 4 && parts[3] === 'boards') {
        send(response, 200, { boards: await (await client(sourceId)).boards(url.searchParams.get('projectKey')) });
        return;
      }
      if (method === 'GET' && parts.length === 5 && parts[3] === 'boards') {
        const boardId = positiveInteger(parts[4], 'Board id');
        send(response, 200, await (await client(sourceId)).board(boardId));
        return;
      }
      if (method === 'POST' && parts.length === 6 && parts[3] === 'issues' && parts[5] === 'transitions') {
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), options.transitionTimeoutMs ?? TRANSITION_TIMEOUT_MS);
        try {
          const input = objectBody(await body(request));
          const boardId = positiveInteger(String(input.boardId ?? ''), 'Board id');
          const statusId = typeof input.statusId === 'string' ? input.statusId.trim() : '';
          if (!statusId) throw new JiraError('Target statusId is required.', 400);
          await (await client(sourceId, deadline.signal)).moveIssue(boardId, parts[4] ?? '', statusId, deadline.signal);
          send(response, 200, { ok: true });
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof ConfigurationError ? 400
        : error instanceof JiraError ? error.status
          : 500;
      const message = error instanceof Error ? error.message : 'Unexpected service error.';
      send(response, status, {
        error: message,
        ...(error instanceof JiraError && error.outcomeUnknown ? { outcome: 'unknown' } : {}),
      });
    }
  });
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JiraError('Expected a JSON object.', 400);
  return value as Record<string, unknown>;
}
