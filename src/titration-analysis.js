// Pure functions for titration data analysis.
// Shared between measurement.js (live titration) and history.js (stored data).

const SMOOTH_HALF      = 5;    // half-window for pH smoothing (full window = 11)
const EP_MIN_THRESHOLD = 0.8;  // noise floor — minimum |d(pH)/dV| for any EP candidate
const EP_NMS_WINDOW_ML = 1.0;  // NMS window — within this span only the strongest candidate survives. Value in milliliters.

export function smoothedPh(points, index, halfWindow = SMOOTH_HALF) {
    const lo = Math.max(0, index - halfWindow);
    const hi = Math.min(points.length - 1, index + halfWindow);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += points[i].ph;
    return sum / (hi - lo + 1);
}

export function interpolatePhAt(points, vol) {
    for (let i = 1; i < points.length; i++) {
        if (points[i].volume >= vol) {
            const a = points[i - 1], b = points[i];
            if (a.ph == null || b.ph == null) return null;
            const t = (vol - a.volume) / (b.volume - a.volume);
            return a.ph + t * (b.ph - a.ph);
        }
    }
    return points[points.length - 1]?.ph ?? null;
}

// Detect equivalence points via d²(pH)/dV² zero-crossing with NMS.
// direction: +1 for base titrant (pH rises), -1 for acid titrant (pH falls).
// Returns array of { volume, ph } sorted by volume.
export function findEquivalencePoints(points, direction) {
    if (points.length < 6) return [];
    const sph = points.map((_, i) => smoothedPh(points, i));

    const dpdv = new Array(points.length).fill(undefined);
    for (let i = 1; i < points.length; i++) {
        const dV = points[i].volume - points[i - 1].volume;
        if (dV > 0) dpdv[i] = (sph[i] - sph[i - 1]) / dV;
    }

    const d2pdv2 = new Array(points.length).fill(undefined);
    for (let i = 2; i < points.length; i++) {
        const dV = points[i].volume - points[i - 1].volume;
        if (dV > 0 && dpdv[i] !== undefined && dpdv[i - 1] !== undefined)
            d2pdv2[i] = (dpdv[i] - dpdv[i - 1]) / dV;
    }

    // Phase 1: collect all zero-crossings above the noise floor
    const candidates = [];
    for (let i = 2; i < points.length - 1; i++) {
        const a2 = d2pdv2[i], b2 = d2pdv2[i + 1];
        if (a2 === undefined || b2 === undefined || dpdv[i] === undefined) continue;
        const crossesCorrectWay = direction > 0 ? a2 > 0 && b2 < 0 : a2 < 0 && b2 > 0;
        if (!crossesCorrectWay) continue;
        const strength = Math.abs(dpdv[i]);
        if (strength < EP_MIN_THRESHOLD) continue;
        const absA = Math.abs(a2), absB = Math.abs(b2);
        const eqVol = (points[i].volume * absB + points[i + 1].volume * absA) / (absA + absB);
        candidates.push({ volume: eqVol, ph: interpolatePhAt(points, eqVol), strength, crossingIdx: i });
    }

    // Phase 2: non-maximum suppression — strongest candidate wins within each 1 mL window
    candidates.sort((a, b) => b.strength - a.strength);
    const accepted = [];
    for (const c of candidates) {
        if (!accepted.some(ep => Math.abs(ep.volume - c.volume) < EP_NMS_WINDOW_ML))
            accepted.push(c);
    }

    // Phase 3: refine each EP volume by fitting a line through the surrounding d²pH/dV² values
    // and solving for the exact zero crossing.
    accepted.sort((a, b) => a.volume - b.volume);
    return accepted.map(({ volume, ph, crossingIdx }) => {
        const pairs = [];
        for (let k = crossingIdx - 2; k <= crossingIdx + 3; k++) {
            if (k >= 0 && k < points.length && d2pdv2[k] !== undefined)
                pairs.push([points[k].volume, d2pdv2[k]]);
        }
        if (pairs.length >= 2) {
            // Least-squares line: d2 = m·v + b  →  zero at v = −b / m
            const n = pairs.length;
            let sv = 0, sd = 0, svv = 0, svd = 0;
            for (const [v, d] of pairs) { sv += v; sd += d; svv += v * v; svd += v * d; }
            const det = n * svv - sv * sv;
            if (Math.abs(det) > 1e-12) {
                const m = (n * svd - sv * sd) / det;
                const b = (sd - m * sv) / n;
                if (Math.abs(m) > 1e-12) {
                    const refined = -b / m;
                    const vLo = pairs[0][0], vHi = pairs[pairs.length - 1][0];
                    if (refined >= vLo && refined <= vHi) {
                        volume = refined;
                        ph     = interpolatePhAt(points, refined);
                    }
                }
            }
        }
        return { volume, ph };
    });
}

export function populateEpTable(tbody, eps) {
    if (!tbody) return;
    tbody.innerHTML = '';
    for (let i = 0; i < eps.length; i++) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${i + 1}</td>
            <td>${eps[i].volume.toFixed(3)}</td>
            <td>${eps[i].ph != null ? eps[i].ph.toFixed(2) : '—'}</td>`;
        tbody.appendChild(tr);
    }
}
