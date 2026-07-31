import { requireUser } from "@/lib/auth";
import { isDemoMode } from "@/lib/settings";
import { ensureTaskInstances } from "@/lib/tasks";
import { AppNav } from "@/components/nav";

export const dynamic = "force-dynamic";

// Lazy daily task generation: run at most once per day per server process.
let lastGenerated = "";
function generateOncePerDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastGenerated !== today) {
    try {
      ensureTaskInstances();
      lastGenerated = today;
    } catch (e) {
      console.error("Task generation failed:", e);
    }
  }
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  generateOncePerDay();
  const demoMode = isDemoMode();

  return (
    <div className="min-h-dvh">
      <AppNav
        user={{
          name: user.name,
          roleName: user.roleName,
          permissions: user.permissions,
        }}
        demoMode={demoMode}
      />
      <main className="px-4 py-6 sm:px-6 lg:ml-64 lg:px-8">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
