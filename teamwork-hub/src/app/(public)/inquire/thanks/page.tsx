import Link from "next/link";
import { Card, CardBody } from "@/components/ui";

export const metadata = { title: "Inquiry received" };

export default function InquiryThanks() {
  return (
    <Card>
      <CardBody className="pt-6">
        <h1 className="text-2xl font-bold tracking-tight">Thanks — we got your inquiry</h1>
        <p className="mt-2 text-sm text-ink-2">
          A member of our team will contact you soon to find an assessment time that works. If you need us sooner, please call or stop by the front desk.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/inquire" className="font-medium text-brand underline underline-offset-2">
            Submit another inquiry
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
