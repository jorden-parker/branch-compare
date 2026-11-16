import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGithubClient, GithubError } from './github.js';
import { proxyRequest, proxyUpgrade } from './proxy.js';
import { runVisualComparison } from './visualComparison.js';

export const baseHostname = 'branch-compare.localhost';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const agentPath = path.join(projectDirectory, 'web/src/components/synced-preview/sync-agent.js');
const largestBodyBytes = 100_000;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const repositoryPattern = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
const forbiddenBranchPattern = /[\p{Cc}\s~^:?*[\\]|\.\./u;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireOwner(owner) {
  if (typeof owner !== 'string' || !ownerPattern.test(owner)) {
    throw new RequestError(400, 'Enter a GitHub organisation or owner name.');
  }
  return owner;
}

function requireRepository(repository) {
  if (typeof repository !== 'string' || !repositoryPattern.test(repository)) {
    throw new RequestError(400, 'Choose a repository.');
  }
  return repository;
}

function requireBranch(branch) {
  if (typeof branch !== 'string' || branch === '' || branch.length > 255 || forbiddenBranchPattern.test(branch)) {
    throw new RequestError(400, 'Choose a branch.');
  }
  return branch;
}

async function readJsonBody(request) {
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > largestBodyBytes) throw new RequestError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'The request body is not valid JSON.');
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  response.end(text);
}

function readHostname(request) {
  return (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
}

function toDataUrl(image) {
  return `data:image/png;base64,${image.toString('base64')}`;
}

export async function startServer({
  port,
  tokenStore,
  runner,
  githubApiUrl,
  staticDirectory = path.join(projectDirectory, 'dist'),
}) {
  const github = createGithubClient({ apiUrl: githubApiUrl, readToken: tokenStore.read });
  let origin;

  const buildApplicationUrl = (slug) => origin.replace('://', `://${slug}.`);
  const addUrl = (application) => ({ ...application, url: buildApplicationUrl(application.slug) });

  async function describeToken() {
    const source = tokenStore.describeSource();
    if (source === 'none') return { source, login: null, error: null };
    try {
      return { source, login: await github.fetchLogin(), error: null };
    } catch (error) {
      return { source, login: null, error: error.message };
    }
  }

  async function enterToken({ request }) {
    const { token } = await readJsonBody(request);
    if (typeof token !== 'string' || token.trim() === '') throw new RequestError(400, 'Enter a GitHub token.');
    const login = await github.fetchLogin(token.trim());
    tokenStore.enter(token.trim());
    return { source: 'entered', login, error: null };
  }

  async function startApplication({ request }) {
    const { owner, repository, branch, startCommand = '' } = await readJsonBody(request);
    if (typeof startCommand !== 'string') throw new RequestError(400, 'The start command must be text.');
    const application = await runner.start({
      owner: requireOwner(owner),
      repository: requireRepository(repository),
      branch: requireBranch(branch),
      startCommand: startCommand.trim(),
    });
    return addUrl(application);
  }

  async function describeApplication({ query }) {
    const application = await runner.describe(query.get('slug'));
    if (!application) throw new RequestError(404, 'This application is not running.');
    return addUrl(application);
  }

  async function compareApplications({ request }) {
    const { baselineSlug, candidateSlug, pagePath = '/' } = await readJsonBody(request);
    if (typeof pagePath !== 'string' || !pagePath.startsWith('/')) {
      throw new RequestError(400, 'The page path must start with "/".');
    }
    for (const slug of [baselineSlug, candidateSlug]) {
      const application = await runner.describe(slug);
      if (application?.status !== 'ready') throw new RequestError(409, 'Start both applications before comparing.');
    }
    const comparison = await runVisualComparison({
      baselineUrl: buildApplicationUrl(baselineSlug) + pagePath,
      candidateUrl: buildApplicationUrl(candidateSlug) + pagePath,
    });
    return {
      mismatchedPixelCount: comparison.mismatchedPixelCount,
      totalPixelCount: comparison.totalPixelCount,
      baselineImage: toDataUrl(comparison.baselineImage),
      candidateImage: toDataUrl(comparison.candidateImage),
      differenceImage: toDataUrl(comparison.differenceImage),
    };
  }

  const apiRoutes = {
    'GET /api/token': describeToken,
    'POST /api/token': enterToken,
    'DELETE /api/token': () => {
      tokenStore.clear();
      return describeToken();
    },
    'GET /api/owners': async () => ({ owners: await github.listOwners() }),
    'GET /api/repositories': ({ query }) => github.listRepositories(requireOwner(query.get('owner'))),
    'GET /api/branches': ({ query }) =>
      github.listBranches(requireOwner(query.get('owner')), requireRepository(query.get('repository'))),
    'POST /api/applications': startApplication,
    'GET /api/applications': describeApplication,
    'DELETE /api/applications': async ({ query }) => {
      await runner.stop(query.get('slug'));
      return { isStopped: true };
    },
    'POST /api/comparisons': compareApplications,
  };

  function isSameOriginRequest(request) {
    const fetchSite = request.headers['sec-fetch-site'] ?? 'none';
    const requestOrigin = request.headers.origin ?? origin;
    return (fetchSite === 'same-origin' || fetchSite === 'none') && requestOrigin === origin;
  }

  async function answerApi(request, response, url) {
    if (!isSameOriginRequest(request)) {
      sendJson(response, 403, { error: 'Only the Branch compare page may call this API.' });
      return;
    }
    const answerRoute = apiRoutes[`${request.method} ${url.pathname}`];
    if (!answerRoute) {
      sendJson(response, 404, { error: 'Unknown API route.' });
      return;
    }
    try {
      sendJson(response, 200, await answerRoute({ request, query: url.searchParams }));
    } catch (error) {
      const isExpected = error instanceof RequestError || error instanceof GithubError;
      sendJson(response, isExpected ? error.status : 500, { error: error.message });
    }
  }

  async function serveFile(response, filePath) {
    try {
      const content = await readFile(filePath);
      response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      sendText(response, 404, 'Not found.');
    }
  }

  async function answerControl(request, response) {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) return answerApi(request, response, url);
    if (url.pathname === '/sync-agent.js') return serveFile(response, agentPath);
    const filePath = path.join(staticDirectory, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!filePath.startsWith(staticDirectory + path.sep)) return sendText(response, 404, 'Not found.');
    return serveFile(response, filePath);
  }

  function findApplicationPort(hostname) {
    if (!hostname.endsWith(`.${baseHostname}`)) return undefined;
    return runner.findPort(hostname.slice(0, -(baseHostname.length + 1)));
  }

  const server = http.createServer((request, response) => {
    const hostname = readHostname(request);
    if (hostname.endsWith(`.${baseHostname}`)) {
      const applicationPort = findApplicationPort(hostname);
      if (!applicationPort) {
        sendText(response, 502, 'This application is not running. Start it from Branch compare.');
        return;
      }
      proxyRequest(request, response, {
        port: applicationPort,
        agentTag: `<script src="${origin}/sync-agent.js"></script>`,
      });
      return;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      sendText(response, 302, 'Redirecting to Branch compare.', { location: origin + request.url });
      return;
    }
    if (hostname !== baseHostname) {
      sendText(response, 421, 'Branch compare does not serve this hostname.');
      return;
    }
    answerControl(request, response).catch(() => {
      if (!response.headersSent) sendText(response, 400, 'Bad request.');
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const applicationPort = findApplicationPort(readHostname(request));
    if (!applicationPort) {
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, applicationPort);
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      const explanation =
        error.code === 'EADDRINUSE'
          ? `Port ${port} is already in use. Stop the other program, or set PORT to another port.`
          : error.message;
      reject(new Error(explanation));
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  const listeningPort = server.address().port;
  origin = `http://${baseHostname}:${listeningPort}`;

  return {
    port: listeningPort,
    origin,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
