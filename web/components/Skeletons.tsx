/** Loading placeholder shaped like a token card. */
export function TokenCardSkeleton() {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3">
        <div className="skeleton h-11 w-11 rounded-xl" />
        <div className="flex-1">
          <div className="skeleton h-5 w-28" />
          <div className="skeleton mt-2 h-3.5 w-16" />
        </div>
      </div>
      <div className="skeleton mt-4 h-4 w-40" />
      <div className="skeleton mt-4 h-2 w-full" />
      <div className="skeleton mt-3 h-4 w-24" />
    </div>
  );
}

/** Generic text-line placeholder. */
export function LineSkeleton({ className = "h-4 w-32" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}
