import { createServer } from 'node:http';

import { createApp } from './app.js';
import { configFromEnv, loadEnvFile } from './config.js';

loadEnvFile();

const config = configFromEnv();
const app = createApp(config);
const server = createServer(app.handler);

server.listen(config.port, config.host, () => {
  console.info('easyjobappschatbot listening', { host: config.host, port: config.port });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info('easyjobappschatbot shutting down', { signal });
  const forceExit = setTimeout(() => {
    console.error('easyjobappschatbot shutdown timed out', { code: 'shutdown_timeout' });
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async (error) => {
    if (error) {
      console.error('easyjobappschatbot shutdown failed', { code: 'server_close_failed' });
      process.exitCode = 1;
    }
    await app.close?.();
    clearTimeout(forceExit);
    process.exit();
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
