import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const browser = process.argv[2] ?? 'firefox';
const cli = fileURLToPath(new URL('../node_modules/wxt/bin/wxt.mjs', import.meta.url));
const child = spawn(process.execPath, [cli, 'build', '-b', browser, '--mv3'], {
  // WXT 0.21 keeps a spinner/readline handle alive on Windows after a successful
  // one-shot build. Close stdin, and exit once the success line is printed.
  stdio: ['ignore', 'pipe', 'inherit'],
});

let finished = false;
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes('Finished in') || text.includes('Built extension')) finished = true;
});

const deadline = setTimeout(() => {
  if (finished) {
    child.kill();
    process.exit(0);
  }
  console.error('WXT build timed out');
  child.kill();
  process.exit(1);
}, 60_000);

const watcher = setInterval(() => {
  if (!finished) return;
  clearInterval(watcher);
  clearTimeout(deadline);
  // Give stdout a moment to flush, then stop WXT's lingering handle.
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
