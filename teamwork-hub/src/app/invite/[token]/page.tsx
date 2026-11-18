import { SetPassword } from "../set-password";

export const metadata = { title: "Accept invite" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SetPassword token={token} kind="invite" title="Welcome to Teamwork Hub — set your password" />;
}
