import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BoardPreferences, IssueFilter } from '../shared/types.ts';

export const DEFAULT_PREFERENCES: BoardPreferences = {
  sourceId: null,
  projectKey: null,
  boardId: null,
  filter: 'all',
};

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
}

function sanitize(value: unknown): BoardPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PREFERENCES };
  const input = value as Record<string, unknown>;
  const boardId = Number(input.boardId);
  const filter: IssueFilter = input.filter === 'mine' || input.filter === 'unassigned' ? input.filter : 'all';
  return {
    sourceId: nullableText(input.sourceId),
    projectKey: nullableText(input.projectKey),
    boardId: Number.isSafeInteger(boardId) && boardId > 0 ? boardId : null,
    filter,
  };
}

export async function readPreferences(dataDir: string): Promise<BoardPreferences> {
  try {
    return sanitize(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function writePreferences(dataDir: string, value: unknown): Promise<BoardPreferences> {
  const preferences = sanitize(value);
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, 'preferences.json');
  const temporary = join(dataDir, `preferences-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return preferences;
}
