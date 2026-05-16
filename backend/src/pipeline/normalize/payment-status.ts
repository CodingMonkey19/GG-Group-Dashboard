/**
 * Map a raw payment-status cell value to the 4-value taxonomy mandated by
 * Constitution Principle VI (NON-NEGOTIABLE).
 *
 * Taxonomy: paid / unpaid / unknown / missing
 *
 * Hard rules:
 *   • An empty / blank cell MUST NEVER coerce to 'paid'.
 *   • If the sheet HAS a status column mapped but the cell is blank → 'unknown'.
 *   • If the sheet has NO status column mapped → 'missing'.
 *
 * Recognized lexicon (case-insensitive, whitespace-trimmed):
 *   paid     : "paid", "yes", "y", "true", "✓", "ok"
 *   unpaid   : "unpaid", "no", "n", "false", "pending", "due", "overdue"
 *   anything else with content → 'unknown' (operator can extend the lexicon
 *                                            in this file if their sheets use
 *                                            different conventions)
 */

import type { PaymentStatus } from '../../shared/contracts.js';

const PAID_TOKENS = new Set(['paid', 'yes', 'y', 'true', '✓', 'ok']);
const UNPAID_TOKENS = new Set(['unpaid', 'no', 'n', 'false', 'pending', 'due', 'overdue']);

/**
 * Resolve the payment status from a raw cell value, given whether the
 * sheet config maps a status column at all.
 *
 * @param rawCell  The cell value as pulled from the sheet (string, possibly
 *                 empty), or undefined when the sheet column isn't mapped.
 *                 Pass `undefined` (not `''`) for the no-column case so
 *                 'missing' vs 'unknown' is unambiguous.
 */
export function classifyPaymentStatus(rawCell: string | undefined): PaymentStatus {
  if (rawCell === undefined) return 'missing';
  const trimmed = rawCell.trim();
  if (trimmed.length === 0) return 'unknown';
  const lower = trimmed.toLowerCase();
  if (PAID_TOKENS.has(lower)) return 'paid';
  if (UNPAID_TOKENS.has(lower)) return 'unpaid';
  return 'unknown';
}
