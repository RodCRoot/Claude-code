import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <p className="kicker">404</p>
        <h1 className="mt-1 text-2xl font-bold">Not found</h1>
        <p className="mt-2 text-sm text-ink-3">That page or record doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <ButtonLink href="/today" className="mt-6">Go to Today</ButtonLink>
      </div>
    </main>
  );
}
