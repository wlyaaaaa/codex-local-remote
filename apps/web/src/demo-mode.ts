const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export interface DemoModeSignals {
  buildEnabled: boolean;
  hostname: string;
  search: string;
  storedPreference: string | null;
}

export function isDemoModeAllowed(signals: DemoModeSignals): boolean {
  if (!LOOPBACK_HOSTNAMES.has(signals.hostname.toLowerCase())) {
    return false;
  }
  return (
    signals.buildEnabled ||
    new URLSearchParams(signals.search).get("demo") === "1" ||
    signals.storedPreference === "1"
  );
}
