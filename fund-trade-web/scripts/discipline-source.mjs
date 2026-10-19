// This source is strictly the workspace-root public discipline document.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DISCIPLINE_ENTRIES, parseDisciplineMarkdown } from '../src/discipline.js';

const invalid = () => { throw new Error('Discipline source unavailable.'); };
const signature = info => [info.size, info.mtimeNs, info.ctimeNs, info.ino].map(String).join(':');

export async function createDisciplineSource({ workspace }) {
  const source = path.join(path.resolve(workspace), '交易纪律.md');
  let lastGood = { revision: null, entries: DISCIPLINE_ENTRIES };
  let goodSignature = null, failedSignature = null;
  let queue = Promise.resolve();
  const read = async () => {
    let beforeSignature;
    try {
      const before = await lstat(source, { bigint: true });
      if (!before.isFile() || before.size > 256n * 1024n) invalid();
      beforeSignature = signature(before);
      if (beforeSignature === goodSignature) return { ...lastGood, status: 'valid' };
      if (beforeSignature === failedSignature) return { ...lastGood, status: 'invalid' };
      const first = await readFile(source);
      await new Promise(resolve => setTimeout(resolve, 25));
      const second = await readFile(source);
      const after = await lstat(source, { bigint: true });
      if (!after.isFile() || signature(after) !== beforeSignature || !first.equals(second)) invalid();
      const entries = parseDisciplineMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(second));
      const revision = createHash('sha256').update(second).digest('hex');
      lastGood = { revision, entries };
      goodSignature = beforeSignature;
      failedSignature = null;
      return { ...lastGood, status: 'valid' };
    } catch {
      if (beforeSignature) failedSignature = beforeSignature;
      return { ...lastGood, status: 'invalid' };
    }
  };
  return {
    snapshot() {
      const pending = queue.then(read);
      queue = pending.catch(() => {});
      return pending;
    },
  };
}
