// Refresh encrypted snapshots from local workbooks. Plaintext stays in memory.
import * as fileSystem from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveDataStore } from './live-data.mjs';
import { createLiveBondDataStore } from './live-bond-data.mjs';
import { validateEncryptedEnvelope } from './publish-data.mjs';
import { PROJECT_ROOT, WORKSPACE_ROOT } from './site-files.mjs';
import { syncLocalSources } from './local-bundle.mjs';
import { FUND_CODES } from '../src/funds.js';
import { siteTemporaryPath } from './project-paths.mjs';

const filenames = ['ledger.enc.json', 'bonds.enc.json'];
const sameKeys = (left, right) => Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(day => ['salt', 'iv', 'ciphertext'].every(key => left[day]?.[key] === right[day]?.[key]));
const preparationError = () => new Error('Account data preparation failed.');

/** Factories and filesystem are injected for synthetic tests; imports do no work. */
export async function prepareAccountData({
  args = [], root = PROJECT_ROOT, workspace = WORKSPACE_ROOT, env = process.env,
  pythonPath = env.FUND_PREVIEW_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ledgerStoreFactory = createLiveDataStore, bondStoreFactory = createLiveBondDataStore,
  io = fileSystem, uniqueId = randomUUID, output = message => console.log(message),
} = {}) {
  const checkOnly = args.includes('--check');
  if (args.some(argument => argument !== '--check')) throw new Error('Unknown account preparation option.');
  const files = filenames.map(name => path.join(path.resolve(root), 'data', name));
  const originals = [], staged = [], committed = [], temporary = new Set();
  let stage = 'source-read';
  const report = state => output(`[Prepare] Stage ${stage}: ${state}.`);
  const removeTemporary = async () => {
    let failed = false;
    for (const file of temporary) {
      try { await io.unlink(file); }
      catch (error) { if (error?.code !== 'ENOENT') failed = true; }
    }
    temporary.clear();
    return !failed;
  };
  const stageBytes = async (file, bytes, label) => {
    const directory = siteTemporaryPath(root, 'account-staging');
    await io.mkdir(directory, { recursive: true });
    const candidate = path.join(directory, `${path.basename(file)}.${label}-${uniqueId()}.tmp`);
    temporary.add(candidate);
    await io.writeFile(candidate, bytes, { flag: 'wx', mode: 0o600 });
    return candidate;
  };
  try {
    report('started');
    try { await syncLocalSources({ workspace, root }); } catch { /* Keep existing local copies. */ }
    for (const file of files) originals.push(await io.readFile(file));
    const originalEnvelopes = originals.map(bytes => validateEncryptedEnvelope(JSON.parse(bytes.toString('utf8'))));
    const stores = await Promise.all([
      ledgerStoreFactory({ workspace, root, pythonPath }),
      bondStoreFactory({ workspace, root, pythonPath }),
    ]);
    const results = await Promise.allSettled(stores.map(store => store.snapshot()));
    if (results.some(result => result.status !== 'fulfilled')) throw preparationError();
    const [ledger, bonds] = results.map(result => result.value);
    report('complete');
    stage = 'source-validation'; report('started');
    if (ledger.status !== 'valid' || bonds.status !== 'live' || !Array.isArray(ledger.sourceSummary)
      || ledger.sourceSummary.length !== FUND_CODES.length
      || FUND_CODES.some(code => ledger.sourceSummary.filter(item => item?.code === code && item.transactions?.kind === 'workbook').length !== 1)) throw preparationError();
    const envelopes = [ledger.envelope, bonds.envelope].map(validateEncryptedEnvelope);
    if (envelopes.some((envelope, index) => !sameKeys(originalEnvelopes[index].keys, envelope.keys))) throw preparationError();
    const bytes = envelopes.map(envelope => Buffer.from(JSON.stringify(envelope), 'utf8'));
    const workbookCount = FUND_CODES.length + 2;
    report('complete');
    output(`[Prepare] Validated ${workbookCount} workbook sources; encryptedFiles=2; mode=${checkOnly ? 'check' : 'refresh'}.`);
    if (checkOnly) return { checkOnly: true, workbookCount, encryptedFileCount: 2 };
    stage = 'stage-envelopes'; report('started');
    for (let index = 0; index < files.length; index++) staged.push(await stageBytes(files[index], bytes[index], 'prepare'));
    // Refuse to replace data changed by another process while sources were read.
    for (let index = 0; index < files.length; index++) if (!(await io.readFile(files[index])).equals(originals[index])) throw preparationError();
    report('complete');
    stage = 'replace-envelopes'; report('started');
    for (let index = 0; index < files.length; index++) {
      await io.rename(staged[index], files[index]);
      temporary.delete(staged[index]);
      committed.push(index);
    }
    report('complete');
    output('[Prepare] Encrypted snapshots refreshed: files=2.');
    return { checkOnly: false, workbookCount, encryptedFileCount: 2 };
  } catch {
    report('failed');
    if (committed.length) {
      stage = 'rollback-envelopes'; report('started');
      let restored = true;
      for (const index of committed.reverse()) {
        try {
          const rollback = await stageBytes(files[index], originals[index], 'rollback');
          await io.rename(rollback, files[index]);
          temporary.delete(rollback);
        } catch { restored = false; }
      }
      report(restored ? 'complete' : 'failed');
      if (!restored) throw new Error('Account data rollback failed.');
    }
    throw preparationError();
  } finally {
    const cleaned = await removeTemporary();
    for (const bytes of originals) bytes.fill(0);
    if (!cleaned) output('[Prepare] Stage temporary-cleanup: failed.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareAccountData({ args: process.argv.slice(2) }); }
  catch (error) {
    console.error(error?.message === 'Account data rollback failed.' ? 'Error: Account data rollback failed.' : 'Error: Account data preparation failed.');
    process.exitCode = 1;
  }
}
