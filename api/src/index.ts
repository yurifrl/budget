import { createApp } from './app';

const port = Number(process.env.API_PORT ?? 3100);
const hostname = process.env.API_HOST ?? '127.0.0.1';

const app = createApp();

if (import.meta.main) {
  const server = Bun.serve({ port, hostname, fetch: app.fetch });
  console.log(`budget api listening on http://${server.hostname}:${server.port}`);
}

export { app };
