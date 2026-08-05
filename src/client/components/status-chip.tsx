export type StatusChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusChipProps {
  tone: StatusChipTone;
  label: string;
}

/**
 * Presentational status chip. Tone is mapped to semantic color plus a shape
 * marker so state never relies on color alone; labels are supplied by the
 * caller and the component itself contains no product vocabulary.
 */
export function StatusChip({ tone, label }: StatusChipProps) {
  return (
    <span className={`fc-status-chip fc-status-chip--${tone}`}>
      <span className="fc-status-chip__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
