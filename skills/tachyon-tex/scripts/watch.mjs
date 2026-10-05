import { promises as fs } from 'node:fs';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cacheRoot, atomicJSON, readJSON } from './installer.mjs';
import { compile } from './compile.mjs';

const ignoredDirs = new Set(['.git', 'node_modules', 'target', '.tachyon-tex', 'dist']);
const generated = /\.(?:aux|log|toc|out|bbl|blg|bcf|fls|fdb_latexmk|synctex(?:\.gz)?|run\.xml)$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function snapshot(root, excluded = []) {
  const files = [];
  async function walk(dir) {
    for (const item of await fs.readdir(dir, {withFileTypes: true})) {
      const name = path.join(dir, item.name);
      if (excluded.includes(name) || item.isSymbolicLink()) continue;
      if (item.isDirectory()) { if (!ignoredDirs.has(item.name)) await walk(name); }
      else if (!generated.test(item.name)) { const stat = await fs.stat(name).catch(() => null); if (stat) files.push(`${name}:${stat.size}:${stat.mtimeMs}`); }
    }
  }
  await walk(root);
  return createHash('sha256').update(files.sort().join('\n')).digest('hex');
}
export async function sessionConfig(input, args, {port = 0, interval = 500} = {}) {
  const real = await fs.realpath(path.resolve(input));
  const stat = await fs.stat(real);
  if (!stat.isDirectory() && !/\.tex$/i.test(real)) throw new Error('Watch accepts a .tex file or project directory. Extract ZIP projects first.');
  const mainIndex = args.indexOf('--main');
  const id = createHash('sha256').update(`${real}\0${mainIndex >= 0 ? args[mainIndex + 1] : ''}`).digest('hex').slice(0, 16);
  const dir = path.join(cacheRoot(), 'sessions', id);
  await fs.mkdir(dir, {recursive: true});
  let output;
  const index = args.findIndex(arg => ['-o', '--output'].includes(arg));
  if (index >= 0) output = path.resolve(args[index + 1]);
  else if (args.includes('--out-dir')) throw new Error('Use --output for watch mode instead of --out-dir.');
  else { output = path.join(dir, 'preview.pdf'); args = [...args, '--output', output]; }
  return {id, input: real, root: stat.isDirectory() ? real : path.dirname(real), args: [real, ...args], output, dir, port, interval, token: randomBytes(24).toString('hex')};
}
export async function control(session, action = 'status') {
  if (!session?.url || !session.token) return null;
  try {
    const response = await fetch(`${session.url}/api/${action}`, {method: action === 'stop' ? 'POST' : 'GET', headers: {'X-Tachyon-Token': session.token}, signal: AbortSignal.timeout(1500)});
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
export async function sessions(input) {
  const dir = path.join(cacheRoot(), 'sessions');
  const entries = await fs.readdir(dir).catch(() => []);
  const resolved = input ? await fs.realpath(path.resolve(input)) : null;
  const found = [];
  for (const id of entries) {
    const saved = await readJSON(path.join(dir, id, 'session.json'));
    if (!saved || (resolved && saved.input !== resolved)) continue;
    const live = await control(saved);
    found.push({...saved, ...live, state: live?.state || 'stopped'});
  }
  return found;
}
export function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, {detached: true, windowsHide: true, stdio: 'ignore'});
  child.on('error', error => console.error(`Could not open browser: ${error.message}. Open ${url} manually.`)); child.unref();
}
export async function background(config) {
  config.background = true;
  const file = path.join(config.dir, 'config.json');
  const lock = path.join(config.dir, 'start.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx'); } catch { throw new Error('Another startup is in progress for this project. Retry shortly.'); }
  try {
    const existing = await readJSON(path.join(config.dir, 'session.json'));
    const live = await control(existing);
    if (live) return {...existing, ...live};
    await atomicJSON(file, config);
    const log = await fs.open(path.join(config.dir, 'watch.log'), 'a');
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '__worker', file], {cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: process.env});
    let spawnError; worker.on('error', error => { spawnError = error; }); worker.unref(); await log.close();
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      const saved = await readJSON(path.join(config.dir, 'session.json'));
      if (saved?.token === config.token && await control(saved)) return saved;
      await sleep(100);
    }
    throw new Error(`Background startup failed. Inspect ${path.join(config.dir, 'watch.log')}.`);
  } finally { await handle.close(); await fs.rm(lock, {force: true}); }
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tachyon TeX live preview</title><style>body{margin:0;font:16px system-ui;background:#171b24;color:#eee}header{padding:14px 20px}pre{white-space:pre-wrap;background:#301f24;margin:0;padding:12px;max-height:25vh;overflow:auto}iframe{width:100%;height:calc(100vh - 65px);border:0}a{color:#acd6ff}</style><header><b>Tachyon TeX</b> · <span id="state">Connecting…</span> · <a href="/document.pdf" target="_blank">Open PDF</a></header><pre id="error" hidden></pre><iframe title="Compiled PDF"></iframe><script>let revision=-1;const events=new EventSource('/events');events.onmessage=e=>{const s=JSON.parse(e.data);document.querySelector('#state').textContent=s.state;const error=document.querySelector('#error');error.hidden=!s.error;error.textContent=s.error||'';if(s.revision>0&&s.revision!==revision){revision=s.revision;document.querySelector('iframe').src='/document.pdf?v='+revision;}};events.onerror=()=>document.querySelector('#state').textContent='Disconnected';</script></html>`;

export async function watch(config) {
  if (config.binary) process.env.TACHYON_BINARY = config.binary;
  function emit(text) { process.stdout.write(text); if (!config.background) appendFileSync(path.join(config.dir, 'watch.log'), text); }
  let stopped = false, active = null, timer, revision = 0;
  const clients = new Set();
  const state = {...config, pid: process.pid, state: 'starting', revision, startedAt: new Date().toISOString(), error: null};
  const sessionFile = path.join(config.dir, 'session.json');
  async function publish() { state.revision = revision; await atomicJSON(sessionFile, state); for (const client of clients) client.write(`data: ${JSON.stringify(publicState())}\n\n`); }
  function publicState() { const {token, args, ...publicData} = state; return publicData; }
  async function shutdown() {
    if (stopped) return; stopped = true; clearTimeout(timer);
    if (active?.pid && active.exitCode === null) {
      if (process.platform === 'win32') { await new Promise(resolve => { const kill = spawn('taskkill.exe', ['/PID', String(active.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}); kill.on('error', resolve); kill.on('close', resolve); }); }
      else { try { process.kill(-active.pid, 'SIGTERM'); } catch { active.kill(); } }
    }
    state.state = 'stopped'; await publish();
    for (const client of clients) client.end(); server.close(); server.closeAllConnections();
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.headers.host !== `127.0.0.1:${server.address().port}` && req.headers.host !== `localhost:${server.address().port}`) { res.writeHead(403).end('Forbidden host'); return; }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-tachyon-token'] !== config.token || (req.headers.origin && req.headers.origin !== state.url)) { res.writeHead(403).end('Forbidden'); return; }
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/status') res.end(JSON.stringify(publicState()));
        else if (url.pathname === '/api/stop' && req.method === 'POST') { res.end(JSON.stringify({ok: true})); await shutdown(); }
        else res.writeHead(404).end('{}');
      } else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
      else if (url.pathname === '/events') { res.writeHead(200, {'Content-Type': 'text/event-stream', Connection: 'keep-alive'}); res.write(`data: ${JSON.stringify(publicState())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); }
      else if (url.pathname === '/document.pdf') {
        const bytes = await fs.readFile(config.output).catch(() => null);
        if (!bytes) { res.writeHead(404).end('No successful compilation yet.'); return; }
        res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Accept-Ranges', 'bytes');
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) { const start = Number(range[1]), end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1); if (start > end || start >= bytes.length) { res.writeHead(416, {'Content-Range': `bytes */${bytes.length}`}).end(); return; } res.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1}); res.end(bytes.subarray(start, end + 1)); }
        else res.end(bytes);
      } else res.writeHead(404).end('Not found');
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  state.url = `http://127.0.0.1:${server.address().port}`;
  await publish(); emit(`Live preview: ${state.url}\n`);
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  let previous = await snapshot(config.root, [config.output, config.dir]);
  async function build() {
    state.state = 'compiling'; state.error = null; await publish();
    emit(`[${new Date().toISOString()}] Compiling ${config.input}\n`);
    try {
      const result = await compile([...config.args, '--json'], {autoSetup: false, detached: process.platform !== 'win32', onChild: child => { active = child; }, onOutput: emit});
      if (stopped) return;
      active = null; state.lastBuildAt = new Date().toISOString(); state.exitCode = result.code;
      state.state = result.code === 0 ? 'ready' : 'error'; state.error = result.code === 0 ? null : result.stderr.slice(-16000);
      if (result.code === 0) revision++;
    } catch (error) { if (stopped) return; state.state = 'error'; state.error = error.message; }
    if (!stopped) await publish();
  }
  async function poll() {
    if (stopped) return;
    try { const next = await snapshot(config.root, [config.output, config.dir]); if (next !== previous) { previous = next; await build(); } }
    catch (error) { state.state = 'error'; state.error = `Cannot watch sources: ${error.message}`; await publish(); }
    if (!stopped) timer = setTimeout(poll, config.interval);
  }
  await build(); if (!stopped) timer = setTimeout(poll, config.interval);
  return state;
}
