// Credentials and decrypted account data remain in browser memory only.
const decode = (value) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export async function unlockVault(password) {
  if (!globalThis.crypto?.subtle) throw new Error('请通过 HTTPS 或本机预览打开网页。');
  const response = await fetch('./data/ledger.enc.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('账本文件加载失败，请稍后重试。');
  const envelope = await response.json();
  if (envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== 600000) {
    throw new Error('账本文件格式不受支持。');
  }
  try {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: decode(envelope.salt), iterations: envelope.iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    new Uint8Array(bytes).fill(0);
    if (!payload.funds || typeof payload.funds !== 'object') throw new Error();
    return payload;
  } catch {
    throw new Error('密码不正确，请重新输入。');
  }
}
