import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { injectAgentTag, proxyRequest, proxyUpgrade } from '../server/proxy.js';
import { closeServer, listenOnFreePort, sendRequest } from './fixtures.js';

const agentTag = '<script src="http://control.test/sync-agent.js"></script>';

async function startProxyInFrontOf(respondAsApplication, context) {
  const application = http.createServer(respondAsApplication);
  const applicationPort = await listenOnFreePort(application);
  const proxy = http.createServer((request, response) => {
    proxyRequest(request, response, { port: applicationPort, agentTag });
  });
  proxy.on('upgrade', (request, socket, head) => proxyUpgrade(request, socket, head, applicationPort));
  const proxyPort = await listenOnFreePort(proxy);
  context.after(() => Promise.all([closeServer(application), closeServer(proxy)]));
  return { application, proxyPort };
}

test('puts the agent tag right after the opening head tag', () => {
  const injected = injectAgentTag(Buffer.from('<!doctype html><html><head lang="en"><title>Shop</title>'), agentTag);

  assert.equal(injected.toString(), `<!doctype html><html><head lang="en">${agentTag}<title>Shop</title>`);
});

test('puts the agent tag after the doctype when there is no head tag', () => {
  const injected = injectAgentTag(Buffer.from('<!DOCTYPE html><p>café</p>'), agentTag);

  assert.equal(injected.toString(), `<!DOCTYPE html>${agentTag}<p>café</p>`);
});

test('injects the agent into pages and lets them be framed', async (context) => {
  const { proxyPort } = await startProxyInFrontOf((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'content-length': Buffer.byteLength('<html><head></head><body>Shop</body></html>'),
    });
    response.end('<html><head></head><body>Shop</body></html>');
  }, context);

  const reply = await sendRequest({ port: proxyPort, host: 'shop.branch-compare.localhost:3000' });

  assert.equal(reply.text, `<html><head>${agentTag}</head><body>Shop</body></html>`);
  assert.equal(reply.headers['x-frame-options'], undefined);
  assert.equal(reply.headers['content-security-policy'], undefined);
});

test('shows the application the hostname and port 3000 the browser used', async (context) => {
  const { proxyPort } = await startProxyInFrontOf((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.headers.host);
  }, context);

  const reply = await sendRequest({ port: proxyPort, host: 'shop.branch-compare.localhost:3000' });

  assert.equal(reply.text, 'shop.branch-compare.localhost:3000');
});

test('leaves HTML fragments fetched by scripts untouched', async (context) => {
  const { proxyPort } = await startProxyInFrontOf((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<head></head>');
  }, context);

  const reply = await sendRequest({
    port: proxyPort,
    host: 'shop.branch-compare.localhost:3000',
    headers: { 'sec-fetch-dest': 'empty' },
  });

  assert.equal(reply.text, '<head></head>');
});

test("keeps redirects to localhost:3000 on the application's own hostname", async (context) => {
  const { proxyPort } = await startProxyInFrontOf((request, response) => {
    response.writeHead(302, { location: 'http://localhost:3000/login?next=%2F' });
    response.end();
  }, context);

  const reply = await sendRequest({ port: proxyPort, host: 'shop.branch-compare.localhost:3000' });

  assert.equal(reply.headers.location, '/login?next=%2F');
});

test('answers 502 when the application is not listening', async (context) => {
  const closedServer = http.createServer();
  const closedPort = await listenOnFreePort(closedServer);
  await closeServer(closedServer);
  const proxy = http.createServer((request, response) =>
    proxyRequest(request, response, { port: closedPort, agentTag }),
  );
  const proxyPort = await listenOnFreePort(proxy);
  context.after(() => closeServer(proxy));

  const reply = await sendRequest({ port: proxyPort, host: 'shop.branch-compare.localhost:3000' });

  assert.equal(reply.status, 502);
});

test('passes websocket upgrades through to the application', async (context) => {
  const { application, proxyPort } = await startProxyInFrontOf(() => {}, context);
  application.on('upgrade', (request, socket) => {
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nupgraded ${request.url}`,
    );
  });

  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        'GET /hot-reload HTTP/1.1\r\nHost: shop.branch-compare.localhost:3000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
  });

  assert.match(received, /^HTTP\/1\.1 101 /);
  assert.match(received, /upgraded \/hot-reload$/);
});
