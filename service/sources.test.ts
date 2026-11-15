import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JiraSource } from '../shared/types.ts';
import { ConfigurationError } from './config.ts';
import { readSources, writeSources } from './sources.ts';

const source: JiraSource = {
  id: 'cloud', name: 'Cloud', baseUrl: 'https://cloud.example.test', kind: 'cloud',
  email: 'me@example.com', token: 'cloud-secret', defaultProjectKey: 'PROJ', defaultBoardId: 7,
};

describe('Jira source storage', () => {
  test('persists complete sources outside the package with private file permissions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jira-sources-test-'));
    try {
      expect(await readSources(dataDir)).toEqual([]);
      await writeSources(dataDir, [source]);
      expect(await readSources(dataDir)).toEqual([source]);
      expect((await stat(join(dataDir, 'sources.json'))).mode & 0o777).toBe(0o600);
      expect(await readdir(dataDir)).toEqual(['sources.json']);

      await writeSources(dataDir, [{ ...source, name: 'Renamed' }]);
      expect((await readSources(dataDir))[0]?.name).toBe('Renamed');
      expect((await stat(join(dataDir, 'sources.json'))).mode & 0o777).toBe(0o600);
      expect(await readdir(dataDir)).toEqual(['sources.json']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('readers see complete old or new documents during atomic replacement', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jira-sources-test-'));
    let writing = true;
    try {
      await writeSources(dataDir, [source]);
      const reader = (async () => {
        while (writing) {
          const sources = await readSources(dataDir);
          expect(sources).toHaveLength(1);
          expect(['Cloud', 'Renamed']).toContain(sources[0]!.name);
        }
      })();
      for (let index = 0; index < 12; index += 1) {
        await writeSources(dataDir, [{ ...source, name: index % 2 ? 'Cloud' : 'Renamed' }]);
      }
      writing = false;
      await reader;
    } finally {
      writing = false;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('surfaces corrupt storage without erasing or replacing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jira-sources-test-'));
    const path = join(dataDir, 'sources.json');
    try {
      await writeFile(path, '{not-json', { mode: 0o600 });
      await expect(readSources(dataDir)).rejects.toThrow(ConfigurationError);
      expect(await readFile(path, 'utf8')).toBe('{not-json');

      await writeFile(path, JSON.stringify([{ ...source, token: '' }]), { mode: 0o600 });
      await expect(readSources(dataDir)).rejects.toThrow('“token” is required');
      expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
