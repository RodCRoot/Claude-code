import { SetPassword } from "../../invite/set-password";

export const metadata = { title: "Reset password" };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SetPassword token={token} kind="reset" title="Choose a new password" />;
}
