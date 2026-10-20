import test from 'node:test';
import assert from 'node:assert/strict';
import { unlockVault } from '../src/vault.js';
import { unlockErrorMessage } from '../src/unlock-errors.js';

test('data fetch failures retain a safe data error instead of blaming the password', async () => {
  for (const fetchFn of [async () => ({ ok: false }), async () => { throw new Error('private detail'); }]) {
    await assert.rejects(unlockVault('synthetic', { fetchFn }), error => {
      assert.equal(error.code, 'DATA_UNAVAILABLE');
      assert.match(unlockErrorMessage(error), /本地数据读取失败/);
      assert.doesNotMatch(unlockErrorMessage(error), /密码|private/);
      return true;
    });
  }
  assert.match(unlockErrorMessage(new Error('snapshot-changing')), /数据正在更新/);
  assert.match(unlockErrorMessage(new Error('private detail')), /检查密码/);
});
