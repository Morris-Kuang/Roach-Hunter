// Tip-line "NLP": local keyword matching against REPORTABLE_LOCATIONS, no
// API key / network call / LLM. Deliberately simple -- it only recognizes a
// fixed vocabulary of room landmarks, it does not understand arbitrary
// phrasing -- but it's free, zero-latency, and works fully offline, matching
// this project's "immune to the venue" demo philosophy (see proposal.md).

import { REPORTABLE_LOCATIONS } from './constants.js';

/** Returns the first REPORTABLE_LOCATIONS entry whose keyword appears in `text`, or null. */
export function parseLocation(text) {
  const lower = text.toLowerCase();
  for (const loc of REPORTABLE_LOCATIONS) {
    for (const kw of loc.keywords) {
      if (lower.includes(kw.toLowerCase())) return loc;
    }
  }
  return null;
}

/** The REPORTABLE_LOCATIONS entry closest to (x, z) -- used to describe roughly where a tracked target vanished. */
export function nearestLocation(x, z) {
  let best = REPORTABLE_LOCATIONS[0], bestD = Infinity;
  for (const loc of REPORTABLE_LOCATIONS) {
    const d = (loc.x - x) ** 2 + (loc.z - z) ** 2;
    if (d < bestD) { bestD = d; best = loc; }
  }
  return best;
}
