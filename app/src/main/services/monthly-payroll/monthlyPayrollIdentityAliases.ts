import { all, getDatabase, run } from '../../db/connection'
import type { MonthlyPayrollIdentityReview } from '../../../shared/types'
import { normalizeIdCard, text } from './monthlyPayrollUtils'

export type ConfirmedIdentityAliasMap = Map<string, string>

export async function readConfirmedIdentityAliasMap(
  worksheetName: string
): Promise<ConfirmedIdentityAliasMap> {
  const database = await getDatabase()
  const rows = await all<{ source_id_card: string; target_id_card: string }>(
    database,
    `SELECT source_id_card, target_id_card
       FROM monthly_payroll_identity_aliases
      WHERE worksheet_name = ?`,
    [worksheetName]
  )
  const result: ConfirmedIdentityAliasMap = new Map()
  for (const row of rows) {
    const sourceIdCard = normalizeIdCard(row.source_id_card)
    const targetIdCard = normalizeIdCard(row.target_id_card)
    if (sourceIdCard && targetIdCard) result.set(sourceIdCard, targetIdCard)
  }
  return result
}

export async function saveConfirmedIdentityAliases(
  reviews: MonthlyPayrollIdentityReview[]
): Promise<number> {
  const confirmable = reviews.filter((review) =>
    review.confirmable &&
      normalizeIdCard(review.sourceIdCard) &&
      normalizeIdCard(review.targetIdCard) &&
      normalizeIdCard(review.sourceIdCard) !== normalizeIdCard(review.targetIdCard)
  )
  if (confirmable.length === 0) return 0

  const database = await getDatabase()
  let saved = 0
  for (const review of confirmable) {
    await run(
      database,
      `INSERT INTO monthly_payroll_identity_aliases (
         worksheet_name, source_name, source_id_card, target_name, target_id_card, confirmed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(worksheet_name, source_id_card, target_id_card)
       DO UPDATE SET
         source_name = excluded.source_name,
         target_name = excluded.target_name,
         updated_at = CURRENT_TIMESTAMP`,
      [
        review.worksheetName,
        text(review.sourceName),
        normalizeIdCard(review.sourceIdCard),
        text(review.targetName),
        normalizeIdCard(review.targetIdCard)
      ]
    )
    saved += 1
  }
  return saved
}
