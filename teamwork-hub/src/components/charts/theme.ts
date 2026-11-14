"use client";

import { useEffect, useState } from "react";

/**
 * Chart colors. Categorical slots 1–3 (blue, orange, aqua) validated with the dataviz
 * validator for both modes (adjacent CVD ΔE ≥ 9.2, normal-vision ΔE ≥ 26.5). Aqua is below
 * 3:1 on the light surface, so every chart ships a table view (relief rule).
 * Values are resolved in JS because SVG presentation attributes can't use CSS var().
 */
const LIGHT = { s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", grid: "#e4e6ea", axis: "#5d6779", ink: "#0f172a", band: "#2a78d6", surface: "#ffffff", muted: "#9aa4b5" };
const DARK = { s1: "#3987e5", s2: "#d95926", s3: "#199e70", grid: "#2a3447", axis: "#9aa4b5", ink: "#eef2f8", band: "#3987e5", surface: "#121826", muted: "#5d6779" };
export type VizTheme = typeof LIGHT;

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function useVizTheme(): VizTheme {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const update = () => setDark(isDark());
    update();
    mq?.addEventListener("change", update);
    return () => mq?.removeEventListener("change", update);
  }, []);
  return dark ? DARK : LIGHT;
}

export const seriesColor = (t: VizTheme, i: number) => [t.s1, t.s2, t.s3][i % 3];

export function fmtValue(v: number | null | undefined, digits = 2, unit?: string) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}
