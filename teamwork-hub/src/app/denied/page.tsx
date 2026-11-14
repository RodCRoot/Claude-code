import { ButtonLink } from "@/components/ui";

export const metadata = { title: "Access denied" };

export default function Denied() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="kicker">403</p>
        <h1 className="mt-1 text-2xl font-bold">You don&apos;t have access to that</h1>
        <p className="mt-2 text-sm text-ink-3">
          Your role doesn&apos;t include this page or record. If you think that&apos;s wrong, ask an owner or admin to review your permissions.
        </p>
        <ButtonLink href="/today" className="mt-6">
          Back to Today
        </ButtonLink>
      </div>
    </main>
  );
}
