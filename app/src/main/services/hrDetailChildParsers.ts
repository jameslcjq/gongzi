export function parseEducationCell(raw: string): Record<string, string> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 1) {
    return { '专业': lines[0] }
  }

  return {
    '毕业时间': lines[0] ?? '',
    '学历': lines[1] ?? '',
    '毕业院校': lines[2] ?? '',
    '专业': lines.slice(3).join('\n')
  }
}

const workHistoryPostSuffixes = [
  '教学点负责人',
  '教务副主任',
  '办公室主任',
  '少先队辅导员',
  '教务主任',
  '教导主任',
  '总务主任',
  '德育主任',
  '政教主任',
  '工会主席',
  '支部书记',
  '副校长',
  '负责人',
  '工作人员',
  '校长',
  '主任',
  '报账员',
  '会计',
  '出纳',
  '教师'
].sort((left, right) => right.length - left.length)

export function parseWorkHistoryLine(raw: string): Record<string, string> {
  const line = raw.replace(/\s+/g, ' ').trim()
  if (!line) return {}

  const rangeMatch = line.match(/^(\d{4,6})\s*[~\-至到]\s*(\d{4,6})\s*(.*)$/)
  if (rangeMatch) {
    return {
      '开始时间': rangeMatch[1],
      '结束时间': rangeMatch[2],
      ...parseWorkUnitAndPost(rangeMatch[3]),
      '说明': line
    }
  }

  const startMatch = line.match(/^(\d{4,6})\s*(.*)$/)
  if (startMatch) {
    return {
      '开始时间': startMatch[1],
      ...parseWorkUnitAndPost(startMatch[2]),
      '说明': line
    }
  }

  return {
    ...parseWorkUnitAndPost(line),
    '说明': line
  }
}

function parseWorkUnitAndPost(raw: string): Record<string, string> {
  const text = raw.trim()
  if (!text) return {}

  const spaced = text.match(/^(.+?)\s+([^\s]+)$/)
  if (spaced) {
    return { '工作单位': spaced[1].trim(), '职务岗位': spaced[2].trim() }
  }

  for (const suffix of workHistoryPostSuffixes) {
    if (!text.endsWith(suffix) || text.length <= suffix.length) continue
    return {
      '工作单位': text.slice(0, -suffix.length).trim(),
      '职务岗位': suffix
    }
  }

  return { '工作单位': text }
}
