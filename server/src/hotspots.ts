// Flags issues concentrated on one device maker, OS version, model or a combination of them.
//
// For an issue seen in n sessions, k of them in segment S, the share k/n is compared with S's
// share of all sessions. A segment is flagged when most affected sessions are in it and even the
// pessimistic (Wilson 95% lower bound) share is at least twice the fleet share. Requiring a
// majority keeps fleet-wide issues from being attributed to whichever segment is largest.

export type SegmentStat = { dimension: string; value: string; sessions: number };

export type Concentration = {
  dimension: string;
  value: string;
  issueSessions: number;
  issueShare: number;
  fleetShare: number;
  lift: number;
  lowerBound: number;
};

export function wilsonLowerBound(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export type ConcentrationOptions = { minSessions?: number; minShare?: number; minLift?: number; maxFleetShare?: number };

export function findConcentrations(
  totalSessions: number,
  fleet: SegmentStat[],
  issueTotal: number,
  issue: SegmentStat[],
  options: ConcentrationOptions = {},
): Concentration[] {
  const { minSessions = 20, minShare = 0.6, minLift = 2, maxFleetShare = 0.5 } = options;
  if (issueTotal < minSessions || totalSessions === 0) return [];
  const fleetBy = new Map(fleet.map((s) => [`${s.dimension}\u0000${s.value}`, s.sessions]));
  const found: Concentration[] = [];
  for (const s of issue) {
    const fleetSessions = fleetBy.get(`${s.dimension}\u0000${s.value}`) ?? 0;
    const fleetShare = fleetSessions / totalSessions;
    const issueShare = s.sessions / issueTotal;
    if (fleetShare === 0 || fleetShare > maxFleetShare || issueShare < minShare) continue;
    const lowerBound = wilsonLowerBound(s.sessions, issueTotal);
    if (lowerBound < minLift * fleetShare) continue;
    found.push({ dimension: s.dimension, value: s.value, issueSessions: s.sessions, issueShare, fleetShare, lift: issueShare / fleetShare, lowerBound });
  }
  // The narrowest explanation first: a combined segment with a higher lift beats its parts.
  return found.sort((a, b) => b.lift - a.lift);
}
