// Credentials and decrypted account data remain in browser memory only.
const decode = (value) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export function getDailyCode(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return parts.find(part => part.type === 'month').value + parts.find(part => part.type === 'day').value;
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: decode(salt), iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
}

export async function unlockVault(password) {
  if (!globalThis.crypto?.subtle) throw new Error('请通过 HTTPS 或本机预览打开网页。');
  const response = await fetch('./data/ledger.enc.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('账本文件加载失败，请稍后重试。');
  const envelope = await response.json();
  if (![1, 2].includes(envelope.version) || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== 600000) {
    throw new Error('账本文件格式不受支持。');
  }
  try {
    let key;
    if (envelope.version === 2) {
      const code = getDailyCode();
      if (password !== code) throw new Error();
      const wrapped = envelope.keys?.[code];
      if (!wrapped) throw new Error();
      const wrappingKey = await deriveKey(password, wrapped.salt, envelope.iterations);
      const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(wrapped.iv) }, wrappingKey, decode(wrapped.ciphertext));
      if (rawKey.byteLength !== 32) throw new Error();
      key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      new Uint8Array(rawKey).fill(0);
    } else {
      key = await deriveKey(password, envelope.salt, envelope.iterations);
    }
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    new Uint8Array(bytes).fill(0);
    if (!payload.funds || typeof payload.funds !== 'object') throw new Error();
    return payload;
  } catch {
    throw new Error('密码不正确，请重新输入。');
  }
}
