import { all, getDatabase, run, runWithLastId } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import { normalizeEducationForBudget } from '../educationNormalize'
import {
  normalizeJobLevelForDisplay,
  normalizeSalaryGradeForBudget,
  normalizeSalaryGradeForDisplay
} from '../salaryLevelNormalize'
import { failRule, okRule } from '../ruleResult'
import { findColumnByName, getWorksheetByName, tableNameOf, tryFindColumnByName } from '../worksheetTable'
import type { RuleResult, WorksheetMeta } from '../../../shared/types'

type Row = Record<string, string | number | null>
type Value = string | number | null

type BuildArgs = {
  sourceRow: Row
  index: number
  source: SheetCtx
  target: SheetCtx
  lookups: LookupCtx
}

type SheetCtx = {
  worksheet: WorksheetMeta
  table: string
  columns: Map<string, string>
  columnsByField: Map<string, string[]>
}

type LookupCtx = {
  jobByAmount: Map<number, Row>
  salaryByAmount: Map<number, Row>
  hrInfoByIdCard: Map<string, Row>
  educationByIdCard: Map<string, Row>
  previousBudgetRetiredByIdCard: Map<string, Row>
  previousBudgetOtherByIdCard: Map<string, Row>
  newHousingByIdCard: Map<string, Row>
}

type LookupFailureDraft = {
  worksheet: string
  idCard: string
  name: string
  lookupTable: string
  lookupKey: string
  lookupValue: string
  reason: string
}

const budgetWorkflowName = '更新预算'

export async function syncAllBudgetFromIntegrated(): Promise<RuleResult> {
  try {
    return await runBudgetStatusSync()
  } catch (error) {
    return failRule(budgetWorkflowName, error)
  }
}

async function runBudgetStatusSync(): Promise<RuleResult> {
  const activeSource = getSheetCtx('在职工资')
  const retiredSource = getSheetCtx('退休工资')
  const otherSource = getSheetCtx('其他工资')
  const activeTarget = getSheetCtx('预算在职')
  const retiredTarget = getSheetCtx('预算退休')
  const otherTarget = getSheetCtx('预算其他')
  const lookups = await loadLookups()

  const activeSourceRows = await loadLatestSourceRows(activeSource)
  const retiredSourceRows = await loadLatestSourceRows(retiredSource)
  const otherSourceRows = await loadLatestSourceRows(otherSource)
  ensureRetiredHousingReady(retiredSourceRows, retiredSource, lookups)
  const activeSourceMap = rowsByIdCard(activeSource, activeSourceRows)
  const retiredSourceMap = rowsByIdCard(retiredSource, retiredSourceRows)
  const otherSourceMap = rowsByIdCard(otherSource, otherSourceRows)
  const activeTargetRows = await loadLatestSourceRows(activeTarget)
  const retiredTargetRows = await loadLatestSourceRows(retiredTarget)
  const otherTargetRows = await loadLatestSourceRows(otherTarget)
  const activeTargetMap = rowsByIdCard(activeTarget, activeTargetRows)
  const retiredTargetMap = rowsByIdCard(retiredTarget, retiredTargetRows)
  const otherTargetMap = rowsByIdCard(otherTarget, otherTargetRows)
  ensureBudgetSourceCompleteness([
    {
      targetName: '预算在职',
      targetRows: activeTargetRows,
      target: activeTarget,
      sourceNames: '在职工资/退休工资',
      existsInSource: (idCard) => activeSourceMap.has(idCard) || retiredSourceMap.has(idCard)
    },
    {
      targetName: '预算退休',
      targetRows: retiredTargetRows,
      target: retiredTarget,
      sourceNames: '退休工资',
      existsInSource: (idCard) => retiredSourceMap.has(idCard)
    },
    {
      targetName: '预算其他',
      targetRows: otherTargetRows,
      target: otherTarget,
      sourceNames: '其他工资',
      existsInSource: (idCard) => otherSourceMap.has(idCard)
    }
  ])

  const messages: string[] = []
  const warnings: string[] = []
  const activeMissingIntegrated: string[] = []
  const retiredMissingIntegrated: string[] = []
  const otherMissingIntegrated: string[] = []
  let lookupFailureCount = 0
  const counts = {
    activeUpdated: 0,
    activeAdded: 0,
    activeTransferredOut: 0,
    activeToRetired: 0,
    retiredUpdated: 0,
    retiredAdded: 0,
    retiredDeceased: 0,
    otherUpdated: 0,
    otherAdded: 0,
    otherDeceased: 0
  }

  const database = await getDatabase()
  await run(database, `DELETE FROM lookup_failures WHERE workflow = ?`, [budgetWorkflowName])
  await run(database, 'BEGIN TRANSACTION')
  try {
    const activeTargetIdColumn = findIdCardColumn(activeTarget)

    for (const row of activeTargetRows) {
      const idCard = normalizeIdCard(row[activeTargetIdColumn])
      if (!idCard) continue

      const sourceActive = activeSourceMap.get(idCard)
      if (sourceActive) {
        const values = buildBudgetActiveRow({
          sourceRow: sourceActive,
          index: counts.activeUpdated,
          source: activeSource,
          target: activeTarget,
          lookups
        })
        const update = buildBudgetActiveUpdateRow({
          sourceRow: sourceActive,
          currentRow: row,
          source: activeSource,
          target: activeTarget,
          lookups
        })
        lookupFailureCount += await recordLookupFailures(update.failures)
        Object.assign(values, update.values)
        await updateTargetFieldsAndStatus(activeTarget, row, values, '正常', '在职工资匹配')
        counts.activeUpdated += 1
        continue
      }

      const sourceRetired = retiredSourceMap.get(idCard)
      if (sourceRetired) {
        const values = buildBudgetRetiredRow({
          sourceRow: sourceRetired,
          index: counts.activeToRetired,
          source: retiredSource,
          target: retiredTarget,
          lookups
        })
        await upsertTargetByIdCard(
          retiredTarget,
          idCard,
          values,
          '正常',
          '由预算在职转入预算退休'
        )
        await deleteTargetRow(activeTarget, row)
        counts.activeToRetired += 1
        continue
      }

      activeMissingIntegrated.push(personLabel(activeTarget, row, idCard))
      await updateTargetStatus(activeTarget, row, '调出人员', '在职工资和退休工资均未找到')
      counts.activeTransferredOut += 1
    }

    for (const sourceRow of activeSourceRows) {
      const idCard = normalizeIdCard(sourceRow[findIdCardColumn(activeSource)])
      if (!idCard || activeTargetMap.has(idCard)) continue
      const values = buildBudgetActiveRow({
        sourceRow,
        index: counts.activeUpdated + counts.activeAdded,
        source: activeSource,
        target: activeTarget,
        lookups
      })
      const update = buildBudgetActiveUpdateRow({
        sourceRow,
        currentRow: undefined,
        source: activeSource,
        target: activeTarget,
        lookups
      })
      lookupFailureCount += await recordLookupFailures(update.failures)
      Object.assign(values, update.values)
      await insertTargetRow(activeTarget, values, '正常', '在职工资新增')
      counts.activeAdded += 1
    }
    await clearBudgetActiveExcludedFields(activeTarget)
    await setChangeTypeAll(activeTarget, '信息调整')

    const retiredTargetIdColumn = findIdCardColumn(retiredTarget)

    for (const row of retiredTargetRows) {
      const idCard = normalizeIdCard(row[retiredTargetIdColumn])
      if (!idCard) continue
      const sourceRetired = retiredSourceMap.get(idCard)
      if (sourceRetired) {
        const values = buildBudgetRetiredRow({
          sourceRow: sourceRetired,
          index: counts.retiredUpdated,
          source: retiredSource,
          target: retiredTarget,
          lookups
        })
        const patch = buildBudgetRetiredPatchRow({
          sourceRow: sourceRetired,
          currentRow: row,
          source: retiredSource,
          target: retiredTarget,
          lookups
        })
        Object.assign(values, patch)
        await updateTargetFieldsAndStatus(retiredTarget, row, values, '正常', '退休工资匹配')
        counts.retiredUpdated += 1
      } else {
        retiredMissingIntegrated.push(personLabel(retiredTarget, row, idCard))
        await updateTargetStatus(retiredTarget, row, '去世', '退休工资未找到')
        counts.retiredDeceased += 1
      }
    }

    for (const sourceRow of retiredSourceRows) {
      const idCard = normalizeIdCard(sourceRow[findIdCardColumn(retiredSource)])
      if (!idCard || retiredTargetMap.has(idCard)) continue
      const values = buildBudgetRetiredRow({
        sourceRow,
        index: counts.retiredUpdated + counts.retiredAdded,
        source: retiredSource,
        target: retiredTarget,
        lookups
      })
      await insertTargetRow(retiredTarget, values, '正常', '退休工资新增')
      counts.retiredAdded += 1
    }

    const otherTargetIdColumn = findIdCardColumn(otherTarget)

    for (const row of otherTargetRows) {
      const idCard = normalizeIdCard(row[otherTargetIdColumn])
      if (!idCard) continue
      const sourceOther = otherSourceMap.get(idCard)
      if (sourceOther) {
        const values = buildBudgetOtherRow({
          sourceRow: sourceOther,
          index: counts.otherUpdated,
          source: otherSource,
          target: otherTarget,
          lookups
        })
        const patch = buildBudgetOtherPatchRow({
          sourceRow: sourceOther,
          currentRow: row,
          source: otherSource,
          target: otherTarget,
          lookups
        })
        Object.assign(values, patch)
        await updateTargetFieldsAndStatus(otherTarget, row, values, '正常', '其他工资匹配')
        counts.otherUpdated += 1
      } else {
        otherMissingIntegrated.push(personLabel(otherTarget, row, idCard))
        await updateTargetStatus(otherTarget, row, '去世', '其他工资未找到')
        counts.otherDeceased += 1
      }
    }

    for (const sourceRow of otherSourceRows) {
      const idCard = normalizeIdCard(sourceRow[findIdCardColumn(otherSource)])
      if (!idCard || otherTargetMap.has(idCard)) continue
      const values = buildBudgetOtherRow({
        sourceRow,
        index: counts.otherUpdated + counts.otherAdded,
        source: otherSource,
        target: otherTarget,
        lookups
      })
      await insertTargetRow(otherTarget, values, '正常', '其他工资新增')
      counts.otherAdded += 1
    }

    await setChangeTypeAll(retiredTarget, '信息调整')
    await setChangeTypeAll(otherTarget, '信息调整')

    await markDeceasedRows(retiredTarget)
    await markDeceasedRows(otherTarget)

    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  if (activeSourceRows.length === 0) warnings.push('在职工资没有可用于更新预算的数据')
  if (retiredSourceRows.length === 0) warnings.push('退休工资没有可用于更新预算的数据')
  if (otherSourceRows.length === 0) warnings.push('其他工资没有可用于更新预算的数据')
  warnings.push(
    ...buildMissingLookupWarnings('在职工资', activeSourceRows, activeSource, lookups.hrInfoByIdCard, '人事信息'),
    ...buildMissingLookupWarnings('退休工资', retiredSourceRows, retiredSource, lookups.hrInfoByIdCard, '人事信息'),
    ...buildMissingLookupWarnings('其他工资', otherSourceRows, otherSource, lookups.hrInfoByIdCard, '人事信息'),
    ...buildMissingLookupWarnings('在职工资', activeSourceRows, activeSource, lookups.educationByIdCard, '教职工学历'),
    ...buildMissingLookupWarnings('退休工资', retiredSourceRows, retiredSource, lookups.educationByIdCard, '教职工学历'),
    ...buildMissingLookupWarnings('其他工资', otherSourceRows, otherSource, lookups.educationByIdCard, '教职工学历')
  )
  if (activeMissingIntegrated.length > 0) {
    warnings.push(
      `预算在职有 ${activeMissingIntegrated.length} 人按身份证在在职工资/退休工资中均未找到，已标记为调出人员。${formatExamples(activeMissingIntegrated)}`
    )
  }
  if (retiredMissingIntegrated.length > 0) {
    warnings.push(
      `预算退休有 ${retiredMissingIntegrated.length} 人按身份证在退休工资中未找到，已标记为去世。${formatExamples(retiredMissingIntegrated)}`
    )
  }
  if (otherMissingIntegrated.length > 0) {
    warnings.push(
      `预算其他有 ${otherMissingIntegrated.length} 人按身份证在其他工资中未找到，已标记为去世。${formatExamples(otherMissingIntegrated)}`
    )
  }
  if (lookupFailureCount > 0) warnings.push(`查询失败 ${lookupFailureCount} 条，已写入查询失败日志`)

  messages.push(
    `预算在职：更新 ${counts.activeUpdated} 行，新增 ${counts.activeAdded} 行，调出 ${counts.activeTransferredOut} 行，转入退休 ${counts.activeToRetired} 行`,
    `预算退休：更新 ${counts.retiredUpdated} 行，新增 ${counts.retiredAdded} 行，标记去世 ${counts.retiredDeceased} 行`,
    `预算其他：更新 ${counts.otherUpdated} 行，新增 ${counts.otherAdded} 行，标记去世 ${counts.otherDeceased} 行`
  )

  const affectedRows = Object.values(counts).reduce((sum, count) => sum + count, 0)
  return okRule(budgetWorkflowName, affectedRows, messages, warnings)
}

function ensureBudgetSourceCompleteness(
  checks: Array<{
    targetName: string
    targetRows: Row[]
    target: SheetCtx
    sourceNames: string
    existsInSource: (idCard: string) => boolean
  }>
): void {
  const blocked: string[] = []
  for (const check of checks) {
    if (check.targetRows.length === 0) continue
    const idColumn = findIdCardColumn(check.target)
    const missing = check.targetRows
      .map((row) => normalizeIdCard(row[idColumn]))
      .filter((idCard) => idCard && !check.existsInSource(idCard))
    const threshold = Math.max(10, Math.ceil(check.targetRows.length * 0.15))
    if (missing.length > threshold) {
      blocked.push(
        `${check.targetName} 有 ${missing.length}/${check.targetRows.length} 人在 ${check.sourceNames} 中找不到，超过保护阈值 ${threshold} 人`
      )
    }
  }
  if (blocked.length === 0) return
  throw new Error(
    [
      '更新预算已暂停：一体化来源数据疑似不完整，继续执行会批量标记调出或去世。',
      ...blocked,
      '请先确认在职工资、退休、其他三张表是否已完整导入。'
    ].join('\n')
  )
}

function buildBudgetActiveRow(args: BuildArgs): Row {
  const { sourceRow, index, source, target, lookups } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = text(get('证件号码'))
  const job = lookupByAmount(lookups.jobByAmount, get('岗位工资'))
  const salary = lookupByAmount(lookups.salaryByAmount, get('薪级工资'))
  const normalizedIdCard = normalizeIdCard(idCard)
  const hrInfo = lookups.hrInfoByIdCard.get(normalizedIdCard)
  const educationInfo = lookups.educationByIdCard.get(normalizedIdCard)
  const entryTime = hrEntryTime(hrInfo)
  const workStartTime = text(pick(hrInfo, '参加工作时间'))
  const education = budgetEducation(hrInfo, educationInfo)
  const workYears = budgetWorkYears(hrInfo, workStartTime)
  const postAllowance = num(get('岗位津贴'))
  const livingAllowance = num(get('生活补贴'))
  const housing = num(get('住房补贴'))
  const payable = num(get('应发工资'))

  const values = byTarget(target, {
    '序号': index + 1,
    '单位代码*': get('单位编码'),
    '单位名称*': get('单位名称'),
    '变动类型*': '信息调整',
    '人员序号*': formatPersonSequence(get('部门内序号') || index + 1),
    '姓名*': get('姓名'),
    '证件类型*': '身份证',
    '证件号码*': idCard,
    '性别*': genderFromIdCard(idCard),
    '民族*': '汉族',
    '人员状态*': '在岗',
    '进入本单位时间*': entryTime,
    '是否在编': '是',
    '人员身份*': '事业专业技术人员',
    '工资级别': '无',
    '工资薪级': normalizeSalaryGradeForBudget(pick(salary, '工资薪级') || pick(salary, '薪级')),
    '在职人员来源*': '招考录用',
    '是否工资统发': '是',
    '学历*': education,
    '出生日期*': birthDateFromIdCard(idCard),
    '参加工作时间*': workStartTime,
    '工龄（年）*': workYears,
    '在编类别*': '全额事业',
    '职务*': '无',
    '工资类别*': pick(job, '工资类别') || get('工资类别名称') || '事业专业技术人员工资',
    '事业人员岗位工资级别': professionalJobLevel(job),
    '岗位工资级别*': postSalaryJobLevel(job),
    '技术职称': '',
    '职称类别': pick(job, '职称类别') || '',
    '国家特岗津贴1': '无',
    '国家特岗津贴2': '无',
    '是否特殊岗位*': '否',
    '工资卡开户银行*': budgetBankValue(hrInfo, undefined, '工资卡开户银行*'),
    '工资卡卡号*': budgetBankValue(hrInfo, undefined, '工资卡卡号*'),
    '是否教师*': isTeacherByJob(job),
    '财政实际供养形式': '全额',
    '人员经费保障方式*': '财政全额保障',
    '岗位工资': get('岗位工资'),
    '薪级工资': get('薪级工资'),
    '基础性绩效工资': postAllowance + livingAllowance,
    '基础绩效奖（教师奖励性补贴）': get('基础绩效奖'),
    '奖励性绩效工资': get('绩效工资'),
    '交通费': trafficAllowance(get),
    '老职工提租补贴': 0,
    '新职工提租补贴': housing,
    '上年提租补贴月发放额': housing,
    '教龄津贴': get('教（工）龄补贴'),
    '其他津贴补贴': num(get('特岗性津补贴')) + num(get('其他一')) + num(get('其他二')) + num(get('其他三')),
    '月合计（元）': payable,
    '养老保险': get('养老保险缴费'),
    '医疗保险': get('医疗保险'),
    '失业保险': get('失业保险'),
    '职业年金': get('职业年金缴费'),
    '住房公积金': get('公积金'),
    '其他': num(get('补发工资')) + num(get('补扣工资')),
    '年合计（元）': payable * 12,
    '国家规定工资津贴': num(get('岗位工资')) + num(get('薪级工资')) + postAllowance + livingAllowance,
    '备注': cleanRemark(get('备注') || get('备注一') || get('备注二') || get('备注三')),
    '财政生效年月': fiscalMonth(),
    '在职教职工类型': '1-专职教师',
    '在职人员属性*': '1-在岗',
    '是否财政供养人员*': '是',
    '岗位津贴': get('教（工）龄补贴'),
    '规范津贴补贴': postAllowance + livingAllowance,
    '改革性补贴': housing + trafficAllowance(get) + num(get('公车补贴')),
    '基本工资*': num(get('岗位工资')) + num(get('薪级工资')),
    '实际执行工资': payable,
    '是否保民生及其他刚性支出人员*': '否',
    '是否参加养老保险*': '是',
    '是否参加医疗保险*': '是',
    '是否参加工伤保险*': '是',
    '基础绩效奖': get('基础绩效奖'),
    '薪级': normalizeSalaryGradeForDisplay(pick(salary, '薪级') || salaryFromAmount(get('薪级工资')) || ''),
    '核对情况': ''
  })

  return values
}

function buildBudgetActiveUpdateRow(args: {
  sourceRow: Row
  currentRow?: Row
  source: SheetCtx
  target: SheetCtx
  lookups: LookupCtx
}): { values: Row; failures: LookupFailureDraft[] } {
  const { sourceRow, currentRow, source, target, lookups } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = normalizeIdCard(get('证件号码'))
  const name = text(get('姓名')) || text(readTargetValue(target, currentRow, '姓名*'))
  const jobAmount = num(get('岗位工资'))
  const salaryAmount = num(get('薪级工资'))
  const job = lookupByAmount(lookups.jobByAmount, jobAmount)
  const salary = lookupByAmount(lookups.salaryByAmount, salaryAmount)
  const hrInfo = lookups.hrInfoByIdCard.get(idCard)
  const educationInfo = lookups.educationByIdCard.get(idCard)
  const hrWorkStartTime = text(pick(hrInfo, '参加工作时间'))
  const currentWorkStartTime = text(readTargetValue(target, currentRow, '参加工作时间*'))
  const workStartTime = currentWorkStartTime || hrWorkStartTime
  const postAllowance = num(get('岗位津贴'))
  const livingAllowance = num(get('生活补贴'))
  const housing = num(get('住房补贴'))
  const failures: LookupFailureDraft[] = []

  const values: Record<string, Value | undefined> = {
    岗位工资: jobAmount,
    薪级工资: salaryAmount,
    基础性绩效工资: postAllowance + livingAllowance,
    教龄津贴: get('教（工）龄补贴'),
    交通费: trafficAllowance(get),
    财政生效年月: fiscalMonth(),
    '性别*': text(readTargetValue(target, currentRow, '性别*')) || undefined,
    '民族*': text(readTargetValue(target, currentRow, '民族*')) || undefined,
    '人员状态*': text(readTargetValue(target, currentRow, '人员状态*')) || undefined,
    '进入本单位时间*': text(readTargetValue(target, currentRow, '进入本单位时间*')) || hrEntryTime(hrInfo) || undefined,
    是否在编: text(readTargetValue(target, currentRow, '是否在编')) || undefined,
    '人员身份*': text(readTargetValue(target, currentRow, '人员身份*')) || undefined,
    '在职人员来源*': text(readTargetValue(target, currentRow, '在职人员来源*')) || '招考录用',
    是否工资统发: text(readTargetValue(target, currentRow, '是否工资统发')) || undefined,
    '学历*': text(readTargetValue(target, currentRow, '学历*')) || budgetEducation(hrInfo, educationInfo) || undefined,
    '工龄（年）*': text(readTargetValue(target, currentRow, '工龄（年）*')) || budgetWorkYears(hrInfo, workStartTime) || undefined,
    '在编类别*': text(readTargetValue(target, currentRow, '在编类别*')) || undefined,
    '工资卡开户银行*': text(readTargetValue(target, currentRow, '工资卡开户银行*')) || budgetBankValue(hrInfo, undefined, '工资卡开户银行*') || undefined,
    '工资卡卡号*': text(readTargetValue(target, currentRow, '工资卡卡号*')) || budgetBankValue(hrInfo, undefined, '工资卡卡号*') || undefined,
    '是否教师*': text(readTargetValue(target, currentRow, '是否教师*')) || isTeacherByJob(job),
    国家特岗津贴1: '无',
    国家特岗津贴2: '无',
    '基本工资*': jobAmount + salaryAmount,
    '变动类型*': '信息调整',
    '人员序号*': formatPersonSequence(readTargetValue(target, currentRow, '人员序号*') || get('部门内序号')),
    '参加工作时间*': currentWorkStartTime ? undefined : hrWorkStartTime || undefined,
    上年提租补贴月发放额: housing,
    '是否参加养老保险*': '是',
    '是否参加医疗保险*': '是',
    改革性补贴: housing + trafficAllowance(get) + num(get('公车补贴')),
    备注: cleanRemark(readTargetValue(target, currentRow, '备注') || get('备注') || get('备注一') || get('备注二') || get('备注三'))
  }

  if (salaryAmount > 0 && salary) {
    values['工资薪级'] = normalizeSalaryGradeForBudget(pick(salary, '工资薪级') || pick(salary, '薪级'))
    values['薪级'] = normalizeSalaryGradeForDisplay(pick(salary, '薪级') || salaryFromAmount(salaryAmount) || '')
  } else if (salaryAmount > 0) {
    failures.push({
      worksheet: target.worksheet.name,
      idCard,
      name,
      lookupTable: '薪级工资对照',
      lookupKey: '金额',
      lookupValue: String(salaryAmount),
      reason: '按薪级工资金额未找到工资薪级'
    })
  }

  if (jobAmount > 0 && job) {
    values.事业人员岗位工资级别 = professionalJobLevel(job)
    values['岗位工资级别*'] = postSalaryJobLevel(job)
  } else if (jobAmount > 0) {
    failures.push({
      worksheet: target.worksheet.name,
      idCard,
      name,
      lookupTable: '岗位工资对照',
      lookupKey: '金额',
      lookupValue: String(jobAmount),
      reason: '按岗位工资金额未找到岗位工资级别'
    })
  }

  if (housing === 0) {
    values.老职工提租补贴 = 0
    values.新职工提租补贴 = 0
  } else {
    const workStartMonth = parseYearMonth(workStartTime)
    if (workStartMonth) {
      values.老职工提租补贴 = workStartMonth <= 199911 ? housing : 0
      values.新职工提租补贴 = workStartMonth <= 199911 ? 0 : housing
    } else {
      failures.push({
        worksheet: target.worksheet.name,
        idCard,
        name,
        lookupTable: target.worksheet.name,
        lookupKey: '参加工作时间*',
        lookupValue: workStartTime,
        reason: '无法判断住房补贴应写入老职工还是新职工提租补贴'
      })
    }
  }

  return { values: byTarget(target, values), failures }
}

function buildBudgetRetiredRow(args: BuildArgs): Row {
  const { sourceRow, index, source, target, lookups } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = text(get('证件号码'))
  const normalizedIdCard = normalizeIdCard(idCard)
  const hrInfo = lookups.hrInfoByIdCard.get(normalizedIdCard)
  const educationInfo = lookups.educationByIdCard.get(normalizedIdCard)
  const entryTime = hrEntryTime(hrInfo)
  const workStartTime = text(pick(hrInfo, '参加工作时间'))
  const education = budgetEducation(hrInfo, educationInfo)
  const workYears = text(pick(hrInfo, '工龄'))
  const duty = text(pick(hrInfo, '岗位职务'))
  const monthTotal = num(get('应发工资小计')) || num(get('实发合计'))
  const previousBudget = lookups.previousBudgetRetiredByIdCard.get(normalizedIdCard)
  const newHousing = lookups.newHousingByIdCard.get(normalizedIdCard)
  const retiredHousing = num(pick(newHousing, '退休提租补贴'))
  const previousRetiredHousing = num(get('住房补贴'))

  return byTarget(target, {
    '序号': index + 1,
    '单位代码*': get('单位编码'),
    '单位名称*': get('单位名称'),
    '变动类型*': '信息调整',
    '人员序号*': formatPersonSequence(get('序号') || index + 1),
    '姓名*': get('姓名'),
    '证件类型*': '身份证',
    '证件号码*': idCard,
    '性别*': genderFromIdCard(idCard),
    '民族*': '汉族',
    '人员状态*': '退休',
    '状态*': '退休',
    '进入本单位时间*': entryTime,
    '人员身份*': '事业专业技术人员',
    '工资级别*': '无',
    '工资薪级*': '无',
    '是否工资统发*': '是',
    '学历*': education,
    '出生日期': birthDateFromIdCard(idCard),
    '出生日期*': birthDateFromIdCard(idCard),
    '参加工作时间*': workStartTime,
    '退休时间*': '',
    '工龄（年）*': workYears,
    '职务*': duty || '无',
    '提前退休人员': '否',
    '养老金发放人员': '否',
    '人员经费保障方式*': '财政全额保障',
    '岗位工资级别*': '',
    '是否特殊岗位*': '否',
    '工资卡开户银行*': budgetBankValue(hrInfo, previousBudget, '工资卡开户银行*'),
    '工资卡卡号*': budgetBankValue(hrInfo, previousBudget, '工资卡卡号*'),
    '财政实际供养形式': '全额',
    '提租补贴': retiredHousing,
    '其他补贴加基础绩效奖': num(get('补发工资')) + num(get('其他一')),
    '月合计（元）': monthTotal,
    '上年提租补贴月发放额': previousRetiredHousing,
    '小计': monthTotal,
    '年合计（元）': monthTotal * 12,
    '备注': get('备注'),
    '财政生效年月*': fiscalMonth(),
    '国家规定工资津补贴': monthTotal,
    '在职教职工类型': '1-专职教师',
    '在职人员属性': '1-在岗',
    '是否财政供养人员*': '是',
    '改革性补贴': retiredHousing,
    '其他收入': num(get('补发工资')) + num(get('其他一')),
    '实际执行工资': monthTotal,
    '是否保民生及其他刚性支出人员*': '否',
    '是否参加养老保险*': '是',
    '是否参加医疗保险*': '是',
    '是否参加工伤保险*': '是',
    '核对情况': ''
  })
}

function buildBudgetRetiredPatchRow(args: {
  sourceRow: Row
  currentRow?: Row
  source: SheetCtx
  target: SheetCtx
  lookups: LookupCtx
}): Row {
  const { sourceRow, currentRow, source, target, lookups } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = normalizeIdCard(get('证件号码'))
  const hrInfo = lookups.hrInfoByIdCard.get(idCard)
  const educationInfo = lookups.educationByIdCard.get(idCard)
  const previousBudget = lookups.previousBudgetRetiredByIdCard.get(idCard)
  const newHousing = lookups.newHousingByIdCard.get(idCard)
  const retiredHousing = num(pick(newHousing, '退休提租补贴'))
  const previousRetiredHousing = num(get('住房补贴'))
  const currentPersonNo = text(readTargetValue(target, currentRow, '人员序号*'))
  const values: Record<string, Value | undefined> = {
    '人员序号*': currentPersonNo ? formatPersonSequence(currentPersonNo) : undefined,
    '变动类型*': '信息调整',
    '进入本单位时间*': text(readTargetValue(target, currentRow, '进入本单位时间*')) || hrEntryTime(hrInfo) || undefined,
    '工资薪级*': text(readTargetValue(target, currentRow, '工资薪级*')) || '无',
    '学历*': text(readTargetValue(target, currentRow, '学历*')) || budgetEducation(hrInfo, educationInfo) || undefined,
    '参加工作时间*': text(readTargetValue(target, currentRow, '参加工作时间*')) || text(pick(hrInfo, '参加工作时间')) || undefined,
    '工龄（年）*': text(readTargetValue(target, currentRow, '工龄（年）*')) || text(pick(hrInfo, '工龄')) || undefined,
    '职务*': text(readTargetValue(target, currentRow, '职务*')) || text(pick(hrInfo, '岗位职务')) || '无',
    '工资卡开户银行*': text(readTargetValue(target, currentRow, '工资卡开户银行*')) || budgetBankValue(hrInfo, previousBudget, '工资卡开户银行*') || undefined,
    '工资卡卡号*': text(readTargetValue(target, currentRow, '工资卡卡号*')) || budgetBankValue(hrInfo, previousBudget, '工资卡卡号*') || undefined,
    '提租补贴': retiredHousing,
    '上年提租补贴月发放额': previousRetiredHousing,
    '改革性补贴': retiredHousing,
    '财政生效年月*': fiscalMonth(),
    '是否参加养老保险*': '是',
    '是否参加医疗保险*': '是',
    '是否参加工伤保险*': '是'
  }
  return byTarget(target, values)
}

function buildBudgetOtherRow(args: BuildArgs): Row {
  const { sourceRow, index, source, target, lookups } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = text(get('证件号码'))
  const normalizedIdCard = normalizeIdCard(idCard)
  const hrInfo = lookups.hrInfoByIdCard.get(normalizedIdCard)
  const educationInfo = lookups.educationByIdCard.get(normalizedIdCard)
  const previousBudget = lookups.previousBudgetOtherByIdCard.get(normalizedIdCard)
  const entryTime = hrEntryTime(hrInfo)
  const workStartTime = text(pick(hrInfo, '参加工作时间'))
  const education = budgetEducation(hrInfo, educationInfo)
  const workYears = text(pick(hrInfo, '工龄'))
  const monthTotal = num(get('应发工资小计')) || num(get('实发合计'))

  return byTarget(target, {
    '序号': index + 1,
    '单位代码*': get('单位编码'),
    '单位名称*': get('单位名称'),
    '变动类型*': '信息调整',
    '人员序号': formatPersonSequence(get('序号') || index + 1),
    '姓名*': get('姓名'),
    '证件类型': '身份证',
    '证件号码': idCard,
    '性别': genderFromIdCard(idCard),
    '民族': '汉族',
    '人员状态': '其他',
    '进入本单位时间': entryTime,
    '人员身份': '其他',
    '在职人员来源': '其他',
    '学历': education,
    '出生日期': birthDateFromIdCard(idCard),
    '参加工作时间': workStartTime,
    '工龄（年）': workYears,
    '工资卡开户银行': budgetBankValue(hrInfo, previousBudget, '工资卡开户银行'),
    '工资卡卡号': budgetBankValue(hrInfo, previousBudget, '工资卡卡号'),
    '财政实际供养形式': '全额',
    '人员经费保障方式': '财政全额保障',
    '遗属生活补助': monthTotal,
    '其他人员工资': null,
    '缴纳养老保险': 0,
    '缴纳医疗保险': 0,
    '缴纳失业保险': 0,
    '缴纳工伤保险': 0,
    '缴纳生育保险': 0,
    '缴纳其他保险': 0,
    '小计': monthTotal,
    '年合计（元）': monthTotal * 12,
    '备注': get('备注'),
    '财政生效年月': fiscalMonth(),
    '国家规定工资津贴': monthTotal,
    '是否财政供养人员': '是',
    '其他收入': num(get('补发工资')) + num(get('其他一')),
    '实际执行工资': monthTotal,
    '是否保民生及其他刚性支出人员*': '是',
    '是否参加养老保险*': '否',
    '是否参加医疗保险*': '否',
    '是否参加工伤保险*': '否',
    '核对情况': ''
  })
}

function buildBudgetOtherPatchRow(args: {
  sourceRow: Row
  currentRow?: Row
  source: SheetCtx
  target: SheetCtx
  lookups: LookupCtx
}): Row {
  const { sourceRow, currentRow, source, target, lookups } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = normalizeIdCard(get('证件号码'))
  const hrInfo = lookups.hrInfoByIdCard.get(idCard)
  const educationInfo = lookups.educationByIdCard.get(idCard)
  const previousBudget = lookups.previousBudgetOtherByIdCard.get(idCard)
  const currentPersonNo = text(readTargetValue(target, currentRow, '人员序号'))
  const monthTotal = num(get('应发工资小计')) || num(get('实发合计'))
  const values: Record<string, Value | undefined> = {
    '人员序号': currentPersonNo ? formatPersonSequence(currentPersonNo) : undefined,
    '变动类型*': '信息调整',
    '进入本单位时间': text(readTargetValue(target, currentRow, '进入本单位时间')) || hrEntryTime(hrInfo) || undefined,
    '学历': text(readTargetValue(target, currentRow, '学历')) || budgetEducation(hrInfo, educationInfo) || undefined,
    '参加工作时间': text(readTargetValue(target, currentRow, '参加工作时间')) || text(pick(hrInfo, '参加工作时间')) || undefined,
    '工龄（年）': text(readTargetValue(target, currentRow, '工龄（年）')) || text(pick(hrInfo, '工龄')) || undefined,
    '工资卡开户银行': text(readTargetValue(target, currentRow, '工资卡开户银行')) || budgetBankValue(hrInfo, previousBudget, '工资卡开户银行') || undefined,
    '工资卡卡号': text(readTargetValue(target, currentRow, '工资卡卡号')) || budgetBankValue(hrInfo, previousBudget, '工资卡卡号') || undefined,
    '遗属生活补助': monthTotal,
    '其他人员工资': null,
    '小计': monthTotal,
    '年合计（元）': monthTotal * 12,
    '财政生效年月': fiscalMonth(),
    '国家规定工资津贴': monthTotal,
    '实际执行工资': monthTotal,
    '是否参加养老保险*': '否',
    '是否参加医疗保险*': '否',
    '是否参加工伤保险*': '否'
  }
  return byTarget(target, values)
}

function getSheetCtx(name: string): SheetCtx {
  const worksheet = getWorksheetByName(name)
  const localColumns = getWorksheetLocalColumns(worksheet)
  const columnsByField = new Map<string, string[]>()
  for (const column of localColumns) {
    const current = columnsByField.get(column.field.name) ?? []
    current.push(column.columnName)
    columnsByField.set(column.field.name, current)
  }
  return {
    worksheet,
    table: tableNameOf(worksheet),
    columns: new Map(localColumns.map((column) => [column.field.name, column.columnName])),
    columnsByField
  }
}

async function loadLatestSourceRows(source: SheetCtx): Promise<Row[]> {
  const idCardColumn = findIdCardColumn(source)
  const batchColumn = source.columns.get('工资批次编码')
  const database = await getDatabase()
  const rows = await all<Row>(database, `SELECT * FROM ${source.table}`)
  const byIdCard = new Map<string, Row>()

  // 在职工资 同一人会出现 001 工资 / 002 数币 两行；预算同步只关心 001（交通费等字段都在 001）。
  // 没有 001 的退回 002，避免漏人。
  const batchRankOf = (row: Row): number => {
    if (!batchColumn) return 0
    const value = text(row[batchColumn]).trim()
    if (value === '001') return 2
    if (value === '002') return 1
    return 0
  }

  for (const row of rows) {
    const idCard = normalizeIdCard(row[idCardColumn])
    if (!idCard) continue
    const previous = byIdCard.get(idCard)
    if (!previous) {
      byIdCard.set(idCard, row)
      continue
    }
    const currentRank = batchRankOf(row)
    const previousRank = batchRankOf(previous)
    if (currentRank > previousRank) {
      byIdCard.set(idCard, row)
      continue
    }
    if (currentRank === previousRank && num(row.id) > num(previous.id)) {
      byIdCard.set(idCard, row)
    }
  }

  return Array.from(byIdCard.values()).sort((a, b) =>
    normalizeIdCard(a[idCardColumn]).localeCompare(normalizeIdCard(b[idCardColumn]))
  )
}

function ensureRetiredHousingReady(rows: Row[], source: SheetCtx, lookups: LookupCtx): void {
  if (rows.length === 0) return
  const idCardColumn = findIdCardColumn(source)
  const missing = rows
    .map((row) => ({
      idCard: normalizeIdCard(row[idCardColumn]),
      name: text(readSourceValue(source, row, '姓名'))
    }))
    .filter((item) => item.idCard && !lookups.newHousingByIdCard.has(item.idCard))

  if (missing.length === rows.filter((row) => normalizeIdCard(row[idCardColumn])).length) {
    throw new Error('预算退休需要先到"退休房补"模块执行"核算新房补"，当前新房补没有可匹配数据，已停止生成预算退休。')
  }

  if (missing.length > 0) {
    const sample = missing
      .slice(0, 10)
      .map((item) => item.name || item.idCard)
      .join('、')
    throw new Error(`预算退休有 ${missing.length} 人在"新房补"中没有匹配数据，已停止生成。请先到"退休房补"模块执行"核算新房补"。示例：${sample}`)
  }
}

async function insertTargetRow(
  target: SheetCtx,
  values: Row,
  status?: string,
  reason?: string
): Promise<number> {
  const entries = Object.entries(withStatus(values, status, reason)).filter(
    ([, value]) => value !== undefined
  )
  if (entries.length === 0) return 0
  const now = new Date().toISOString()
  const database = await getDatabase()
  const result = await runWithLastId(
    database,
    `INSERT INTO ${target.table} (${entries.map(([column]) => quoteIdentifier(column)).join(', ')}, "md_created_at", "md_updated_at")
     VALUES (${entries.map(() => '?').join(', ')}, ?, ?)`,
    [...entries.map(([, value]) => value), now, now]
  )
  return result.lastId
}

async function updateTargetStatus(
  target: SheetCtx,
  row: Row,
  status: string,
  reason: string
): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    `UPDATE ${target.table}
     SET "md_status" = ?, "md_status_changed_at" = ?, "md_status_reason" = ?, "md_updated_at" = ?
     WHERE "id" = ?`,
    [status, new Date().toISOString(), reason, new Date().toISOString(), row.id]
  )
}

async function updateTargetFieldsAndStatus(
  target: SheetCtx,
  row: Row,
  values: Row,
  status: string,
  reason: string
): Promise<void> {
  const next = withStatus(values, status, reason)
  const entries = Object.entries(next).filter(([column, value]) => column !== 'id' && value !== undefined)
  if (entries.length === 0) return
  const assignments = entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')
  const database = await getDatabase()
  await run(
    database,
    `UPDATE ${target.table} SET ${assignments}, "md_updated_at" = ? WHERE "id" = ?`,
    [...entries.map(([, value]) => value), new Date().toISOString(), row.id]
  )
}

async function setChangeTypeAll(target: SheetCtx, value: string): Promise<void> {
  const column = target.columns.get('变动类型*') ?? target.columns.get('变动类型')
  if (!column) return
  const database = await getDatabase()
  await run(
    database,
    `UPDATE ${target.table} SET ${quoteIdentifier(column)} = ?, "md_updated_at" = ?`,
    [value, new Date().toISOString()]
  )
}

async function markDeceasedRows(target: SheetCtx): Promise<void> {
  const changeTypeColumn = target.columns.get('变动类型*') ?? target.columns.get('变动类型')
  const reasonColumn = target.columns.get('减少原因') ?? target.columns.get('减少原因*')
  if (!changeTypeColumn && !reasonColumn) return
  const assignments: string[] = []
  const params: unknown[] = []
  if (changeTypeColumn) {
    assignments.push(`${quoteIdentifier(changeTypeColumn)} = ?`)
    params.push('信息删除')
  }
  if (reasonColumn) {
    assignments.push(`${quoteIdentifier(reasonColumn)} = ?`)
    params.push('自然减员（含死亡）')
  }
  assignments.push(`"md_updated_at" = ?`)
  params.push(new Date().toISOString())
  const database = await getDatabase()
  await run(
    database,
    `UPDATE ${target.table} SET ${assignments.join(', ')} WHERE "md_status" = '去世'`,
    params
  )
}

async function clearBudgetActiveExcludedFields(target: SheetCtx): Promise<void> {
  const fieldNames = [
    '月合计（元）',
    '年合计（元）',
    '奖励性绩效工资',
    '养老保险',
    '医疗保险',
    '失业保险',
    '工伤保险',
    '其他保险',
    '职业年金',
    '住房公积金'
  ]
  const columns = fieldNames
    .map((fieldName) => target.columns.get(fieldName))
    .filter((column): column is string => Boolean(column))
  if (columns.length === 0) return

  const database = await getDatabase()
  await run(
    database,
    `UPDATE ${target.table}
     SET ${columns.map((column) => `${quoteIdentifier(column)} = NULL`).join(', ')},
         "md_updated_at" = ?`,
    [new Date().toISOString()]
  )
}

async function deleteTargetRow(target: SheetCtx, row: Row): Promise<void> {
  const database = await getDatabase()
  await run(database, `DELETE FROM ${target.table} WHERE "id" = ?`, [row.id])
  await run(database, `DELETE FROM import_batch_rows WHERE worksheet_name = ? AND record_id = ?`, [
    target.worksheet.name,
    row.id
  ])
}

async function upsertTargetByIdCard(
  target: SheetCtx,
  idCard: string,
  values: Row,
  status: string,
  reason: string
): Promise<void> {
  const idCardColumn = findIdCardColumn(target)
  const database = await getDatabase()
  const matched = await all<Row>(
    database,
    `SELECT * FROM ${target.table}
     WHERE UPPER(REPLACE(REPLACE(TRIM(CAST(${quoteIdentifier(idCardColumn)} AS TEXT)), ' ', ''), ',', '')) = ?
     ORDER BY "id" DESC LIMIT 1`,
    [idCard]
  )
  if (matched[0]) {
    await updateTargetStatus(target, matched[0], status, reason)
  } else {
    await insertTargetRow(target, values, status, reason)
  }
}

function rowsByIdCard(source: SheetCtx, rows: Row[]): Map<string, Row> {
  const idCardColumn = findIdCardColumn(source)
  const result = new Map<string, Row>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idCardColumn])
    if (idCard) result.set(idCard, row)
  }
  return result
}

function buildMissingLookupWarnings(
  sourceName: string,
  rows: Row[],
  source: SheetCtx,
  lookup: Map<string, Row>,
  lookupName: string
): string[] {
  const idCardColumn = findIdCardColumn(source)
  const missing = rows
    .map((row) => ({
      idCard: normalizeIdCard(row[idCardColumn]),
      label: personLabel(source, row, normalizeIdCard(row[idCardColumn]))
    }))
    .filter((item) => item.idCard && !lookup.has(item.idCard))

  if (missing.length === 0) return []
  return [
    `${sourceName}有 ${missing.length} 人按身份证在${lookupName}中未找到，相关字段已留空或沿用原值。${formatExamples(missing.map((item) => item.label))}`
  ]
}

function personLabel(source: SheetCtx, row: Row, idCard: string): string {
  const name = text(readSourceValue(source, row, '姓名')) || text(readSourceValue(source, row, '姓名*'))
  return name ? `${name}(${idCard})` : idCard
}

function formatExamples(items: string[]): string {
  const examples = items.filter(Boolean).slice(0, 8)
  if (examples.length === 0) return ''
  const suffix = items.length > examples.length ? `等 ${items.length} 人` : ''
  return `示例：${examples.join('、')}${suffix ? `，${suffix}` : ''}`
}

function findIdCardColumn(source: SheetCtx): string {
  const column =
    tryFindColumnByName(source.worksheet, '证件号码*') ??
    tryFindColumnByName(source.worksheet, '证件号码') ??
    tryFindColumnByName(source.worksheet, '教职工身份证号') ??
    tryFindColumnByName(source.worksheet, '身份证号') ??
    tryFindColumnByName(source.worksheet, '身份证号码')
  if (!column) throw new Error(`工作表"${source.worksheet.name}"缺少证件号码字段`)
  return column
}

function withStatus(values: Row, status?: string, reason?: string): Row {
  if (!status) return values
  return {
    ...values,
    md_status: status,
    md_status_changed_at: new Date().toISOString(),
    md_status_reason: reason ?? ''
  }
}

async function recordLookupFailures(failures: LookupFailureDraft[]): Promise<number> {
  if (failures.length === 0) return 0
  const database = await getDatabase()
  for (const failure of failures) {
    await run(
      database,
      `
        INSERT INTO lookup_failures
          (workflow, worksheet, id_card, name, lookup_table, lookup_key, lookup_value, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        budgetWorkflowName,
        failure.worksheet,
        failure.idCard,
        failure.name,
        failure.lookupTable,
        failure.lookupKey,
        failure.lookupValue,
        failure.reason
      ]
    )
  }
  return failures.length
}

async function loadLookups(): Promise<LookupCtx> {
  return {
    jobByAmount: await loadLookupByAmount('岗位工资对照', '金额'),
    salaryByAmount: await loadLookupByAmount('薪级工资对照', '薪级工资'),
    hrInfoByIdCard: await loadRowsByIdCard('人事信息'),
    educationByIdCard: await loadRowsByIdCard('教职工学历'),
    previousBudgetRetiredByIdCard: await loadRowsByIdCard('预算退休'),
    previousBudgetOtherByIdCard: await loadRowsByIdCard('预算其他'),
    newHousingByIdCard: await loadRowsByIdCard('新房补')
  }
}

async function loadLookupByAmount(worksheetName: string, amountField: string): Promise<Map<number, Row>> {
  const worksheet = getWorksheetByName(worksheetName)
  const amountColumn = findColumnByName(worksheet, amountField)
  const database = await getDatabase()
  const rows = await all<Row>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  const result = new Map<number, Row>()
  for (const row of rows) {
    const amount = num(row[amountColumn])
    if (amount > 0) result.set(amount, row)
  }
  return result
}

async function loadRowsByIdCard(worksheetName: string): Promise<Map<string, Row>> {
  const worksheet = getWorksheetByName(worksheetName)
  const source = getSheetCtx(worksheetName)
  const idCardColumn = findIdCardColumn(source)
  const database = await getDatabase()
  const rows = await all<Row>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  const result = new Map<string, Row>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idCardColumn])
    if (!idCard) continue
    const previous = result.get(idCard)
    if (!previous || num(row.id) > num(previous.id)) result.set(idCard, row)
  }
  return result
}

function byTarget(target: SheetCtx, values: Record<string, Value | undefined>): Row {
  const result: Row = {}
  for (const [fieldName, value] of Object.entries(values)) {
    const columns = target.columnsByField.get(fieldName) ?? []
    if (columns.length === 0 || value === undefined) continue
    const fieldValues = duplicateFieldValues(fieldName, value, columns.length)
    columns.forEach((column, index) => {
      result[column] = fieldValues[index] ?? value
    })
  }
  return result
}

function duplicateFieldValues(fieldName: string, value: Value, count: number): Value[] {
  if ((fieldName === '国家特岗津贴1' || fieldName === '国家特岗津贴2') && count > 1) {
    return Array.from({ length: count }, (_, index) => (index === 0 ? value : 0))
  }
  return Array.from({ length: count }, () => value)
}

function readTargetValue(target: SheetCtx, row: Row | undefined, fieldName: string): Value {
  if (!row) return null
  const columns = target.columnsByField.get(fieldName) ?? []
  for (const column of columns) {
    const value = row[column]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return null
}

function sourceGetter(source: SheetCtx, row: Row): (fieldName: string) => Value {
  return (fieldName: string) => {
    const column = source.columns.get(fieldName)
    return column ? row[column] ?? null : null
  }
}

function readSourceValue(source: SheetCtx, row: Row | undefined, fieldName: string): Value {
  if (!row) return null
  const column = source.columns.get(fieldName)
  return column ? row[column] ?? null : null
}

function lookupByAmount(lookup: Map<number, Row>, value: Value): Row | undefined {
  return lookup.get(num(value))
}

function pick(row: Row | undefined, fieldName: string): Value {
  if (!row) return null
  return row[fieldName] ?? null
}

function hrEntryTime(hrInfo: Row | undefined): string {
  return text(pick(hrInfo, '本县入编时间')) || text(pick(hrInfo, '参加工作时间'))
}

function budgetEducation(hrInfo: Row | undefined, educationInfo: Row | undefined): string {
  return normalizeEducationForBudget(text(pick(hrInfo, '最高学历')) || text(pick(educationInfo, '学历')))
}

function budgetWorkYears(hrInfo: Row | undefined, workStartTime: unknown): string {
  const existing = text(pick(hrInfo, '工龄'))
  if (existing) return existing
  const startYear = parseYear(workStartTime)
  if (!startYear) return ''
  const currentYear = new Date().getFullYear()
  if (startYear > currentYear) return ''
  return String(currentYear - startYear + 1)
}

function professionalJobLevel(job: Row | undefined): string {
  return text(pick(job, '事业人员岗位工资级别'))
}

function postSalaryJobLevel(job: Row | undefined): string {
  return text(pick(job, '岗位工资级别'))
}

function isTeacherByJob(job: Row | undefined): string {
  const titleCategory = text(pick(job, '职称类别')).replace(/\s+/g, '')
  if (['初级工', '中级工', '高级工'].includes(titleCategory)) return '否'
  return '是'
}

function budgetBankValue(hrInfo: Row | undefined, previousBudget: Row | undefined, targetFieldName: string): string {
  const hrFieldName = targetFieldName.replace(/\*$/, '')
  return (
    text(pick(hrInfo, hrFieldName)) ||
    text(pick(previousBudget, targetFieldName)) ||
    text(pick(previousBudget, hrFieldName))
  )
}

function trafficAllowance(get: (fieldName: string) => Value): number {
  const value = num(get('交通费'))
  return value > 0 ? value : 300
}

function cleanRemark(value: Value): string {
  const remark = text(value)
  return remark === '乡镇补贴' ? '' : remark
}

function salaryFromAmount(value: Value): string {
  return ''
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function formatPersonSequence(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  const normalized = raw.replace(/\.0$/, '')
  return /^\d+$/.test(normalized) ? normalized.padStart(4, '0') : normalized
}

function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function parseYearMonth(value: unknown): number | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const digits = raw.replace(/\D/g, '')
  if (digits.length >= 6) {
    const year = Number(digits.slice(0, 4))
    const month = Number(digits.slice(4, 6))
    if (year >= 1900 && month >= 1 && month <= 12) return year * 100 + month
  }
  if (digits.length === 4) {
    const year = Number(digits)
    if (year >= 1900) return year * 100 + 1
  }
  return undefined
}

function parseYear(value: unknown): number | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const match = raw.match(/(19|20)\d{2}/)
  if (!match) return undefined
  const year = Number(match[0])
  return Number.isFinite(year) ? year : undefined
}

function genderFromIdCard(idCard: string): string {
  if (!/^\d{17}[\dXx]$/.test(idCard)) return ''
  return Number(idCard[16]) % 2 === 1 ? '男' : '女'
}

function birthDateFromIdCard(idCard: string): string {
  if (!/^\d{17}[\dXx]$/.test(idCard)) return ''
  return idCard.slice(6, 14)
}

function fiscalMonth(): string {
  return `${new Date().getFullYear()}09`
}
