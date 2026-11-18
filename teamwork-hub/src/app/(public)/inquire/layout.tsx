import { connection } from "next/server";

/** The public site layout supplies the header; this only keeps the form per-request and narrow. */
export default async function InquireLayout({ children }: { children: React.ReactNode }) {
  await connection(); // per-request: never query the database at build time
  return <div className="mx-auto max-w-3xl px-4 py-8">{children}</div>;
}
