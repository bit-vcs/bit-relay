import { base64UrlEncode } from './signing.ts';

const SSH_ED25519_PREFIX = 'ssh-ed25519';
const ED25519_RAW_KEY_LENGTH = 32;

/**
 * Parse a single OpenSSH authorized_keys line for an Ed25519 key.
 * Returns the raw 32-byte public key, or null if not Ed25519 or malformed.
 *
 * Wire format: [4-byte len]["ssh-ed25519"][4-byte len][32-byte raw key]
 */
export function parseOpenSshEd25519Line(line: string): Uint8Array | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  if (parts[0] !== SSH_ED25519_PREFIX) return null;

  let decoded: Uint8Array;
  try {
    const binary = atob(parts[1]);
    decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      decoded[i] = binary.charCodeAt(i);
    }
  } catch {
    return null;
  }

  // Minimum: 4 + 11 ("ssh-ed25519") + 4 + 32 = 51 bytes
  if (decoded.length < 51) return null;

  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);

  // First field: key type string
  const typeLen = view.getUint32(0);
  if (typeLen !== 11) return null; // "ssh-ed25519" is 11 bytes
  const typeStr = new TextDecoder().decode(decoded.subarray(4, 4 + typeLen));
  if (typeStr !== SSH_ED25519_PREFIX) return null;

  // Second field: raw key
  const keyOffset = 4 + typeLen;
  if (keyOffset + 4 > decoded.length) return null;
  const keyLen = view.getUint32(keyOffset);
  if (keyLen !== ED25519_RAW_KEY_LENGTH) return null;

  const keyStart = keyOffset + 4;
  if (keyStart + keyLen > decoded.length) return null;

  return decoded.slice(keyStart, keyStart + keyLen);
}

/**
 * Parse multiple lines of authorized_keys text, extracting only Ed25519 keys.
 */
export function parseOpenSshEd25519Keys(text: string): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (const line of text.split('\n')) {
    const key = parseOpenSshEd25519Line(line);
    if (key) keys.push(key);
  }
  return keys;
}

export interface GitHubKeyFetchResult {
  ok: boolean;
  keys: Uint8Array[];
  error?: string;
}

/**
 * Fetch Ed25519 public keys from GitHub for a given username.
 * Uses the public endpoint https://github.com/{username}.keys
 */
export async function fetchGitHubEd25519Keys(
  username: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubKeyFetchResult> {
  try {
    const res = await fetchFn(`https://github.com/${encodeURIComponent(username)}.keys`);
    if (!res.ok) {
      return { ok: false, keys: [], error: `github returned ${res.status}` };
    }
    const text = await res.text();
    return { ok: true, keys: parseOpenSshEd25519Keys(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'fetch failed';
    return { ok: false, keys: [], error: message };
  }
}

/**
 * Check if a relay public key (base64url-encoded) matches any of the provided
 * GitHub Ed25519 raw keys.
 */
export function matchesGitHubKey(
  relayPublicKeyBase64Url: string,
  githubEd25519Keys: Uint8Array[],
): boolean {
  let relayBytes: Uint8Array;
  try {
    // Decode base64url to raw bytes
    const normalized = relayPublicKeyBase64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const binary = atob(padded);
    relayBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      relayBytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return false;
  }

  if (relayBytes.length !== ED25519_RAW_KEY_LENGTH) return false;

  for (const ghKey of githubEd25519Keys) {
    if (ghKey.length !== ED25519_RAW_KEY_LENGTH) continue;
    let match = true;
    for (let i = 0; i < ED25519_RAW_KEY_LENGTH; i++) {
      if (relayBytes[i] !== ghKey[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export interface GitHubVerifyResult {
  verified: boolean;
  error?: string;
}

/**
 * High-level verification: check if a relay public key belongs to a GitHub user.
 * Fetches the user's SSH keys from GitHub and checks for a match.
 */
export async function verifyKeyAgainstGitHub(
  relayPublicKeyBase64Url: string,
  githubUsername: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<GitHubVerifyResult> {
  const result = await fetchGitHubEd25519Keys(githubUsername, fetchFn);
  if (!result.ok) {
    return { verified: false, error: result.error };
  }
  if (result.keys.length === 0) {
    return { verified: false, error: 'no ed25519 keys found for github user' };
  }
  const matched = matchesGitHubKey(relayPublicKeyBase64Url, result.keys);
  return { verified: matched };
}

// Re-export for convenience (used to build mock test data)
export { base64UrlEncode };
