import type { DeviceRegistryEntry } from "./types.js";

/** A child device inherits its parent's area unless it has its own assignment. */
export function effectiveDeviceArea(
  device: DeviceRegistryEntry | null | undefined,
  devices: ReadonlyMap<string, DeviceRegistryEntry>,
): string | undefined {
  if (device?.area_id != null) return device.area_id;
  if (!device?.parent_device_id) return undefined;
  return devices.get(device.parent_device_id)?.area_id ?? undefined;
}
