import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const port = Number(process.argv[2] ?? 8123);

const server = createServer(async (request, response) => {
  const name = (request.url ?? '/').split('?')[0].replace(/^\//, '') || 'article.html';
  if (!/^[\w.-]+$/.test(name)) {
    response.writeHead(400);
    response.end('bad path');
    return;
  }
  try {
    const body = await readFile(join(fixtures, name));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${port}/article.html`));
