import { describe, expect, test } from 'bun:test';
import type { BoardData, BoardPreferences, JiraIssue, PublicJiraSource } from './types.ts';
import {
  applyOptimisticMove,
  clearReconciledOperations,
  isCurrentUserAssignee,
  resolveBoardSelection,
  rollbackOptimisticMove,
} from './board-state.ts';

const todo = { id: '11', name: 'To Do' };
const progress = { id: '31', name: 'In Progress' };
const done = { id: '41', name: 'Done' };

function issue(key: string): JiraIssue {
  return {
    id: key, key, summary: key, url: `https://example.test/browse/${key}`,
    columnId: 'todo', status: todo, assignee: null, priority: null, issueType: 'Task', updated: null,
  };
}

function board(): BoardData {
  return {
    board: { id: 7, name: 'Product', type: 'kanban' },
    columns: [
      { id: 'todo', name: 'To Do', statuses: [todo], canDrop: true },
      { id: 'progress', name: 'In Progress', statuses: [progress], canDrop: true },
      { id: 'done', name: 'Done', statuses: [done], canDrop: true },
    ],
    issues: [issue('PROJ-1'), issue('PROJ-2')],
    currentUser: null,
    truncated: false,
  };
}

describe('optimistic board operations', () => {
  test('rolls back one failed move without discarding another pending move', () => {
    const original = board();
    const optimisticA = applyOptimisticMove(original, 'PROJ-1', progress);
    const optimisticBoth = applyOptimisticMove(optimisticA, 'PROJ-2', done);
    const moveA = { issueKey: 'PROJ-1', fromStatus: todo, fromColumnId: 'todo', optimisticIssue: optimisticA.issues[0]! };
    const moveB = { issueKey: 'PROJ-2', fromStatus: todo, fromColumnId: 'todo', optimisticIssue: optimisticBoth.issues[1]! };

    const afterAFailed = rollbackOptimisticMove(optimisticBoth, moveA);
    expect(afterAFailed.issues.find((item) => item.key === 'PROJ-1')).toMatchObject({ columnId: 'todo', status: todo });
    expect(afterAFailed.issues.find((item) => item.key === 'PROJ-2')).toMatchObject({ columnId: 'done', status: done });

    const afterBothFailed = rollbackOptimisticMove(afterAFailed, moveB);
    expect(afterBothFailed.issues).toEqual(original.issues);
  });

  test('does not overwrite a newer server state for the same issue', () => {
    const original = board();
    const optimistic = applyOptimisticMove(original, 'PROJ-1', progress);
    const operation = { issueKey: 'PROJ-1', fromStatus: todo, fromColumnId: 'todo', optimisticIssue: optimistic.issues[0]! };
    const reconciled = applyOptimisticMove(optimistic, 'PROJ-1', done);
    expect(rollbackOptimisticMove(reconciled, operation).issues[0]).toMatchObject({ columnId: 'done', status: done });
  });

  test('does not roll back refreshed server state even when its status equals the optimistic target', () => {
    const original = board();
    const optimistic = applyOptimisticMove(original, 'PROJ-1', progress);
    const operation = { issueKey: 'PROJ-1', fromStatus: todo, fromColumnId: 'todo', optimisticIssue: optimistic.issues[0]! };
    const refreshed = { ...optimistic, issues: optimistic.issues.map((item) => ({ ...item, status: { ...item.status } })) };
    const result = rollbackOptimisticMove(refreshed, operation);
    expect(result.issues[0]).toBe(refreshed.issues[0]);
    expect(result.issues[0]).toMatchObject({ columnId: 'progress', status: progress });
  });
});

describe('uncertain transition reconciliation', () => {
  test('keeps the card locked when an early board load overtakes a delayed POST', () => {
    const uncertain = new Map([['PROJ-1', 13_000]]);
    clearReconciledOperations(uncertain, 1_000);
    expect(uncertain.has('PROJ-1')).toBe(true);
    clearReconciledOperations(uncertain, 3_001);
    expect(uncertain.has('PROJ-1')).toBe(true);
    clearReconciledOperations(uncertain, 13_000);
    expect(uncertain.has('PROJ-1')).toBe(false);
  });
});

describe('source selection', () => {
  const sources: PublicJiraSource[] = [
    { id: 'cloud', name: 'Cloud', kind: 'cloud', baseUrl: 'https://cloud.example.test', defaultProjectKey: 'PROJ', defaultBoardId: 7 },
    { id: 'dc', name: 'DC', kind: 'datacenter', baseUrl: 'https://dc.example.test' },
  ];
  const allProjects: BoardPreferences = { sourceId: 'cloud', projectKey: null, boardId: null, filter: 'mine' };

  test('preserves an explicit All projects choice instead of applying the source default', () => {
    expect(resolveBoardSelection(sources, allProjects)).toEqual(allProjects);
  });

  test('preserves the current valid source and filter during a full refresh', () => {
    const current = { ...allProjects, sourceId: 'dc', filter: 'unassigned' as const };
    expect(resolveBoardSelection(sources, { sourceId: null, projectKey: null, boardId: null, filter: 'all' }, current)).toEqual(current);
  });

  test('falls back to source defaults only when the selected source no longer exists', () => {
    expect(resolveBoardSelection(sources, { ...allProjects, sourceId: 'removed' })).toEqual({
      sourceId: 'cloud', projectKey: 'PROJ', boardId: 7, filter: 'mine',
    });
  });
});

describe('current user identity', () => {
  test('does not match equal display names when account ids differ', () => {
    expect(isCurrentUserAssignee(
      { displayName: 'Mona Lisa', accountId: 'u2' },
      { displayName: 'Mona Lisa', accountId: 'u1' },
    )).toBe(false);
  });

  test('prefers matching account ids and Data Center keys', () => {
    expect(isCurrentUserAssignee(
      { displayName: 'Renamed', accountId: 'u1' },
      { displayName: 'Old name', accountId: 'u1' },
    )).toBe(true);
    expect(isCurrentUserAssignee(
      { displayName: 'Same', key: 'mona' },
      { displayName: 'Same', name: 'mona' },
    )).toBe(true);
    expect(isCurrentUserAssignee(
      { displayName: 'Same', key: 'other' },
      { displayName: 'Same', key: 'mona' },
    )).toBe(false);
  });

  test('uses display name only when no stable identity exists', () => {
    expect(isCurrentUserAssignee({ displayName: 'Mona' }, { displayName: 'Mona' })).toBe(true);
  });
});
