import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { PageHeader } from "@/components/ui";
import { OfflineToday } from "../../_components/offline-today";

export const metadata = { title: "Today's training (offline copy)" };

/**
 * Offline shell for the athlete logger. The HTML carries no workout data: the client loads it
 * from /api/training/today, which the service worker answers from its saved copy when offline.
 * The service worker caches this page and serves it for /training/today when the network is down.
 */
export default async function TrainingTodayOffline() {
  const viewer = await requireViewer();
  if (viewer.role !== "athlete") redirect("/training/today");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader kicker="Training" title="Today's workout" description="Log each set as you go. Entries save on this device first and sync automatically." />
      <OfflineToday />
    </div>
  );
}
