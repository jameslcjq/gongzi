import { ref } from 'vue'

const STORAGE_KEY = 'gongzi.internalTools.enabled'
const DIAGNOSTIC_PASSWORD = 'kfb638400'

function readInitialValue(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export const internalToolsEnabled = ref(readInitialValue())

export function setInternalToolsEnabled(enabled: boolean): void {
  internalToolsEnabled.value = enabled
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function unlockInternalTools(password: string): boolean {
  if (password !== DIAGNOSTIC_PASSWORD) return false
  setInternalToolsEnabled(true)
  return true
}
