import type {
  RuleResult,
  WorkflowDefinition,
  WorkflowRunPayload,
  WorkflowRunResult
} from '../../shared/types'
import { all, getDatabase, listIdentityDuplicateIssues, run } from '../db/connection'
import {
  generateAnnualSalaryReport
} from './annual-report/annualReport'
import {
  calculateBudgetActiveBaseSalary,
  increaseSalaryGrade,
  updateSalaryGrade
} from './budget/budgetActive'
import {
  syncAllBudgetFromIntegrated,
} from './budget/integratedBudgetSync'
import {
  prepareNewHousingSubsidy,
  writeBackNewHousingSubsidyToRetired
} from './housing-subsidy/newHousingSubsidy'
import {
  generateMonthlyPayrollReports,
  preprocessMonthlyPayroll
} from './monthly-payroll/monthlyPayroll'

type WorkflowExecutor = (payload?: WorkflowRunPayload) => Promise<RuleResult>

type WorkflowRegistryItem = WorkflowDefinition & {
  run: WorkflowExecutor
}

const workflows: WorkflowRegistryItem[] = [
  {
    key: 'annual-report.generate',
    name: '生成工资年报',
    module: '工资年报',
    status: 'ready',
    run: generateAnnualSalaryReport
  },
  {
    key: 'budget-all.sync-from-integrated',
    name: '更新预算',
    module: '预算',
    status: 'ready',
    run: syncAllBudgetFromIntegrated
  },
  {
    key: 'budget-active.update-grade',
    name: '更新薪级',
    module: '预算在职',
    status: 'ready',
    run: updateSalaryGrade
  },
  {
    key: 'budget-active.increase-grade',
    name: '增加薪级',
    module: '预算在职',
    status: 'ready',
    run: increaseSalaryGrade
  },
  {
    key: 'budget-active.calculate-base-performance',
    name: '计算基础性绩效工资',
    module: '预算在职',
    status: 'ready',
    run: calculateBudgetActiveBaseSalary
  },
  {
    key: 'housing-subsidy.prepare-new',
    name: '核算新房补',
    module: '退休房补',
    status: 'ready',
    run: prepareNewHousingSubsidy
  },
  {
    key: 'housing-subsidy.write-back-retired',
    name: '执行新退休房补',
    module: '退休房补',
    status: 'ready',
    run: writeBackNewHousingSubsidyToRetired
  },
  {
    key: 'monthly-payroll.preprocess',
    name: '月度工资报账预处理',
    module: '工资报账',
    status: 'ready',
    run: preprocessMonthlyPayroll
  },
  {
    key: 'monthly-payroll.generate',
    name: '月度工资报账汇总生成',
    module: '工资报账',
    status: 'ready',
    run: generateMonthlyPayrollReports
  }
]

export function listWorkflows(): WorkflowDefinition[] {
  return workflows.map(({ key, name, module, status, blockedReason }) => ({
    key,
    name,
    module,
    status,
    blockedReason
  }))
}

export async function runWorkflow(
  workflowKey: string,
  payload?: WorkflowRunPayload
): Promise<WorkflowRunResult> {
  const workflow = workflows.find((item) => item.key === workflowKey)
  if (!workflow) throw new Error(`未找到工作流：${workflowKey}`)
  if (workflow.status !== 'ready') {
    throw new Error(workflow.blockedReason || `${workflow.name} 规则未完成，暂不允许执行`)
  }

  await clearWorkflowLookupFailures(workflow.name)
  await assertNoIdentityDuplicatesBeforeWorkflow(workflow.name)
  const result = await workflow.run(payload)
  await ensureWorkflowFailureDetails(workflow.name, result)
  return {
    workflowKey: workflow.key,
    workflowName: workflow.name,
    ...result
  }
}

async function assertNoIdentityDuplicatesBeforeWorkflow(workflowName: string): Promise<void> {
  const issues = await listIdentityDuplicateIssues()
  if (issues.length === 0) return
  const examples = issues
    .slice(0, 5)
    .map((issue) => `${issue.worksheetName}.${issue.identityFieldName} ${issue.idCard}(${issue.count})`)
    .join('；')
  throw new Error(`已暂停执行「${workflowName}」：检测到身份证/唯一键重复数据，请先清理后再运行关键流程。示例：${examples}`)
}

async function clearWorkflowLookupFailures(workflowName: string): Promise<void> {
  const database = await getDatabase()
  await run(database, `DELETE FROM lookup_failures WHERE workflow = ?`, [workflowName])
}

async function ensureWorkflowFailureDetails(
  workflowName: string,
  result: RuleResult
): Promise<void> {
  if (result.ok && result.warnings.length === 0) return

  const database = await getDatabase()
  const existing = await all<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM lookup_failures WHERE workflow = ?`,
    [workflowName]
  )
  if ((existing[0]?.count ?? 0) > 0) return

  const reasons = [
    ...result.warnings,
    ...(!result.ok && result.messages.length > 0 ? result.messages : [])
  ].filter((item) => item.trim())
  const detailReasons = reasons.length > 0 ? reasons : [`${workflowName} 执行失败，未返回明细原因`]

  if (detailReasons.length === 0) return

  // 批量 INSERT + 事务，避免逐条 fsync
  await run(database, 'BEGIN TRANSACTION')
  try {
    const BATCH_SIZE = 200
    for (let i = 0; i < detailReasons.length; i += BATCH_SIZE) {
      const batch = detailReasons.slice(i, i + BATCH_SIZE)
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
      const params: unknown[] = []
      for (const reason of batch) {
        params.push(workflowName, '工作流', '', '', '', '', '', reason)
      }
      await run(
        database,
        `INSERT INTO lookup_failures (workflow, worksheet, id_card, name, lookup_table, lookup_key, lookup_value, reason) VALUES ${placeholders}`,
        params
      )
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
}
