import net from 'node:net';

const applicationPort = 3000;
const publishedPort = 3001;

net
  .createServer((client) => {
    const application = net.connect(applicationPort, 'localhost');
    client.pipe(application);
    application.pipe(client);
    application.on('error', () => client.destroy());
    client.on('error', () => application.destroy());
  })
  .listen(publishedPort);
