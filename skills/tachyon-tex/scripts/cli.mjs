#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureBinary, cacheRoot, readJSON } from './installer.mjs';
import { compile, requiresFull, capture } from './compile.mjs';
import { setupFull, texEnvironment } from './full-tex.mjs';
import { background, watch, sessionConfig, sessions, control, openBrowser } from './watch.mjs';

const help = `Tachyon TeX 2.0.0 — portable LaTeX compiler and live preview

Usage: tachyon-tex [compile] <file.tex|directory|project.zip> [options]
       tachyon-tex <command> [options]

Commands:
  compile <input>       Compile a document (the default command)
  setup                Download and verify the binary for this OS/CPU
  setup --full         Install portable full TeX (latexmk, Biber, LuaLaTeX)
  setup --full --all-packages  Install the complete TeX Live package scheme
  update               Check for and install the latest verified release
  doctor               Report the platform, cache, and engine availability
  watch <input>        Watch source changes and serve a live PDF in the browser
  background <input>   Start watch in a detached background process
  status [input]       Show all sessions, or sessions for one project
  logs [input]         Read a session's persistent compilation log
  stop [input]         Stop a session; use --all to stop every session

Compilation options:
  --main <file.tex>     Main file relative to a directory or ZIP
  -o, --output <PDF>    Destination PDF (default: beside the input)
  --out-dir <DIR>      Output directory (compile only)
  --engine <BACKEND>   auto (default), tectonic, or latexmk
  --tex-engine <NAME>  xelatex (default), pdflatex, or lualatex
  --shell-escape       Allow external commands for trusted documents
  --offline            Use cached binary/packages; disable network access
  --bundle <PATH|URL>  Tectonic package bundle
  --keep-logs          Save the compiler log
  -k, --keep-intermediates  Save auxiliary files
  --synctex            Generate SyncTeX data
  -q, --quiet          Suppress progress; keep error diagnostics
  --json               Machine-readable compilation result or session status
  --no-update-check    Skip the startup release check
  --no-auto-update     Notify about a release without installing it

Watch/session options:
  --background         Run watch in the background
  --open               Open the local preview URL in the default browser
  --port <0..65535>     Preview port (default: choose a free port)
  --interval <MS>       Source polling interval (default: 500; minimum: 100)
  --follow             Stream new log output until Ctrl+C
  --all                Stop all sessions

  -h, --help           Show this help without downloading anything
  -V, --version        Show the launcher version

Examples (GitHub distribution; no npm publication required):
  npx --yes github:srsergi0/tachyon-tex-cli main.tex --json
  npx --yes github:srsergi0/tachyon-tex-cli background . --main main.tex --open
  npx --yes github:srsergi0/tachyon-tex-cli status --json
  npx --yes github:srsergi0/tachyon-tex-cli logs --follow
  npx --yes github:srsergi0/tachyon-tex-cli stop

Node.js 22+ is required for this launcher. Native release binaries need no Node
or Docker. First compilation downloads LaTeX packages; --offline requires a warm
cache. Full TeX installs automatically for detected LuaLaTeX/Biber requirements.
External tools/fonts must be installed if a document requires them.
Docs: https://github.com/srsergi0/tachyon-tex-cli
`;

function takeOption(args, name, fallback) {
  const i = args.indexOf(name); if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${name} requires a value.`);
  return args.splice(i, 2)[1];
}
function flag(args, name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }
function showSession(session, json = false) {
  const {token, args, ...safe} = session;
  console.log(json ? JSON.stringify(safe) : `${session.state}: ${session.input}\nPreview: ${session.url || 'unavailable'}\nLog: ${path.join(session.dir, 'watch.log')}`);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || !args.length) { console.log(help); return; }
  if (args.includes('--version') || args.includes('-V')) { console.log('tachyon-tex launcher 2.0.0'); return; }
  if (args.includes('--no-update-check')) process.env.TACHYON_NO_UPDATE_CHECK = '1';
  let command = args[0];
  const commands = ['compile', 'setup', 'update', 'doctor', 'watch', 'background', 'status', 'logs', 'stop', '__worker'];
  if (commands.includes(command)) args.shift(); else command = 'compile';
  if (command === '__worker') { const config = await readJSON(args[0]); if (!config) throw new Error('Missing worker configuration.'); await watch(config); return; }
  if (command === 'setup' || command === 'update') {
    if (args.includes('--offline') && (command === 'update' || args.includes('--full') || args.includes('--all-packages'))) throw new Error('Update/full TeX setup requires network access. Remove --offline or compile with an existing cache.');
    await ensureBinary({update: command === 'update', offline: args.includes('--offline'), notifyOnly: args.includes('--no-auto-update')});
    if (args.includes('--full') || args.includes('--all-packages')) await setupFull({allPackages: args.includes('--all-packages')});
    console.log('Tachyon TeX is ready.'); return;
  }
  if (command === 'doctor') {
    const binary = await ensureBinary({offline: args.includes('--offline')});
    const report = await capture(binary, ['doctor'], {env: await texEnvironment()});
    process.stdout.write(report.stdout); process.stderr.write(report.stderr); process.exitCode = report.code; return;
  }
  if (['status', 'logs', 'stop'].includes(command)) {
    const json = flag(args, '--json'), all = flag(args, '--all'), follow = flag(args, '--follow');
    const input = args[0]; if (args.length > 1 || input?.startsWith('-')) throw new Error(`Unexpected session argument: ${args.join(' ')}`);
    const found = await sessions(input);
    if (command === 'status') { if (json) console.log(JSON.stringify(found.map(({token, args, ...safe}) => safe))); else if (!found.length) console.log('No watch sessions.'); else found.forEach(s => showSession(s)); return; }
    const active = found.filter(s => s.state !== 'stopped');
    const chosen = input ? found : (active.length ? active : found);
    if (command === 'stop') {
      if (!all && chosen.length > 1) throw new Error('Several sessions exist. Specify a project path or use stop --all.');
      for (const session of chosen) {
        if (session.state === 'stopped') { console.log(`Already stopped: ${session.input}`); continue; }
        const result = await control(session, 'stop'); if (!result?.ok) throw new Error(`Could not stop ${session.input}; inspect its log.`);
        for (let i = 0; i < 100 && await control(session); i++) await new Promise(r => setTimeout(r, 100));
        if (await control(session)) throw new Error(`Session is still stopping: ${session.input}`);
        console.log(`Stopped: ${session.input}`);
      }
      if (!chosen.length) console.log('No watch sessions.'); return;
    }
    if (chosen.length !== 1) throw new Error(chosen.length ? 'Several logs exist. Specify a project path.' : 'No watch log exists. Start watch or background first.');
    const logFile = path.join(chosen[0].dir, 'watch.log'); let offset = 0;
    async function print() { const bytes = await fs.readFile(logFile).catch(() => Buffer.alloc(0)); if (bytes.length < offset) offset = 0; process.stdout.write(bytes.subarray(offset)); offset = bytes.length; }
    await print(); if (follow) { const timer = setInterval(() => print().catch(error => { console.error(error.message); clearInterval(timer); }), 500); process.once('SIGINT', () => { clearInterval(timer); }); } return;
  }
  if (command === 'watch' || command === 'background') {
    const detached = flag(args, '--background') || command === 'background', open = flag(args, '--open'), json = flag(args, '--json');
    const port = Number(takeOption(args, '--port', '0')), interval = Number(takeOption(args, '--interval', '500'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
    if (!Number.isFinite(interval) || interval < 100) throw new Error('--interval must be at least 100 milliseconds.');
    const input = args.shift(); if (!input) throw new Error(`${command} requires an input path.`);
    const binary = await ensureBinary({offline: args.includes('--offline'), notifyOnly: args.includes('--no-auto-update')});
    if (await requiresFull([input, ...args])) {
      const probe = await capture('latexmk', ['-version'], {env: await texEnvironment()}).catch(() => null);
      if (!probe || probe.code !== 0) { if (args.includes('--offline')) throw new Error('Full TeX is unavailable offline. Run setup --full first.'); await setupFull(); }
    }
    const config = await sessionConfig(input, args, {port, interval});
    config.binary = binary;
    if (detached) { const session = await background(config); showSession(session, json); if (open) openBrowser(session.url); }
    else {
      const existing = (await sessions(input)).find(s => s.state !== 'stopped'); if (existing) throw new Error(`A session is already running at ${existing.url}. Use stop before starting another.`);
      if (open) { const timer = setInterval(async () => { const saved = await readJSON(path.join(config.dir, 'session.json')); if (saved?.token === config.token && saved.url) { clearInterval(timer); openBrowser(saved.url); } }, 100); timer.unref(); }
      await watch(config);
    }
    return;
  }
  const result = await compile(args);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code;
}
main().catch(error => { console.error(`error: ${error.message}`); if (process.argv.includes('--json')) console.log(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1; });
