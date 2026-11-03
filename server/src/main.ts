import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startApp } from './app.ts';

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? '.data');
mkdirSync(dataDir, { recursive: true });

const app = await startApp({
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '127.0.0.1',
  dataDir: env.DATA_DIR === ':memory:' ? null : dataDir,
  apiKeys: (env.API_KEYS ?? 'sample-key').split(',').filter(Boolean),
  log: env.LOG_REQUESTS === '1',
});

process.stdout.write(
  `Blackbox server on ${app.url} (dashboard: ${app.url}/, metrics: ${app.url}/metrics)\n` +
    `Native symbolication: ${app.service.symbolizer ?? 'off (set LLVM_SYMBOLIZER or ANDROID_HOME with an NDK)'}\n`,
);

const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
