/**
 * Outbound-address guard for tenant-supplied URLs (webhooks). ADR 0007 / 0008.
 *
 * A hostname check alone is not enough: `hooks.evil.example` can resolve to 10.0.0.5, and the
 * answer can change between "check" and "connect" (DNS rebinding). So the guard works on the
 * RESOLVED addresses and is used as the socket's `lookup` function: the address Node connects to
 * is exactly the address that was checked. Every resolved address must be public; one private
 * answer in the set fails the whole lookup.
 */
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';

const blocked = new BlockList();
// IPv4 — RFC 6890 special-purpose + anything a webhook has no business reaching.
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// IPv6
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 → embeds an IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo (tunnels to arbitrary IPv4)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True if the address is anything other than a routable public unicast address. */
export function isBlockedAddress(ip: string): boolean {
  // BlockList matches IPv4-mapped IPv6 (::ffff:7f00:1 etc.) against the IPv4 rules itself.
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(addr);
  if (family === 4) return blocked.check(addr, 'ipv4');
  if (family === 6) return blocked.check(addr, 'ipv6');
  return true; // not an IP at all → refuse
}

export class BlockedAddressError extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to a private or reserved address (${address})`);
    this.name = 'BlockedAddressError';
  }
}

type LookupFn = (
  hostname: string,
  options: { all: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * Build a `net.connect`-compatible lookup that resolves ALL addresses, refuses the host if any is
 * blocked, and hands back the first. `resolver` is injectable so tests can simulate DNS answers.
 */
export function guardedLookup(resolver: LookupFn = dnsLookup as unknown as LookupFn) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    const wantAll = typeof options === 'object' && options !== null && options.all === true;
    const done = (addrs: LookupAddress[]) => {
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad) return cb(new BlockedAddressError(hostname, bad.address) as NodeJS.ErrnoException, wantAll ? [] : '', 0);
      if (addrs.length === 0) return cb(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), wantAll ? [] : '', 0);
      if (wantAll) return cb(null, addrs);
      return cb(null, addrs[0]!.address, addrs[0]!.family);
    };
    // IP literals skip DNS but still pass through the check.
    const literal = hostname.replace(/^\[|\]$/g, '');
    const fam = isIP(literal);
    if (fam) return done([{ address: literal, family: fam }]);
    resolver(hostname, { all: true }, (err, addrs) => (err ? cb(err, wantAll ? [] : '', 0) : done(addrs)));
  };
}
