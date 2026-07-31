import { redirect } from "next/navigation";
import { getSessionUser, verifyCredentials, createSession } from "@/lib/auth";
import { Button, Input, Label } from "@/components/ui";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await verifyCredentials(email, password);
  if (!user) {
    redirect("/login?error=1");
  }
  await createSession(user.id);
  redirect("/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const existing = await getSessionUser();
  if (existing) redirect("/");
  const { error } = await searchParams;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand-600 text-xl font-black text-white">
            TW
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Teamwork Bloomington</h1>
          <p className="kicker mt-1">Business Scoreboard</p>
        </div>
        <form
          action={login}
          className="space-y-4 rounded-xl border border-edge bg-surface-2 p-6 shadow-sm"
        >
          {error ? (
            <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm font-medium text-bad">
              Invalid email or password.
            </p>
          ) : null}
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@teamworkbloomington.com"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>
          <Button type="submit" className="w-full" size="lg">
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-ink-3">
          Demo logins are listed in the project README.
        </p>
      </div>
    </div>
  );
}
