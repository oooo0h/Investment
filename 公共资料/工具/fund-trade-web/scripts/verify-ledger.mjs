import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlockVault } from '../vault.js';
import { calculateLedger } from '../engine.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let password = '';
for await (const chunk of process.stdin) password += chunk;
password = password.trim();
const envelope = JSON.parse(await readFile(path.join(root, 'data', 'ledger.enc.json'), 'utf8'));
globalThis.fetch = async () => ({ ok: true, json: async () => envelope });
try {
  const payload = await unlockVault(password);
  password = '';
  for (const [code, book] of Object.entries(payload.funds)) {
    const result = book.incomplete ? null : calculateLedger(book.transactions, { mode: book.mode });
    if (result && !result.summary.valid) throw new Error('Invalid source ledger');
    console.log(`${code}: records=${book.transactions.length}; incomplete=${book.incomplete === true}; valid=true`);
  }
} catch {
  console.error('Ledger verification failed. No account fields were emitted.');
  process.exitCode = 1;
}
