import { safeStorage } from 'electron'

const FALLBACK_BYTES = new TextEncoder().encode('LaoJiuGzXt_Mail_2026_Key')

export function encryptAuthCode(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  const input = new TextEncoder().encode(plaintext)
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] ^ FALLBACK_BYTES[i % FALLBACK_BYTES.length]
  }
  return Buffer.from(out).toString('base64')
}

export function decryptAuthCode(encrypted: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      // safeStorage 解密失败（如密钥变更），回退 XOR
    }
  }
  const buf = Buffer.from(encrypted, 'base64')
  const out = new Uint8Array(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ FALLBACK_BYTES[i % FALLBACK_BYTES.length]
  }
  return new TextDecoder().decode(out)
}
