import Link from "next/link";
import { getPublicSite } from "@/lib/public-site";
import { getViewer } from "@/lib/auth/viewer";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const [{ orgName }, viewer] = await Promise.all([getPublicSite(), getViewer()]);
  const links = [
    ["/programs", "Programs"],
    ["/classes", "Schedule"],
    ["/inquire", "Book an assessment"],
  ];
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-edge bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="text-lg font-bold tracking-tight">
            {orgName} <span className="text-brand">Bloomington</span>
          </Link>
          <nav aria-label="Site" className="flex flex-wrap items-center gap-1 text-sm">
            {links.map(([href, label]) => (
              <Link key={href} href={href} className="min-h-11 rounded-lg px-3 py-3 font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
                {label}
              </Link>
            ))}
            <Link href={viewer ? "/today" : "/login"} className="ml-1 min-h-11 rounded-lg bg-brand px-4 py-3 font-medium text-brand-ink">
              {viewer ? "Open Hub" : "Member sign in"}
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-edge bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-ink-3">
          © {new Date().getFullYear()} {orgName} · Bloomington, Indiana ·{" "}
          <Link className="underline" href="/login">
            Staff &amp; member sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
