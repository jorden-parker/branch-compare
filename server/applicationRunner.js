import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildApplicationSlug } from './applicationSlug.js';
import { detectStartCommand } from './startCommand.js';

const runnerDirectory = fileURLToPath(new URL('../runner', import.meta.url));
const forwardedContainerPort = '3001';
const startupTimeoutMilliseconds = 15 * 60 * 1000;
const probeIntervalMilliseconds = 1000;
const probeTimeoutMilliseconds = 10000;

function explainDockerFailure(error) {
  if (error.code === 'ENOENT') return 'Docker is not installed. Install Docker Desktop or Colima, then start again.';
  const dockerOutput = (error.stderr ?? error.message).trim();
  if (/cannot connect to the docker daemon/i.test(dockerOutput)) {
    return 'Docker is not running. Start Docker (with Colima: colima start), then start again.';
  }
  return dockerOutput;
}

async function isListening(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(probeTimeoutMilliseconds),
    });
    return true;
  } catch {
    return false;
  }
}

export function createApplicationRunner({ dataDirectory, readToken, image, runCommand = promisify(execFile) }) {
  const applications = new Map();
  const runDocker = (dockerArguments) => runCommand('docker', dockerArguments);

  async function fetchBranch(application, workspaceDirectory) {
    const token = readToken();
    const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (token) {
      const credential = Buffer.from(`x-access-token:${token}`).toString('base64');
      gitEnvironment.GIT_CONFIG_COUNT = '1';
      gitEnvironment.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      gitEnvironment.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${credential}`;
    }
    const repositoryUrl = `https://github.com/${application.owner}/${application.repository}.git`;
    try {
      await mkdir(workspaceDirectory, { recursive: true });
      await runCommand('git', ['init', '--quiet', workspaceDirectory]);
      await runCommand(
        'git',
        ['-C', workspaceDirectory, 'fetch', '--depth', '1', repositoryUrl, `refs/heads/${application.branch}`],
        { env: gitEnvironment },
      );
      await runCommand('git', ['-C', workspaceDirectory, 'reset', '--hard', 'FETCH_HEAD']);
    } catch (error) {
      const advice = token
        ? 'Check that the token can read this repository.'
        : 'Add a GitHub token if the repository is private.';
      const gitOutput = (error.stderr ?? error.message).trim();
      throw new Error(
        `Could not fetch ${application.branch} from ${application.owner}/${application.repository}. ${advice}\n${gitOutput}`,
      );
    }
  }

  async function startContainer(application, workspaceDirectory, startCommand) {
    try {
      await runDocker(['rm', '--force', application.containerName]).catch(() => {});
      await runDocker([
        'run',
        '--detach',
        '--name',
        application.containerName,
        '--publish',
        `127.0.0.1::${forwardedContainerPort}`,
        '--volume',
        `${workspaceDirectory}:/app`,
        '--volume',
        `${runnerDirectory}:/runner:ro`,
        '--workdir',
        '/app',
        '--env',
        'PORT=3000',
        '--env',
        'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        '--env',
        `START_COMMAND=${startCommand}`,
        image,
        'sh',
        '/runner/entrypoint.sh',
      ]);
      const { stdout } = await runDocker(['port', application.containerName, `${forwardedContainerPort}/tcp`]);
      application.port = Number(stdout.trim().split('\n')[0].split(':').pop());
    } catch (error) {
      throw new Error(explainDockerFailure(error));
    }
  }

  async function waitUntilListening(application) {
    const deadline = Date.now() + startupTimeoutMilliseconds;
    while (Date.now() < deadline) {
      if (applications.get(application.slug) !== application) return false;
      const { stdout } = await runDocker(['inspect', '--format', '{{.State.Running}}', application.containerName]);
      if (stdout.trim() !== 'true') {
        throw new Error(
          'The application stopped before it listened on port 3000. Read the log below, or set a start command.',
        );
      }
      if (await isListening(application.port)) return true;
      await sleep(probeIntervalMilliseconds);
    }
    throw new Error('Nothing listened on port 3000 within 15 minutes. Set a start command that listens on port 3000.');
  }

  async function launch(application, requestedStartCommand) {
    const workspaceDirectory = path.join(dataDirectory, 'workspaces', application.slug);
    await fetchBranch(application, workspaceDirectory);
    const startCommand = requestedStartCommand || (await detectStartCommand(workspaceDirectory));
    application.message = 'Starting the container';
    await startContainer(application, workspaceDirectory, startCommand);
    application.message = `Running: ${startCommand}`;
    if (await waitUntilListening(application)) {
      application.status = 'ready';
      application.message = 'Listening on port 3000';
    }
  }

  async function readLogTail(application) {
    if (application.status === 'ready') return '';
    try {
      const { stdout, stderr } = await runDocker(['logs', '--tail', '40', application.containerName]);
      return `${stdout}${stderr}`.trim();
    } catch {
      return '';
    }
  }

  async function describe(slug) {
    const application = applications.get(slug);
    if (!application) return null;
    return {
      slug,
      branch: application.branch,
      status: application.status,
      message: application.message,
      logTail: await readLogTail(application),
    };
  }

  async function start({ owner, repository, branch, startCommand }) {
    const slug = buildApplicationSlug({ owner, repository, branch });
    const knownApplication = applications.get(slug);
    if (knownApplication && knownApplication.status !== 'failed') return describe(slug);
    const application = {
      slug,
      owner,
      repository,
      branch,
      containerName: `branch-compare-${slug}`,
      status: 'starting',
      message: 'Fetching the branch',
      port: undefined,
    };
    applications.set(slug, application);
    launch(application, startCommand).catch((error) => {
      application.status = 'failed';
      application.message = error.message;
    });
    return describe(slug);
  }

  async function stop(slug) {
    const application = applications.get(slug);
    if (!application) return;
    applications.delete(slug);
    await runDocker(['rm', '--force', application.containerName]).catch(() => {});
  }

  return {
    start,
    describe,
    stop,
    stopAll: () => Promise.all([...applications.keys()].map(stop)),
    findPort: (slug) => applications.get(slug)?.port,
  };
}
