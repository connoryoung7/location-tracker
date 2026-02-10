import sodium from 'libsodium-wrappers';
import type { PayloadDecryptor } from '@/domain/ports.ts';

export class LibsodiumDecryptor implements PayloadDecryptor {
  private key: Uint8Array;

  constructor(secretKey: Uint8Array) {
    this.key = secretKey;
  }

  static async create(secretKey: Uint8Array): Promise<LibsodiumDecryptor> {
    await sodium.ready;
    return new LibsodiumDecryptor(secretKey);
  }

  encrypt(plaintext: string): string {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(
      new TextEncoder().encode(plaintext),
      nonce,
      this.key,
    );
    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);
    return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  }

  decrypt(ciphertext: string): Uint8Array {
    const bytes = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
    const nonce = bytes.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = bytes.slice(sodium.crypto_secretbox_NONCEBYTES);
    return sodium.crypto_secretbox_open_easy(encrypted, nonce, this.key);
  }
}
