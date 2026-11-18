import { Tabs } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { trainingTabs, type TabKey } from "../_lib/helpers";

export function TrainingNav({ viewer, current }: { viewer: Viewer; current: TabKey }) {
  return <Tabs tabs={trainingTabs(viewer)} current={current} />;
}
