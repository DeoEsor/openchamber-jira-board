import type { JiraSource, JiraSourceKind, PublicJiraSource } from '../shared/types.ts';

export const MAX_SOURCES = 16;

const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const MAX_EMAIL_LENGTH = 320;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_PROJECT_KEY_LENGTH = 128;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

type SourceDetails = Omit<JiraSource, 'id'>;

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

function fail(message: string, label = ''): never {
  throw new ConfigurationError(`${label}${message}`);
}

function requiredText(value: unknown, field: string, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) fail(`“${field}” is required.`, label);
  const result = value.trim();
  if (result.length > maxLength) fail(`“${field}” must be at most ${maxLength} characters.`, label);
  return result;
}

function optionalText(value: unknown, field: string, label: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`“${field}” must be a string.`, label);
  const result = value.trim();
  if (result.length > maxLength) fail(`“${field}” must be at most ${maxLength} characters.`, label);
  return result;
}

function normalizeBaseUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('“url” must be an absolute Jira address.', label);
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    fail('use HTTPS (HTTP is allowed only for a local Jira server).', label);
  }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value)) {
    fail('the URL cannot contain credentials, a query, or a fragment.', label);
  }
  return value.replace(/\/+$/, '');
}

function optionalBoardId(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') {
    fail('“boardId” must be a positive integer.', label);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail('“boardId” must be a positive integer.', label);
  return id;
}

function normalizeSource(value: unknown, existing: JiraSource | undefined, label: string): SourceDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object.', label);
  const input = value as Record<string, unknown>;
  const name = requiredText(input.name, 'name', label, MAX_NAME_LENGTH);
  const url = requiredText(input.url, 'url', label, MAX_URL_LENGTH);
  const kind = requiredText(input.type, 'type', label, 32) as JiraSourceKind;
  if (kind !== 'cloud' && kind !== 'datacenter') fail('“type” must be “cloud” or “datacenter”.', label);

  const email = optionalText(input.email, 'email', label, MAX_EMAIL_LENGTH);
  if (kind === 'cloud' && !email) fail('Jira Cloud requires “email”.', label);
  const baseUrl = normalizeBaseUrl(url, label);
  const suppliedToken = optionalText(input.token, 'token', label, MAX_TOKEN_LENGTH);
  const canRetainToken = existing !== undefined
    && existing.kind === kind
    && new URL(existing.baseUrl).origin === new URL(baseUrl).origin;
  const token = suppliedToken || (canRetainToken ? existing?.token : '') || '';
  if (!token) {
    if (existing) fail('“token” must be non-empty when changing the Jira origin or type.', label);
    fail('“token” is required for a new source.', label);
  }
  if (token.length > MAX_TOKEN_LENGTH) fail(`“token” must be at most ${MAX_TOKEN_LENGTH} characters.`, label);

  const projectKey = optionalText(input.projectKey, 'projectKey', label, MAX_PROJECT_KEY_LENGTH);
  const boardId = optionalBoardId(input.boardId, label);
  return {
    name,
    baseUrl,
    kind,
    token,
    ...(kind === 'cloud' && email ? { email } : {}),
    ...(projectKey ? { defaultProjectKey: projectKey } : {}),
    ...(boardId !== undefined ? { defaultBoardId: boardId } : {}),
  };
}

export function parseSourceInput(value: unknown, existing?: JiraSource): SourceDetails {
  return normalizeSource(value, existing, '');
}

export function parseSourceDocument(document: unknown): JiraSource[] {
  if (!Array.isArray(document)) throw new ConfigurationError('Sources must be a JSON array.');
  if (document.length > MAX_SOURCES) {
    throw new ConfigurationError(`No more than ${MAX_SOURCES} Jira sources are supported.`);
  }

  const ids = new Set<string>();
  return document.map((entry, index) => {
    const label = `Source ${index + 1}: `;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('expected an object.', label);
    const value = entry as Record<string, unknown>;
    const id = requiredText(value.id, 'id', label, 64);
    if (!ID_PATTERN.test(id)) fail('“id” must be kebab-case (for example, “work-cloud”).', label);
    if (ids.has(id)) throw new ConfigurationError(`Duplicate source id “${id}”.`);
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
        boardId: value.defaultBoardId,
      }, undefined, label),
    };
  });
}

export function generateSourceId(name: string, existingIds: Iterable<string>): string {
  const ids = new Set(existingIds);
  let base = name.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (!base) base = 'source';
  if (!/^[a-z]/.test(base)) base = `source-${base}`.slice(0, 64).replace(/-+$/g, '');

  let id = base;
  for (let suffix = 2; ids.has(id); suffix += 1) {
    const ending = `-${suffix}`;
    id = `${base.slice(0, 64 - ending.length).replace(/-+$/g, '')}${ending}`;
  }
  return id;
}

export function toPublicSource(source: JiraSource): PublicJiraSource {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    kind: source.kind,
    ...(source.email ? { email: source.email } : {}),
    ...(source.defaultProjectKey ? { defaultProjectKey: source.defaultProjectKey } : {}),
    ...(source.defaultBoardId !== undefined ? { defaultBoardId: source.defaultBoardId } : {}),
  };
}
