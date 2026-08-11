import type { DateRange } from '../lib/dateRanges';
import { REPORTING_MAX_DATE, REPORTING_MIN_DATE } from '../lib/dateRanges';

interface Props {
  primary: DateRange;
  onPrimaryChange: (range: DateRange) => void;
  comparison: DateRange;
  onComparisonChange: (range: DateRange) => void;
  showComparison: boolean;
}

function RangeFields({ legend, value, onChange }: {
  legend: string;
  value: DateRange;
  onChange: (range: DateRange) => void;
}): JSX.Element {
  return (
    <fieldset className="date-range-fields">
      <legend>{legend}</legend>
      <label>
        <span>From</span>
        <input type="date" min={REPORTING_MIN_DATE} max={value.to} value={value.from}
          onChange={(event) => onChange({ ...value, from: event.target.value })} />
      </label>
      <label>
        <span>To</span>
        <input type="date" min={value.from} max={REPORTING_MAX_DATE} value={value.to}
          onChange={(event) => onChange({ ...value, to: event.target.value })} />
      </label>
    </fieldset>
  );
}

export function DateRangeControls({ primary, onPrimaryChange, comparison, onComparisonChange, showComparison }: Props): JSX.Element {
  return (
    <div className="date-range-row" aria-label="Custom reporting periods">
      <RangeFields legend="Selected period" value={primary} onChange={onPrimaryChange} />
      {showComparison && <RangeFields legend="Comparison period" value={comparison} onChange={onComparisonChange} />}
    </div>
  );
}
