import http from 'node:http';
import net from 'node:net';

const headOpeningPattern = /<head(\s[^>]*)?>/i;
const doctypePattern = /^\s*<!doctype[^>]*>/i;
const longestDocumentStartBytes = 65536;
const believedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(?=\/|$)/;
const headersBlockingFraming = ['content-length', 'x-frame-options', 'content-security-policy'];

export function injectAgentTag(documentStart, agentTag) {
  const searchableText = documentStart.toString('latin1');
  const anchor = headOpeningPattern.exec(searchableText) ?? doctypePattern.exec(searchableText);
  const insertionOffset = anchor ? anchor.index + anchor[0].length : 0;
  return Buffer.concat([
    documentStart.subarray(0, insertionOffset),
    Buffer.from(agentTag),
    documentStart.subarray(insertionOffset),
  ]);
}

function isFramedDocument(request, upstreamResponse) {
  const fetchDestination = request.headers['sec-fetch-dest'] ?? 'document';
  const isDocumentRequest = fetchDestination === 'document' || fetchDestination === 'iframe';
  const isHtml = (upstreamResponse.headers['content-type'] ?? '').includes('text/html');
  const { statusCode } = upstreamResponse;
  const hasBody = request.method !== 'HEAD' && statusCode !== 204 && (statusCode < 300 || statusCode >= 400);
  return isDocumentRequest && isHtml && hasBody;
}

function pipeWithAgentTag(upstreamResponse, response, agentTag) {
  let pendingStart = Buffer.alloc(0);
  let isInjected = false;
  const writeInjectedStart = () => {
    isInjected = true;
    response.write(injectAgentTag(pendingStart, agentTag));
  };
  upstreamResponse.on('data', (chunk) => {
    if (isInjected) {
      response.write(chunk);
      return;
    }
    pendingStart = Buffer.concat([pendingStart, chunk]);
    const hasHeadOpening = headOpeningPattern.test(pendingStart.toString('latin1'));
    if (hasHeadOpening || pendingStart.length > longestDocumentStartBytes) writeInjectedStart();
  });
  upstreamResponse.on('end', () => {
    if (!isInjected) writeInjectedStart();
    response.end();
  });
}

export function proxyRequest(request, response, { port, agentTag }) {
  const headers = { ...request.headers };
  delete headers['accept-encoding'];
  const upstreamRequest = http.request(
    { host: '127.0.0.1', port, method: request.method, path: request.url, headers },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      if (responseHeaders.location) {
        responseHeaders.location = responseHeaders.location.replace(believedOriginPattern, '') || '/';
      }
      if (!isFramedDocument(request, upstreamResponse)) {
        response.writeHead(upstreamResponse.statusCode, responseHeaders);
        upstreamResponse.pipe(response);
        return;
      }
      for (const headerName of headersBlockingFraming) delete responseHeaders[headerName];
      response.writeHead(upstreamResponse.statusCode, responseHeaders);
      pipeWithAgentTag(upstreamResponse, response, agentTag);
    },
  );
  upstreamRequest.on('error', () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('The application did not answer on port 3000.');
  });
  response.on('close', () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

export function proxyUpgrade(request, socket, head, port) {
  const upstreamSocket = net.connect(port, '127.0.0.1', () => {
    const headerLines = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headerLines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstreamSocket.write(`${request.method} ${request.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
    upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamSocket.on('error', () => socket.destroy());
  socket.on('error', () => upstreamSocket.destroy());
}
