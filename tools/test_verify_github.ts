#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env
/**
 * Test script: publish with local SSH ed25519 key, then verify against GitHub.
 *
 * Usage:
 *   deno run --allow-read --allow-net --allow-env tools/test_verify_github.ts [github_username]
 *
 * Starts an in-process relay, reads ~/.ssh/id_ed25519, signs a publish request,
 * then calls verify-github to check if the key matches the GitHub user's keys.
 */

import { createMemoryRelayService } from '../src/memory_handler.ts';
import {
  base64UrlEncode,
  buildPublishSigningMessage,
  canonicalizeJson,
  sha256Hex,
} from '../src/signing.ts';

// --- OpenSSH private key parser (unencrypted ed25519 only) ---

function parseOpenSshPrivateKey(pemText: string): { seed: Uint8Array; publicKey: Uint8Array } {
  const lines = pemText.split('\n').filter(
    (l) => !l.startsWith('-----') && l.trim().length > 0,
  );
  const binary = atob(lines.join(''));
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Verify magic: "openssh-key-v1\0"
  const magic = 'openssh-key-v1\0';
  const magicBytes = new TextDecoder().decode(data.subarray(0, magic.length));
  if (magicBytes !== magic) throw new Error('not an openssh private key');

  let offset = magic.length;

  function readString(): Uint8Array {
    const len = view.getUint32(offset);
    offset += 4;
    const val = data.subarray(offset, offset + len);
    offset += len;
    return val;
  }

  const cipherName = new TextDecoder().decode(readString());
  if (cipherName !== 'none') throw new Error(`encrypted key (cipher: ${cipherName}), cannot parse`);

  const kdfName = new TextDecoder().decode(readString());
  if (kdfName !== 'none') throw new Error(`encrypted key (kdf: ${kdfName})`);

  readString(); // kdf options
  const numKeys = view.getUint32(offset);
  offset += 4;
  if (numKeys !== 1) throw new Error(`expected 1 key, got ${numKeys}`);

  readString(); // public key blob (skip)
  const privateBlob = readString();

  // Parse private section
  const pv = new DataView(privateBlob.buffer, privateBlob.byteOffset, privateBlob.byteLength);
  let po = 0;

  function pvReadUint32(): number {
    const v = pv.getUint32(po);
    po += 4;
    return v;
  }
  function pvReadString(): Uint8Array {
    const len = pvReadUint32();
    const val = privateBlob.subarray(po, po + len);
    po += len;
    return val;
  }

  const check1 = pvReadUint32();
  const check2 = pvReadUint32();
  if (check1 !== check2) throw new Error('check values mismatch (encrypted?)');

  const keyType = new TextDecoder().decode(pvReadString());
  if (keyType !== 'ssh-ed25519') throw new Error(`not ed25519: ${keyType}`);

  const pubKey = pvReadString(); // 32 bytes
  const privKey = pvReadString(); // 64 bytes (seed 32 + pub 32)

  if (pubKey.length !== 32) throw new Error(`unexpected pubkey length: ${pubKey.length}`);
  if (privKey.length !== 64) throw new Error(`unexpected privkey length: ${privKey.length}`);

  return {
    seed: privKey.subarray(0, 32),
    publicKey: new Uint8Array(pubKey),
  };
}

// --- PKCS8 wrapping for Ed25519 seed ---

function wrapEd25519SeedAsPkcs8(seed: Uint8Array): Uint8Array {
  // ASN.1 DER: SEQUENCE { version INTEGER 0, algorithm SEQUENCE { OID 1.3.101.112 }, key OCTET STRING { OCTET STRING { seed } } }
  const prefix = new Uint8Array([
    0x30, 0x2e, // SEQUENCE (46 bytes)
    0x02, 0x01, 0x00, // INTEGER 0
    0x30, 0x05, // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
    0x04, 0x22, // OCTET STRING (34 bytes)
    0x04, 0x20, // OCTET STRING (32 bytes)
  ]);
  const pkcs8 = new Uint8Array(prefix.length + 32);
  pkcs8.set(prefix);
  pkcs8.set(seed, prefix.length);
  return pkcs8;
}

// --- main ---

const username = Deno.args[0] ?? Deno.env.get('GITHUB_USERNAME') ?? 'mizchi';
const keyPath = Deno.args[1] ?? `${Deno.env.get('HOME')}/.ssh/id_ed25519`;

console.log(`\n=== verify-github manual test ===`);
console.log(`GitHub username : ${username}`);
console.log(`SSH key         : ${keyPath}\n`);

// 1. Parse SSH key
const pemText = await Deno.readTextFile(keyPath);
const { seed, publicKey: rawPubKey } = parseOpenSshPrivateKey(pemText);
const pubKeyB64Url = base64UrlEncode(rawPubKey);
console.log(`Public key (b64url): ${pubKeyB64Url}`);

// 2. Import as Web Crypto key
const pkcs8 = wrapEd25519SeedAsPkcs8(seed);
const privateKey = await crypto.subtle.importKey(
  'pkcs8',
  pkcs8,
  { name: 'Ed25519' },
  false,
  ['sign'],
);

// 3. Start in-process relay (uses real fetch for GitHub)
const service = createMemoryRelayService({ requireSignatures: true });

// 4. Signed publish
const sender = username;
const room = 'main';
const id = `test-${Date.now()}`;
const topic = 'notify';
const ts = Math.floor(Date.now() / 1000);
const nonce = crypto.randomUUID();
const payload = { kind: 'verify-test', ts };

const payloadHash = await sha256Hex(canonicalizeJson(payload));
const signingMessage = buildPublishSigningMessage({
  sender,
  room,
  id,
  topic,
  ts,
  nonce,
  payloadHash,
});
const sigBytes = new Uint8Array(
  await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(signingMessage)),
);
const signature = base64UrlEncode(sigBytes);

const publishUrl = `http://localhost/api/v1/publish?sender=${sender}&room=${room}&id=${id}&topic=${topic}`;
const publishReq = new Request(publishUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-relay-public-key': pubKeyB64Url,
    'x-relay-signature': signature,
    'x-relay-timestamp': String(ts),
    'x-relay-nonce': nonce,
  },
  body: JSON.stringify(payload),
});

console.log(`\n--- Step 1: publish (register key via TOFU) ---`);
const publishRes = await service.fetch(publishReq);
const publishBody = await publishRes.json();
console.log(`Status: ${publishRes.status}`);
console.log(`Body:`, JSON.stringify(publishBody, null, 2));

if (publishRes.status !== 200 || !publishBody.ok) {
  console.error('\nPublish failed, aborting.');
  Deno.exit(1);
}

// 5. verify-github
console.log(`\n--- Step 2: verify-github ---`);
const verifyReq = new Request('http://localhost/api/v1/key/verify-github', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sender, github_username: username }),
});
const verifyRes = await service.fetch(verifyReq);
const verifyBody = await verifyRes.json();
console.log(`Status: ${verifyRes.status}`);
console.log(`Body:`, JSON.stringify(verifyBody, null, 2));

// 6. key/info
console.log(`\n--- Step 3: key/info ---`);
const infoRes = await service.fetch(
  new Request(`http://localhost/api/v1/key/info?sender=${sender}`),
);
const infoBody = await infoRes.json();
console.log(`Status: ${infoRes.status}`);
console.log(`Body:`, JSON.stringify(infoBody, null, 2));

// Summary
console.log('\n=== Result ===');
if (verifyBody.verified) {
  console.log(`✅ Verified: ${sender} の relay 鍵は GitHub ユーザー ${username} の SSH 鍵と一致`);
} else {
  console.log(`❌ Not verified: ${verifyBody.error ?? 'unknown error'}`);
}
