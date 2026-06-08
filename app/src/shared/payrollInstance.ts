export type PayrollInstanceId = 'main' | 'copy2'

export type PayrollInstanceSummary = {
  id: PayrollInstanceId
  displayName: string
  isSecondary: boolean
  dataRoot: string
  installRoot: string
  importFolder: string
  outputRoot: string
  tempRoot: string
  exchangeRoot: string
  userDataRoot: string | null
  portalPartitionPrefix: string
  shortcutSuffix: string
}

type ResolveInput = {
  env?: Record<string, string | undefined>
  argv?: string[]
  execPath?: string
  appName?: string
}

type BuildInput = {
  id: PayrollInstanceId
  isDevelopment: boolean
  env?: Record<string, string | undefined>
}

const laojiuRoot = 'D:\\laojiu'

export function resolvePayrollInstanceId(input: ResolveInput = {}): PayrollInstanceId {
  const explicit = normalizeInstanceValue(
    input.env?.PAYROLL_INSTANCE ||
      input.env?.PAYROLL_PROFILE ||
      findArgValue(input.argv ?? [], '--payroll-instance') ||
      findArgValue(input.argv ?? [], '--payroll-profile')
  )
  if (explicit) return explicit

  const execPath = String(input.execPath || '').toLowerCase()
  const appName = String(input.appName || '').toLowerCase()
  if (
    execPath.includes('\\gzxt2\\') ||
    execPath.includes('/gzxt2/') ||
    execPath.includes('工资系统2') ||
    appName.includes('工资系统2')
  ) {
    return 'copy2'
  }
  return 'main'
}

export function buildPayrollInstanceSummary(input: BuildInput): PayrollInstanceSummary {
  const isCopy2 = input.id === 'copy2'
  const env = input.env ?? {}
  const dataRoot = env.PAYROLL_DATA_ROOT ||
    joinWin(laojiuRoot, input.isDevelopment ? (isCopy2 ? 'gzdata2-dev' : 'gzdata-dev') : (isCopy2 ? 'gzdata2' : 'gzdata'))
  const installRoot = env.PAYROLL_INSTALL_ROOT ||
    joinWin(laojiuRoot, input.isDevelopment ? (isCopy2 ? 'gzxt2-dev' : 'gzxt-dev') : (isCopy2 ? 'gzxt2' : 'gzxt'))
  const importFolder = env.PAYROLL_IMPORT_ROOT ||
    joinWin(laojiuRoot, isCopy2 ? '工资导入2' : '工资导入')
  const outputRoot = env.PAYROLL_OUTPUT_ROOT || joinWin(dataRoot, '工资数据')
  const tempRoot = env.PAYROLL_TEMP_ROOT || joinWin(dataRoot, 'temp')
  const exchangeRoot = env.PAYROLL_EXCHANGE_ROOT ||
    joinWin(laojiuRoot, '交换包', isCopy2 ? '工资系统2' : '工资系统')
  const userDataRoot = env.PAYROLL_USER_DATA_ROOT ||
    (isCopy2 ? joinWin(dataRoot, 'userData') : null)

  return {
    id: input.id,
    displayName: isCopy2 ? '老九的工资系统2' : '老九的工资系统',
    isSecondary: isCopy2,
    dataRoot,
    installRoot,
    importFolder,
    outputRoot,
    tempRoot,
    exchangeRoot,
    userDataRoot,
    portalPartitionPrefix: isCopy2 ? 'integrated-portal2' : 'integrated-portal',
    shortcutSuffix: isCopy2 ? '2' : ''
  }
}

function normalizeInstanceValue(value: string | undefined): PayrollInstanceId | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === '2' || normalized === 'copy2' || normalized === 'secondary') return 'copy2'
  if (normalized === '1' || normalized === 'main' || normalized === 'primary') return 'main'
  return null
}

function findArgValue(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === name) return argv[index + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function joinWin(...segments: string[]): string {
  return segments
    .map((segment, index) =>
      index === 0
        ? segment.replace(/[\\/]+$/, '')
        : segment.replace(/^[\\/]+|[\\/]+$/g, '')
    )
    .filter(Boolean)
    .join('\\')
}
