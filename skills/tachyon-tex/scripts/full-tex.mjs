import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cacheRoot, request, verifiedDownload, readJSON, atomicJSON } from './installer.mjs';

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env, shell: false, windowsHide: true, stdio: 'inherit'});
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} failed with exit code ${code}.`)));
  });
}
async function findBins(root, depth = 0) {
  if (depth > 5) return [];
  let entries; try { entries = await fs.readdir(root, {withFileTypes: true}); } catch { return []; }
  const bins = [];
  if (entries.some(e => /^(?:xelatex|latexmk|perl)(?:\.exe|\.bat)?$/.test(e.name))) bins.push(root);
  for (const e of entries) if (e.isDirectory() && !['texmf-dist', 'doc', 'fonts', 'source'].includes(e.name)) bins.push(...await findBins(path.join(root, e.name), depth + 1));
  return bins;
}
export async function texEnvironment() {
  const state = await readJSON(path.join(cacheRoot(), 'full-tex.json'));
  const env = process.platform === 'win32' ? {...process.env, LC_ALL: 'C', LANG: 'C'} : {...process.env};
  return state?.bins?.length ? {...env, PATH: [...state.bins, process.env.PATH || ''].join(path.delimiter)} : env;
}
export async function setupFull({allPackages = false} = {}) {
  const stateFile = path.join(cacheRoot(), 'full-tex.json');
  let state = await readJSON(stateFile);
  if (!state || !(await Promise.all(state.bins.map(p => fs.access(p).then(() => true, () => false)))).every(Boolean)) {
    const release = await (await request('https://api.github.com/repos/rstudio/tinytex-releases/releases/latest')).json();
    const version = release.tag_name;
    if (!/^v\d{4}\.\d{2}(?:\.\d+)?$/.test(version)) throw new Error('Invalid TinyTeX release version.');
    const name = process.platform === 'win32' ? `TinyTeX-${version}.zip` : process.platform === 'darwin' ? `TinyTeX-darwin-${version}.tar.xz` : `TinyTeX-linux-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-${version}.tar.xz`;
    const asset = release.assets.find(a => a.name === name);
    if (!asset?.digest?.startsWith('sha256:')) throw new Error(`Verified TinyTeX asset unavailable: ${name}. Install TeX Live or MiKTeX and put latexmk on PATH.`);
    const archive = path.join(cacheRoot(), 'downloads', name);
    console.error(`Installing full TeX support: ${name}. This may take several minutes.`);
    await verifiedDownload(asset.browser_download_url, archive, asset.digest.slice(7));
    const base = path.join(cacheRoot(), 'full-tex'); await fs.mkdir(base, {recursive: true});
    const staging = await fs.mkdtemp(path.join(base, '.install-'));
    try {
      await run('tar', ['-xf', archive, '-C', staging]);
      const destination = path.join(cacheRoot(), 'full-tex', version);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      try { await fs.rename(staging, destination); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      const bins = await findBins(destination);
      if (!bins.length) throw new Error('TinyTeX extraction did not contain engine executables.');
      state = {version, root: destination, bins}; await atomicJSON(stateFile, state);
    } finally { await fs.rm(staging, {recursive: true, force: true}); }
    await fs.rm(archive, {force: true});
  }
  const env = await texEnvironment();
  // TeX Live's package manager is a batch script on Windows. Invoke the known
  // interpreter with argument arrays; never interpolate document paths into a shell.
  const tlmgr = path.join(state.bins.find(p => p.includes(`${path.sep}bin${path.sep}`)) || state.bins[0], process.platform === 'win32' ? 'tlmgr.bat' : 'tlmgr');
  if (process.platform === 'win32') {
    // Locate the script using the bin's canonical distribution root.
    const bin = path.dirname(tlmgr);
    const script = path.resolve(bin, '..', '..', 'texmf-dist', 'scripts', 'texlive', 'tlmgr.pl');
    await run('perl', [script, 'install', ...(allPackages ? ['scheme-full'] : ['latexmk', 'biber', 'biblatex', 'luatex', 'luaotfload', 'fontspec'])], env);
  } else {
    await run(tlmgr, ['install', ...(allPackages ? ['scheme-full'] : ['latexmk', 'biber', 'biblatex', 'luatex', 'luaotfload', 'fontspec'])], env);
  }
  console.error(`Full TeX ready (${state.version}).`);
  return state;
}
