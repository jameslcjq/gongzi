/// <reference types="vite/client" />

import type { SalaryApi } from '../../../preload/preload'

declare global {
  interface Window {
    salaryApi: SalaryApi
  }
}
