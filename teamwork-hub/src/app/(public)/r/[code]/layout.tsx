import { connection } from "next/server";

/** Per-request and narrow, like the public inquiry form. */
export default async function ReferralLandingLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return <div className="mx-auto max-w-3xl px-4 py-8">{children}</div>;
}
