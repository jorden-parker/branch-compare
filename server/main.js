import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplicationRunner } from './applicationRunner.js';
import { startServer } from './server.js';
import { createTokenStore } from './tokenStore.js';

function readConfiguredToken() {
  const environmentToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (environmentToken) return { value: environmentToken, source: 'environment' };
  try {
    const githubCliToken = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (githubCliToken) return { value: githubCliToken, source: 'github-cli' };
  } catch {
    return { value: null, source: 'none' };
  }
  return { value: null, source: 'none' };
}

const tokenStore = createTokenStore(readConfiguredToken());
const runner = createApplicationRunner({
  dataDirectory: process.env.DATA_DIRECTORY ?? fileURLToPath(new URL('../data', import.meta.url)),
  readToken: tokenStore.read,
  image: process.env.RUNNER_IMAGE ?? 'node:24',
});

try {
  const server = await startServer({ port: Number(process.env.PORT ?? 3000), tokenStore, runner });
  console.log(`Branch compare is running at ${server.origin}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('Stopping the running applications');
    await runner.stopAll();
    process.exit(0);
  });
}
