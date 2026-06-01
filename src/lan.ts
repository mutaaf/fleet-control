// LAN URL discovery for the welcome's pair section (ticket 0032).
//
// Reads node:os network interfaces and picks the first non-loopback
// IPv4 address. No shell-out, no new runtime deps. The detection is
// deliberately simple: when the operator explicitly bound to 127.0.0.1
// (the default), we return null so the welcome stays silent — that
// operator is on the same machine and doesn't need a pair URL. When
// the bind is `0.0.0.0` (or any non-loopback host), we walk
// `os.networkInterfaces()` and return the first usable LAN address.
//
// The walker is injectable via the `interfaces` opt for tests, so the
// CLI test can stub a fixture interface set without touching the host's
// real network state.

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type InterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>;

/** Discover a LAN URL for the given bind host + port. Returns `null` when
 *  the operator is loopback-only or no usable IPv4 interface is found. */
export function discoverLanUrl(
  host: string,
  port: number,
  opts: { interfaces?: () => InterfaceMap } = {},
): string | null {
  // Loopback-only binds: by design no QR. The operator is on the same
  // machine; the URL `http://127.0.0.1:7070` is in the welcome already.
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return null;

  const ifaces = (opts.interfaces ?? networkInterfaces)();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const info of list) {
      if (!info) continue;
      // Skip loopback and IPv6 addresses. We only emit IPv4 because the
      // welcome's downstream QR encoder is V1-L alphanumeric — IPv6
      // colons and brackets aren't in the QR alphabet and IPv4 is what
      // phones on the same WiFi consistently route to.
      if (info.internal) continue;
      if (info.family !== "IPv4" && (info as unknown as { family: number }).family !== 4) continue;
      candidates.push(info.address);
    }
  }
  if (candidates.length === 0) return null;
  // Deterministic choice: lexicographic sort, lowest IP wins. On a
  // typical home network this hits 192.168.x.y first, which is what the
  // operator's phone is most likely to reach.
  candidates.sort();
  return `http://${candidates[0]}:${port}`;
}
