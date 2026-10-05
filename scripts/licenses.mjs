import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {maxBuffer: 16 * 1024 * 1024, windowsHide: true}));
await fs.mkdir('assets/licenses/rust', {recursive: true});
for (const pkg of metadata.packages) {
  if (!pkg.source) continue;
  const directory = path.dirname(pkg.manifest_path);
  const names = (await fs.readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:$|[-._])/i.test(name));
  const dest = path.join('assets/licenses/rust', `${pkg.name}-${pkg.version}`);
  await fs.mkdir(dest, {recursive: true});
  await fs.writeFile(path.join(dest, 'source.txt'), `${pkg.name} ${pkg.version}\n${pkg.source}\nLicense: ${pkg.license || pkg.license_file || 'see source'}\n${pkg.repository || ''}\n`);
  for (const name of names) if ((await fs.stat(path.join(directory, name))).isFile()) await fs.copyFile(path.join(directory, name), path.join(dest, name));
}
