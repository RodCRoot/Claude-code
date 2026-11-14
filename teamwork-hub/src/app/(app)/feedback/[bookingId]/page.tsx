import { notFound, redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";

export const metadata = { title: "Session feedback" };

/**
 * The ten-second session rating now lives inside the after check, so nobody is asked twice.
 * Old links (bookmarks, earlier task descriptions) keep working: same booking, same permission
 * checks, same `session_feedback` row for the rating.
 */
export default async function FeedbackPage({ params }: { params: Promise<{ bookingId: string }> }) {
  await requireViewer(["guardian", "athlete"]);
  const { bookingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) notFound();
  redirect(`/check-ins/${bookingId}/after`);
}
