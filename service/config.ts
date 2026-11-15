import type { JiraSource, JiraSourceKind, PublicJiraSource } from '../shared/types.ts';

const MAX_SOURCES = 16;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredText(value: unknown, field: string, index: number): string {
  const result = text(value);
  if (!result) throw new ConfigurationError(`Source ${index + 1}: “${field}” is required.`);
  return result;
}

function normalizeBaseUrl(value: string, index: number): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`Source ${index + 1}: “url” must be an absolute Jira address.`);
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ConfigurationError(`Source ${index + 1}: use HTTPS (HTTP is allowed only for a local Jira server).`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(`Source ${index + 1}: the URL cannot contain credentials, a query, or a fragment.`);
  }
  return value.replace(/\/+$/, '');
}

function optionalBoardId(value: unknown, index: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ConfigurationError(`Source ${index + 1}: “boardId” must be a positive integer.`);
  }
  return id;
}

export function parseSources(settings: Record<string, string>): JiraSource[] {
  const raw = settings.sources?.trim();
  if (!raw) return [];

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new ConfigurationError('Sources must be a valid JSON array.');
  }
  if (!Array.isArray(document)) throw new ConfigurationError('Sources must be a JSON array.');
  if (document.length > MAX_SOURCES) {
    throw new ConfigurationError(`No more than ${MAX_SOURCES} Jira sources are supported.`);
  }

  const ids = new Set<string>();
  return document.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigurationError(`Source ${index + 1}: expected an object.`);
    }
    const value = entry as Record<string, unknown>;
    const id = requiredText(value.id, 'id', index);
    if (!ID_PATTERN.test(id)) {
      throw new ConfigurationError(`Source ${index + 1}: “id” must be kebab-case (for example, “work-cloud”).`);
    }
    if (ids.has(id)) throw new ConfigurationError(`Duplicate source id “${id}”.`);
    ids.add(id);

    const kind = requiredText(value.type, 'type', index) as JiraSourceKind;
    if (kind !== 'cloud' && kind !== 'datacenter') {
      throw new ConfigurationError(`Source ${index + 1}: “type” must be “cloud” or “datacenter”.`);
    }
    const email = text(value.email);
    if (kind === 'cloud' && !email) {
      throw new ConfigurationError(`Source ${index + 1}: Jira Cloud requires “email”.`);
    }

    const projectKey = text(value.projectKey);
    const source: JiraSource = {
      id,
      name: requiredText(value.name, 'name', index),
      baseUrl: normalizeBaseUrl(requiredText(value.url, 'url', index), index),
      kind,
      token: requiredText(value.token, 'token', index),
      ...(email ? { email } : {}),
      ...(projectKey ? { defaultProjectKey: projectKey } : {}),
      ...(optionalBoardId(value.boardId, index) !== undefined
        ? { defaultBoardId: optionalBoardId(value.boardId, index) }
        : {}),
    };
    return source;
  });
}

export function toPublicSource(source: JiraSource): PublicJiraSource {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    kind: source.kind,
    ...(source.defaultProjectKey ? { defaultProjectKey: source.defaultProjectKey } : {}),
    ...(source.defaultBoardId !== undefined ? { defaultBoardId: source.defaultBoardId } : {}),
  };
}

export function findSource(settings: Record<string, string>, id: string): JiraSource {
  const source = parseSources(settings).find((candidate) => candidate.id === id);
  if (!source) throw new ConfigurationError(`Jira source “${id}” was not found.`);
  return source;
}
