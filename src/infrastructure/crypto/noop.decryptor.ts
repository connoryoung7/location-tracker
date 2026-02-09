import type { PayloadDecryptor } from '@/domain/ports.ts';

export class NoopDecryptor implements PayloadDecryptor {
  encrypt(plaintext: string): string {
    return plaintext;
  }

  decrypt(ciphertext: string): Uint8Array {
    return new TextEncoder().encode(ciphertext);
  }
}
