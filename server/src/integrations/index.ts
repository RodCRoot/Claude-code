import { DeviceAdapter } from "./types";
import { hawkinAdapter } from "./hawkin";
import { ovrAdapter } from "./ovr";

export const adapters: DeviceAdapter[] = [hawkinAdapter, ovrAdapter];

export function getAdapter(key: string): DeviceAdapter | undefined {
  return adapters.find((a) => a.key.toLowerCase() === key.toLowerCase());
}

export * from "./types";
