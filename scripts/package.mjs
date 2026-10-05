import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import './licenses.mjs';
const [target, platform, tag = 'v2.0.0'] = process.argv.slice(2);
if (!target || !platform) throw new Error('Usage: node scripts/package.mjs <rust-target> <platform> [vVERSION]');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const cargoVersion = (await fs.readFile('Cargo.toml', 'utf8')).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (tag !== `v${pkg.version}` || cargoVersion !== pkg.version) throw new Error('Release tag, Cargo version, and launcher version must match.');
const suffix = platform.startsWith('windows') ? '.exe' : '';
const name = `tachyon-tex-${tag}-${platform}${suffix}`;
await fs.mkdir('dist', {recursive: true});
await fs.copyFile(path.join('target', target, 'release', `tachyon-tex${suffix}`), path.join('dist', name));
const sha = createHash('sha256').update(await fs.readFile(path.join('dist', name))).digest('hex');
await fs.writeFile(path.join('dist', `${platform}.sha256`), `${sha}  ${name}\n`);
// Raw assets support dependency-free install/update. Companion archives preserve
// the project and embedded-engine license notices when redistributed.
const stage = path.join('dist', 'packages', `tachyon-tex-${tag}-${platform}`);
await fs.mkdir(stage, {recursive: true});
await fs.copyFile(path.join('dist', name), path.join(stage, `tachyon-tex${suffix}`));
for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(file, path.join(stage, file));
await fs.cp('assets/licenses', path.join(stage, 'licenses'), {recursive: true});
await fs.cp('skills', path.join(stage, 'skills'), {recursive: true});
console.log(`Packaged ${platform}: ${sha}`);
