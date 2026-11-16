import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient } from '../server/github.js';
import { startFakeGithub } from './fixtures.js';

const shopRepository = { name: 'shop', private: true, default_branch: 'main' };

test("lists an organisation's repositories with the token, private ones included", async (context) => {
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath === '/user') return { body: { login: 'jo' } };
    if (requestPath.startsWith('/orgs/acme/repos')) return { body: [shopRepository] };
    return undefined;
  });
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => 'secret-token' });

  const listing = await github.listRepositories('acme');

  assert.deepEqual(listing.repositories, [{ name: 'shop', isPrivate: true, defaultBranch: 'main' }]);
  assert.equal(listing.isAuthenticated, true);
  assert.ok(fakeGithub.seenRequests.every((seenRequest) => seenRequest.authorization === 'Bearer secret-token'));
});

test("lists a user's public repositories when the owner is not an organisation", async (context) => {
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath.startsWith('/users/octo/repos'))
      return { body: [{ name: 'site', private: false, default_branch: 'trunk' }] };
    return undefined;
  });
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => null });

  const listing = await github.listRepositories('octo');

  assert.deepEqual(listing.repositories, [{ name: 'site', isPrivate: false, defaultBranch: 'trunk' }]);
  assert.equal(listing.isAuthenticated, false);
  assert.equal(fakeGithub.seenRequests[0].authorization, undefined);
});

test("lists the token owner's own repositories, private ones included", async (context) => {
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath === '/user') return { body: { login: 'Jo' } };
    if (requestPath.startsWith('/user/repos')) return { body: [shopRepository] };
    return undefined;
  });
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => 'secret-token' });

  const listing = await github.listRepositories('jo');

  assert.deepEqual(
    listing.repositories.map((repository) => repository.name),
    ['shop'],
  );
});

test('explains that the token was rejected', async (context) => {
  const fakeGithub = await startFakeGithub(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => 'expired-token' });

  await assert.rejects(github.listRepositories('acme'), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /GitHub rejected the token/);
    return true;
  });
});

test('explains that a token lifts the rate limit when none is set', async (context) => {
  const fakeGithub = await startFakeGithub(() => ({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
    body: { message: 'API rate limit exceeded' },
  }));
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => null });

  await assert.rejects(github.listRepositories('acme'), /rate limit.*Add a GitHub token/);
});

test("passes on GitHub's own explanation for other refusals", async (context) => {
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath === '/user') return { body: { login: 'jo' } };
    return { status: 403, body: { message: 'Resource protected by organization SAML enforcement.' } };
  });
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => 'secret-token' });

  await assert.rejects(github.listRepositories('acme'), /SAML enforcement/);
});

test('says when neither an organisation nor a user has the name', async (context) => {
  const fakeGithub = await startFakeGithub(() => undefined);
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => null });

  await assert.rejects(github.listRepositories('nobody'), /No organisation or user named "nobody"/);
});

test('lists every page of branches', async (context) => {
  const firstPage = Array.from({ length: 100 }, (unused, index) => ({ name: `branch-${index}` }));
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath === '/repos/acme/shop/branches?per_page=100&page=1') return { body: firstPage };
    if (requestPath === '/repos/acme/shop/branches?per_page=100&page=2') return { body: [{ name: 'main' }] };
    return undefined;
  });
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => null });

  const listing = await github.listBranches('acme', 'shop');

  assert.equal(listing.branches.length, 101);
  assert.equal(listing.branches.at(-1), 'main');
  assert.equal(listing.isTruncated, false);
});

test('lists the token owner and their organisations as owners', async (context) => {
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath === '/user') return { body: { login: 'jo' } };
    if (requestPath.startsWith('/user/orgs')) return { body: [{ login: 'acme' }] };
    return undefined;
  });
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => 'secret-token' });

  assert.deepEqual(await github.listOwners(), ['jo', 'acme']);
});

test('lists no owners without a token', async (context) => {
  const fakeGithub = await startFakeGithub(() => undefined);
  context.after(fakeGithub.close);
  const github = createGithubClient({ apiUrl: fakeGithub.apiUrl, readToken: () => null });

  assert.deepEqual(await github.listOwners(), []);
  assert.equal(fakeGithub.seenRequests.length, 0);
});
