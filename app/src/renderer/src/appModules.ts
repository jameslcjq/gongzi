export type ModuleGroup = {
  key: string
  label: string
  tables: string[]
  hidden?: boolean
}

export const modules: ModuleGroup[] = [
  { key: 'integration', label: '一体化对接', tables: [] },
  { key: 'integrated', label: '工资数据', tables: ['在职工资', '退休工资', '其他工资'] },
  { key: 'payroll', label: '工资业务', tables: [] },
  { key: 'budget', label: '预算', tables: ['预算在职', '预算退休', '预算其他'] },
  { key: 'annual', label: '工资年报', tables: ['工资年报', '绩效工资'] },
  { key: 'township', label: '乡镇补贴', tables: ['乡镇补贴'] },
  {
    key: 'housing',
    label: '退休房补',
    tables: ['人员明细导出', '新房补']
  },
  { key: 'pivot', label: '统计分析', tables: [] },
  {
    key: 'hr',
    label: '人事管理',
    tables: [
      '人事信息',
      '在编教职工基本信息',
      '教职工学历',
      '教职工教师资格',
      '教职工任教信息',
      '教职工工作履历',
      '职级简历'
    ]
  }
]

export const visibleModules = modules.filter((module) => !module.hidden)

export const nonWorksheetModuleKeys = new Set(['integration', 'payroll', 'pivot'])

const worksheetDisplayNames: Record<string, string> = {
  在职工资: '在职工资',
  退休工资: '退休工资',
  其他工资: '其他工资'
}

export function displayWorksheetName(name: string) {
  return worksheetDisplayNames[name] ?? name
}
