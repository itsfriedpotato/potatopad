"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center">
      <p className="font-mono text-5xl font-bold text-rose-500">!</p>
      <h1 className="mt-4 text-lg font-bold text-neutral-100">Something went wrong</h1>
      <p className="mt-2 text-sm text-neutral-400">
        A hiccup on our end. Try again, or head back to Discover.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <button type="button" onClick={reset} className="btn-primary">
          Try again
        </button>
        <a href="/" className="btn-secondary">
          Back to Discover
        </a>
      </div>
    </div>
  );
}
