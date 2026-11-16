import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const installAndRunByLockfile = [
  ['pnpm-lock.yaml', 'corepack enable && pnpm install && pnpm run'],
  ['yarn.lock', 'corepack enable && yarn install && yarn run'],
];
const defaultInstallAndRun = 'npm install && npm run';

async function hasFile(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectStartCommand(workspaceDirectory) {
  let packageDefinition;
  try {
    packageDefinition = JSON.parse(await readFile(path.join(workspaceDirectory, 'package.json'), 'utf8'));
  } catch {
    throw new Error('This branch has no readable package.json. Enter a start command.');
  }
  const scriptName = packageDefinition.scripts?.dev ? 'dev' : 'start';
  for (const [lockfileName, installAndRun] of installAndRunByLockfile) {
    if (await hasFile(path.join(workspaceDirectory, lockfileName))) return `${installAndRun} ${scriptName}`;
  }
  return `${defaultInstallAndRun} ${scriptName}`;
}
