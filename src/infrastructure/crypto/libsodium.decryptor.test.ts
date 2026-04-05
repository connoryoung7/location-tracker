import { test, expect, describe, beforeAll } from 'bun:test';
import sodium from 'libsodium-wrappers';
import { LibsodiumDecryptor } from './libsodium.decryptor.ts';

const TEXT_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 bytes key for testing

const TEST_SECRET_KEY = Buffer.from(btoa(TEXT_KEY), 'base64'); // "0123456789abcdef0123456789abcdef" (32 bytes)

let decryptor: LibsodiumDecryptor;

beforeAll(async () => {
  decryptor = await LibsodiumDecryptor.create(TEST_SECRET_KEY);
});

function encrypt(plaintext: string): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(plaintext),
    nonce,
    TEST_SECRET_KEY,
  );
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

describe('LibsodiumDecryptor', () => {
  test('decrypts a payload encrypted with the same key', () => {
    const original = '{"_type":"location","lat":46.36,"lon":-79.06}';
    const encrypted = encrypt(original);

    const result = decryptor.decrypt(encrypted);
    const decoded = new TextDecoder().decode(result);

    expect(decoded).toBe(original);
  });

  test('throws on tampered ciphertext', () => {
    const encrypted = encrypt('hello');
    const tampered = encrypted.slice(0, -2) + 'AA';

    expect(() => decryptor.decrypt(tampered)).toThrow();
  });

  test('throws on invalid base64', () => {
    expect(() => decryptor.decrypt('not-valid-base64!!!')).toThrow();
  });

  test('throws when decrypting with wrong key', async () => {
    const wrongKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(
      new TextEncoder().encode('secret'),
      nonce,
      wrongKey,
    );
    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);
    const encoded = sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);

    expect(() => decryptor.decrypt(encoded)).toThrow();
  });
});
