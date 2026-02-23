import { assertEquals } from '@std/assert';
import {
  base64UrlEncode,
  fetchGitHubEd25519Keys,
  matchesGitHubKey,
  parseOpenSshEd25519Keys,
  parseOpenSshEd25519Line,
  verifyKeyAgainstGitHub,
} from '../src/github_keys.ts';

// Helper: build a valid OpenSSH ed25519 wire-format blob from a 32-byte key
function buildSshEd25519Blob(rawKey: Uint8Array): string {
  const typeStr = new TextEncoder().encode('ssh-ed25519');
  // 4-byte type length + type string + 4-byte key length + key
  const buf = new Uint8Array(4 + typeStr.length + 4 + rawKey.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, typeStr.length);
  buf.set(typeStr, 4);
  view.setUint32(4 + typeStr.length, rawKey.length);
  buf.set(rawKey, 4 + typeStr.length + 4);

  // standard base64
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function randomKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

// --- parseOpenSshEd25519Line ---

Deno.test('parseOpenSshEd25519Line - valid ed25519 line', () => {
  const rawKey = randomKey();
  const blob = buildSshEd25519Blob(rawKey);
  const line = `ssh-ed25519 ${blob} user@host`;
  const result = parseOpenSshEd25519Line(line);
  assertEquals(result !== null, true);
  assertEquals(result!.length, 32);
  assertEquals(Array.from(result!), Array.from(rawKey));
});

Deno.test('parseOpenSshEd25519Line - RSA line returns null', () => {
  const result = parseOpenSshEd25519Line(
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ... user@host',
  );
  assertEquals(result, null);
});

Deno.test('parseOpenSshEd25519Line - ECDSA line returns null', () => {
  const result = parseOpenSshEd25519Line(
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY... user@host',
  );
  assertEquals(result, null);
});

Deno.test('parseOpenSshEd25519Line - empty line returns null', () => {
  assertEquals(parseOpenSshEd25519Line(''), null);
});

Deno.test('parseOpenSshEd25519Line - comment line returns null', () => {
  assertEquals(parseOpenSshEd25519Line('# this is a comment'), null);
});

Deno.test('parseOpenSshEd25519Line - invalid base64 returns null', () => {
  const result = parseOpenSshEd25519Line('ssh-ed25519 !!!invalid!!! user@host');
  assertEquals(result, null);
});

Deno.test('parseOpenSshEd25519Line - truncated blob returns null', () => {
  // Only encode the type field, no key
  const typeStr = new TextEncoder().encode('ssh-ed25519');
  const buf = new Uint8Array(4 + typeStr.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, typeStr.length);
  buf.set(typeStr, 4);
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  const result = parseOpenSshEd25519Line(`ssh-ed25519 ${btoa(binary)} user@host`);
  assertEquals(result, null);
});

Deno.test('parseOpenSshEd25519Line - wrong key length (16 bytes) returns null', () => {
  // Build blob with a 16-byte key instead of 32
  const typeStr = new TextEncoder().encode('ssh-ed25519');
  const shortKey = new Uint8Array(16);
  crypto.getRandomValues(shortKey);
  const buf = new Uint8Array(4 + typeStr.length + 4 + shortKey.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, typeStr.length);
  buf.set(typeStr, 4);
  view.setUint32(4 + typeStr.length, shortKey.length);
  buf.set(shortKey, 4 + typeStr.length + 4);
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  const result = parseOpenSshEd25519Line(`ssh-ed25519 ${btoa(binary)} user@host`);
  assertEquals(result, null);
});

Deno.test('parseOpenSshEd25519Line - wrong type length in wire format returns null', () => {
  // Declare type length as 5 instead of 11
  const rawKey = randomKey();
  const typeStr = new TextEncoder().encode('ssh-ed25519');
  const buf = new Uint8Array(4 + typeStr.length + 4 + rawKey.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 5); // wrong length
  buf.set(typeStr, 4);
  view.setUint32(4 + typeStr.length, rawKey.length);
  buf.set(rawKey, 4 + typeStr.length + 4);
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  const result = parseOpenSshEd25519Line(`ssh-ed25519 ${btoa(binary)} user@host`);
  assertEquals(result, null);
});

Deno.test('parseOpenSshEd25519Line - line without comment field succeeds', () => {
  const rawKey = randomKey();
  const blob = buildSshEd25519Blob(rawKey);
  // No trailing comment - just type + blob
  const result = parseOpenSshEd25519Line(`ssh-ed25519 ${blob}`);
  assertEquals(result !== null, true);
  assertEquals(Array.from(result!), Array.from(rawKey));
});

Deno.test('parseOpenSshEd25519Line - line with extra whitespace succeeds', () => {
  const rawKey = randomKey();
  const blob = buildSshEd25519Blob(rawKey);
  const result = parseOpenSshEd25519Line(`  ssh-ed25519   ${blob}   user@host  `);
  assertEquals(result !== null, true);
  assertEquals(Array.from(result!), Array.from(rawKey));
});

Deno.test('parseOpenSshEd25519Line - single field returns null', () => {
  assertEquals(parseOpenSshEd25519Line('ssh-ed25519'), null);
});

// --- parseOpenSshEd25519Keys ---

Deno.test('parseOpenSshEd25519Keys - extracts only ed25519 from mixed text', () => {
  const key1 = randomKey();
  const key2 = randomKey();
  const blob1 = buildSshEd25519Blob(key1);
  const blob2 = buildSshEd25519Blob(key2);

  const text = [
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ... user@host',
    `ssh-ed25519 ${blob1} key1@host`,
    '',
    `ssh-ed25519 ${blob2} key2@host`,
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY... user@host',
  ].join('\n');

  const keys = parseOpenSshEd25519Keys(text);
  assertEquals(keys.length, 2);
  assertEquals(Array.from(keys[0]), Array.from(key1));
  assertEquals(Array.from(keys[1]), Array.from(key2));
});

Deno.test('parseOpenSshEd25519Keys - empty text returns empty', () => {
  assertEquals(parseOpenSshEd25519Keys('').length, 0);
});

// --- fetchGitHubEd25519Keys ---

Deno.test('fetchGitHubEd25519Keys - successful fetch', async () => {
  const key = randomKey();
  const blob = buildSshEd25519Blob(key);
  const mockFetch = (_url: string | URL | Request) => {
    return Promise.resolve(
      new Response(`ssh-ed25519 ${blob} user@host\nssh-rsa AAAA... user@host`, {
        status: 200,
      }),
    );
  };

  const result = await fetchGitHubEd25519Keys('testuser', mockFetch as typeof globalThis.fetch);
  assertEquals(result.ok, true);
  assertEquals(result.keys.length, 1);
  assertEquals(Array.from(result.keys[0]), Array.from(key));
});

Deno.test('fetchGitHubEd25519Keys - 404 user not found', async () => {
  const mockFetch = (_url: string | URL | Request) => {
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  };

  const result = await fetchGitHubEd25519Keys('nonexistent', mockFetch as typeof globalThis.fetch);
  assertEquals(result.ok, false);
  assertEquals(result.error, 'github returned 404');
});

Deno.test('fetchGitHubEd25519Keys - 5xx server error', async () => {
  const mockFetch = (_url: string | URL | Request) => {
    return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
  };

  const result = await fetchGitHubEd25519Keys('testuser', mockFetch as typeof globalThis.fetch);
  assertEquals(result.ok, false);
  assertEquals(result.error, 'github returned 500');
});

Deno.test('fetchGitHubEd25519Keys - network error', async () => {
  const mockFetch = (_url: string | URL | Request) => {
    return Promise.reject(new Error('network error'));
  };

  const result = await fetchGitHubEd25519Keys('testuser', mockFetch as typeof globalThis.fetch);
  assertEquals(result.ok, false);
  assertEquals(result.error, 'network error');
});

Deno.test('fetchGitHubEd25519Keys - no ed25519 keys for user', async () => {
  const mockFetch = (_url: string | URL | Request) => {
    return Promise.resolve(
      new Response('ssh-rsa AAAA... user@host\n', { status: 200 }),
    );
  };

  const result = await fetchGitHubEd25519Keys('testuser', mockFetch as typeof globalThis.fetch);
  assertEquals(result.ok, true);
  assertEquals(result.keys.length, 0);
});

// --- matchesGitHubKey ---

Deno.test('matchesGitHubKey - matching key returns true', () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);
  assertEquals(matchesGitHubKey(b64url, [randomKey(), key, randomKey()]), true);
});

Deno.test('matchesGitHubKey - no match returns false', () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);
  assertEquals(matchesGitHubKey(b64url, [randomKey(), randomKey()]), false);
});

Deno.test('matchesGitHubKey - empty keys returns false', () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);
  assertEquals(matchesGitHubKey(b64url, []), false);
});

Deno.test('matchesGitHubKey - invalid base64url returns false', () => {
  assertEquals(matchesGitHubKey('!!!', [randomKey()]), false);
});

Deno.test('matchesGitHubKey - wrong length relay key (16 bytes) returns false', () => {
  const shortKey = new Uint8Array(16);
  crypto.getRandomValues(shortKey);
  const b64url = base64UrlEncode(shortKey);
  assertEquals(matchesGitHubKey(b64url, [randomKey()]), false);
});

Deno.test('matchesGitHubKey - first key in list matches', () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);
  assertEquals(matchesGitHubKey(b64url, [key, randomKey(), randomKey()]), true);
});

Deno.test('matchesGitHubKey - last key in list matches', () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);
  assertEquals(matchesGitHubKey(b64url, [randomKey(), randomKey(), key]), true);
});

Deno.test('fetchGitHubEd25519Keys - encodes username in URL', async () => {
  let capturedUrl = '';
  const mockFetch = (url: string | URL | Request) => {
    capturedUrl = typeof url === 'string' ? url : url.toString();
    return Promise.resolve(new Response('', { status: 200 }));
  };
  await fetchGitHubEd25519Keys('user/name', mockFetch as typeof globalThis.fetch);
  assertEquals(capturedUrl, 'https://github.com/user%2Fname.keys');
});

Deno.test('fetchGitHubEd25519Keys - empty response body returns empty keys', async () => {
  const mockFetch = (_url: string | URL | Request) =>
    Promise.resolve(new Response('', { status: 200 }));
  const result = await fetchGitHubEd25519Keys('testuser', mockFetch as typeof globalThis.fetch);
  assertEquals(result.ok, true);
  assertEquals(result.keys.length, 0);
});

// --- verifyKeyAgainstGitHub ---

Deno.test('verifyKeyAgainstGitHub - matching key returns verified', async () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);
  const blob = buildSshEd25519Blob(key);

  const mockFetch = (_url: string | URL | Request) =>
    Promise.resolve(new Response(`ssh-ed25519 ${blob} user@host`, { status: 200 }));

  const result = await verifyKeyAgainstGitHub(
    b64url,
    'testuser',
    mockFetch as typeof globalThis.fetch,
  );
  assertEquals(result.verified, true);
  assertEquals(result.error, undefined);
});

Deno.test('verifyKeyAgainstGitHub - non-matching key returns not verified', async () => {
  const key = randomKey();
  const differentKey = randomKey();
  const b64url = base64UrlEncode(key);
  const blob = buildSshEd25519Blob(differentKey);

  const mockFetch = (_url: string | URL | Request) =>
    Promise.resolve(new Response(`ssh-ed25519 ${blob} user@host`, { status: 200 }));

  const result = await verifyKeyAgainstGitHub(
    b64url,
    'testuser',
    mockFetch as typeof globalThis.fetch,
  );
  assertEquals(result.verified, false);
});

Deno.test('verifyKeyAgainstGitHub - fetch error returns not verified with error', async () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);

  const mockFetch = (_url: string | URL | Request) => Promise.reject(new Error('network failure'));

  const result = await verifyKeyAgainstGitHub(
    b64url,
    'testuser',
    mockFetch as typeof globalThis.fetch,
  );
  assertEquals(result.verified, false);
  assertEquals(result.error, 'network failure');
});

Deno.test('verifyKeyAgainstGitHub - no ed25519 keys returns not verified', async () => {
  const key = randomKey();
  const b64url = base64UrlEncode(key);

  const mockFetch = (_url: string | URL | Request) =>
    Promise.resolve(new Response('ssh-rsa AAAA... user@host\n', { status: 200 }));

  const result = await verifyKeyAgainstGitHub(
    b64url,
    'testuser',
    mockFetch as typeof globalThis.fetch,
  );
  assertEquals(result.verified, false);
  assertEquals(result.error, 'no ed25519 keys found for github user');
});
