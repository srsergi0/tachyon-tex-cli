import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from '../skills/tachyon-tex/scripts/compile.mjs';
import { snapshot } from '../skills/tachyon-tex/scripts/watch.mjs';

const launcher = fileURLToPath(new URL('../bin/tachyon-tex.mjs', import.meta.url));
const root = path.dirname(path.dirname(launcher));
const binary = process.env.TACHYON_BINARY || path.join(root, 'target', 'debug', `tachyon-tex${process.platform === 'win32' ? '.exe' : ''}`);
const pause = ms => new Promise(r => setTimeout(r, ms));

test('help and version work with no release, network, or installed binary', async () => {
  for (const arg of ['--help', '--version']) {
    const r = await capture(process.execPath, [launcher, arg], {env: {...process.env, TACHYON_BINARY: '/missing/binary'}});
    assert.equal(r.code, 0); assert.match(r.stdout, /Tachyon|tachyon/);
  }
});
test('source watcher sees local package and image changes, skips generated output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tachyon-snapshot-'));
  try {
    await fs.writeFile(path.join(dir, 'local.sty'), 'A'); const first = await snapshot(dir);
    await fs.writeFile(path.join(dir, 'paper.aux'), 'ignored'); assert.equal(await snapshot(dir), first);
    await fs.writeFile(path.join(dir, 'figure.png'), 'graphic'); assert.notEqual(await snapshot(dir), first);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
test('real background preview recompiles, preserves PDFs on failure, provides logs, and stops', {timeout: 240000}, async () => {
  await fs.access(binary); // Missing binaries are failures, not silently skipped tests.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tachyon-live-á-'));
  const project = path.join(dir, 'project with spaces'); await fs.mkdir(project);
  const main = path.join(project, 'main.tex'), body = path.join(project, 'body.tex');
  await fs.writeFile(main, '\\documentclass{article}\n\\begin{document}\\input{body}\\end{document}\n'); await fs.writeFile(body, 'First document.');
  const env = {...process.env, TACHYON_BINARY: binary, TACHYON_CACHE_DIR: path.join(dir, 'cache'), TACHYON_NO_UPDATE_CHECK: '1'};
  const run = (...args) => capture(process.execPath, [launcher, ...args], {env});
  let session;
  async function until(predicate) {
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      const result = await run('status', project, '--json'); assert.equal(result.code, 0, result.stderr);
      const state = JSON.parse(result.stdout)[0]; if (state && predicate(state)) return state;
      await pause(300);
    }
    throw new Error(`Preview did not reach expected state. ${(await run('logs', project)).stdout}`);
  }
  try {
    const started = await run('background', project, '--json', '--interval', '100'); assert.equal(started.code, 0, started.stderr); session = JSON.parse(started.stdout);
    assert.equal(session.token, undefined, 'Never expose control token in public output');
    session = await until(s => s.state === 'ready');
    const first = await fs.readFile(session.output); assert.ok(first.subarray(0, 5).equals(Buffer.from('%PDF-')));
    const repeated = await run('background', project, '--json'); assert.equal(repeated.code, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).pid, session.pid);
    const preview = await fetch(session.url); assert.equal(preview.status, 200); assert.match(await preview.text(), /EventSource/);
    const partial = await fetch(`${session.url}/document.pdf`, {headers: {Range: 'bytes=0-4'}}); assert.equal(partial.status, 206); assert.equal(await partial.text(), '%PDF-');
    assert.equal((await fetch(`${session.url}/api/stop`, {method: 'POST'})).status, 403);
    await fs.writeFile(body, 'Second document changed.'); session = await until(s => s.state === 'ready' && s.revision >= 2);
    const good = await fs.readFile(session.output); assert.notDeepEqual(good, first);
    await fs.writeFile(body, '\\undefinedTachyonCommand'); session = await until(s => s.state === 'error'); assert.match(session.error, /Undefined control sequence/);
    assert.deepEqual(await fs.readFile(session.output), good);
    const logs = await run('logs', project); assert.equal(logs.code, 0); assert.match(logs.stdout, /Undefined control sequence/);
    await fs.writeFile(body, 'Recovered document.'); session = await until(s => s.state === 'ready' && s.revision >= 3);
    const stopped = await run('stop', project); assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse((await run('status', project, '--json')).stdout)[0].state, 'stopped');
    await assert.rejects(fetch(session.url, {signal: AbortSignal.timeout(1500)}));
  } finally {
    await run('stop', '--all'); await pause(300);
    await fs.rm(dir, {recursive: true, force: true});
  }
});
