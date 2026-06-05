export const nonSortableFields = new Set([
  '身份证号',
  '身份证号码',
  '证件号码',
  '证件号码*',
  '教职工身份证号'
])

export const personnelDrawerTables = new Set([
  '人事信息',
  '在编教职工基本信息',
  '预算在职',
  '预算退休',
  '预算其他',
  '在职工资',
  '退休工资',
  '其他工资'
])

export const plainAllFieldTables = new Set([
  '预算在职',
  '预算退休',
  '预算其他',
  '在职工资',
  '退休工资',
  '其他工资'
])

export const personnelDetailTabs = [
  { id: 'basic', label: '基本信息' },
  { id: 'edu', label: '学历职称' },
  { id: 'cert', label: '教师资格' },
  { id: 'teach', label: '任教' },
  { id: 'career', label: '工作履历' },
  { id: 'all', label: '字段详情' }
]

export const genericPersonTabs = [
  { id: 'basic', label: '基本信息' },
  { id: 'edu', label: '学历职称' },
  { id: 'career', label: '岗位薪酬' },
  { id: 'all', label: '字段详情' }
]

export const allFieldTabs = [{ id: 'all', label: '字段详情' }]
