# Jira Board for OpenChamber

A spacious Kanban panel for Jira Cloud and Jira Data Center. It supports multiple Jira sources, project and board selection, client-side search and assignee filters, and drag-and-drop status changes.

## Install and build

Requires OpenChamber **2.7.2 or newer** and Bun.

```bash
bun install
bun run build
bun run check
```

Install the folder from **Settings → Extensions**, approve the integration and local service, then open **Jira Board** from the extension rail. The **+** menu can also open it in a larger dialog, which is more comfortable for wide boards.

## Configure sources

Open **Settings → Integrations → Jira Board** and paste a JSON array into **Sources (JSON array)**.

> OpenChamber's integration manifest requires a generic **Access token** field. The board does not use that field; leave it empty. Credentials are read only from the protected `sources` setting by the local service.

Example with both supported Jira kinds:

```json
[
  {
    "id": "work-cloud",
    "name": "Work Cloud",
    "url": "https://your-company.atlassian.net",
    "type": "cloud",
    "email": "you@example.com",
    "token": "YOUR_JIRA_CLOUD_API_TOKEN",
    "projectKey": "PRODUCT",
    "boardId": 42
  },
  {
    "id": "internal-dc",
    "name": "Internal Data Center",
    "url": "https://jira.internal.example.com",
    "type": "datacenter",
    "token": "YOUR_JIRA_DC_PERSONAL_ACCESS_TOKEN",
    "projectKey": "PLATFORM",
    "boardId": 17
  }
]
```

Fields:

- `id` — unique kebab-case identifier, used by the panel.
- `name` — display name in the source selector.
- `url` — Jira base URL. HTTPS is required except for Jira on localhost. A Data Center context path such as `https://example.com/jira` is supported.
- `type` — `cloud` or `datacenter`.
- `email` — required for Cloud; used with the API token for Basic authentication.
- `token` — Jira Cloud API token, or a Data Center personal access token sent as a Bearer token.
- `projectKey` — optional default project. The panel also offers **All projects**.
- `boardId` — optional default Jira Software board. The selectors allow changing both without editing JSON again.

Up to 16 sources are supported. Save the settings, return to the panel, and choose **Check again** or **Refresh**.

Cloud API tokens are created in the Atlassian account's **Security → API tokens** page. Data Center personal access tokens are created in the Jira profile's **Personal Access Tokens** page. The account needs permission to view projects and boards and to execute the relevant workflow transitions.

## Use the board

- **Source / Project / Board** selectors switch the visible Jira board. The selection and active assignee filter are restored on the next launch.
- **Search** filters the loaded cards by issue key, summary, issue type, or assignee.
- **All issues / My issues / Unassigned** filter cards without changing Jira.
- Click an issue summary to open it in Jira.
- Drag a card to another column. When one Jira column contains several statuses, drop onto the specific status chip.
- **Refresh** rediscovers configured sources, projects, and boards, then reloads the current board while preserving selections that still exist.

Status changes use Jira's real workflow. If there is no direct transition, or a transition requires additional fields, only the failed card returns to its old column and the panel shows Jira's error. A transition has one overall 12-second deadline, including settings and workflow lookup. If the connection drops or the deadline expires, the outcome is treated as unknown: the panel waits for the original operation window, reloads Jira, and keeps that card locked until its actual status is confirmed. Refreshes started before that window cannot unlock it early. Issues in **Other statuses** are visible but that synthetic column is not a drop target.

## Development

```bash
bun run typecheck
bun test
bun run build
bun run check
```

The tests run the authenticated loopback service against a fake Jira API and verify Cloud Basic auth, Data Center Bearer auth, board mapping, transition deadlines, overlapping preference writes, and credential redaction. Pure panel-state tests cover concurrent optimistic moves, exact rollback versions, delayed reconciliation, stable assignee identity, and source selection.

For the required local smoke check:

```bash
OPENCHAMBER_SERVICE_PORT=4599 \
OPENCHAMBER_SERVICE_TOKEN=t \
OPENCHAMBER_SERVICE_DATA_DIR="$HOME/.local/share/openchamber-jira-board-dev" \
node service/main.js
```

Then call `/health` with `Authorization: Bearer t`. Other routes require the real OpenChamber callback environment because settings are read through `createServiceHost(...).readSettings()`.

## Security and limits

- Source credentials never appear in the panel, `ready.settings`, bootstrap responses, or preference files.
- The panel reaches only its extension service through OpenChamber. Jira requests are made by that service.
- The service listens only on `127.0.0.1` and requires its bearer token on every route, including `/health`.
- Preferences are stored atomically in `OPENCHAMBER_SERVICE_DATA_DIR`, outside the package. Writes are serialized by the shared service across all open panel and dialog frames.
- The board loads at most 200 issues and 500 boards per request sequence to stay below host response limits.
- The extension uses Jira Software's Agile API; Jira Core-only installations do not provide boards.
- The panel is desktop/web only because OpenChamber does not run extension services on mobile or in VS Code.
