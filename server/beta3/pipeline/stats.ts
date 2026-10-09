/** Fit statistics used in travel-model validation (FHWA 2010; CTC RTP Guidelines). */
export function stats(pairs: { obs: number; mod: number }[]) {
  const n = pairs.length;
  const so = pairs.reduce((a, p) => a + p.obs, 0), sm = pairs.reduce((a, p) => a + p.mod, 0);
  const mo = so / n, mm = sm / n;
  let cov = 0, vo = 0, vm = 0, se = 0, ape = 0, sxy = 0, sxx = 0;
  const apes: number[] = [];
  for (const p of pairs) {
    cov += (p.obs - mo) * (p.mod - mm);
    vo += (p.obs - mo) ** 2;
    vm += (p.mod - mm) ** 2;
    se += (p.mod - p.obs) ** 2;
    const a = Math.abs(p.mod - p.obs) / Math.max(1, p.obs);
    ape += a;
    apes.push(a);
    sxy += p.obs * p.mod;
    sxx += p.obs * p.obs;
  }
  apes.sort((a, b) => a - b);
  const r = cov / Math.sqrt(vo * vm);
  const rmse = Math.sqrt(se / n);
  return {
    n,
    observedTotal: Math.round(so),
    modelTotal: Math.round(sm),
    totalRatio: sm / so,
    r,
    r2: r * r,
    pctRmse: (100 * rmse) / mo,
    mape: (100 * ape) / n,
    medianApe: 100 * apes[Math.floor(n / 2)],
    within25: pairs.filter((p) => Math.abs(p.mod - p.obs) <= 0.25 * p.obs).length / n,
    slopeThroughOrigin: sxy / sxx,
  };
}
