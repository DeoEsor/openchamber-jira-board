import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JiraSource } from '../shared/types.ts';
import { ConfigurationError, parseSourceDocument } from './config.ts';

const SOURCES_FILE = 'sources.json';

function sourcesPath(dataDir: string): string {
  return join(dataDir, SOURCES_FILE);
}

export async function readSources(dataDir: string): Promise<JiraSource[]> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigurationError('Jira source storage could not be read.');
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new ConfigurationError('Jira source storage must contain valid JSON.');
  }
  return parseSourceDocument(document);
}

export async function writeSources(dataDir: string, sources: readonly JiraSource[]): Promise<JiraSource[]> {
  const validated = parseSourceDocument(sources);
  await mkdir(dataDir, { recursive: true });
  const target = sourcesPath(dataDir);
  const temporary = join(dataDir, `sources-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return validated;
}

export async function findSource(dataDir: string, id: string): Promise<JiraSource> {
  const source = (await readSources(dataDir)).find((candidate) => candidate.id === id);
  if (!source) throw new ConfigurationError(`Jira source “${id}” was not found.`);
  return source;
}
