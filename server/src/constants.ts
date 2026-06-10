// Centralized string-enum values (SQLite has no native enums).

export const ROLES = ["ADMIN", "COACH", "ATHLETE"] as const;
export type Role = (typeof ROLES)[number];

export const METRIC_SOURCES = ["HAWKIN", "OVR", "TIMING", "MANUAL", "CSV"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

export const METRIC_CATEGORIES = ["JUMP", "SPEED", "STRENGTH", "POWER", "OTHER"] as const;

export const BENCHMARK_LEVELS = ["ELITE", "GOOD", "AVERAGE"] as const;

export const ASSIGNMENT_STATUS = ["ASSIGNED", "IN_PROGRESS", "COMPLETED"] as const;
