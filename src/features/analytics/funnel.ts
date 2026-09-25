/**
 * Tracked links and funnel analytics (ADR 0014): the pure parts, shared by the API and tests.
 */
import { randomInt } from 'node:crypto';
import { LINK_CHANNELS, type FunnelCounts, type FunnelStage, type LinkChannel, type TrackedLink } from '@/server/repos/types';

/** No 0/o/1/l/i: codes get read aloud and typed from printed QR cards. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CODE_LENGTH = 7;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export const MAX_ACTIVE_LINKS = 200;
export const LABEL_MAX = 80;
export const RANGE_DAYS = [7, 30, 90, 365] as const;
export const RETENTION_DAYS = 400;

export function newLinkCode(): string {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return c;
}

/** A ?src= value worth looking up, normalized; anything else is ignored (never an error). */
export function parseSrc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return CODE_RE.test(v) ? v : null;
}

export function parseLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim(); // eslint-disable-line no-control-regex -- stripping control characters
  return v.length >= 1 && v.length <= LABEL_MAX ? v : null;
}

export function parseChannel(raw: unknown): LinkChannel | null {
  return typeof raw === 'string' && (LINK_CHANNELS as readonly string[]).includes(raw) ? (raw as LinkChannel) : null;
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Inclusive range ending today (UTC): `days` calendar days. */
export function dayRange(now: Date, days: number): { from: string; to: string; days: string[] } {
  const out: string[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(new Date(end - i * 86_400_000)));
  return { from: out[0]!, to: out[out.length - 1]!, days: out };
}

type Stages = Record<FunnelStage, number>;
const zero = (): Stages => ({ visit: 0, proof: 0, lead: 0 });

export interface FunnelSummary {
  range: { from: string; to: string; days: number };
  totals: Stages;
  /** One entry per day in the range, zeros included, oldest first. */
  byDay: ({ day: string } & Stages)[];
  /** One row per link that has activity or is active, plus "direct" (no link). Most visits first. */
  byLink: ({ linkId: string | null; code: string | null; label: string; channel: LinkChannel | null; archived: boolean } & Stages)[];
}

export function summarize(counts: FunnelCounts, links: TrackedLink[], range: { from: string; to: string; days: string[] }): FunnelSummary {
  const totals = zero();
  const days = new Map(range.days.map((d) => [d, zero()]));
  for (const r of counts.byDay) {
    const d = days.get(r.day);
    if (!d) continue;
    d[r.kind] += r.count;
    totals[r.kind] += r.count;
  }
  const perLink = new Map<string, Stages>();
  for (const r of counts.byLink) {
    const k = r.linkId ?? '';
    const v = perLink.get(k) ?? zero();
    v[r.kind] += r.count;
    perLink.set(k, v);
  }
  const byId = new Map(links.map((l) => [l.id, l]));
  const rows: FunnelSummary['byLink'] = [];
  for (const l of links) {
    const v = perLink.get(l.id);
    if (!v && l.archivedAt) continue; // archived and quiet in this range: nothing to show
    rows.push({ linkId: l.id, code: l.code, label: l.label, channel: l.channel, archived: !!l.archivedAt, ...(v ?? zero()) });
  }
  // Events whose link row is gone (can't normally happen: FKs set NULL) fold into direct.
  const direct = zero();
  for (const [k, v] of perLink) {
    if (k && byId.has(k)) continue;
    direct.visit += v.visit;
    direct.proof += v.proof;
    direct.lead += v.lead;
  }
  rows.push({ linkId: null, code: null, label: 'Direct / no link', channel: null, archived: false, ...direct });
  rows.sort((a, b) => b.visit - a.visit || b.lead - a.lead || a.label.localeCompare(b.label));
  return {
    range: { from: range.from, to: range.to, days: range.days.length },
    totals,
    byDay: range.days.map((d) => ({ day: d, ...days.get(d)! })),
    byLink: rows,
  };
}
