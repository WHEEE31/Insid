// Floor detection — cluster barometric relAltitude into discrete levels.
//
// Why relAltitude and not ARKit y or GPS: the barometer is accurate to ~0.3-1m
// (well under a ~3-4m floor height) and doesn't drift like integrated ARKit y or
// GPS altitude. See docs/path-schema.md. If relAltitude is missing on a point we
// fall back to y so synthetic / partial data still works.

const alt = (p) => (p.relAltitude != null ? p.relAltitude : p.y);

// Floors are DENSITY PEAKS in the altitude distribution: people dwell on a floor
// (many samples at one altitude) and transit stairs/elevators quickly (few
// samples spread across the in-between altitudes). So we histogram relAltitude
// and pick peaks, rather than splitting on gaps -- a staircase fills the gap
// between floors with a continuous ramp, which defeats gap-based clustering.
//
//   binSize    histogram resolution (m)
//   minGap     minimum altitude separation between distinct floors (m)
//   densityFrac a bin is a floor seed only if its count >= densityFrac * maxCount
export function detectFloors(
  walks,
  { binSize = 0.5, minGap = 2.5, densityFrac = 0.08 } = {}
) {
  const values = [];
  for (const w of walks) for (const p of w.points) values.push(alt(p));
  if (values.length === 0) return { levels: [], assign: () => 0 };

  // histogram: binIndex -> { count, sum } (sum to recover a precise mean later)
  const bins = new Map();
  for (const v of values) {
    const idx = Math.round(v / binSize);
    const b = bins.get(idx) || { count: 0, sum: 0 };
    b.count += 1;
    b.sum += v;
    bins.set(idx, b);
  }
  let maxCount = 0;
  for (const b of bins.values()) maxCount = Math.max(maxCount, b.count);
  const threshold = maxCount * densityFrac;

  // seed bins that clear the density threshold, sorted by altitude
  const seeds = [...bins.entries()]
    .filter(([, b]) => b.count >= threshold)
    .map(([idx, b]) => ({ alt: idx * binSize, count: b.count, sum: b.sum }))
    .sort((a, b) => a.alt - b.alt);

  // merge seeds closer than minGap into one floor (weighted by count)
  const groups = [];
  for (const s of seeds) {
    const g = groups[groups.length - 1];
    if (g && s.alt - g.altHi < minGap) {
      g.sum += s.sum;
      g.count += s.count;
      g.altHi = s.alt;
    } else {
      groups.push({ sum: s.sum, count: s.count, altLo: s.alt, altHi: s.alt });
    }
  }

  const levels = groups.map((g, i) => ({
    floor: i,
    altitude: g.sum / g.count,
    min: g.altLo,
    max: g.altHi,
  }));

  // assign an altitude to its nearest level index
  const assign = (a) => {
    let best = 0;
    let bestD = Infinity;
    for (const lvl of levels) {
      const d = Math.abs(a - lvl.altitude);
      if (d < bestD) {
        bestD = d;
        best = lvl.floor;
      }
    }
    return best;
  };

  return { levels, assign };
}

// Annotate every point in-place with `.floor` (index) using detected levels.
// Returns the floors result so callers can read `levels`.
export function annotateFloors(walks, opts) {
  const floors = detectFloors(walks, opts);
  for (const w of walks) for (const p of w.points) p.floor = floors.assign(alt(p));
  return floors;
}
