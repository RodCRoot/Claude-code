import { PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Today" };

export default async function TodayPage() {
  const viewer = await requireViewer();
  return <PageHeader kicker="Today" title={`Welcome, ${viewer.displayName}`} />;
}
