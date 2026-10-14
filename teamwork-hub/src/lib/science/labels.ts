/** Source labels shared by KPI series, comparability checks and the UI (no database imports). */
export const VENDOR_LABEL: Record<string, string> = {
  hawkin: "Hawkin (vendor)",
  teambuildr: "TeamBuildr (vendor)",
  other_vendor: "Vendor",
  wearable: "Wearable",
  teamwork_manual: "Teamwork",
  teamwork_derived: "Teamwork-derived",
};
export const isVendor = (s: string) => s === "hawkin" || s === "teambuildr" || s === "other_vendor";
