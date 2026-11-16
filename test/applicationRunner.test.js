import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApplicationRunner } from '../server/applicationRunner.js';
import { closeServer, listenOnFreePort } from './fixtures.js';

async function waitForStatus(runner, slug, expectedStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const description = await runner.describe(slug);
    if (description.status === expectedStatus) return description;
    await sleep(50);
  }
  throw new Error(`${slug} never became ${expectedStatus}`);
}

async function createRunnerWithFakeDocker(context, answerDocker = () => undefined) {
  const listeningApplication = http.createServer((request, response) => response.end('ok'));
  const applicationPort = await listenOnFreePort(listeningApplication);
  context.after(() => closeServer(listeningApplication));
  const commands = [];
  const runCommand = async (file, commandArguments, options = {}) => {
    commands.push({ file, commandArguments, environment: options.env ?? {} });
    const answer = file === 'docker' ? answerDocker(commandArguments) : undefined;
    if (answer) return answer;
    if (file === 'docker' && commandArguments[0] === 'port')
      return { stdout: `127.0.0.1:${applicationPort}\n`, stderr: '' };
    if (file === 'docker' && commandArguments[0] === 'inspect') return { stdout: 'true\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const runner = createApplicationRunner({
    dataDirectory: await mkdtemp(path.join(tmpdir(), 'branch-compare-data-')),
    readToken: () => 'secret-token',
    image: 'node:22',
    runCommand,
  });
  const findDockerCommands = (subcommand) =>
    commands.filter((command) => command.file === 'docker' && command.commandArguments[0] === subcommand);
  return { runner, commands, applicationPort, findDockerCommands };
}

const shopSpecification = { owner: 'acme', repository: 'shop', startCommand: 'npm run dev' };

test('runs main and a branch of one repository side by side, each on port 3000', async (context) => {
  const { runner, applicationPort, findDockerCommands } = await createRunnerWithFakeDocker(context);

  const mainApplication = await runner.start({ ...shopSpecification, branch: 'main' });
  const branchApplication = await runner.start({ ...shopSpecification, branch: 'checkout' });
  await waitForStatus(runner, mainApplication.slug, 'ready');
  await waitForStatus(runner, branchApplication.slug, 'ready');

  const runCommands = findDockerCommands('run').map((command) => command.commandArguments);
  assert.equal(runCommands.length, 2);
  for (const runArguments of runCommands) {
    assert.ok(runArguments.includes('PORT=3000'));
    assert.equal(runArguments[runArguments.indexOf('--publish') + 1], '127.0.0.1::3001');
    assert.ok(runArguments.includes('START_COMMAND=npm run dev'));
  }
  const containerNames = runCommands.map((runArguments) => runArguments[runArguments.indexOf('--name') + 1]);
  const workspaceMounts = runCommands.map((runArguments) =>
    runArguments.find((argument) => argument.endsWith(':/app')),
  );
  assert.notEqual(containerNames[0], containerNames[1]);
  assert.notEqual(workspaceMounts[0], workspaceMounts[1]);
  assert.equal(runner.findPort(mainApplication.slug), applicationPort);
  assert.equal(runner.findPort(branchApplication.slug), applicationPort);
});

test('gives git the token through the environment, never the command line', async (context) => {
  const { runner, commands } = await createRunnerWithFakeDocker(context);

  const application = await runner.start({ ...shopSpecification, branch: 'main' });
  await waitForStatus(runner, application.slug, 'ready');

  const fetchCommand = commands.find((command) => command.file === 'git' && command.commandArguments.includes('fetch'));
  const expectedCredential = Buffer.from('x-access-token:secret-token').toString('base64');
  assert.ok(fetchCommand.environment.GIT_CONFIG_VALUE_0.includes(expectedCredential));
  assert.ok(fetchCommand.commandArguments.includes('refs/heads/main'));
  for (const command of commands) {
    assert.ok(!command.commandArguments.join(' ').includes('secret-token'));
    assert.ok(!command.commandArguments.join(' ').includes(expectedCredential));
  }
});

test('does not start a second container for an application that is already running', async (context) => {
  const { runner, findDockerCommands } = await createRunnerWithFakeDocker(context);

  const application = await runner.start({ ...shopSpecification, branch: 'main' });
  await waitForStatus(runner, application.slug, 'ready');
  await runner.start({ ...shopSpecification, branch: 'main' });

  assert.equal(findDockerCommands('run').length, 1);
});

test('says when Docker is not running', async (context) => {
  const { runner } = await createRunnerWithFakeDocker(context, () => {
    throw Object.assign(new Error('Command failed'), {
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    });
  });

  const application = await runner.start({ ...shopSpecification, branch: 'main' });
  const description = await waitForStatus(runner, application.slug, 'failed');

  assert.match(description.message, /Docker is not running/);
});

test('reports the log when the application exits before listening', async (context) => {
  const { runner } = await createRunnerWithFakeDocker(context, (commandArguments) => {
    if (commandArguments[0] === 'inspect') return { stdout: 'false\n', stderr: '' };
    if (commandArguments[0] === 'logs') return { stdout: 'npm error Missing script: "dev"\n', stderr: '' };
    return undefined;
  });

  const application = await runner.start({ ...shopSpecification, branch: 'main' });
  const description = await waitForStatus(runner, application.slug, 'failed');

  assert.match(description.message, /stopped before it listened on port 3000/);
  assert.match(description.logTail, /Missing script/);
});

test('removes the container when an application is stopped', async (context) => {
  const { runner, findDockerCommands } = await createRunnerWithFakeDocker(context);
  const application = await runner.start({ ...shopSpecification, branch: 'main' });
  await waitForStatus(runner, application.slug, 'ready');

  await runner.stop(application.slug);

  assert.ok(findDockerCommands('rm').some((command) => command.commandArguments.includes('--force')));
  assert.equal(await runner.describe(application.slug), null);
  assert.equal(runner.findPort(application.slug), undefined);
});
