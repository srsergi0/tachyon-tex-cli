import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['bin', 'scripts', 'test', 'skills/tachyon-tex/scripts']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], {stdio: 'inherit', windowsHide: true});
    if (result.status) process.exit(result.status);
  }
}
