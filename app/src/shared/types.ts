export type WorksheetField = {
  fieldId: string
  name: string
  type: string
  controlType: number
  desc?: string
  options?: string[]
  hidden?: boolean
  displayOrder?: number
  custom?: boolean
  /**
   * 用于一体化预算 xls 导入时的"列匹配键"。形如 "人员基本情况_性别*" / "序号"，
   * 由 xls 表头 row2(分组) + row3(字段) 拼成。
   * 与 name 解耦：name 是 UI 显示名，importSource 是匹配名，可独立演进。
   */
  importSource?: string
}

export type WorksheetMeta = {
  name: string
  worksheetId: string
  fields: WorksheetField[]
  views?: Array<{ viewId?: string; name?: string }>
}

export type RuleResult = {
  ok: boolean
  affectedRows: number
  messages: string[]
  warnings: string[]
  monthlyPayrollWriteBack?: MonthlyPayrollWriteBackPreview
}

export type AnnualReportWorkflowInput = {
  totalPerformance: number
  totalHeadTeacher: number
  totalOvertime: number
}

export type WorkflowRunPayload = {
  annualReport?: AnnualReportWorkflowInput
  monthlyPayroll?: MonthlyPayrollWorkflowInput
}

export type MonthlyPayrollProcessScope = 'auto' | 'salary' | 'social' | 'salary-social'
export type MonthlyPayrollDataSourceMode = 'integrated' | 'salary-workbook'

export type MonthlyPayrollWorkflowInput = {
  salaryWorkbookPath?: string
  socialSecurityWorkbookPath?: string
  taxWorkbookPath?: string
  year?: number
  month?: number
  confirmWriteBack?: boolean
  salaryImportFields?: string[]
  salaryImportIdCards?: string[]
  processScope?: MonthlyPayrollProcessScope
  dataSourceMode?: MonthlyPayrollDataSourceMode
}

export type MonthlyPayrollSourcePeriodSummary = {
  periods: string[]
  message: string
}

export type MonthlyPayrollSourcePeriodInspection = {
  socialSecurity?: MonthlyPayrollSourcePeriodSummary
  tax?: MonthlyPayrollSourcePeriodSummary
}

export type MonthlyPayrollTaxField = '补扣工资' | '当月个人所得税'

export type MonthlyPayrollSettings = {
  taxField: MonthlyPayrollTaxField
}

export type MonthlyPayrollWriteBackPreview = {
  requiresConfirmation: boolean
  applied: boolean
  syncableCount: number
  manualCount: number
  personCount: number
  examples: string[]
  manualExamples: string[]
  salaryImportFields: string[]
  salaryImportIdCards: string[]
}

export type WorkflowDefinition = {
  key: string
  name: string
  module: string
  status: 'ready' | 'needs-rule' | 'blocked-by-source'
  blockedReason?: string
}

export type WorkflowRunResult = RuleResult & {
  workflowKey: string
  workflowName: string
}

export type LookupFailureEntry = {
  id: number
  workflow: string
  worksheet: string
  idCard: string
  name: string
  lookupTable: string
  lookupKey: string
  lookupValue: string
  reason: string
  createdAt: string
}

export type AppSummary = {
  tableCount: number
  fieldCount: number
  databasePath: string
  worksheets: Array<{
    name: string
    worksheetId: string
    fieldCount: number
    viewCount: number
    fields: WorksheetField[]
    views?: Array<{ viewId?: string; name?: string }>
  }>
}

export type WorksheetRecordValue = string | number | null

export type WorksheetRecord = Record<string, WorksheetRecordValue>

export type WorksheetRecordsQuery = {
  limit?: number
  offset?: number
  search?: string
  view?: string
  sortColumn?: string
  sortOrder?: 'asc' | 'desc'
}

export type WorksheetRecordsResult = {
  worksheetId: string
  worksheetName: string
  total: number
  limit: number
  offset: number
  rows: WorksheetRecord[]
}

export type ConsistencyAuditValue = {
  worksheetName: string
  fieldName: string
  recordId?: number
  value: string
  updatedAt?: string
}

export type ConsistencyAuditIssue = {
  key: string
  idCard: string
  name: string
  fieldKey: string
  fieldLabel: string
  master?: ConsistencyAuditValue
  source: ConsistencyAuditValue
  severity: 'warning' | 'error'
}

export type ConsistencyAuditRuleSummary = {
  fieldKey: string
  fieldLabel: string
  comparedCount: number
  issueCount: number
}

export type ConsistencyAuditResult = {
  masterWorksheetName: string
  checkedPeople: number
  comparedCells: number
  issueCount: number
  missingMasterRows: number
  generatedAt: string
  rules: ConsistencyAuditRuleSummary[]
  issues: ConsistencyAuditIssue[]
}

export type ConsistencyAuditApplyDirection = 'source-to-master' | 'master-to-source'

export type ConsistencyAuditApplyResult = {
  updatedRows: number
  skippedRows: number
  messages: string[]
}

export type ExcelImportLog = {
  fileName: string
  worksheetName?: string
  ok: boolean
  importedRows: number
  message: string
  createdAt: string
  batchId?: number
}

export type ImportWatcherStatus = {
  folderPath: string
  templateFolderPath: string
  running: boolean
  logs: ExcelImportLog[]
  monthlyPayroll?: MonthlyPayrollDetectedFiles
  annualAdjustment?: AnnualAdjustmentDetectedFiles
}

export type MonthlyPayrollDetectedFiles = {
  salaryWorkbookPath?: string
  salaryWorkbookName?: string
  socialSecurityWorkbookPath?: string
  socialSecurityWorkbookName?: string
  taxWorkbookPath?: string
  taxWorkbookName?: string
  mode:
    | 'missing-source'
    | 'salary-only'
    | 'salary-social'
    | 'salary-tax'
    | 'salary-social-tax'
    | 'social-only'
    | 'social-tax'
}

export type AnnualAdjustmentDetectedFiles = {
  salaryWorkbookPath?: string
  salaryWorkbookName?: string
  housingAccountWorkbookPath?: string
  housingAccountWorkbookName?: string
  insuranceDetailWorkbookPaths: string[]
  insuranceDetailWorkbookNames: string[]
  taxTemplateWorkbookPath?: string
  taxTemplateWorkbookName?: string
  socialBaseTemplateWorkbookPath?: string
  socialBaseTemplateWorkbookName?: string
}

export type PersonnelExpensePlanPrefillRow = {
  budgetCode?: string
  unitName: string
  amounts: Record<string, number>
}

export type PersonnelExpensePlanPrefillResult = {
  ok: boolean
  filePath?: string
  fileName?: string
  rows: PersonnelExpensePlanPrefillRow[]
  message?: string
}

export type SalaryQuotaMatchLocalSummary = {
  ok: boolean
  activeOtherOneTotal: number
  activeBasicPerformanceTotal: number
  activeHousingTotal: number
  activeAllowanceTotal: number
  retiredHousingTotal: number
  retiredBackpayTotal: number
  retiredActualPayTotal: number
  otherActualPayTotal: number
  /** 实发合计 = 在职实发 + 遗补实发 + 退休房补实发（取当月最新未过期报账记录），用于额度匹配前置总额校验 */
  actualPayTotal: number
  /** 002 数币批次的交通费合计，前置校验时从实发合计中扣除 */
  traffic002Total: number
  message?: string
}

export type BudgetSheetImportResult = {
  sheetName: string
  worksheetName: string
  inserted: number
  updated: number
  skipped: number
  status: 'ok' | 'no-target-worksheet' | 'empty' | 'no-key' | 'error'
  message?: string
}

export type BudgetImportResult = {
  ok: boolean
  filePath: string
  sheets: BudgetSheetImportResult[]
  totalInserted: number
  totalUpdated: number
  totalSkipped: number
  message?: string
}

export type LocalFileBase64 = {
  filePath: string
  fileName: string
  base64: string
  size: number
}

/** v4 之后只需配置类别，批次在运行时通过 getBatchAgency 自动发现 */
export type SalaryExportSaltype = {
  saltype_id: string
  saltype_name: string
  /** 是否只导首批次（退休类用 true，因为它通常没有"数币"等二级批次） */
  onlyFirstBatch?: boolean
}

export type IntegratedHistorySalaryPeriod = {
  year: number
  month: number
}

export type IntegratedHistorySalaryPerson = {
  name: string
  idCard: string
  jobSalary: number
  salaryLevel: number
  postAllowance: number
  livingAllowance: number
  rowNumber?: number
}

export type IntegratedHistorySalaryDataset = IntegratedHistorySalaryPeriod & {
  agencyId: string
  agencyName: string
  agencyCode?: string
  saltypeId: string
  saltypeName: string
  salbatchId: string
  salbatchName: string
  people: IntegratedHistorySalaryPerson[]
  warnings: string[]
}

export type PerformancePayrollGenerateInput = {
  unitName?: string
  first: IntegratedHistorySalaryDataset
  second: IntegratedHistorySalaryDataset
}

export type PerformancePayrollHistoryGenerateInput = {
  firstPeriod: IntegratedHistorySalaryPeriod
  secondPeriod: IntegratedHistorySalaryPeriod
}

export type PerformancePayrollLocalGenerateInput = PerformancePayrollHistoryGenerateInput & {
  firstWorkbookPath: string
  secondWorkbookPath: string
}

export type PerformancePayrollGenerateResult = {
  ok: boolean
  filePath: string
  rowCount: number
  matchedCount: number
  changedCount: number
  firstMissingCount: number
  secondMissingCount: number
  warnings: string[]
}

export type UnitSettings = {
  unitFullName: string
  unitImportCode: string
  schoolLevel: string
  functionCode: string
  retiredFunctionCode: string
  retiredFunctionName: string
  budgetActiveCode: string
  budgetRetiredCode: string
  socialPayeeName: string
  socialPayeeBank: string
  socialPayeeAccount: string
  housingPayeeName: string
  housingPayeeBank: string
  housingPayeeAccount: string
  /** 一键导出工资时要遍历的"工资类别"列表（批次自动发现） */
  salaryExportSaltypes?: SalaryExportSaltype[]
}

export type UnitSettingsLockState = {
  locked: boolean
  rowCount: number
  tables: Array<{
    name: string
    rows: number
  }>
}

export type MonthlyPayrollReportSheet = {
  name: string
  columns: string[]
  rows: Array<Array<string | number>>
  showColumnHeader?: boolean
  merges?: string[]
  columnWidths?: number[]
  rowHeights?: Array<number | null>
}

export type MonthlyPayrollRun = {
  id: number
  year: number
  month: number
  unitFullName: string
  activeCount: number
  survivorCount: number
  retiredHousingCount: number
  salaryTotal: number
  withholdingTotal: number
  taxTotal: number
  actualPay: number
  activeActualPay: number
  survivorActualPay: number
  retiredHousingActualPay: number
  retiredHousing: number
  sourceSalaryPath: string | null
  sourceSocialPath: string | null
  sourceTaxPath: string | null
  insuranceImportPath: string | null
  voucherImportPath: string | null
  salaryImportPath: string | null
  payrollBackpayPath: string | null
  reportFingerprint: string | null
  taxField: MonthlyPayrollTaxField | null
  dataSourceMode: MonthlyPayrollDataSourceMode | null
  archivedAt: string | null
  archiveDir: string | null
  archiveManifest: string[]
  reportSnapshot?: MonthlyPayrollReportResult | null
  isOutdated: boolean
  outdatedAt: string | null
  outdatedReason: string | null
  insurancePushStatus: MonthlyPayrollPushStatus
  voucherPushStatus: MonthlyPayrollPushStatus
  salaryPushStatus: MonthlyPayrollPushStatus
  insurancePushedAt: string | null
  voucherPushedAt: string | null
  salaryPushedAt: string | null
  createdAt: string
}

export type MonthlyPayrollPushTarget = 'insurance' | 'voucher' | 'salary'

export type MonthlyPayrollPushStatus =
  | 'not-pushed'
  | 'queued'
  | 'success'
  | 'failed'
  | 'needs-repush'

export type MonthlyPayrollSourceKind = 'salary' | 'social' | 'tax'

export type MonthlyPayrollSourceVersionStatus = 'current' | 'replaced'

export type MonthlyPayrollSourceVersion = {
  id: number
  year: number
  month: number
  kind: MonthlyPayrollSourceKind
  filePath: string
  archivePath: string | null
  fileName: string
  fileSize: number
  sha256: string
  rowCount: number
  totalAmount: number
  summary: Record<string, unknown>
  status: MonthlyPayrollSourceVersionStatus
  replacedAt: string | null
  createdAt: string
}

export type RecycleBinBatch = {
  id: number
  kind: string
  targetType: string | null
  targetName: string | null
  reason: string | null
  recordCount: number
  createdAt: string
}

export type RecycleBinRecord = {
  id: number
  batchId: number
  tableName: string
  worksheetName: string | null
  recordId: number | null
  action: 'delete' | 'clear' | 'wipe'
  beforeValues: Record<string, unknown>
  createdAt: string
}

export type RecycleBinRestoreResult = {
  batchId: number
  restoredRows: number
  skippedRows: number
  conflictRows: number
  failedRows: number
  messages: string[]
}

export type MonthlyPayrollArchiveResult = {
  run: MonthlyPayrollRun
  archiveDir: string
  files: string[]
}

export type MonthlyPayrollReportResult = {
  ok: boolean
  message: string
  outputWorkbookPath?: string
  insuranceImportPath?: string
  salaryImportPath?: string
  payrollBackpayPath?: string
  voucherImportPath?: string
  sourceSalaryOriginalPath?: string
  taxField?: MonthlyPayrollTaxField
  processScope?: MonthlyPayrollProcessScope
  dataSourceMode?: MonthlyPayrollDataSourceMode
  voucherPageCounts?: MonthlyPayrollVoucherPageCounts
  sheets: MonthlyPayrollReportSheet[]
}

export type MonthlyPayrollVoucherPageCounts = {
  insuranceAttachmentPages: number
  salaryWorkbookPages: number
  survivorWorkbookPages: number
  retiredHousingPages: number
  salaryAttachmentPages: number
}

export type PrinterSummary = {
  name: string
  displayName: string
  isDefault: boolean
  status?: string
}

export type MonthlyPayrollPrintSettings = {
  reportPrinterName: string
  voucherPrinterName: string
  voucherOffsetX: number
  voucherOffsetY: number
}

export type MonthlyPayrollSalaryPrintPageSummary = {
  items: Array<{
    label: string
    sheetName: string
    pages: number
  }>
  totalPages: number
}

export type PrintRequest = {
  printerName?: string
  landscape?: boolean
  scaleFactor?: number
  pageRanges?: Array<{
    from: number
    to: number
  }>
  pageSize?: {
    width: number
    height: number
  }
}

export type AnnualAdjustmentFilePick = {
  filePath: string
  fileName: string
}

export type AnnualAdjustmentChooseFilesRequest = {
  title?: string
  multi?: boolean
}

export type AnnualAdjustmentPreviewInput = {
  salaryWorkbookPath: string
  housingAccountWorkbookPath?: string
  insuranceDetailWorkbookPaths: string[]
}

export type AnnualAdjustmentApplyInput = AnnualAdjustmentPreviewInput & {
  confirmIntegratedWriteBack: boolean
}

export type AnnualAdjustmentSourceRow = {
  sourceFile: string
  rowNumber: number
  idCard: string
  name: string
  rate: string
  amount: number
  fieldName: string
  status: 'matched' | 'id-conflict' | 'missing' | 'skipped'
  reason: string
}

export type AnnualIntegratedChangePreview = {
  idCard: string
  name: string
  fieldName: string
  sourceValue: number
  targetValue: number
  reason: string
}

export type AnnualAdjustmentPreviewSummary = {
  salaryPeople: number
  housingAccountRows: number
  insuranceRows: number
  matchedInsuranceRows: number
  blockedInsuranceRows: number
  integratedChangeCount: number
  integratedManualCount: number
  warnings: string[]
}

export type AnnualAdjustmentPreview = {
  unitName: string
  summary: AnnualAdjustmentPreviewSummary
  sourceRows: AnnualAdjustmentSourceRow[]
  integratedChanges: AnnualIntegratedChangePreview[]
  manualIntegratedChanges: AnnualIntegratedChangePreview[]
}

export type AnnualAdjustmentApplyResult = {
  ok: boolean
  message: string
  salaryOutputPath: string
  salaryImportPath?: string
  housingDeclarationPath?: string
  housingMissingLogPath?: string
  salaryApplied: number
  integratedApplied: number
  integratedManualCount: number
  warnings: string[]
}

export type PersonalTaxImportGenerateInput = {
  templateWorkbookPath?: string
  incomeFields: string[]
}

export type PersonalTaxImportGenerateResult = {
  ok: boolean
  filePath: string
  rowCount: number
  incomeTotal: number
  pensionTotal: number
  medicalTotal: number
  unemploymentTotal: number
  housingTotal: number
  annuityTotal: number
}

export type SocialInsuranceBaseExportInput = {
  templateWorkbookPath?: string
  baseFields: string[]
}

export type SocialInsuranceBaseExportResult = {
  ok: boolean
  filePath: string
  rowCount: number
  baseTotal: number
}

export type ImportBatchSummary = {
  id: number
  sourceName: string
  worksheetName?: string
  worksheetId?: string
  status: 'imported' | 'failed' | 'rolled-back'
  rowCount: number
  insertedRows?: number
  updatedRows?: number
  unchangedRows?: number
  message?: string
  createdAt: string
}

export type ImportPreviewChange = {
  fieldName: string
  columnName: string
  currentValue: WorksheetRecordValue
  nextValue: WorksheetRecordValue
}

export type ImportPreviewDiffExample = {
  rowNumber?: number
  key: string
  action: 'insert' | 'update'
  changes: ImportPreviewChange[]
}

export type ImportPreviewDiff = {
  uniqueFieldName?: string
  insertedRows: number
  updatedRows: number
  unchangedRows: number
  missingKeyRows: number
  changedCells: number
  requiresConfirmation: boolean
  examples: ImportPreviewDiffExample[]
}

export type ImportPreviewRow = {
  rowNumber: number
  values: Record<string, WorksheetRecordValue>
  warnings: string[]
}

export type ImportPreview = {
  worksheetId: string
  worksheetName: string
  matchedHeaders: Array<{ source: string; columnName: string; fieldName: string }>
  unknownHeaders: string[]
  rows: ImportPreviewRow[]
  totalRows: number
  diff?: ImportPreviewDiff
}

export type WorksheetMutationResult = {
  worksheetId: string
  worksheetName: string
  affectedRows: number
}

export type HrMasterSyncChange = {
  fieldName: '单位名称' | '职称' | '职级' | '薪级'
  currentValue: string
  nextValue: string
}

export type MasterSyncSelectionItem = {
  sourceRecordId?: number
  idCard: string
  fieldName: string
}

export type HrMasterSyncDiff = {
  idCard: string
  name: string
  sourceRecordId: number
  masterRecordId?: number
  action: 'insert' | 'update'
  changes: HrMasterSyncChange[]
}

export type HrMasterSyncPreview = {
  sourceRows: number
  masterRows: number
  updatableRows: number
  insertRows: number
  updateRows: number
  missingIdCardRows: number
  missingLookupRows: number
  diffs: HrMasterSyncDiff[]
}

export type HrMasterSyncApplyResult = {
  insertedRows: number
  updatedRows: number
  affectedRows: number
}

export type TownshipNameIssue = {
  name: string
  rowId: number
  reason: 'not-found' | 'duplicate'
  matchedCount: number
}

export type TownshipIdCardFillResult = {
  updatedRows: number
  notFoundRows: number
  duplicateRows: number
  issues: TownshipNameIssue[]
}

export type TownshipMasterSyncChange = {
  fieldName: '参加工作时间' | '工龄' | '乡镇工作年限'
  sourceFieldName: '工作时间' | '工龄' | '乡镇工作年限'
  currentValue: string
  nextValue: string
}

export type TownshipMasterSyncDiff = {
  idCard: string
  name: string
  townshipRecordId: number
  masterRecordId: number
  changes: TownshipMasterSyncChange[]
}

export type TownshipMasterSyncPreview = {
  sourceRows: number
  matchedRows: number
  missingMasterRows: number
  updatableRows: number
  diffs: TownshipMasterSyncDiff[]
}

export type TownshipMasterSyncApplyResult = {
  updatedRows: number
  affectedRows: number
}

export type BudgetActiveMasterSyncChange = {
  fieldName: '性别' | '民族' | '参加工作时间'
  sourceFieldName: '性别*' | '民族*' | '参加工作时间*'
  currentValue: string
  nextValue: string
}

export type BudgetActiveMasterSyncDiff = {
  idCard: string
  name: string
  budgetRecordId: number
  masterRecordId?: number
  action: 'insert' | 'update'
  changes: BudgetActiveMasterSyncChange[]
}

export type BudgetActiveMasterSyncPreview = {
  sourceRows: number
  masterRows: number
  updatableRows: number
  insertRows: number
  updateRows: number
  missingIdCardRows: number
  diffs: BudgetActiveMasterSyncDiff[]
}

export type BudgetActiveMasterSyncApplyResult = {
  insertedRows: number
  updatedRows: number
  affectedRows: number
}

export type TeacherDetailMasterSyncChange = {
  fieldName: string
  currentValue: string
  nextValue: string
}

export type TeacherDetailMasterSyncDiff = {
  idCard: string
  name: string
  sourceRecordId: number
  masterRecordId?: number
  action: 'insert' | 'update'
  changes: TeacherDetailMasterSyncChange[]
}

export type TeacherDetailMasterSyncPreview = {
  sourceRows: number
  masterRows: number
  comparedFields: string[]
  updatableRows: number
  insertRows: number
  updateRows: number
  missingIdCardRows: number
  diffs: TeacherDetailMasterSyncDiff[]
}

export type TeacherDetailMasterSyncApplyResult = {
  insertedRows: number
  updatedRows: number
  affectedRows: number
}

export type BackupSummary = {
  fileName: string
  filePath: string
  sizeBytes: number
  createdAt: string
}

export type PivotAggregation = 'sum' | 'count' | 'count_distinct' | 'avg' | 'max' | 'min'

export type PivotFilterOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'is_null'
  | 'not_null'
  | 'between'
  | 'in'

export type PivotFieldRef = {
  worksheetId: string
  fieldName: string
}

export type PivotValueRef = PivotFieldRef & {
  agg: PivotAggregation
  alias?: string
}

export type PivotFilterRef = PivotFieldRef & {
  op: PivotFilterOp
  values: string[]
}

export type PivotJoinRef = {
  worksheetId: string
  joinType: 'left' | 'inner'
}

export type PivotConfig = {
  id?: number
  name: string
  primaryWorksheetId: string
  joins: PivotJoinRef[]
  rows: PivotFieldRef[]
  columns: PivotFieldRef[]
  values: PivotValueRef[]
  filters: PivotFilterRef[]
  showRowSubtotal: boolean
  showRowGrandTotal: boolean
  showColumnGrandTotal: boolean
  createdAt?: string
  updatedAt?: string
}

export type PivotResult = {
  rowDimensions: string[]
  columnDimensions: string[]
  valueAliases: string[]
  rows: Array<Record<string, string | number | null>>
  totalRows: number
}

export type StatReportColumn = {
  key: string
  label: string
  width?: number
}

export type StatReportFilterClause = {
  field: string
  op: 'eq' | 'in' | 'not_in' | 'contains' | 'is_null' | 'not_null' | 'computed'
  values?: string[]
  computedKind?: 'age' | 'tenure' | 'townshipYears' | 'postCategory' | 'postLevel' | 'seniorTitle'
  computedRange?: [number | null, number | null]
}

export type StatReportRow = {
  label: string
  indent: number
  isTotal: boolean
  isSectionHeader: boolean
  values: Record<string, string | number | null>
  filter?: StatReportFilterClause[]
  filterDesc?: string
}

export type StatReportResult = {
  id: string
  name: string
  columns: StatReportColumn[]
  rows: StatReportRow[]
  generatedAt: string
  dataCount: number
}

export type StatReportDef = {
  id: string
  name: string
  category: string
  description: string
  sourceTable: string
}

export type StatReportDrillResult = {
  filterDesc: string
  fields: string[]
  rows: Array<Record<string, string | number | null>>
  totalRows: number
}

// === 邮件附件下载 ===

export interface MailAccount {
  id?: number
  email: string
  imapHost: string
  imapPort: number
  username: string
  authCodeEncrypted: string
  displayName?: string
  folder?: string
  fromFilter?: string
  createdAt?: string
  updatedAt?: string
}

export interface MailAccountView {
  id: number
  email: string
  imapHost: string
  imapPort: number
  username: string
  authCodeMasked: string
  displayName?: string
  folder?: string
  fromFilter?: string
  createdAt?: string
  updatedAt?: string
}

export interface MailDownloadRule {
  id?: number
  enabled: boolean
  accountId: number
  subjectContains?: string
  extensionFilter?: string
  onlyUnread?: boolean
  markSeen?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface MailDownloadRecord {
  id?: number
  messageUid: number
  messageId?: string
  messageDate: string
  fromAddress: string
  subject: string
  attachmentFilename: string
  attachmentSize: number
  savedPath: string
  accountId: number
  ruleId?: number | null
  createdAt?: string
}

export interface MailDownloadLog {
  id?: number
  accountId: number
  ruleId?: number | null
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: string
  createdAt?: string
}

export interface MailCheckProgress {
  phase: 'connecting' | 'scanning' | 'downloading' | 'done'
  accountEmail?: string
  totalMessages?: number
  scannedMessages?: number
  foundCount?: number
  downloadedCount?: number
  skippedCount?: number
  errorCount?: number
  currentFilename?: string
  message?: string
}

export interface MailCheckResult {
  accountId: number
  accountEmail: string
  totalMessages: number
  scannedMessages: number
  foundCount: number
  downloadedCount: number
  skippedCount: number
  errorCount: number
  errors: string[]
}
