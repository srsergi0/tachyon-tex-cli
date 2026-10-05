import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from '../skills/tachyon-tex/scripts/compile.mjs';
const launcher = fileURLToPath(new URL('../bin/tachyon-tex.mjs', import.meta.url));
const run = args => capture(process.execPath, [launcher, ...args], {env: process.env, onOutput: text => process.stderr.write(text)});
const setup = await run(['setup', '--full']); assert.equal(setup.code, 0, setup.stderr);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tachyon-full-á-'));
try {
  for (const engine of ['xelatex', 'pdflatex', 'lualatex']) {
    const file = path.join(root, `${engine}.tex`);
    const lua = engine === 'lualatex' ? '\\directlua{tex.print("Lua engine verified.")}' : '';
    const header = engine === 'pdflatex' ? '% !TeX program=pdflatex\n' : '';
    await fs.writeFile(file, `${header}\\documentclass{article}\n\\begin{document}Full ${engine}. ${lua}\\end{document}\n`);
    const selected = engine === 'pdflatex' ? [] : ['--engine', 'latexmk', '--tex-engine', engine];
    const result = await run([file, ...selected, '--json', '--keep-logs']);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).engine, 'latexmk');
    if (engine === 'pdflatex') assert.match(result.stderr, /pdfTeX/);
    assert.ok((await fs.readFile(file.replace(/\.tex$/, '.pdf'))).subarray(0, 5).equals(Buffer.from('%PDF-')));
  }
  const bib = path.join(root, 'bibliography.tex');
  await fs.writeFile(path.join(root, 'refs.bib'), '@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}');
  await fs.writeFile(bib, '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\\cite{knuth}\\printbibliography\\end{document}\n');
  const result = await run([bib, '--json', '--keep-intermediates']); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).engine, 'latexmk');
  assert.match(await fs.readFile(path.join(root, 'bibliography.bbl'), 'utf8'), /Knuth/);
  const extra = path.join(root, 'extra-package.tex');
  await fs.writeFile(extra, '\\documentclass{article}\n\\usepackage{lipsum}\n\\begin{document}\\lipsum[1]\\end{document}\n');
  const packageResult = await run([extra, '--engine', 'latexmk', '--json']); assert.equal(packageResult.code, 0, packageResult.stderr);
  assert.ok(JSON.parse(packageResult.stdout).ok);
  console.log('Full TeX verified: XeLaTeX, pdfLaTeX, LuaLaTeX, biblatex/Biber, and additional TeX packages.');
} finally { await fs.rm(root, {recursive: true, force: true}); }
