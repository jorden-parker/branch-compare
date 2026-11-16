import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/server.js';
import { createTokenStore } from '../server/tokenStore.js';
import { createFakeRunner, sendRequest, startFakeGithub } from './fixtures.js';

async function startTestServer(context, { respondAsGithub = () => undefined, initialToken } = {}) {
  const fakeGithub = await startFakeGithub(respondAsGithub);
  const runner = createFakeRunner();
  const server = await startServer({
    port: 0,
    githubApiUrl: fakeGithub.apiUrl,
    tokenStore: createTokenStore(initialToken),
    runner,
  });
  context.after(() => Promise.all([server.close(), fakeGithub.close()]));
  const controlHost = `branch-compare.localhost:${server.port}`;
  const callApi = async (method, path, payload, headers) => {
    const reply = await sendRequest({ port: server.port, host: controlHost, method, path, payload, headers });
    return { status: reply.status, body: JSON.parse(reply.text) };
  };
  return { server, runner, fakeGithub, callApi };
}

const checkoutSpecification = { owner: 'acme', repository: 'shop', branch: 'checkout' };

test('refuses API calls from other websites', async (context) => {
  const { runner, callApi } = await startTestServer(context);

  const reply = await callApi('POST', '/api/applications', checkoutSpecification, { origin: 'http://evil.example' });

  assert.equal(reply.status, 403);
  assert.equal(runner.startedSpecifications.length, 0);
});

test('refuses API calls from an application under test', async (context) => {
  const { server, runner, callApi } = await startTestServer(context);

  const reply = await callApi('POST', '/api/applications', checkoutSpecification, {
    origin: `http://shop-main.branch-compare.localhost:${server.port}`,
    'sec-fetch-site': 'same-site',
  });

  assert.equal(reply.status, 403);
  assert.equal(runner.startedSpecifications.length, 0);
});

test('rejects an invalid token with a clear message and does not keep it', async (context) => {
  const { callApi } = await startTestServer(context, {
    respondAsGithub: () => ({ status: 401, body: { message: 'Bad credentials' } }),
  });

  const rejection = await callApi('POST', '/api/token', { token: 'wrong-token' });
  const tokenStatus = await callApi('GET', '/api/token');

  assert.equal(rejection.status, 401);
  assert.match(rejection.body.error, /GitHub rejected the token/);
  assert.equal(tokenStatus.body.source, 'none');
});

test("keeps a valid token and lists the organisation's repositories with it", async (context) => {
  const { fakeGithub, callApi } = await startTestServer(context, {
    respondAsGithub: (requestPath) => {
      if (requestPath === '/user') return { body: { login: 'jo' } };
      if (requestPath.startsWith('/orgs/acme/repos'))
        return { body: [{ name: 'shop', private: true, default_branch: 'main' }] };
      return undefined;
    },
  });

  const tokenStatus = await callApi('POST', '/api/token', { token: 'org-token' });
  const listing = await callApi('GET', '/api/repositories?owner=acme');

  assert.deepEqual(tokenStatus.body, { source: 'entered', login: 'jo', error: null });
  assert.deepEqual(
    listing.body.repositories.map((repository) => repository.name),
    ['shop'],
  );
  assert.equal(fakeGithub.seenRequests.at(-1).authorization, 'Bearer org-token');
  assert.ok(!JSON.stringify(tokenStatus.body).includes('org-token'));
});

test('returns to the configured token when the entered one is removed', async (context) => {
  const { callApi } = await startTestServer(context, {
    initialToken: { value: 'environment-token', source: 'environment' },
    respondAsGithub: (requestPath) => (requestPath === '/user' ? { body: { login: 'jo' } } : undefined),
  });

  await callApi('POST', '/api/token', { token: 'entered-token' });
  const tokenStatus = await callApi('DELETE', '/api/token');

  assert.equal(tokenStatus.body.source, 'environment');
});

test('lists public repositories and says no token is set', async (context) => {
  const { callApi } = await startTestServer(context, {
    respondAsGithub: (requestPath) =>
      requestPath.startsWith('/orgs/acme/repos')
        ? { body: [{ name: 'docs', private: false, default_branch: 'main' }] }
        : undefined,
  });

  const listing = await callApi('GET', '/api/repositories?owner=acme');

  assert.equal(listing.body.isAuthenticated, false);
  assert.deepEqual(
    listing.body.repositories.map((repository) => repository.name),
    ['docs'],
  );
});

test('starts an application and gives its address on the server port', async (context) => {
  const { server, runner, callApi } = await startTestServer(context);

  const reply = await callApi('POST', '/api/applications', checkoutSpecification);

  assert.equal(reply.status, 200);
  assert.equal(reply.body.url, `http://shop-checkout.branch-compare.localhost:${server.port}`);
  assert.deepEqual(runner.startedSpecifications, [{ ...checkoutSpecification, startCommand: '' }]);
});

test('rejects owner names that GitHub would not allow', async (context) => {
  const { runner, callApi } = await startTestServer(context);

  const reply = await callApi('POST', '/api/applications', { ...checkoutSpecification, owner: '../acme' });

  assert.equal(reply.status, 400);
  assert.equal(runner.startedSpecifications.length, 0);
});

test('rejects branch names that git would not allow', async (context) => {
  const { runner, callApi } = await startTestServer(context);

  for (const branch of ['two words', 'bell\u0007inside', 'up/../out', 'tilde~1']) {
    const reply = await callApi('POST', '/api/applications', { ...checkoutSpecification, branch });
    assert.equal(reply.status, 400);
  }
  assert.equal(runner.startedSpecifications.length, 0);
});

test('tells the browser when an application is not running', async (context) => {
  const { server } = await startTestServer(context);

  const reply = await sendRequest({ port: server.port, host: `ghost.branch-compare.localhost:${server.port}` });

  assert.equal(reply.status, 502);
  assert.match(reply.text, /not running/);
});

test('sends plain localhost to the Branch compare hostname', async (context) => {
  const { server } = await startTestServer(context);

  const reply = await sendRequest({ port: server.port, host: `localhost:${server.port}` });

  assert.equal(reply.status, 302);
  assert.equal(reply.headers.location, `http://branch-compare.localhost:${server.port}/`);
});

test('refuses hostnames it does not serve', async (context) => {
  const { server } = await startTestServer(context);

  const reply = await sendRequest({ port: server.port, host: 'evil.example' });

  assert.equal(reply.status, 421);
});

test('serves the sync agent for applications under test', async (context) => {
  const { server } = await startTestServer(context);

  const reply = await sendRequest({
    port: server.port,
    host: `branch-compare.localhost:${server.port}`,
    path: '/sync-agent.js',
  });

  assert.equal(reply.status, 200);
  assert.match(reply.headers['content-type'], /javascript/);
  assert.match(reply.text, /__sp/);
});
