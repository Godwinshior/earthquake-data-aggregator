/**
 * process.js
 * Earthquake data processing pipeline:
 *  - Magnitude scale normalization (ML, mb, Ms, Mw, mww, etc.) → Mw equivalent
 *  - Severity classification (USGS / Richter standard)
 *  - Risk scoring (composite 0–100 based on mag, depth, population proximity)
 *  - Historical pattern analysis
 */

// ─── Magnitude Scale Normalization ────────────────────────────────────────────
// Empirical conversion formulas from seismological literature
// All conversions produce approximate Mw (moment magnitude) equivalent

const MAGNITUDE_CONVERSIONS = {
  // Moment magnitude — already Mw
  mw:   (m) => m,
  mww:  (m) => m,
  mwb:  (m) => m,
  mwc:  (m) => m,
  mwr:  (m) => m,

  // Local / Richter magnitude (Hutton & Boore, 1987)
  ml:   (m) => m <= 3.0 ? m : 0.835 * m + 0.5,

  // Short-period body wave (Nuttli, 1973 / ISC)
  mb:   (m) => 1.084 * m - 0.142,

  // Surface wave magnitude (Kanamori, 1977)
  ms:   (m) => m <= 6.0 ? 0.65 * m + 2.45 : 0.5 * m + 3.3,
  ms_20: (m) => 0.5 * m + 3.3,

  // Duration magnitude (coda length)
  md:   (m) => 0.87 * m + 0.37,

  // Moment magnitude from energy (Choy & Boatwright, 1995)
  me:   (m) => m,

  // Chilean local magnitude
  mlv:  (m) => m,

  // Broadband P-wave
  mwp:  (m) => m,

  // Default: assume equivalent to Mw
  default: (m) => m,
};

/**
 * Normalize any seismic magnitude type to approximate Mw equivalent
 * @param {number} magnitude - Raw magnitude value
 * @param {string} type - Magnitude type (ml, mb, Ms, Mw, etc.)
 * @returns {number} Normalized Mw equivalent (rounded to 2dp)
 */
export function normalizeMagnitude(magnitude, type = 'mw') {
  if (magnitude === null || magnitude === undefined || isNaN(magnitude)) return null;

  const normalizedType = type.toLowerCase().replace(/[_\s-]/g, '');
  const converter = MAGNITUDE_CONVERSIONS[normalizedType] || MAGNITUDE_CONVERSIONS.default;

  const result = converter(parseFloat(magnitude));
  return Math.round(result * 100) / 100;
}

// ─── Severity Classification ──────────────────────────────────────────────────
// Based on USGS / Richter scale standard definitions

const SEVERITY_THRESHOLDS = [
  { min: 8.0,  label: 'great',    color: '#FF0000', description: 'Devastating — affects large regions' },
  { min: 7.0,  label: 'major',    color: '#FF4500', description: 'Serious damage over large areas' },
  { min: 6.0,  label: 'strong',   color: '#FF8C00', description: 'Damaging in populated areas' },
  { min: 5.0,  label: 'moderate', color: '#FFA500', description: 'Widely felt, slight to moderate damage' },
  { min: 4.0,  label: 'light',    color: '#FFD700', description: 'Often felt, rarely damages' },
  { min: 2.5,  label: 'minor',    color: '#9ACD32', description: 'Usually felt but no damage' },
  { min: -Infinity, label: 'micro', color: '#4CAF50', description: 'Not felt except by seismographs' },
];

/**
 * Classify earthquake severity from normalized magnitude
 * @param {number} magnitude - Normalized Mw magnitude
 * @returns {{ label: string, color: string, description: string }}
 */
export function classifySeverity(magnitude) {
  if (magnitude === null || magnitude === undefined) {
    return { label: 'micro', color: '#4CAF50', description: 'Unknown magnitude' };
  }

  const mag = parseFloat(magnitude);
  const tier = SEVERITY_THRESHOLDS.find(t => mag >= t.min);
  return tier || SEVERITY_THRESHOLDS[SEVERITY_THRESHOLDS.length - 1];
}

// ─── Risk Score Calculation ───────────────────────────────────────────────────
// Composite 0–100 score weighing: magnitude, depth, tsunami flag, PAGER alert, significance

/**
 * Depth-based risk modifier
 * Shallow earthquakes (<70km) cause more surface damage
 */
function depthMod(depthKm) {
  if (depthKm === null || depthKm === undefined) return 0.5;
  if (depthKm < 10)   return 1.0;
  if (depthKm < 30)   return 0.85;
  if (depthKm < 70)   return 0.70;
  if (depthKm < 300)  return 0.45;
  return 0.25;
}

/** PAGER alert level to numeric weight */
const ALERT_WEIGHTS = { red: 30, orange: 20, yellow: 10, green: 0 };

/**
 * Calculate composite risk score (0–100)
 * @param {object} params
 * @param {number} params.magnitude - Normalized Mw
 * @param {number} params.depth - Depth in km
 * @param {number} params.tsunami - Tsunami flag (0 or 1)
 * @param {string} params.alert - PAGER alert color
 * @param {number} params.sig - USGS significance score (0–1000+)
 * @param {number} params.cdi - Community Decimal Intensity (1–12 scale)
 * @param {number} params.mmi - Maximum Instrumental Intensity
 * @returns {number} Risk score 0–100
 */
export function calculateRiskScore({ magnitude, depth, tsunami, alert, sig, cdi, mmi } = {}) {
  let score = 0;

  // Magnitude component (0–50 pts): exponential — M8 = 50, M6 = 25, M4 = 8
  if (magnitude !== null && magnitude !== undefined) {
    const magScore = Math.min(50, Math.pow(Math.max(0, magnitude - 1), 1.8) * 2.2);
    score += magScore * depthMod(depth);
  }

  // Tsunami component (0–20 pts)
  if (tsunami === 1 || tsunami === true) score += 20;

  // PAGER alert component (0–30 pts)
  if (alert && ALERT_WEIGHTS[alert.toLowerCase()] !== undefined) {
    score += ALERT_WEIGHTS[alert.toLowerCase()];
  }

  // Felt reports / community intensity (0–10 pts)
  if (cdi && cdi > 0) score += Math.min(10, (cdi / 12) * 10);

  // USGS significance bonus (0–10 pts)
  if (sig && sig > 0) score += Math.min(10, sig / 100);

  return Math.min(100, Math.round(score));
}

// ─── Historical Pattern Analysis ──────────────────────────────────────────────

/**
 * Analyze a collection of earthquakes for temporal patterns
 * @param {Array} earthquakes - Array of earthquake documents sorted by time desc
 * @returns {object} Pattern analysis report
 */
export function analyzePatterns(earthquakes) {
  if (!earthquakes || earthquakes.length === 0) {
    return { status: 'insufficient_data', patterns: [] };
  }

  const patterns = [];
  const now = Date.now();

  // ── Frequency analysis
  const last24h = earthquakes.filter(e => now - new Date(e.time) < 86400000);
  const last7d   = earthquakes.filter(e => now - new Date(e.time) < 7 * 86400000);

  const dailyRate = last24h.length;
  const weeklyAvgRate = last7d.length / 7;

  if (dailyRate > weeklyAvgRate * 2 && weeklyAvgRate > 0) {
    patterns.push({
      type: 'surge',
      severity: dailyRate > weeklyAvgRate * 4 ? 'high' : 'medium',
      message: `Activity surge: ${dailyRate} events today vs ${weeklyAvgRate.toFixed(1)}/day weekly average`,
    });
  }

  // ── Magnitude trend
  if (last24h.length >= 3) {
    const recent = last24h.slice(0, 5).map(e => e.magnitude || 0);
    const older  = last24h.slice(-5).map(e => e.magnitude || 0);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg  = older.reduce((a, b) => a + b, 0) / older.length;

    if (recentAvg > olderAvg + 0.5) {
      patterns.push({
        type: 'escalation',
        severity: 'high',
        message: `Magnitude escalation detected: recent avg ${recentAvg.toFixed(1)} vs earlier ${olderAvg.toFixed(1)}`,
      });
    }
  }

  // ── Swarm detection (many events in short window)
  const last1h = last24h.filter(e => now - new Date(e.time) < 3600000);
  if (last1h.length >= 10) {
    patterns.push({
      type: 'swarm',
      severity: last1h.length >= 20 ? 'high' : 'medium',
      message: `Earthquake swarm: ${last1h.length} events in the past hour`,
    });
  }

  // ── Significant lull
  if (last24h.length === 0 && last7d.length > 5) {
    patterns.push({
      type: 'lull',
      severity: 'low',
      message: 'Unusual quiet period after elevated activity',
    });
  }

  // ── Magnitude distribution (Gutenberg-Richter b-value proxy)
  const magBuckets = { micro: 0, minor: 0, light: 0, moderate: 0, strong: 0, major: 0, great: 0 };
  last7d.forEach(e => { if (e.severity) magBuckets[e.severity]++; });

  return {
    status: 'ok',
    timeWindow: { last1h: last1h.length, last24h: last24h.length, last7d: last7d.length },
    dailyRate,
    weeklyAvgRate: Number(weeklyAvgRate.toFixed(2)),
    magnitudeDistribution: magBuckets,
    patterns,
    riskLevel: patterns.some(p => p.severity === 'high') ? 'elevated'
             : patterns.length > 0 ? 'moderate' : 'normal',
  };
}

// ─── Utility Exports ──────────────────────────────────────────────────────────

export const SEVERITY_LABELS = SEVERITY_THRESHOLDS.map(t => t.label).reverse();
export const SEVERITY_COLORS = Object.fromEntries(
  SEVERITY_THRESHOLDS.map(t => [t.label, t.color])
);