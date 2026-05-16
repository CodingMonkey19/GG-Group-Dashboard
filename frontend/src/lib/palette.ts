/**
 * Categorical palette shared by DonutChart + StackedBars so a project's
 * colour stays consistent across charts. Indexed by the project's rank in
 * `projectsRankedBySpend()` (sorted by lifetime spend desc).
 *
 * Import directly — never stash on window. The constants are frozen `as const`
 * tuples so consumers get literal-typed colors.
 */

export const PROJECT_PALETTE = [
  '#0e1a36', // navy        — rank 1
  '#2c63d6', // blue        — rank 2
  '#0a9396', // teal        — rank 3
  '#1e7a4d', // green       — rank 4
  '#94c11f', // lime        — rank 5
  '#e0a800', // gold        — rank 6
  '#d97706', // orange      — rank 7
  '#c2410c', // burnt       — rank 8
  '#b91c1c', // red         — rank 9
  '#be185d', // pink        — rank 10
  '#7c3aed', // purple      — rank 11
] as const;

export const PROJECT_OTHER_COLOR = '#cbd5e1';
export const TOP_N_FOR_PALETTE: number = PROJECT_PALETTE.length; // 11
