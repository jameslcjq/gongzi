import type sqlite3 from 'sqlite3'
import { get, run } from '../db/connection'
import { quoteIdentifier } from '../db/schema'
import type { UnitSettings } from '../../shared/types'

type SchoolLookupSeed = {
  unitName: string
  budgetUnitCode: string
  stage: string
  agreementNo: string
  functionCode: string
}

const SCHOOL_LOOKUP_TABLE = '学校对照表'
const DEFAULT_SOCIAL_PAYEE_NAME = '沭阳县会计核算中心代扣代缴专户'
const DEFAULT_SOCIAL_PAYEE_BANK = '工商银行沭阳支行营业室'
const DEFAULT_HOUSING_PAYEE_NAME = '宿迁市住房公积金管理中心'
const DEFAULT_HOUSING_PAYEE_BANK = '建行宿迁分行新楚支行'
const DEFAULT_HOUSING_PAYEE_ACCOUNT = '32050177443600000028'

const schoolLookupSeed: SchoolLookupSeed[] = [
  { unitName: '沭阳县马厂中心小学', budgetUnitCode: '019023', stage: '小学', agreementNo: '9558851116004193027', functionCode: '2050202' },
  { unitName: '沭阳县沂涛中心小学', budgetUnitCode: '019024', stage: '小学', agreementNo: '9558851116004192912', functionCode: '2050202' },
  { unitName: '沭阳县李恒中心小学', budgetUnitCode: '019025', stage: '小学', agreementNo: '9558851116004192581', functionCode: '2050202' },
  { unitName: '沭阳县汤涧中心小学', budgetUnitCode: '019026', stage: '小学', agreementNo: '9558851116004192938', functionCode: '2050202' },
  { unitName: '沭阳县章集中心小学', budgetUnitCode: '019027', stage: '小学', agreementNo: '9558851116004192540', functionCode: '2050202' },
  { unitName: '沭阳县七雄中心小学', budgetUnitCode: '019028', stage: '小学', agreementNo: '9558851116004192607', functionCode: '2050202' },
  { unitName: '沭阳县钱集中心小学', budgetUnitCode: '019032', stage: '小学', agreementNo: '9558851116004192987', functionCode: '2050202' },
  { unitName: '沭阳县胡集实验小学', budgetUnitCode: '019033', stage: '小学', agreementNo: '9558851116004193142', functionCode: '2050202' },
  { unitName: '沭阳县东小店中心小学', budgetUnitCode: '019034', stage: '小学', agreementNo: '9558851116004192771', functionCode: '2050202' },
  { unitName: '沭阳县陇集中心小学', budgetUnitCode: '019035', stage: '小学', agreementNo: '9558851116004192821', functionCode: '2050202' },
  { unitName: '沭阳县悦来中心小学', budgetUnitCode: '019037', stage: '小学', agreementNo: '9558851116004192946', functionCode: '2050202' },
  { unitName: '沭阳县耿圩中心小学', budgetUnitCode: '019038', stage: '小学', agreementNo: '9558851116004193084', functionCode: '2050202' },
  { unitName: '沭阳县北丁集中心小学', budgetUnitCode: '019039', stage: '小学', agreementNo: '9558851116004193068', functionCode: '2050202' },
  { unitName: '沭阳县十字中心小学', budgetUnitCode: '019040', stage: '小学', agreementNo: '9558851116004193191', functionCode: '2050202' },
  { unitName: '沭阳县庙头中心小学', budgetUnitCode: '019041', stage: '小学', agreementNo: '9558851116004192714', functionCode: '2050202' },
  { unitName: '沭阳县潼阳中心小学', budgetUnitCode: '019042', stage: '小学', agreementNo: '9558851116004193100', functionCode: '2050202' },
  { unitName: '沭阳县颜集中心小学', budgetUnitCode: '019043', stage: '小学', agreementNo: '9558851116004193001', functionCode: '2050202' },
  { unitName: '沭阳县新河中心小学', budgetUnitCode: '019044', stage: '小学', agreementNo: '9558851116004192524', functionCode: '2050202' },
  { unitName: '沭阳县茆圩中心小学', budgetUnitCode: '019045', stage: '小学', agreementNo: '9558851116004192847', functionCode: '2050202' },
  { unitName: '沭阳县贤官中心小学', budgetUnitCode: '019046', stage: '小学', agreementNo: '9558851116004192797', functionCode: '2050202' },
  { unitName: '沭阳县华冲实验小学', budgetUnitCode: '019047', stage: '小学', agreementNo: '9558851116004192961', functionCode: '2050202' },
  { unitName: '沭阳县桑墟中心小学', budgetUnitCode: '019049', stage: '小学', agreementNo: '9558851116004192896', functionCode: '2050202' },
  { unitName: '沭阳县万匹中心小学', budgetUnitCode: '019050', stage: '小学', agreementNo: '9558851116004192813', functionCode: '2050202' },
  { unitName: '沭阳县龙庙中心小学', budgetUnitCode: '019051', stage: '小学', agreementNo: '9558851116004192672', functionCode: '2050202' },
  { unitName: '沭阳县扎下中心小学', budgetUnitCode: '019052', stage: '小学', agreementNo: '9558851116004192623', functionCode: '2050202' },
  { unitName: '沭阳县韩山中心小学', budgetUnitCode: '019053', stage: '小学', agreementNo: '9558851116004192755', functionCode: '2050202' },
  { unitName: '沭阳县吴集中心小学', budgetUnitCode: '019054', stage: '小学', agreementNo: '9558851116004192730', functionCode: '2050202' },
  { unitName: '沭阳县湖东中心小学', budgetUnitCode: '019057', stage: '小学', agreementNo: '9558851116004193183', functionCode: '2050202' },
  { unitName: '沭阳县官墩中心小学', budgetUnitCode: '019058', stage: '小学', agreementNo: '9558851116004193167', functionCode: '2050202' },
  { unitName: '沭阳县赵集小学', budgetUnitCode: '019059', stage: '小学', agreementNo: '9558851116004192664', functionCode: '2050202' },
  { unitName: '沭阳县第一实验小学', budgetUnitCode: '019060', stage: '小学', agreementNo: '9558851116004192300', functionCode: '2050202' },
  { unitName: '沭阳县南湖小学', budgetUnitCode: '019062', stage: '小学', agreementNo: '9558851116004192391', functionCode: '2050202' },
  { unitName: '沭阳县深圳路实验小学', budgetUnitCode: '019063', stage: '小学', agreementNo: '9558851116004192342', functionCode: '2050202' },
  { unitName: '沭阳县东兴小学', budgetUnitCode: '019064', stage: '小学', agreementNo: '9558851116004192433', functionCode: '2050202' },
  { unitName: '沭阳县南关小学', budgetUnitCode: '019065', stage: '小学', agreementNo: '9558851116004192334', functionCode: '2050202' },
  { unitName: '沭阳县开发区实验小学', budgetUnitCode: '019066', stage: '小学', agreementNo: '9558851116004192425', functionCode: '2050202' },
  { unitName: '沭阳县东关实验小学', budgetUnitCode: '019067', stage: '小学', agreementNo: '9558851116004192417', functionCode: '2050202' },
  { unitName: '沭阳县广州路小学', budgetUnitCode: '019068', stage: '小学', agreementNo: '9558851116004192326', functionCode: '2050202' },
  { unitName: '沭阳县人民路小学', budgetUnitCode: '019069', stage: '小学', agreementNo: '9558851116004192383', functionCode: '2050202' },
  { unitName: '沭阳县学府路小学', budgetUnitCode: '019070', stage: '小学', agreementNo: '9558851116004192409', functionCode: '2050202' },
  { unitName: '江苏省沭阳师范学校附属小学', budgetUnitCode: '019073', stage: '小学', agreementNo: '9558851116004192359', functionCode: '2050202' },
  { unitName: '沭阳县第二实验小学', budgetUnitCode: '019071', stage: '小学', agreementNo: '9558851116004192367', functionCode: '2050202' },
  { unitName: '沭阳县塘沟中心小学', budgetUnitCode: '019029', stage: '小学', agreementNo: '9558851116004192649', functionCode: '2050202' },
  { unitName: '沭阳县高墟中心小学', budgetUnitCode: '019056', stage: '小学', agreementNo: '9558851116004192862', functionCode: '2050202' },
  { unitName: '沭阳县刘集中心小学', budgetUnitCode: '019036', stage: '小学', agreementNo: '9558851116004193126', functionCode: '2050202' },
  { unitName: '沭阳县周集中心小学', budgetUnitCode: '019030', stage: '小学', agreementNo: '9558851116004192698', functionCode: '2050202' },
  { unitName: '沭阳县青伊湖中心小学', budgetUnitCode: '019048', stage: '小学', agreementNo: '9558851116004193043', functionCode: '2050202' },
  { unitName: '沭阳县西圩中心小学', budgetUnitCode: '019055', stage: '小学', agreementNo: '9558851116004192565', functionCode: '2050202' },
  { unitName: '沭阳县张圩中心小学', budgetUnitCode: '019031', stage: '小学', agreementNo: '9558851116004192888', functionCode: '2050202' },
  { unitName: '沭阳县外国语实验学校', budgetUnitCode: '019116', stage: '中学', agreementNo: '9558851116004192466', functionCode: '2050203' },
  { unitName: '沭阳如东实验学校', budgetUnitCode: '019117', stage: '中学', agreementNo: '9558851116004192441', functionCode: '2050203' },
  { unitName: '沭阳县沂涛初级中学', budgetUnitCode: '019075', stage: '中学', agreementNo: '9558851116004192920', functionCode: '2050203' },
  { unitName: '沭阳县李恒初级中学', budgetUnitCode: '019076', stage: '中学', agreementNo: '9558851116004192599', functionCode: '2050203' },
  { unitName: '沭阳县章集初级中学', budgetUnitCode: '019078', stage: '中学', agreementNo: '9558851116004192557', functionCode: '2050203' },
  { unitName: '沭阳县七雄初级中学', budgetUnitCode: '019079', stage: '中学', agreementNo: '9558851116004192615', functionCode: '2050203' },
  { unitName: '沭阳县钱集初级中学', budgetUnitCode: '019082', stage: '中学', agreementNo: '9558851116004192995', functionCode: '2050203' },
  { unitName: '沭阳县胡集初级中学', budgetUnitCode: '019083', stage: '中学', agreementNo: '9558851116004193159', functionCode: '2050203' },
  { unitName: '沭阳县东小店初级中学', budgetUnitCode: '019084', stage: '中学', agreementNo: '9558851116004192789', functionCode: '2050203' },
  { unitName: '沭阳县陇集初级中学', budgetUnitCode: '019085', stage: '中学', agreementNo: '9558851116004192839', functionCode: '2050203' },
  { unitName: '沭阳县悦来初级中学', budgetUnitCode: '019087', stage: '中学', agreementNo: '9558851116004192953', functionCode: '2050203' },
  { unitName: '沭阳县耿圩初级中学', budgetUnitCode: '019088', stage: '中学', agreementNo: '9558851116004193092', functionCode: '2050203' },
  { unitName: '沭阳县北丁集初级中学', budgetUnitCode: '019089', stage: '中学', agreementNo: '9558851116004193076', functionCode: '2050203' },
  { unitName: '沭阳县十字初级中学', budgetUnitCode: '019090', stage: '中学', agreementNo: '9558851116004193209', functionCode: '2050203' },
  { unitName: '沭阳县潼阳初级中学', budgetUnitCode: '019091', stage: '中学', agreementNo: '9558851116004193118', functionCode: '2050203' },
  { unitName: '沭阳县颜集初级中学', budgetUnitCode: '019092', stage: '中学', agreementNo: '9558851116004193019', functionCode: '2050203' },
  { unitName: '沭阳县新河初级中学', budgetUnitCode: '019093', stage: '中学', agreementNo: '9558851116004192532', functionCode: '2050203' },
  { unitName: '沭阳县茆圩初级中学', budgetUnitCode: '019094', stage: '中学', agreementNo: '9558851116004192854', functionCode: '2050203' },
  { unitName: '沭阳县贤官初级中学', budgetUnitCode: '019095', stage: '中学', agreementNo: '9558851116004192805', functionCode: '2050203' },
  { unitName: '沭阳县桑墟初级中学', budgetUnitCode: '019097', stage: '中学', agreementNo: '9558851116004192904', functionCode: '2050203' },
  { unitName: '沭阳县龙庙初级中学', budgetUnitCode: '019099', stage: '中学', agreementNo: '9558851116004192680', functionCode: '2050203' },
  { unitName: '沭阳县扎下初级中学', budgetUnitCode: '019100', stage: '中学', agreementNo: '9558851116004192631', functionCode: '2050203' },
  { unitName: '沭阳县吴集初级中学', budgetUnitCode: '019101', stage: '中学', agreementNo: '9558851116004192748', functionCode: '2050203' },
  { unitName: '沭阳县官墩初级中学', budgetUnitCode: '019105', stage: '中学', agreementNo: '9558851116004193175', functionCode: '2050203' },
  { unitName: '沭阳县实验初级中学', budgetUnitCode: '019113', stage: '中学', agreementNo: '9558851116004192508', functionCode: '2050203' },
  { unitName: '沭阳县人民路初级中学', budgetUnitCode: '019115', stage: '中学', agreementNo: '9558851116004192482', functionCode: '2050203' },
  { unitName: '沭阳县怀文中学', budgetUnitCode: '019112', stage: '中学', agreementNo: '9558851116004192458', functionCode: '2050203' },
  { unitName: '沭阳县高墟初级中学', budgetUnitCode: '019103', stage: '中学', agreementNo: '9558851116004192870', functionCode: '2050203' },
  { unitName: '沭阳县青伊湖初级中学', budgetUnitCode: '019096', stage: '中学', agreementNo: '9558851116004193050', functionCode: '2050203' },
  { unitName: '沭阳县西圩初级中学', budgetUnitCode: '019102', stage: '中学', agreementNo: '9558851116004192573', functionCode: '2050203' },
  { unitName: '沭阳县刘集初级中学', budgetUnitCode: '019086', stage: '中学', agreementNo: '9558851116004193134', functionCode: '2050203' },
  { unitName: '沭阳县周集初级中学', budgetUnitCode: '019080', stage: '中学', agreementNo: '9558851116004192706', functionCode: '2050203' }
]

export async function ensureSchoolLookupSeed(database: sqlite3.Database): Promise<void> {
  const tableName = quoteIdentifier(SCHOOL_LOOKUP_TABLE)
  const row = await get<{ total: number }>(database, `SELECT COUNT(*) AS total FROM ${tableName}`)
  if ((row?.total ?? 0) > 0) return

  for (const item of schoolLookupSeed) {
    await run(
      database,
      `INSERT INTO ${tableName}
        (${quoteIdentifier('单位名称')}, ${quoteIdentifier('单位预算编码')}, ${quoteIdentifier('学段')}, ${quoteIdentifier('协议号')}, ${quoteIdentifier('功能科目')}, "md_created_at", "md_updated_at")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.unitName,
        item.budgetUnitCode,
        item.stage,
        item.agreementNo,
        item.functionCode,
        new Date().toISOString(),
        new Date().toISOString()
      ]
    )
  }
}

export async function resolveSchoolUnitSettings(
  database: sqlite3.Database,
  budgetUnitCode: string
): Promise<Partial<UnitSettings> | null> {
  await ensureSchoolLookupSeed(database)

  const normalizedCode = normalizeBudgetUnitCode(budgetUnitCode)
  if (!normalizedCode) return null

  const tableName = quoteIdentifier(SCHOOL_LOOKUP_TABLE)
  const row = await get<Record<string, unknown>>(
    database,
    `SELECT * FROM ${tableName} WHERE ${quoteIdentifier('单位预算编码')} = ? LIMIT 1`,
    [normalizedCode]
  )
  if (!row) return null

  const unitName = text(row['单位名称'])
  const stage = text(row['学段'])
  const agreementNo = text(row['协议号'])
  const functionCode = text(row['功能科目'])

  return {
    unitFullName: unitName,
    unitImportCode: normalizedCode,
    schoolLevel: stageToFunctionName(stage),
    functionCode,
    socialPayeeName: DEFAULT_SOCIAL_PAYEE_NAME,
    socialPayeeBank: DEFAULT_SOCIAL_PAYEE_BANK,
    socialPayeeAccount: agreementNo,
    housingPayeeName: DEFAULT_HOUSING_PAYEE_NAME,
    housingPayeeBank: DEFAULT_HOUSING_PAYEE_BANK,
    housingPayeeAccount: DEFAULT_HOUSING_PAYEE_ACCOUNT
  }
}

function normalizeBudgetUnitCode(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  if (/^\d+$/.test(raw) && raw.length < 6) return raw.padStart(6, '0')
  return raw
}

function stageToFunctionName(stage: string): string {
  if (stage.includes('小学')) return '小学教育'
  if (stage.includes('中学')) return '初中教育'
  return stage
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}
