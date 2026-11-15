import { describe, expect, test } from 'bun:test';
import { ConfigurationError, parseSources, toPublicSource } from './config.ts';

describe('parseSources', () => {
  test('parses Cloud and Data Center sources without exposing credentials', () => {
    const sources = parseSources({ sources: JSON.stringify([
      { id: 'cloud', name: 'Cloud', url: 'https://example.atlassian.net/', type: 'cloud', email: 'me@example.com', token: 'cloud-secret', projectKey: 'PROJ', boardId: 7 },
      { id: 'dc', name: 'DC', url: 'https://jira.internal.example', type: 'datacenter', token: 'dc-secret' },
    ]) });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ baseUrl: 'https://example.atlassian.net', defaultProjectKey: 'PROJ', defaultBoardId: 7 });
    expect(sources[1]).toMatchObject({ kind: 'datacenter', token: 'dc-secret' });
    const publicSource = toPublicSource(sources[0]!);
    expect(publicSource).not.toHaveProperty('token');
    expect(publicSource).not.toHaveProperty('email');
    expect(JSON.stringify(publicSource)).not.toContain('cloud-secret');
  });

  test('accepts an empty setting and local HTTP for development', () => {
    expect(parseSources({})).toEqual([]);
    expect(parseSources({ sources: JSON.stringify([
      { id: 'local', name: 'Local', url: 'http://127.0.0.1:8080', type: 'datacenter', token: 't' },
    ]) })).toHaveLength(1);
  });

  test('rejects invalid JSON, duplicate ids, insecure remote HTTP, and missing Cloud email', () => {
    expect(() => parseSources({ sources: '{' })).toThrow(ConfigurationError);
    expect(() => parseSources({ sources: JSON.stringify([
      { id: 'same', name: 'One', url: 'https://one.example', type: 'datacenter', token: 'a' },
      { id: 'same', name: 'Two', url: 'https://two.example', type: 'datacenter', token: 'b' },
    ]) })).toThrow('Duplicate source id');
    expect(() => parseSources({ sources: JSON.stringify([
      { id: 'remote', name: 'Remote', url: 'http://jira.example', type: 'datacenter', token: 'a' },
    ]) })).toThrow('use HTTPS');
    expect(() => parseSources({ sources: JSON.stringify([
      { id: 'cloud', name: 'Cloud', url: 'https://cloud.example', type: 'cloud', token: 'a' },
    ]) })).toThrow('requires “email”');
  });
});
