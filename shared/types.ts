export type JiraSourceKind = 'cloud' | 'datacenter';

export type JiraSource = {
  id: string;
  name: string;
  baseUrl: string;
  kind: JiraSourceKind;
  email?: string;
  token: string;
  defaultProjectKey?: string;
  defaultBoardId?: number;
};

export type PublicJiraSource = Omit<JiraSource, 'token' | 'email'>;

export type JiraProject = {
  id: string;
  key: string;
  name: string;
};

export type JiraBoard = {
  id: number;
  name: string;
  type: string;
  projectKey?: string;
  projectName?: string;
};

export type JiraStatus = {
  id: string;
  name: string;
};

export type JiraColumn = {
  id: string;
  name: string;
  statuses: JiraStatus[];
  canDrop: boolean;
};

export type JiraAssignee = {
  displayName: string;
  accountId?: string;
  key?: string;
  name?: string;
};

export type JiraIssue = {
  id: string;
  key: string;
  summary: string;
  url: string;
  columnId: string;
  status: JiraStatus;
  assignee: JiraAssignee | null;
  priority: string | null;
  issueType: string | null;
  updated: string | null;
};

export type JiraCurrentUser = {
  displayName: string;
  accountId?: string;
  key?: string;
  name?: string;
};

export type BoardData = {
  board: JiraBoard;
  columns: JiraColumn[];
  issues: JiraIssue[];
  currentUser: JiraCurrentUser | null;
  truncated: boolean;
};

export type IssueFilter = 'all' | 'mine' | 'unassigned';

export type BoardPreferences = {
  sourceId: string | null;
  projectKey: string | null;
  boardId: number | null;
  filter: IssueFilter;
};

export type BootstrapData = {
  sources: PublicJiraSource[];
  preferences: BoardPreferences;
  configError: string | null;
};
