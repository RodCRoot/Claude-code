"use client";

import { Button } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto mt-10 max-w-lg rounded-xl border border-bad/30 bg-bad/5 p-6">
      <h1 className="text-lg font-semibold">This page couldn&apos;t load</h1>
      <p className="mt-1 text-sm text-ink-2">
        {error.name === "AuthzError" ? "You don't have permission to view this." : "Something went wrong loading this page. Nothing was changed."}
      </p>
      {error.digest ? <p className="mt-1 text-xs text-ink-3">Reference: {error.digest}</p> : null}
      <Button className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
