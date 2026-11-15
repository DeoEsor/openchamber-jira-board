import { describe, expect, test } from 'bun:test';
import {
  ConfigurationError,
  generateSourceId,
  parseSourceDocument,
  parseSourceInput,
  toPublicSource,
} from './config.ts';

const cloud = {
  id: 'cloud',
  name: 'Cloud',
  baseUrl: 'https://example.atlassian.net',
  kind: 'cloud',
  email: 'me@example.com',
  token: 'cloud-secret',
  defaultProjectKey: 'PROJ',
  defaultBoardId: 7,
} as const;

describe('source configuration', () => {
  test('parses stored Cloud and Data Center sources and exposes only public metadata', () => {
    const sources = parseSourceDocument([
      cloud,
      {
        id: 'dc', name: 'DC', baseUrl: 'https://jira.internal.example', kind: 'datacenter',
        email: 'not-needed@example.com', token: 'dc-secret',
      },
    ]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ defaultProjectKey: 'PROJ', defaultBoardId: 7 });
    expect(sources[1]).toMatchObject({ kind: 'datacenter', token: 'dc-secret' });
    expect(sources[1]).not.toHaveProperty('email');

    const publicSource = toPublicSource(sources[0]!);
    expect(publicSource).toMatchObject({ email: 'me@example.com' });
    expect(publicSource).not.toHaveProperty('token');
    expect(JSON.stringify(publicSource)).not.toContain('cloud-secret');
  });

  test('accepts local HTTP and normalizes source input', () => {
    const source = parseSourceInput({
      name: ' Local ', url: 'http://127.0.0.1:8080/', type: 'datacenter', token: ' t ',
      projectKey: ' DEV ', boardId: '9',
    });
    expect(source).toEqual({
      name: 'Local', baseUrl: 'http://127.0.0.1:8080', kind: 'datacenter', token: 't',
      defaultProjectKey: 'DEV', defaultBoardId: 9,
    });
  });

  test('requires a token for new sources and preserves it on blank or omitted edits', () => {
    expect(() => parseSourceInput({
      name: 'Cloud', url: 'https://example.atlassian.net', type: 'cloud', email: 'me@example.com', token: ' ',
    })).toThrow('“token” is required');

    const existing = parseSourceDocument([cloud])[0]!;
    const input = {
      name: 'Renamed', url: 'https://example.atlassian.net', type: 'cloud', email: 'me@example.com',
    };
    expect(parseSourceInput({ ...input, token: '' }, existing).token).toBe('cloud-secret');
    expect(parseSourceInput(input, existing).token).toBe('cloud-secret');
  });

  test('retains tokens only for the same normalized origin and authentication kind', () => {
    const existing = parseSourceDocument([cloud])[0]!;
    const input = {
      name: 'Renamed', type: 'cloud', email: 'me@example.com', token: '',
    };
    expect(parseSourceInput({
      ...input, url: 'https://EXAMPLE.atlassian.net:443/a/different/base/',
    }, existing)).toMatchObject({ token: 'cloud-secret', baseUrl: 'https://EXAMPLE.atlassian.net:443/a/different/base' });

    expect(() => parseSourceInput({
      ...input, url: 'https://other.atlassian.net',
    }, existing)).toThrow('“token” must be non-empty when changing the Jira origin or type');
    expect(() => parseSourceInput({
      name: 'Renamed', url: 'https://example.atlassian.net', type: 'datacenter', token: '',
    }, existing)).toThrow('“token” must be non-empty when changing the Jira origin or type');
    expect(parseSourceInput({
      ...input, url: 'https://other.atlassian.net', token: 'new-secret',
    }, existing).token).toBe('new-secret');
  });

  test('rejects malformed documents, duplicate ids, insecure URLs, and missing Cloud email', () => {
    expect(() => parseSourceDocument('{')).toThrow(ConfigurationError);
    expect(() => parseSourceDocument([
      cloud,
      { ...cloud, baseUrl: 'https://two.example' },
    ])).toThrow('Duplicate source id');
    expect(() => parseSourceInput({
      name: 'Remote', url: 'http://jira.example', type: 'datacenter', token: 'a',
    })).toThrow('use HTTPS');
    expect(() => parseSourceInput({
      name: 'Cloud', url: 'https://cloud.example', type: 'cloud', token: 'a',
    })).toThrow('requires “email”');
    expect(() => parseSourceInput({
      name: 'Query', url: 'https://cloud.example?token=a', type: 'datacenter', token: 'a',
    })).toThrow('cannot contain credentials, a query, or a fragment');
  });

  test('enforces the source count and reasonable field limits', () => {
    const sources = Array.from({ length: 17 }, (_, index) => ({
      id: `source-${index}`, name: `Source ${index}`, baseUrl: 'https://jira.example', kind: 'datacenter', token: 't',
    }));
    expect(() => parseSourceDocument(sources)).toThrow('No more than 16');
    expect(() => parseSourceInput({
      name: 'x'.repeat(121), url: 'https://jira.example', type: 'datacenter', token: 't',
    })).toThrow('at most 120');
  });
});

describe('generateSourceId', () => {
  test('creates stable kebab-case ids with numeric suffixes for collisions', () => {
    expect(generateSourceId('  My Team’s Jira  ', [])).toBe('my-team-s-jira');
    expect(generateSourceId('My Team', ['my-team'])).toBe('my-team-2');
    expect(generateSourceId('My Team', ['my-team', 'my-team-2'])).toBe('my-team-3');
    expect(generateSourceId('123', [])).toBe('source-123');
    expect(generateSourceId('***', [])).toBe('source');
    expect(generateSourceId('x'.repeat(120), [])).toHaveLength(64);
  });
});
