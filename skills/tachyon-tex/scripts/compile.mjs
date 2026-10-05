import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureBinary } from './installer.mjs';
import { texEnvironment, setupFull, installMissingPackage } from './full-tex.mjs';

export function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    options.onChild?.(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; options.onOutput?.(String(chunk)); });
    child.stderr.on('data', chunk => { stderr += chunk; options.onOutput?.(String(chunk)); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({code: code ?? 1, signal, stdout, stderr}));
  });
}
export async function requiresFull(args) {
  if (args.includes('--shell-escape') || args.includes('--tex-engine')) return true;
  const chosen = args.indexOf('--engine');
  if (chosen >= 0 && args[chosen + 1] !== 'auto') return args[chosen + 1] === 'latexmk';
  const input = args.find(arg => !arg.startsWith('-'));
  if (!input) return false;
  try {
    let file = path.resolve(input);
    if ((await fs.stat(file)).isDirectory()) { const i = args.indexOf('--main'); file = path.join(file, i >= 0 ? args[i + 1] : 'main.tex'); }
    const text = await fs.readFile(file, 'utf8');
    return /\\(?:directlua|usepackage(?:\[[^\]]*\])?\{(?:[^}]*,)?(?:biblatex|minted|luacode)(?:,[^}]*)?\})|%\s*!\s*TeX\s+program\s*=\s*(?:pdf|lua)latex/i.test(text);
  } catch { return false; }
}
export async function compile(args, {onOutput, onChild, detached = false, autoSetup = true} = {}) {
  const offline = args.includes('--offline') || args.includes('--only-cached');
  const binary = await ensureBinary({offline, notifyOnly: args.includes('--no-auto-update')});
  let env = await texEnvironment();
  if (autoSetup && await requiresFull(args)) {
    const probe = await capture('latexmk', ['-version'], {env}).catch(() => null);
    if (!probe || probe.code !== 0) {
      if (offline) throw new Error('Full TeX is required but unavailable offline. Run setup --full while online.');
      await setupFull(); env = await texEnvironment();
    }
  }
  const cleanArgs = args.filter(arg => !['--no-auto-update', '--no-update-check'].includes(arg));
  // Node owns release updates; the child must not race its managed installer.
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await capture(binary, [...cleanArgs, '--no-update-check'], {env: {...env, TACHYON_NO_UPDATE_CHECK: '1'}, onOutput, onChild, detached});
    if (result.code === 0 || offline || attempt === 3 || !result.stderr.includes('using latexmk')) break;
    if (!await installMissingPackage(result.stderr, {onOutput, onChild, detached})) break;
  }
  return result;
}
