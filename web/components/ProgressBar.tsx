export function ProgressBar({
  bps,
  label,
  className = "",
}: {
  /** curve progress in basis points (0–10000) */
  bps: bigint;
  /** optional percentage label rendered at the end of the track */
  label?: string;
  className?: string;
}) {
  const pct = Math.min(100, Number(bps) / 100);
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-neutral-800"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      {label && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-amber-300">{label}</span>
      )}
    </div>
  );
}
