# Custom Date-Range Comparison

## Goal

Let the CEO view dashboard results for an exact inclusive invoice-date range and optionally compare that range with a second exact inclusive range.

## Interaction

- Keep the current Month and Jan–Jul 2026 scope choices.
- Add `Custom period` to the scope control.
- When selected, show native calendar inputs for `From` and `To`.
- Keep comparison off by default. Add `Custom period` to the comparison selector; selecting it shows a second `From` and `To` pair.
- Initial custom dates use the currently selected month. Comparison dates default to the immediately preceding period of equal length.
- Reject an end date earlier than its start date and keep the last valid dashboard state visible.

## Data behavior

- Date boundaries are inclusive and use the normalized `invoice_date` field (`YYYY-MM-DD`).
- Custom ranges remain inside 1 January–31 July 2026 and continue excluding LiveSportsOdds through the existing source pipeline.
- The selected project filter applies to both ranges.
- KPI cards, comparison deltas, completed-link counts, drill-down rows, project rankings, and charts all use the exact selected ranges.
- Month and Jan–Jul modes retain their current behavior.

## Presentation

- The top bar remains compact: the calendar fields appear in a second control row only while a custom range is active.
- Range labels use concise dates, for example `1–15 Jul 2026`.
- Comparison chart legends identify `Selected period` and `Comparison period`; daily buckets are used for short custom ranges so partial-month results are not presented as whole-month totals.

## Verification

- Confirm inclusive boundary dates are counted once.
- Confirm changing project applies to both periods.
- Confirm cards and charts use the same filtered row sets.
- Confirm invalid ranges do not replace the last valid view.
- Confirm existing month and Jan–Jul views still work.
