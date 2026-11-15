import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/wxt/bin/wxt.mjs', import.meta.url));
const child = spawn(process.execPath, [cli, 'prepare'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});

let finished = false;
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes('Finished in') || text.includes('Generating types')) finished = true;
});

const deadline = setTimeout(() => {
  if (finished) {
    child.kill();
    process.exit(0);
  }
  console.error('WXT prepare timed out');
  child.kill();
  process.exit(1);
}, 30_000);

const watcher = setInterval(() => {
  if (!finished) return;
  clearInterval(watcher);
  clearTimeout(deadline);
  setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 150);
}, 100);

child.on('exit', (code) => {
  clearInterval(watcher);
  clearTimeout(deadline);
  process.exit(code ?? (finished ? 0 : 1));
});
