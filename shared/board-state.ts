import type {
  BoardData,
  BoardPreferences,
  JiraAssignee,
  JiraCurrentUser,
  JiraStatus,
  PublicJiraSource,
} from './types.ts';

export type OptimisticMove = {
  issueKey: string;
  fromStatus: JiraStatus;
  fromColumnId: string;
  optimisticIssue: BoardData['issues'][number];
};

export function applyOptimisticMove(board: BoardData, issueKey: string, status: JiraStatus): BoardData {
  const targetColumn = board.columns.find((column) => column.statuses.some((candidate) => candidate.id === status.id));
  if (!targetColumn) return board;
  return {
    ...board,
    issues: board.issues.map((issue) => issue.key === issueKey
      ? { ...issue, status: { ...status }, columnId: targetColumn.id }
      : issue),
  };
}

export function rollbackOptimisticMove(board: BoardData, move: OptimisticMove): BoardData {
  return {
    ...board,
    issues: board.issues.map((issue) => issue === move.optimisticIssue
      ? { ...issue, status: { ...move.fromStatus }, columnId: move.fromColumnId }
      : issue),
  };
}

export function clearReconciledOperations(uncertain: Map<string, number>, loadStartedAt: number): void {
  for (const [issueKey, notBefore] of uncertain) {
    if (loadStartedAt >= notBefore) uncertain.delete(issueKey);
  }
}

export function resolveBoardSelection(
  sources: PublicJiraSource[],
  persisted: BoardPreferences,
  preserved?: BoardPreferences,
): BoardPreferences {
  const candidate = preserved ?? persisted;
  const selected = sources.find((source) => source.id === candidate.sourceId);
  if (selected) return { ...candidate, sourceId: selected.id };
  const fallback = sources[0];
  return {
    sourceId: fallback?.id ?? null,
    projectKey: fallback?.defaultProjectKey ?? null,
    boardId: fallback?.defaultBoardId ?? null,
    filter: candidate.filter,
  };
}

function stableKeys(user: JiraCurrentUser | JiraAssignee): string[] {
  return [user.key, user.name].filter((value): value is string => Boolean(value));
}

export function isCurrentUserAssignee(assignee: JiraAssignee, user: JiraCurrentUser): boolean {
  if (user.accountId || assignee.accountId) {
    return Boolean(user.accountId && assignee.accountId && user.accountId === assignee.accountId);
  }
  const userKeys = stableKeys(user);
  const assigneeKeys = stableKeys(assignee);
  if (userKeys.length || assigneeKeys.length) {
    return userKeys.some((key) => assigneeKeys.includes(key));
  }
  return user.displayName === assignee.displayName;
}
