import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectStartCommand } from '../server/startCommand.js';

async function createWorkspace(files) {
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), 'branch-compare-workspace-'));
  for (const [fileName, content] of Object.entries(files)) {
    await writeFile(path.join(workspaceDirectory, fileName), content);
  }
  return workspaceDirectory;
}

const packageWithDevScript = JSON.stringify({ scripts: { dev: 'next dev', start: 'next start' } });

test('uses npm and the dev script by default', async () => {
  const workspaceDirectory = await createWorkspace({ 'package.json': packageWithDevScript });

  assert.equal(await detectStartCommand(workspaceDirectory), 'npm install && npm run dev');
});

test('uses pnpm through corepack when a pnpm lockfile exists', async () => {
  const workspaceDirectory = await createWorkspace({ 'package.json': packageWithDevScript, 'pnpm-lock.yaml': '' });

  assert.equal(await detectStartCommand(workspaceDirectory), 'corepack enable && pnpm install && pnpm run dev');
});

test('uses yarn through corepack when a yarn lockfile exists', async () => {
  const workspaceDirectory = await createWorkspace({ 'package.json': packageWithDevScript, 'yarn.lock': '' });

  assert.equal(await detectStartCommand(workspaceDirectory), 'corepack enable && yarn install && yarn run dev');
});

test('falls back to the start script when there is no dev script', async () => {
  const workspaceDirectory = await createWorkspace({
    'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
  });

  assert.equal(await detectStartCommand(workspaceDirectory), 'npm install && npm run start');
});

test('asks for a start command when the repository has no package.json', async () => {
  const workspaceDirectory = await createWorkspace({});

  await assert.rejects(detectStartCommand(workspaceDirectory), /Enter a start command/);
});
