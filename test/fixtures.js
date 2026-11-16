import http from 'node:http';

export function listenOnFreePort(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

export function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

export async function startFakeGithub(respond) {
  const seenRequests = [];
  const server = http.createServer((request, response) => {
    seenRequests.push({ path: request.url, authorization: request.headers.authorization });
    const reply = respond(request.url, request.headers) ?? { status: 404, body: { message: 'Not Found' } };
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    response.end(JSON.stringify(reply.body));
  });
  const port = await listenOnFreePort(server);
  return { apiUrl: `http://127.0.0.1:${port}`, seenRequests, close: () => closeServer(server) };
}

export function sendRequest({ port, host, method = 'GET', path = '/', headers = {}, payload }) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const contentHeaders = body === undefined ? {} : { 'content-type': 'application/json' };
    const request = http.request(
      { host: '127.0.0.1', port, method, path, headers: { host, ...contentHeaders, ...headers } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, headers: response.headers, text });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

export function createFakeRunner(portsBySlug = {}) {
  const applications = new Map();
  return {
    startedSpecifications: [],
    async start(specification) {
      const slug = `${specification.repository}-${specification.branch}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      this.startedSpecifications.push(specification);
      applications.set(slug, { slug, branch: specification.branch, status: 'ready', message: 'Running', logTail: '' });
      return applications.get(slug);
    },
    async describe(slug) {
      return applications.get(slug) ?? null;
    },
    async stop(slug) {
      applications.delete(slug);
    },
    findPort(slug) {
      return applications.has(slug) ? portsBySlug[slug] : undefined;
    },
  };
}
