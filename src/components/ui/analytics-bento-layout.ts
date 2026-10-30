// Squarify geometry adapted from the user-supplied Analytics Bento by vasnev.art.
export type TreemapRect = { name: string; group: string; v: number; x: number; y: number; w: number; h: number };
export function squarify(items: { name: string; group: string; v: number }[], x: number, y: number, w: number, h: number): TreemapRect[] {
  items = items.filter(item => Number.isFinite(item.v) && item.v > 0);
  if (!items.length || w <= 0 || h <= 0) return [];
  const total = items.reduce((a, b) => a + b.v, 0) || 1, scale = (w * h) / total, out: TreemapRect[] = [];
  let rest = items.map((i) => ({ ...i, a: i.v * scale }));
  const worst = (row: typeof rest, len: number) => {
    const s = row.reduce((a, b) => a + b.a, 0), mx = Math.max(...row.map((r) => r.a)), mn = Math.min(...row.map((r) => r.a));
    return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn));
  };
  while (rest.length) {
    const len = Math.min(w, h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], len) <= worst(row, len)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((a, b) => a + b.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; for (const r of row) { const rh = r.a / cw; out.push({ ...r, x, y: cy, w: cw, h: rh }); cy += rh; } x += cw; w -= cw; }
    else { const rh = s / w; let cx = x; for (const r of row) { const rw = r.a / rh; out.push({ ...r, x: cx, y, w: rw, h: rh }); cx += rw; } y += rh; h -= rh; }
  }
  return out;
}

