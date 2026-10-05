import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { platform, checksumFor, verifiedDownload } from '../skills/tachyon-tex/scripts/installer.mjs';

test('selects all six OS/CPU assets and rejects unsupported architectures', () => {
  for (const [osName, expected] of [['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']]) for (const arch of ['x64', 'arm64']) assert.equal(platform(osName, arch), `${expected}-${arch}`);
  assert.throws(() => platform('freebsd', 'x64'), /Unsupported/); assert.throws(() => platform('linux', 'ia32'), /Unsupported/);
});
test('verified downloads are atomic and corruption cannot replace an installed binary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tachyon-download-'));
  try {
    const file = path.join(root, 'binary'), bytes = Buffer.from('verified executable fixture');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const fetcher = async () => new Response(bytes);
    assert.equal(checksumFor(`${sha}  binary\n`, 'binary'), sha);
    assert.throws(() => checksumFor(`${sha}  another\n`, 'binary'), /missing/);
    await verifiedDownload('https://example.invalid', file, sha, fetcher);
    await assert.rejects(verifiedDownload('https://example.invalid', file, '0'.repeat(64), fetcher), /mismatch/);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(await fs.readdir(root), ['binary']);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
