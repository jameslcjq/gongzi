import { safeStorage } from 'electron'

const FALLBACK_BYTES = new TextEncoder().encode('LaoJiuGzXt_Mail_2026_Key')

export function encryptAuthCode(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  throw new Error('当前系统无法安全保存邮箱授权码，请确认 Windows 用户环境和系统密钥服务正常后重试。')
}

export function decryptAuthCode(encrypted: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      // safeStorage 解密失败（如密钥变更），回退 XOR
    }
  }
  if (safeStorage.isEncryptionAvailable()) return decryptLegacyXor(encrypted)
  throw new Error('当前系统无法安全读取邮箱授权码，请重新保存邮箱账号。')
}

function decryptLegacyXor(encrypted: string): string {
  const buf = Buffer.from(encrypted, 'base64')
  const out = new Uint8Array(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ FALLBACK_BYTES[i % FALLBACK_BYTES.length]
  }
  return new TextDecoder().decode(out)
}
