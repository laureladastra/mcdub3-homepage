// Turns the zip that worker.js generates into a normal browser download, streamed as it is made: a static site
// has no server to send a 3.4 GB file from, and holding it in memory is not an option.

const jobs = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const { type, id, filename, size } = event.data ?? {};
  if (type === 'download') {
    // ports[0] carries the zip, ports[1] says the download is ready to be opened
    jobs.set(id, { port: event.ports[0], filename, size });
    event.ports[1].postMessage('ready');
  }
  if (type === 'claim') {
    // a forced reload opens the page without this worker: take it back
    event.waitUntil(self.clients.claim());
  }
  // 'ping' just keeps this worker awake during a long download
});

self.addEventListener('fetch', (event) => {
  const match = new URL(event.request.url).pathname.match(/\/download\/([^/]+)\/[^/]+$/);
  const job = match && jobs.get(match[1]);
  if (!job) {
    return;
  }
  jobs.delete(match[1]);
  const { port, filename, size } = job;
  const stream = new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        port.onmessage = ({ data }) => {
          if (data.error) {
            controller.error(new Error(data.error));
          } else if (data.done) {
            controller.close();
          } else {
            controller.enqueue(data.chunk);
          }
          resolve();
        };
        port.postMessage('pull');
      });
    },
    cancel() {
      port.postMessage('cancel');
    },
  });
  event.respondWith(new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  }));
});
