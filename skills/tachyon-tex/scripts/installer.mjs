import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const repository = 'srsergi0/tachyon-tex-cli';
export function platform(osName = process.platform, arch = process.arch) {
  const systems = {win32: 'windows', darwin: 'macos', linux: 'linux'};
  if (!systems[osName] || !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported platform: ${osName}/${arch}. Supported: Windows, Linux, macOS on x64 or ARM64.`);
  return `${systems[osName]}-${arch}`;
}
export function cacheRoot() {
  if (process.env.TACHYON_CACHE_DIR) return path.resolve(process.env.TACHYON_CACHE_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'TachyonTex');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'tachyon-tex');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tachyon-tex');
}
export async function readJSON(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), {mode: 0o600});
  await fs.rename(temp, file);
}
export async function request(url, timeout = 15000) {
  const response = await fetch(url, {headers: {'User-Agent': 'tachyon-tex-cli/2', Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(timeout)});
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} from ${url}. Check network access and GitHub rate limits.`);
  return response;
}
export function checksumFor(text, name) {
  const row = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === name);
  if (!row || !/^[a-f0-9]{64}$/i.test(row[0])) throw new Error(`Release checksum missing for ${name}.`);
  return row[0].toLowerCase();
}
export async function verifiedDownload(url, destination, expected, fetcher = request) {
  const bytes = Buffer.from(await (await fetcher(url, 300000)).arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== expected.toLowerCase()) throw new Error('SHA-256 mismatch: download rejected; the installed binary was not changed.');
  await fs.mkdir(path.dirname(destination), {recursive: true});
  const temp = `${destination}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, {mode: 0o755});
  try { await fs.rename(temp, destination); } finally { await fs.rm(temp, {force: true}); }
  return hash;
}
export async function ensureBinary({offline = false, update = false, notifyOnly = false} = {}) {
  if (process.env.TACHYON_BINARY) {
    const binary = path.resolve(process.env.TACHYON_BINARY);
    await fs.access(binary);
    return binary;
  }
  const root = cacheRoot();
  const stateFile = path.join(root, 'installation.json');
  let state = await readJSON(stateFile);
  const target = platform();
  let valid = false;
  if (state?.platform === target && state.binary && state.sha256) {
    try { valid = createHash('sha256').update(await fs.readFile(state.binary)).digest('hex') === state.sha256; } catch { /* install below */ }
  }
  if (offline && !valid) throw new Error('No verified binary is cached. Run setup once while online before using --offline.');
  const check = update || !valid || (!offline && !process.env.TACHYON_NO_UPDATE_CHECK && Date.now() - (state.checkedAt || 0) > 3600000);
  if (!check) return state.binary;
  let release;
  try { release = await (await request(`https://api.github.com/repos/${repository}/releases/latest`, valid ? 2500 : 15000)).json(); }
  catch (error) { if (valid && !update) { console.error(`Version check unavailable: ${error.message} Using cached ${state.version}.`); return state.binary; } throw error; }
  const tag = release.tag_name;
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('Invalid release version returned by GitHub.');
  if (valid && state.version === tag) { state.checkedAt = Date.now(); await atomicJSON(stateFile, state); return state.binary; }
  if (valid) {
    console.error(`New version available: ${tag} (installed: ${state.version}).`);
    if (notifyOnly && !update) { state.checkedAt = Date.now(); await atomicJSON(stateFile, state); return state.binary; }
  }
  const name = `tachyon-tex-${tag}-${target}${process.platform === 'win32' ? '.exe' : ''}`;
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const expected = checksumFor(await (await request(`${base}/SHA256SUMS`)).text(), name);
  const binary = path.join(root, 'bin', tag, name);
  console.error(`Installing ${tag} for ${target} (SHA-256 verified)...`);
  const sha256 = await verifiedDownload(`${base}/${name}`, binary, expected);
  await atomicJSON(stateFile, {version: tag, platform: target, binary, sha256, checkedAt: Date.now()});
  return binary;
}
