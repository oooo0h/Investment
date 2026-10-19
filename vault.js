// Credentials and decrypted account data remain in browser memory only.
const decode = (value) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const encode = value => btoa(Array.from(new Uint8Array(value), byte => String.fromCharCode(byte)).join(''));
const VAULT_URLS = new Set(['./data/ledger.enc.json', './data/bonds.enc.json']);
const LOCAL_AAD = new TextEncoder().encode('fund-ledger:bonds:local:v1');

export function getDailyCode(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return parts.find(part => part.type === 'month').value + parts.find(part => part.type === 'day').value;
}

async function deriveKey(password, salt, iterations, usages = ['decrypt']) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: decode(salt), iterations },
    material, { name: 'AES-GCM', length: 256 }, false, usages,
  );
}

async function readEnvelope(url, fetchFn) {
  if (!VAULT_URLS.has(url)) throw new Error('不支持的账本文件。');
  const response = await fetchFn(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('账本文件加载失败，请稍后重试。');
  const envelope = await response.json();
  if (![1, 2].includes(envelope.version) || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== 600000) {
    throw new Error('账本文件格式不受支持。');
  }
  return envelope;
}

async function decryptPayload(envelope, key) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload.funds || typeof payload.funds !== 'object') throw new Error();
    return payload;
  } finally { new Uint8Array(bytes).fill(0); }
}

export async function unlockVault(password, { onSession, url = './data/ledger.enc.json', fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  if (!globalThis.crypto?.subtle) throw new Error('请通过 HTTPS 或本机预览打开网页。');
  const envelope = await readEnvelope(url, fetchFn);
  try {
    let key;
    if (envelope.version === 2) {
      const code = getDailyCode();
      if (password !== code) throw new Error();
      const wrapped = envelope.keys?.[code];
      if (!wrapped) throw new Error();
      const wrappingKey = await deriveKey(password, wrapped.salt, envelope.iterations);
      const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(wrapped.iv) }, wrappingKey, decode(wrapped.ciphertext));
      try {
        if (rawKey.byteLength !== 32) throw new Error();
        key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      } finally { new Uint8Array(rawKey).fill(0); }
    } else {
      key = await deriveKey(password, envelope.salt, envelope.iterations, ['encrypt', 'decrypt']);
    }
    const payload = await decryptPayload(envelope, key);
    if (typeof onSession === 'function') {
      let sessionKey = key;
      const requireKey = heldKey => {
        if (!sessionKey || (heldKey && sessionKey !== heldKey)) {
          const error = new Error('会话已结束。');
          error.code = 'SESSION_CLOSED';
          throw error;
        }
        return sessionKey;
      };
      const session = {
        get closed() { return sessionKey === null; },
        async refresh() {
          const heldKey = requireKey();
          const latest = await readEnvelope(url, fetchFn);
          requireKey(heldKey);
          const result = await decryptPayload(latest, heldKey);
          requireKey(heldKey);
          return result;
        },
        async encryptLocal(value) {
          const heldKey = requireKey();
          const serialized = JSON.stringify(value);
          if (typeof serialized !== 'string') throw new Error('本机记录格式无效。');
          const bytes = new TextEncoder().encode(serialized);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          try {
            const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: LOCAL_AAD }, heldKey, bytes);
            requireKey(heldKey);
            return { version: 1, iv: encode(iv), ciphertext: encode(ciphertext) };
          } finally { bytes.fill(0); }
        },
        async decryptLocal(record) {
          const heldKey = requireKey();
          if (!record || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'ciphertext,iv,version' || record.version !== 1 ||
              typeof record.iv !== 'string' || typeof record.ciphertext !== 'string' || record.ciphertext.length > 1048576) throw new Error('本机记录格式无效。');
          const iv = decode(record.iv), ciphertext = decode(record.ciphertext);
          if (iv.length !== 12 || ciphertext.length < 16) throw new Error('本机记录格式无效。');
          const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: LOCAL_AAD }, heldKey, ciphertext);
          try {
            requireKey(heldKey);
            return JSON.parse(new TextDecoder().decode(bytes));
          } finally { new Uint8Array(bytes).fill(0); }
        },
        close() { sessionKey = null; },
      };
      try { onSession(session); }
      catch (error) { session.close(); throw error; }
    }
    return payload;
  } catch {
    throw new Error('密码不正确，请重新输入。');
  } finally { password = ''; }
}
