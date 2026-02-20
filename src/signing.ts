export interface PublishSigningInput {
  sender: string;
  room: string;
  id: string;
  topic: string;
  ts: number;
  nonce: string;
  payloadHash: string;
}

export interface RotateSigningInput {
  sender: string;
  newPublicKey: string;
  ts: number;
  nonce: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return base64ToBytes(padded);
}

export function isLikelyBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function canonicalizeJsonInternal(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'string') {
    return JSON.stringify(value);
  }
  if (t === 'number') {
    if (!Number.isFinite(value as number)) return 'null';
    return JSON.stringify(value);
  }
  if (t === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonInternal(item)).join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJsonInternal(obj[key])}`);
    return `{${parts.join(',')}}`;
  }

  return 'null';
}

export function canonicalizeJson(value: unknown): string {
  return canonicalizeJsonInternal(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildPublishSigningMessage(input: PublishSigningInput): string {
  return [
    'v1',
    `sender=${input.sender}`,
    `room=${input.room}`,
    `id=${input.id}`,
    `topic=${input.topic}`,
    `ts=${input.ts}`,
    `nonce=${input.nonce}`,
    `payload_sha256=${input.payloadHash}`,
  ].join('\n');
}

export function buildRotateSigningMessage(input: RotateSigningInput): string {
  return [
    'v1',
    'op=rotate',
    `sender=${input.sender}`,
    `new_public_key=${input.newPublicKey}`,
    `ts=${input.ts}`,
    `nonce=${input.nonce}`,
  ].join('\n');
}

export async function signEd25519(privateKey: CryptoKey, message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, bytes));
  return base64UrlEncode(signature);
}

export async function verifyEd25519Signature(
  publicKeyBase64Url: string,
  message: string,
  signatureBase64Url: string,
): Promise<boolean> {
  try {
    const keyBytes = new Uint8Array(base64UrlDecode(publicKeyBase64Url));
    const signatureBytes = new Uint8Array(base64UrlDecode(signatureBase64Url));
    const messageBytes = new Uint8Array(new TextEncoder().encode(message));
    const publicKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, messageBytes);
  } catch {
    return false;
  }
}
