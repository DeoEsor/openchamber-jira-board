import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiraBoardServer } from './app.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new Error('OPENCHAMBER_SERVICE_PORT is required.');
}
if (!token) throw new Error('OPENCHAMBER_SERVICE_TOKEN is required.');

const server = createJiraBoardServer({
  token,
  dataDir: process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? join(tmpdir(), 'openchamber-jira-board'),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Jira Board service listening on 127.0.0.1:${port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
