import { all, getDatabase, refreshAllPersonnelStatuses, run } from '../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import { readWorksheetMetadata } from '../db/metadata'
import { normalizeEducationForCompare } from './educationNormalize'
import {
  jobLevelsEquivalent,
  normalizeJobLevelForCompare,
  normalizeSalaryGradeForCompare
} from './salaryLevelNormalize'
import type {
  ConsistencyAuditIssue,
  ConsistencyAuditApplyDirection,
  ConsistencyAuditApplyResult,
  ConsistencyAuditResult,
  ConsistencyAuditRuleSummary,
  ConsistencyAuditValue,
  WorksheetMeta,
  WorksheetRecordValue
} from '../../shared/types'

type Row = Record<string, WorksheetRecordValue | number | undefined>
type CompareKind =
  | 'text'
  | 'number'
  | 'identity'
  | 'date'
  | 'education'
  | 'ethnicity'
  | 'jobLevel'
  | 'personnelStatus'
  | 'salaryGrade'

type FieldRule = {
  key: string
  label: string
  master: string[]
  source: string[]
  kind?: CompareKind
  masterWorksheet?: string
  masterFilter?: { field: string; value: string }
}

type SourceRule = {
  worksheetName: string
  identity: string[]
  fields: FieldRule[]
}

type SheetCtx = {
  worksheet: WorksheetMeta
  tableName: string
  columns: Map<string, string>
}

type FieldMatch = {
  fieldName: string
  columnName: string
}

const masterWorksheetName = '人事信息'
const identityCandidates = ['身份证号码', '身份证号', '证件号码*', '证件号码', '教职工身份证号']
const statusCandidates = ['人员状态', '人员状态*', '状态', '状态*']
const activeStatusTexts = new Set(['在职', '在岗', '正常'])
const inactiveStatusTexts = ['退休', '其他', '调出', '调出人员', '去世']
const activeAuditWorksheetNames = new Set([
  '在职工资',
  '预算在职',
  '乡镇补贴',
  '工资年报',
  '绩效工资',
  '人员明细导出',
  '在编教职工基本信息'
])
const inactiveAuditWorksheetNames = new Set([
  '退休工资',
  '预算退休',
  '新房补',
  '退休养老金',
  '人事退休',
  '其他工资',
  '预算其他',
  '其他人员'
])

const nameRule: FieldRule = {
  key: 'name',
  label: '姓名',
  master: ['姓名'],
  source: ['姓名', '姓名*']
}

const unitRule: FieldRule = {
  key: 'unit',
  label: '单位',
  master: ['单位名称', '单位全称'],
  source: ['单位名称', '单位名称*', '单位全称', '单位', '所在学校']
}

const statusRule: FieldRule = {
  key: 'personnelStatus',
  label: '人员状态',
  master: ['人员状态'],
  source: ['人员状态', '人员状态*'],
  kind: 'personnelStatus'
}

const sexRule: FieldRule = {
  key: 'sex',
  label: '性别',
  master: ['性别'],
  source: ['性别', '性别*']
}

const ethnicityRule: FieldRule = {
  key: 'ethnicity',
  label: '民族',
  master: ['民族'],
  source: ['民族', '民族*'],
  kind: 'ethnicity'
}

const educationRule: FieldRule = {
  key: 'education',
  label: '学历',
  master: ['最高学历'],
  source: ['学历*', '学历', '最高学历'],
  kind: 'education'
}

const jobLevelRule: FieldRule = {
  key: 'jobLevel',
  label: '职级',
  master: ['职级'],
  source: ['事业人员岗位工资级别', '执行基本工资对应岗位', '级别', '岗位工资级别*', '岗位工资级别', '层次'],
  kind: 'jobLevel'
}

const salaryGradeRule: FieldRule = {
  key: 'salaryGrade',
  label: '薪级',
  master: ['薪级'],
  source: ['薪级', '工资薪级', '薪级级别', '工资薪级*', '薪级（含浮动薪级和浮动改固定薪级）'],
  kind: 'salaryGrade'
}

const birthDateRule: FieldRule = {
  key: 'birthDate',
  label: '出生日期',
  master: ['出生日期'],
  source: ['出生日期', '出生日期*', '出生年月'],
  kind: 'date'
}

const workDateRule: FieldRule = {
  key: 'workDate',
  label: '参加工作时间',
  master: ['参加工作时间'],
  source: ['参加工作时间', '参加工作时间*', '工作时间', '参加工作年月'],
  kind: 'date'
}

const workYearsRule: FieldRule = {
  key: 'workYears',
  label: '工龄',
  master: ['工龄'],
  source: ['工龄', '工龄（年）*', '工龄（年）', '工龄(年）'],
  kind: 'number'
}

const townshipYearsRule: FieldRule = {
  key: 'townshipYears',
  label: '乡镇工作年限',
  master: ['乡镇工作年限'],
  source: ['乡镇工作年限', '乡镇工作年限（年）'],
  kind: 'number'
}

const applicableSchoolYearsRule: FieldRule = {
  key: 'applicableSchoolYears',
  label: '应计学龄',
  master: ['应计学龄'],
  source: ['不计算工龄的大专以上学龄（年）', '不计算工龄的大专以上学龄'],
  kind: 'number'
}

const politicalRule: FieldRule = {
  key: 'political',
  label: '政治面貌',
  master: ['政治面貌'],
  source: ['政治面貌']
}

const joinPartyDateRule: FieldRule = {
  key: 'joinPartyDate',
  label: '参加党派时间',
  master: ['入党时间'],
  source: ['入党时间', '参加党派时间'],
  kind: 'date'
}

const nativePlaceRule: FieldRule = {
  key: 'nativePlace',
  label: '籍贯',
  master: ['籍贯'],
  source: ['籍贯']
}

const phoneRule: FieldRule = {
  key: 'phone',
  label: '联系电话',
  master: ['联系电话'],
  source: ['联系电话', '移动电话']
}

const titleRule: FieldRule = {
  key: 'title',
  label: '职称',
  master: ['职称'],
  source: ['职称', '专业技术职称1', '聘任职称']
}

const titleDateRule: FieldRule = {
  key: 'titleDate',
  label: '职称获得时间',
  master: ['职称获得时间'],
  source: ['职称获得时间', '职称1取得时间'],
  kind: 'date'
}

const adminPostRule: FieldRule = {
  key: 'adminPost',
  label: '岗位职务',
  master: ['岗位职务'],
  source: ['岗位职务', '行政职务']
}

const appointUnitRule: FieldRule = {
  key: 'appointUnit',
  label: '任命单位',
  master: ['任命单位'],
  source: ['任命单位', '行政职务任命单位']
}

const appointDateRule: FieldRule = {
  key: 'appointDate',
  label: '在现单位任现职时间',
  master: ['在现单位任现职时间'],
  source: ['在现单位任现职时间', '任职年月', '行政职务任职年月'],
  kind: 'date'
}

const firstEducationRule: FieldRule = {
  key: 'firstEducation',
  label: '第一学历',
  master: ['学历'],
  source: ['第一学历'],
  kind: 'education',
  masterWorksheet: '教职工学历',
  masterFilter: { field: '学历类别', value: '全日制' }
}

const firstEducationMajorRule: FieldRule = {
  key: 'firstEducationMajor',
  label: '第一学历专业',
  master: ['专业'],
  source: ['第一学历专业'],
  masterWorksheet: '教职工学历',
  masterFilter: { field: '学历类别', value: '全日制' }
}

const highestEducationRule: FieldRule = {
  key: 'highestEducation',
  label: '最高学历',
  master: ['学历'],
  source: ['最高学历'],
  kind: 'education',
  masterWorksheet: '教职工学历',
  masterFilter: { field: '学历类别', value: '最高' }
}

const highestEducationMajorRule: FieldRule = {
  key: 'highestEducationMajor',
  label: '最高学历专业',
  master: ['专业'],
  source: ['最高学历专业'],
  masterWorksheet: '教职工学历',
  masterFilter: { field: '学历类别', value: '最高' }
}

const bankNameRule: FieldRule = {
  key: 'bankName',
  label: '工资卡开户银行',
  master: ['工资卡开户银行'],
  source: ['工资卡开户银行*', '工资卡开户银行']
}

const bankCardRule: FieldRule = {
  key: 'bankCard',
  label: '工资卡卡号',
  master: ['工资卡卡号'],
  source: ['工资卡卡号*', '工资卡卡号'],
  kind: 'identity'
}

const missingMasterRule: FieldRule = {
  key: 'missingMaster',
  label: '人事信息缺失',
  master: ['身份证号码'],
  source: identityCandidates,
  kind: 'identity'
}

const sourceRules: SourceRule[] = [
  {
    worksheetName: '在职工资',
    identity: identityCandidates,
    fields: [nameRule, unitRule]
  },
  {
    worksheetName: '退休工资',
    identity: identityCandidates,
    fields: [nameRule, unitRule]
  },
  {
    worksheetName: '其他工资',
    identity: identityCandidates,
    fields: [nameRule, unitRule, statusRule]
  },
  {
    worksheetName: '预算在职',
    identity: identityCandidates,
    fields: [
      nameRule,
      unitRule,
      statusRule,
      sexRule,
      ethnicityRule,
      educationRule,
      birthDateRule,
      workDateRule,
      workYearsRule,
      jobLevelRule,
      salaryGradeRule,
      bankNameRule,
      bankCardRule
    ]
  },
  {
    worksheetName: '预算退休',
    identity: identityCandidates,
    fields: [
      nameRule,
      unitRule,
      statusRule,
      sexRule,
      ethnicityRule,
      educationRule,
      birthDateRule,
      workDateRule,
      workYearsRule,
      jobLevelRule,
      salaryGradeRule,
      bankNameRule,
      bankCardRule
    ]
  },
  {
    worksheetName: '预算其他',
    identity: identityCandidates,
    fields: [
      nameRule,
      unitRule,
      statusRule,
      sexRule,
      ethnicityRule,
      educationRule,
      birthDateRule,
      workDateRule,
      workYearsRule,
      salaryGradeRule,
      bankNameRule,
      bankCardRule
    ]
  },
  {
    worksheetName: '乡镇补贴',
    identity: identityCandidates,
    fields: [nameRule, unitRule, statusRule, workDateRule, workYearsRule, townshipYearsRule]
  },
  {
    worksheetName: '工资年报',
    identity: identityCandidates,
    fields: [
      nameRule,
      statusRule,
      sexRule,
      ethnicityRule,
      educationRule,
      workDateRule,
      workYearsRule,
      jobLevelRule,
      salaryGradeRule,
      townshipYearsRule,
      applicableSchoolYearsRule
    ]
  },
  {
    worksheetName: '绩效工资',
    identity: identityCandidates,
    fields: [nameRule, statusRule]
  },
  {
    worksheetName: '人员明细导出',
    identity: identityCandidates,
    fields: [nameRule, statusRule]
  },
  {
    worksheetName: '新房补',
    identity: identityCandidates,
    fields: [nameRule, unitRule, statusRule]
  },
  {
    worksheetName: '在编教职工基本信息',
    identity: identityCandidates,
    fields: [nameRule, unitRule, statusRule, sexRule, ethnicityRule, birthDateRule]
  },
]

export async function runConsistencyAudit(): Promise<ConsistencyAuditResult> {
  const database = await getDatabase()
  const worksheets = readWorksheetMetadata()
  const masterWorksheet = worksheets.find((item) => item.name === masterWorksheetName)
  if (!masterWorksheet) throw new Error(`未找到主表：${masterWorksheetName}`)

  const master = buildSheetCtx(masterWorksheet)
  const masterIdentityColumn = findColumn(master, identityCandidates)
  if (!masterIdentityColumn) throw new Error(`主表缺少身份证字段：${masterWorksheetName}`)

  const masterRows = await all<Row>(database, `SELECT * FROM ${master.tableName}`)
  const masterByIdCard = new Map<string, Row>()
  const activeIdCards = new Set<string>()
  const inactiveIdCards = new Set<string>()
  const masterStatusColumn = findColumn(master, statusCandidates)
  for (const row of masterRows) {
    const idCard = normalizeValue(row[masterIdentityColumn], 'identity')
    if (!idCard) continue
    masterByIdCard.set(idCard, row)
    if (!masterStatusColumn) continue
    const status = row[masterStatusColumn]
    if (isActiveStatus(status)) activeIdCards.add(idCard)
    else if (isInactiveStatus(status)) inactiveIdCards.add(idCard)
  }

  await collectWorksheetIdCards(database, worksheets, ['在职工资'], activeIdCards)
  await collectWorksheetIdCards(database, worksheets, [...inactiveAuditWorksheetNames], inactiveIdCards)

  const altMasters = await loadAltMasters(database, worksheets, sourceRules)

  const issues: ConsistencyAuditIssue[] = []
  const ruleStats = new Map<string, ConsistencyAuditRuleSummary>()
  let comparedCells = 0
  let missingMasterRows = 0
  const missingMasterKeys = new Set<string>()

  for (const rule of sourceRules) {
    if (!activeAuditWorksheetNames.has(rule.worksheetName)) continue

    const worksheet = worksheets.find((item) => item.name === rule.worksheetName)
    if (!worksheet) continue

    const source = buildSheetCtx(worksheet)
    const sourceIdentityColumn = findColumn(source, rule.identity)
    if (!sourceIdentityColumn) continue
    const sourceStatusColumn = findColumn(source, statusCandidates)

    const sourceRows = await all<Row>(database, `SELECT * FROM ${source.tableName}`)
    for (const sourceRow of sourceRows) {
      const idCard = normalizeValue(sourceRow[sourceIdentityColumn], 'identity')
      if (!idCard) continue
      if (!shouldAuditActiveRow(rule.worksheetName, sourceRow, sourceStatusColumn, idCard, activeIdCards, inactiveIdCards)) continue

      const masterRow = masterByIdCard.get(idCard)
      if (!masterRow) {
        const missingKey = `${rule.worksheetName}|${idCard}`
        if (!missingMasterKeys.has(missingKey)) {
          missingMasterKeys.add(missingKey)
          missingMasterRows += 1
          incrementCompared(ruleStats, missingMasterRule)
          incrementIssue(ruleStats, missingMasterRule)
          issues.push(buildMissingMasterIssue(rule.worksheetName, source, sourceRow, idCard))
        }
        continue
      }

      for (const fieldRule of rule.fields) {
        const sourceField = findField(source, fieldRule.source)
        if (!sourceField) continue

        const altKey = altMasterKey(fieldRule)
        const alt = altKey ? altMasters.get(altKey) : undefined
        if (altKey && !alt) continue
        const masterCtx = alt ? alt.ctx : master
        const masterRowToUse = alt ? alt.rowsByIdCard.get(idCard) : masterRow
        const masterWorksheetForIssue = alt ? alt.ctx.worksheet.name : masterWorksheetName
        if (!masterRowToUse) continue
        const masterField = findField(masterCtx, fieldRule.master)
        if (!masterField) continue

        const sourceRaw = sourceRow[sourceField.columnName]
        const masterRaw = masterRowToUse[masterField.columnName]
        const sourceText = text(sourceRaw)
        const masterText = text(masterRaw)
        if (!sourceText && !masterText) continue

        comparedCells += 1
        incrementCompared(ruleStats, fieldRule)

        if (valuesMatch(sourceRaw, masterRaw, fieldRule.kind)) continue

        incrementIssue(ruleStats, fieldRule)
        const name = text(readByCandidates(master, masterRow, ['姓名'])) || text(readByCandidates(source, sourceRow, ['姓名', '姓名*']))
        issues.push({
          key: `${rule.worksheetName}|${numberOrUndefined(sourceRow.id) ?? ''}|${idCard}|${fieldRule.key}`,
          idCard,
          name,
          fieldKey: fieldRule.key,
          fieldLabel: fieldRule.label,
          master: toAuditValue(masterWorksheetForIssue, masterField.fieldName, masterRowToUse, masterRaw),
          source: toAuditValue(rule.worksheetName, sourceField.fieldName, sourceRow, sourceRaw),
          severity: 'warning'
        })
      }
    }
  }

  return {
    masterWorksheetName,
    checkedPeople: [...masterByIdCard.keys()].filter(
      (idCard) => activeIdCards.has(idCard) && !inactiveIdCards.has(idCard)
    ).length,
    comparedCells,
    issueCount: issues.length,
    missingMasterRows,
    generatedAt: new Date().toISOString(),
    rules: [...ruleStats.values()].sort((a, b) => b.issueCount - a.issueCount || a.fieldLabel.localeCompare(b.fieldLabel)),
    issues
  }
}

export async function applyConsistencyAuditUpdates(
  direction: ConsistencyAuditApplyDirection,
  issues: ConsistencyAuditIssue[]
): Promise<ConsistencyAuditApplyResult> {
  const database = await getDatabase()
  const worksheets = readWorksheetMetadata()
  let updatedRows = 0
  let skippedRows = 0

  // 批量回写必须放在一个事务里：中途某行报错（如撞唯一约束）能整体回滚，
  // 不会留下"前半应用、后半未应用"的半成品；WAL 下也省去逐行 fsync。
  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const issue of issues) {
      if (issue.severity !== 'warning' || !issue.master) {
        skippedRows += 1
        continue
      }

      const targetValue = direction === 'source-to-master' ? issue.source : issue.master
      const targetRecord =
        direction === 'source-to-master'
          ? issue.master
          : issue.source
      if (!targetRecord.recordId) {
        skippedRows += 1
        continue
      }

      const worksheet = worksheets.find((item) => item.name === targetRecord.worksheetName)
      if (!worksheet) {
        skippedRows += 1
        continue
      }

      const column = getWorksheetLocalColumns(worksheet).find(
        (item) => item.field.name === targetRecord.fieldName
      )
      if (!column) {
        skippedRows += 1
        continue
      }

      await run(
        database,
        `UPDATE ${quoteIdentifier(worksheet.name)}
         SET ${quoteIdentifier(column.columnName)} = ?, "md_updated_at" = ?
         WHERE "id" = ?`,
        [targetValue.value, new Date().toISOString(), targetRecord.recordId]
      )
      updatedRows += 1
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK').catch(() => undefined)
    throw error
  }

  if (updatedRows > 0) {
    await refreshAllPersonnelStatuses(database)
  }

  const directionText = direction === 'source-to-master' ? '来源值更新人事信息' : '人事信息回写来源表'
  return {
    updatedRows,
    skippedRows,
    messages: [`${directionText}：更新 ${updatedRows} 项，跳过 ${skippedRows} 项`]
  }
}

type AltMasterCtx = {
  ctx: SheetCtx
  rowsByIdCard: Map<string, Row>
}

function altMasterKey(fieldRule: FieldRule): string | undefined {
  if (!fieldRule.masterWorksheet) return undefined
  const filter = fieldRule.masterFilter
  return filter
    ? `${fieldRule.masterWorksheet}|${filter.field}=${filter.value}`
    : fieldRule.masterWorksheet
}

async function loadAltMasters(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheets: WorksheetMeta[],
  rules: SourceRule[]
): Promise<Map<string, AltMasterCtx>> {
  const altSpecs = new Map<string, FieldRule>()
  for (const rule of rules) {
    for (const fieldRule of rule.fields) {
      const key = altMasterKey(fieldRule)
      if (!key) continue
      if (!altSpecs.has(key)) altSpecs.set(key, fieldRule)
    }
  }

  const result = new Map<string, AltMasterCtx>()
  for (const [key, spec] of altSpecs) {
    const worksheet = worksheets.find((item) => item.name === spec.masterWorksheet)
    if (!worksheet) continue
    const ctx = buildSheetCtx(worksheet)
    const identityColumn = findColumn(ctx, identityCandidates)
    if (!identityColumn) continue

    const filterColumn = spec.masterFilter
      ? ctx.columns.get(spec.masterFilter.field)
      : undefined

    const rows = await all<Row>(database, `SELECT * FROM ${ctx.tableName} ORDER BY "id" ASC`)
    const rowsByIdCard = new Map<string, Row>()
    for (const row of rows) {
      const idCard = normalizeValue(row[identityColumn], 'identity')
      if (!idCard) continue
      if (spec.masterFilter && filterColumn) {
        if (text(row[filterColumn]) !== spec.masterFilter.value) continue
      }
      rowsByIdCard.set(idCard, row)
    }
    result.set(key, { ctx, rowsByIdCard })
  }
  return result
}

async function collectWorksheetIdCards(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheets: WorksheetMeta[],
  worksheetNames: string[],
  target: Set<string>
): Promise<void> {
  for (const worksheetName of worksheetNames) {
    const worksheet = worksheets.find((item) => item.name === worksheetName)
    if (!worksheet) continue

    const source = buildSheetCtx(worksheet)
    const identityColumn = findColumn(source, identityCandidates)
    if (!identityColumn) continue

    const rows = await all<Row>(database, `SELECT * FROM ${source.tableName}`)
    for (const row of rows) {
      const idCard = normalizeValue(row[identityColumn], 'identity')
      if (idCard) target.add(idCard)
    }
  }
}

function shouldAuditActiveRow(
  worksheetName: string,
  row: Row,
  statusColumn: string | undefined,
  idCard: string,
  activeIdCards: Set<string>,
  inactiveIdCards: Set<string>
): boolean {
  const fieldStatus = statusColumn ? row[statusColumn] : undefined
  if (inactiveIdCards.has(idCard) || isInactiveStatus(fieldStatus) || isInactiveStatus(row.md_status)) {
    return false
  }

  if (activeIdCards.has(idCard)) return true
  if (isActiveStatus(fieldStatus) || isActiveStatus(row.md_status)) return true
  return worksheetName === '在职工资'
}

function buildSheetCtx(worksheet: WorksheetMeta): SheetCtx {
  const columns = new Map<string, string>()
  for (const column of getWorksheetLocalColumns(worksheet)) {
    columns.set(column.field.name, column.columnName)
  }
  return { worksheet, tableName: quoteIdentifier(worksheet.name), columns }
}

function findColumn(sheet: SheetCtx, candidates: string[]): string | undefined {
  return candidates.map((name) => sheet.columns.get(name)).find((column): column is string => Boolean(column))
}

function findField(sheet: SheetCtx, candidates: string[]): FieldMatch | undefined {
  for (const fieldName of candidates) {
    const columnName = sheet.columns.get(fieldName)
    if (columnName) return { fieldName, columnName }
  }
  return undefined
}

function readByCandidates(sheet: SheetCtx, row: Row, candidates: string[]): WorksheetRecordValue | number | undefined {
  const column = findColumn(sheet, candidates)
  return column ? row[column] : undefined
}

function buildMissingMasterIssue(
  worksheetName: string,
  source: SheetCtx,
  sourceRow: Row,
  idCard: string
): ConsistencyAuditIssue {
  const name = text(readByCandidates(source, sourceRow, ['姓名', '姓名*']))
  return {
    key: `${worksheetName}|${numberOrUndefined(sourceRow.id) ?? ''}|${idCard}|missingMaster`,
    idCard,
    name,
    fieldKey: 'missingMaster',
    fieldLabel: '人事信息缺失',
    source: toAuditValue(worksheetName, '身份证字段', sourceRow, idCard),
    severity: 'error'
  }
}

function toAuditValue(
  worksheetName: string,
  fieldName: string,
  row: Row,
  value: unknown
): ConsistencyAuditValue {
  return {
    worksheetName,
    fieldName,
    recordId: numberOrUndefined(row.id),
    value: text(value),
    updatedAt: text(row.md_updated_at) || undefined
  }
}

function incrementCompared(ruleStats: Map<string, ConsistencyAuditRuleSummary>, rule: FieldRule): void {
  const summary = getRuleSummary(ruleStats, rule)
  summary.comparedCount += 1
}

function incrementIssue(ruleStats: Map<string, ConsistencyAuditRuleSummary>, rule: FieldRule): void {
  const summary = getRuleSummary(ruleStats, rule)
  summary.issueCount += 1
}

function getRuleSummary(ruleStats: Map<string, ConsistencyAuditRuleSummary>, rule: FieldRule): ConsistencyAuditRuleSummary {
  const existing = ruleStats.get(rule.key)
  if (existing) return existing
  const created = {
    fieldKey: rule.key,
    fieldLabel: rule.label,
    comparedCount: 0,
    issueCount: 0
  }
  ruleStats.set(rule.key, created)
  return created
}

function normalizeValue(value: unknown, kind: CompareKind = 'text'): string {
  if (kind === 'identity') return text(value).replace(/[\s,]/g, '').toUpperCase()
  if (kind === 'number') return normalizeNumber(value)
  if (kind === 'date') return normalizeDate(value)
  if (kind === 'education') return normalizeEducationForCompare(value)
  if (kind === 'ethnicity') return normalizeEthnicity(value)
  if (kind === 'jobLevel') return normalizeJobLevelForCompare(value)
  if (kind === 'personnelStatus') return normalizePersonnelStatus(value)
  if (kind === 'salaryGrade') return normalizeSalaryGradeForCompare(value)
  return text(value).replace(/\s+/g, '').toUpperCase()
}

function isActiveStatus(value: unknown): boolean {
  const normalized = text(value).replace(/\s+/g, '')
  return activeStatusTexts.has(normalized)
}

function isInactiveStatus(value: unknown): boolean {
  const normalized = text(value).replace(/\s+/g, '')
  if (!normalized) return false
  return inactiveStatusTexts.some((status) => normalized.includes(status))
}

function valuesMatch(source: unknown, master: unknown, kind: CompareKind = 'text'): boolean {
  if (kind === 'jobLevel') return jobLevelsEquivalent(source, master)
  const sourceValue = normalizeValue(source, kind)
  const masterValue = normalizeValue(master, kind)
  if (sourceValue === masterValue) return true
  if (kind !== 'date') return false
  if (sourceValue.length === 7 && masterValue.startsWith(`${sourceValue}-`)) return true
  if (masterValue.length === 7 && sourceValue.startsWith(`${masterValue}-`)) return true
  return false
}

function normalizeNumber(value: unknown): string {
  const raw = text(value).replace(/,/g, '')
  if (!raw) return ''
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return raw.replace(/\s+/g, '')
  return String(parsed)
}

function normalizeEthnicity(value: unknown): string {
  const normalized = text(value).replace(/\s+/g, '')
  return normalized.endsWith('族') ? normalized.slice(0, -1) : normalized
}

function normalizePersonnelStatus(value: unknown): string {
  const normalized = text(value).replace(/\s+/g, '')
  if (normalized === '在职' || normalized === '在岗' || normalized === '正常') return '在职'
  return normalized
}

function normalizeDate(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  const compact = raw.replace(/\s+00:00:00$/, '').trim()
  const matched = compact.match(/^(\d{4})[年/.-]?(\d{1,2})[月/.-]?(\d{1,2})日?$/)
  if (!matched) {
    const monthMatched = compact.match(/^(\d{4})[年/.-](\d{1,2})月?$/)
    if (monthMatched) return `${monthMatched[1]}-${monthMatched[2].padStart(2, '0')}`
    return compact.replace(/\s+/g, '').toUpperCase()
  }
  return `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
