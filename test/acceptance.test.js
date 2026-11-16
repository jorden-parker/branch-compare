import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { startServer } from '../server/server.js';
import { createTokenStore } from '../server/tokenStore.js';
import { closeServer, createFakeRunner, listenOnFreePort, startFakeGithub } from './fixtures.js';

async function startShop(headingColour) {
  const shop = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Shop</title></head><body>
      <h1 style="color: ${headingColour}">Shop</h1>
      <button id="add" type="button">Add to basket</button>
      <p id="count">0</p>
      <script>
        document.getElementById('add').addEventListener('click', () => {
          const count = document.getElementById('count');
          count.textContent = Number(count.textContent) + 1;
        });
      </script>
    </body></html>`);
  });
  return { server: shop, port: await listenOnFreePort(shop) };
}

test('pick a repository and branch, mirror clicks in the synced preview, then compare against main', async (context) => {
  const mainShop = await startShop('black');
  const branchShop = await startShop('crimson');
  const fakeGithub = await startFakeGithub((requestPath) => {
    if (requestPath.startsWith('/orgs/acme/repos'))
      return { body: [{ name: 'shop', private: false, default_branch: 'main' }] };
    if (requestPath.startsWith('/repos/acme/shop/branches')) return { body: [{ name: 'checkout' }, { name: 'main' }] };
    return undefined;
  });
  const runner = createFakeRunner({ 'shop-main': mainShop.port, 'shop-checkout': branchShop.port });
  const server = await startServer({
    port: 0,
    githubApiUrl: fakeGithub.apiUrl,
    tokenStore: createTokenStore(),
    runner,
  });
  const browser = await chromium.launch({ channel: 'chrome' });
  context.after(() =>
    Promise.all([
      browser.close(),
      server.close(),
      fakeGithub.close(),
      closeServer(mainShop.server),
      closeServer(branchShop.server),
    ]),
  );
  const page = await browser.newPage();

  await page.goto(server.origin);
  await page.getByLabel('Owner or organisation').fill('acme');
  await page.getByRole('button', { name: 'List repositories' }).click();
  await page.getByLabel('Repository').selectOption('shop');
  await page.getByLabel('Branch', { exact: true }).selectOption('checkout');
  await page.getByRole('button', { name: 'Start both applications' }).click();

  const mainPane = page.frameLocator('iframe[title="pane-A"]');
  const branchPane = page.frameLocator('iframe[title="pane-B"]');
  await page.getByText('B ✓ agent connected').waitFor();
  await page.getByText('A ✓ agent connected').waitFor();
  await mainPane.getByRole('button', { name: 'Add to basket' }).click();
  await branchPane.locator('#count', { hasText: '1' }).waitFor();

  assert.deepEqual(
    runner.startedSpecifications.map((specification) => specification.branch),
    ['main', 'checkout'],
  );

  await page.getByRole('tab', { name: 'Visual comparison' }).click();
  await page.getByRole('button', { name: 'Run visual comparison' }).click();
  await page.getByText(/pixels differ/).waitFor();

  assert.equal(await page.getByRole('img').count(), 3);
});
