import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center">
      <p className="font-mono text-5xl font-bold text-amber-500">404</p>
      <h1 className="mt-4 text-lg font-bold text-neutral-100">This patch is empty</h1>
      <p className="mt-2 text-sm text-neutral-400">
        The page you&apos;re looking for isn&apos;t here. Head back to the field.
      </p>
      <Link href="/" className="btn-primary mt-6">
        Back to Discover
      </Link>
    </div>
  );
}
