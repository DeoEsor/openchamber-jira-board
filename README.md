<div align="center">
  <img src="docs/assets/icon.png" alt="Jira Board icon" width="128" height="128">

  <h1>Jira Board for OpenChamber</h1>

  <p><strong>A spacious Kanban board for Jira Cloud and Jira Data Center, right inside your OpenChamber workspace.</strong></p>

  <p>Multiple Jira sources · Project and board switching · Search and assignee filters · Drag-and-drop transitions</p>

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/board-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/board-light.png">
  <img src="docs/assets/board-dark.png" alt="Jira Board showing a four-column Kanban board with source, project, board, search, and assignee controls">
</picture>

> Screenshots show the actual extension interface with fictional Jira data. The theme follows OpenChamber automatically.

## Why Jira Board?

- **Keep work close to your workspace.** Check priorities, find an issue, and move it forward without opening another Jira tab.
- **Bring different Jira sites together.** Switch between Jira Cloud and self-hosted Data Center sources from one panel.
- **Work with the board you already know.** Jira columns, statuses, assignees, issue types, and priorities come from your board configuration.
- **Change status, not just view it.** Drag cards between columns or onto a specific status when a column contains several statuses.
- **Keep credentials out of the UI.** Authentication is handled by a local, authenticated OpenChamber extension service; tokens are never sent to the panel.

## Features

- Jira Cloud using email + API token, and Jira Data Center using a personal access token.
- Up to 16 independently configured Jira sources.
- Source, project, and Jira Software board selectors, including **All projects**.
- Restored source, project, board, and assignee-filter selections.
- Fast client-side search by issue key, summary, type, or assignee.
- **All issues**, **My issues**, and **Unassigned** filters.
- Issue links that open directly in Jira.
- Optimistic drag-and-drop updates with rollback on rejected transitions.
- Reconciliation when a connection failure leaves a transition outcome uncertain.
- Light and dark themes through OpenChamber's native theme tokens.

## Requirements

- OpenChamber **2.7.2 or newer**, on desktop or web. Extension services are not available on mobile or in VS Code.
- Jira Software Cloud or a Jira Data Center instance with the Agile API.
- A Jira account allowed to view the relevant projects and boards. Changing status also requires permission to execute the workflow transition.

Bun is **not required to install the downloaded package** because the built panel and service are included in this repository. Bun is only needed to rebuild or develop the extension.

## Install

### Option 1: Download the ZIP

1. [Download the latest source ZIP](https://github.com/DeoEsor/openchamber-jira-board/archive/refs/heads/main.zip) and unzip it.
2. In OpenChamber, open **Settings → Extensions** and install the unzipped folder as a local extension.
3. Approve the **Jira Board integration** and its **local service** when prompted.
4. Open **Jira Board** from the extension rail. For a wider view, open it from the **+** menu as a dialog.
5. Continue with [Connect Jira](#connect-jira).

### Option 2: Clone with Git

```bash
git clone https://github.com/DeoEsor/openchamber-jira-board.git
```

Open **Settings → Extensions** in OpenChamber and install the cloned `openchamber-jira-board` folder. The included bundles are ready to use; no build step is needed.

## Connect Jira

Open **Settings → Integrations → Jira Board** and paste a JSON array into **Sources (JSON array)**.

> **Leave the generic Access token field empty.** OpenChamber's integration manifest requires that field, but Jira Board does not use it. The local service reads credentials only from the protected `sources` setting.

### Jira Cloud

Create an API token in your Atlassian account under **Security → API tokens**, then configure:

```json
[
  {
    "id": "work-cloud",
    "name": "Work Cloud",
    "url": "https://your-company.atlassian.net",
    "type": "cloud",
    "email": "you@example.com",
    "token": "YOUR_JIRA_CLOUD_API_TOKEN"
  }
]
```

### Jira Data Center

Create a personal access token in your Jira profile under **Personal Access Tokens**, then configure:

```json
[
  {
    "id": "internal-dc",
    "name": "Internal Data Center",
    "url": "https://jira.internal.example.com",
    "type": "datacenter",
    "token": "YOUR_JIRA_DC_PERSONAL_ACCESS_TOKEN"
  }
]
```

Data Center context paths such as `https://example.com/jira` are supported.

### Multiple sources and default selections

Add up to 16 objects to the same array. Optional `projectKey` and `boardId` fields choose what opens first:

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

Save the settings, return to Jira Board, and choose **Check again** or **Refresh**. You can change sources, projects, and boards in the panel without editing the JSON again.

### Source field reference

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Unique kebab-case identifier, such as `work-cloud`. |
| `name` | Yes | Display name shown in the source selector. |
| `url` | Yes | Jira base URL. HTTPS is required except for localhost. |
| `type` | Yes | `cloud` or `datacenter`. |
| `email` | Cloud only | Atlassian account email used with the Cloud API token. |
| `token` | Yes | Cloud API token or Data Center personal access token. |
| `projectKey` | No | Default Jira project key. Leave it out to start with the standard selection behavior. |
| `boardId` | No | Default Jira Software board ID. |

## Use the board

1. **Choose a source, project, and board.** Your selections are restored the next time you open the panel.
2. **Find work quickly.** Search the loaded cards by key, summary, issue type, or assignee, or use the assignee tabs.
3. **Open an issue.** Click its summary to open the original Jira page.
4. **Move work forward.** Drag a card to another column. If a Jira column contains multiple statuses, drop onto the specific status chip.
5. **Refresh safely.** Reload configured sources, projects, boards, and issues while preserving selections that still exist.

## Status changes and failure handling

Jira Board uses Jira's actual workflow transitions; it does not directly rewrite an issue's status field. A move fails when no direct transition exists or when Jira requires additional fields. In that case, only the affected card returns to its previous column and the Jira error is shown.

Each transition has one overall **12-second deadline**, including settings lookup, workflow discovery, and the update request. If the connection drops or the deadline expires, the result is treated as unknown rather than assumed to have failed. The panel waits for the original operation window, reloads Jira, and keeps that card locked until its actual status is confirmed.

Issues outside the configured board columns appear under **Other statuses**. That synthetic column is read-only and is not a drop target.

## Privacy and security

- Credentials never appear in the panel, host `ready.settings`, bootstrap responses, or preference files.
- The panel communicates only with its extension service through OpenChamber; the service makes Jira requests.
- The service listens only on `127.0.0.1` and requires bearer authentication on every route, including `/health`.
- Preferences are written atomically to `OPENCHAMBER_SERVICE_DATA_DIR`, outside the package. Writes are serialized across all open panel and dialog frames.

## Current limits

- At most **200 issues** and **500 boards** are loaded per request sequence to stay within host response limits.
- Jira Software's Agile API is required; Jira Core-only installations do not provide boards.
- Search and assignee filters operate on the loaded issues, not the entire Jira database.
- Transitions that require extra fields must be completed in Jira itself.

## Development

Install dependencies, then run the full validation suite:

```bash
bun install
bun run typecheck
bun test
bun run build
bun run check
```

The test suite uses a fake Jira API and covers Cloud Basic authentication, Data Center Bearer authentication, board mapping, transition deadlines, overlapping preference writes, and credential redaction. Pure state tests cover concurrent optimistic moves, exact rollback versions, delayed reconciliation, stable assignee identity, and source selection.

For a local service smoke check:

```bash
OPENCHAMBER_SERVICE_PORT=4599 \
OPENCHAMBER_SERVICE_TOKEN=t \
OPENCHAMBER_SERVICE_DATA_DIR="$HOME/.local/share/openchamber-jira-board-dev" \
node service/main.js
```

Then call `/health` with `Authorization: Bearer t`. Other routes require the real OpenChamber callback environment because settings are read through `createServiceHost(...).readSettings()`.

---

The documentation icon was generated with [Kling](https://kling.ai/) and adapted into the package's monochrome SVG rail icon. Screenshots use fictional projects, people, and issues.
