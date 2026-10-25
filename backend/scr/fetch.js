/**
 * fetch.js
 * Fetches earthquake data from:
 *  - USGS FDSN Event API (primary, global)
 *  - EMSC SeismicPortal API (secondary, European/Mediterranean focus)
 * Normalizes to a unified schema and upserts into MongoDB.
 */

import axios from 'axios';
import { normalizeMagnitude, classifySeverity, calculateRiskScore } from './process.js';

const USGS_BASE  = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const EMSC_BASE  = 'https://www.seismicportal.eu/fdsnws/event/1/query';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'EarthquakeDataAggregator/1.0 (research)' },
});

// ─── USGS Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch events from USGS FDSN API
 * @param {object} opts
 * @param {Date}   opts.starttime
 * @param {Date}   opts.endtime
 * @param {number} opts.minmagnitude
 * @param {number} opts.limit
 * @returns {Array} Raw USGS GeoJSON features
 */
export async function fetchUSGS({
  starttime = new Date(Date.now() - 2 * 3600000),
  endtime   = new Date(),
  minmagnitude = parseFloat(process.env.MIN_MAGNITUDE || '1.0'),
  limit = 500,
} = {}) {
  const params = {
    format: 'geojson',
    starttime: starttime.toISOString(),
    endtime:   endtime.toISOString(),
    minmagnitude,
    limit,
    orderby: 'time',
  };

  const { data } = await http.get(USGS_BASE, { params });
  return data.features || [];
}

/**
 * Normalize a USGS GeoJSON feature to our unified schema
 */
export function normalizeUSGS(feature) {
  const p = feature.properties;
  const [lng, lat, depth] = feature.geometry?.coordinates || [];

  const magnitudeRaw = p.mag;
  const magnitudeType = p.magType || 'mw';
  const magnitude = normalizeMagnitude(magnitudeRaw, magnitudeType);
  const severityInfo = classifySeverity(magnitude);
  const riskScore = calculateRiskScore({
    magnitude,
    depth,
    tsunami: p.tsunami,
    alert:   p.alert,
    sig:     p.sig,
    cdi:     p.cdi,
    mmi:     p.mmi,
  });

  return {
    eventId:       feature.id,
    source:        'USGS',
    time:          new Date(p.time),
    updatedAt:     p.updated ? new Date(p.updated) : null,
    place:         p.place,
    location: {
      type:        'Point',
      coordinates: [lng, lat],
    },
    depth:         typeof depth === 'number' ? depth : null,
    magnitude,
    magnitudeRaw,
    magnitudeType,
    severity:      severityInfo.label,
    riskScore,
    felt:          p.felt || 0,
    cdi:           p.cdi  || null,
    mmi:           p.mmi  || null,
    alert:         p.alert || null,
    tsunami:       p.tsunami || 0,
    sig:           p.sig  || 0,
    url:           p.url  || null,
    rawData:       p,
  };
}

// ─── EMSC Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch events from EMSC SeismicPortal API
 */
export async function fetchEMSC({
  starttime = new Date(Date.now() - 2 * 3600000),
  endtime   = new Date(),
  minmagnitude = parseFloat(process.env.MIN_MAGNITUDE || '1.0'),
  limit = 200,
} = {}) {
  const params = {
    format: 'json',
    starttime: starttime.toISOString(),
    endtime:   endtime.toISOString(),
    minmagnitude,
    limit,
    orderby: 'time',
  };

  const { data } = await http.get(EMSC_BASE, { params });
  // EMSC returns standard FDSN GeoJSON
  return (data.features || []);
}

/**
 * Normalize an EMSC GeoJSON feature to unified schema
 * EMSC uses slightly different property names
 */
export function normalizeEMSC(feature) {
  const p = feature.properties;
  const [lng, lat, depth] = feature.geometry?.coordinates || [];

  // EMSC uses 'mag' and 'magtype'
  const magnitudeRaw = p.mag ?? p.magnitude;
  const magnitudeType = p.magtype || p.magnitudeType || 'mw';
  const magnitude = normalizeMagnitude(magnitudeRaw, magnitudeType);
  const severityInfo = classifySeverity(magnitude);
  const riskScore = calculateRiskScore({ magnitude, depth, tsunami: 0, sig: 0 });

  // Build a stable eventId from EMSC data (they use 'unid' or 'source_id')
  const eventId = `emsc-${p.unid || p.source_id || feature.id}`;

  return {
    eventId,
    source:        'EMSC',
    time:          new Date(p.time),
    updatedAt:     p.lastupdate ? new Date(p.lastupdate) : null,
    place:         p.flynn_region || p.region || 'Unknown',
    location: {
      type:        'Point',
      coordinates: [lng, lat],
    },
    depth:         typeof depth === 'number' ? depth : null,
    magnitude,
    magnitudeRaw,
    magnitudeType,
    severity:      severityInfo.label,
    riskScore,
    felt:          0,
    cdi:           null,
    mmi:           null,
    alert:         null,
    tsunami:       0,
    sig:           0,
    url:           null,
    rawData:       p,
  };
}

// ─── Main Aggregation Function ────────────────────────────────────────────────

/**
 * Fetch from both APIs, normalize, deduplicate, and upsert into MongoDB.
 * Returns summary of what was inserted/updated.
 *
 * @param {object} Earthquake - Mongoose model (passed to avoid circular imports)
 * @param {object} io - Socket.io server instance for real-time broadcasting
 * @param {object} opts - Fetch options (starttime, endtime, minmagnitude)
 */
export async function fetchAndStore(Earthquake, io, opts = {}) {
  const results = { usgs: 0, emsc: 0, inserted: 0, updated: 0, errors: [] };
  const newEvents = [];

  // ── Fetch from both APIs concurrently
  const [usgsResult, emscResult] = await Promise.allSettled([
    fetchUSGS(opts),
    fetchEMSC(opts),
  ]);

  const usgsFeatures = usgsResult.status === 'fulfilled'
    ? usgsResult.value : (results.errors.push(`USGS: ${usgsResult.reason?.message}`), []);

  const emscFeatures = emscResult.status === 'fulfilled'
    ? emscResult.value : (results.errors.push(`EMSC: ${emscResult.reason?.message}`), []);

  results.usgs = usgsFeatures.length;
  results.emsc = emscFeatures.length;

  // ── Normalize
  const normalized = [
    ...usgsFeatures.map(f => { try { return normalizeUSGS(f); } catch { return null; } }),
    ...emscFeatures.map(f => { try { return normalizeEMSC(f); } catch { return null; } }),
  ].filter(Boolean);

  // ── Upsert each event (deduplicate by eventId)
  for (const event of normalized) {
    try {
      const existing = await Earthquake.findOne({ eventId: event.eventId });

      if (!existing) {
        await Earthquake.create(event);
        results.inserted++;
        newEvents.push(event);
      } else {
        // Only update if the source reports a newer timestamp
        const sourceUpdated = event.updatedAt || event.time;
        const dbUpdated     = existing.updatedAt || existing.time;

        if (sourceUpdated > dbUpdated) {
          await Earthquake.updateOne({ eventId: event.eventId }, { $set: event });
          results.updated++;
        }
      }
    } catch (err) {
      if (err.code !== 11000) { // ignore duplicate key race conditions
        results.errors.push(`Store ${event.eventId}: ${err.message}`);
      }
    }
  }

  // ── Broadcast new significant events via Socket.io
  if (io && newEvents.length > 0) {
    const significant = newEvents.filter(e => e.magnitude >= 4.0);
    if (significant.length > 0) {
      io.emit('new_earthquakes', { count: significant.length, events: significant });
    }

    // Broadcast any M6+ as priority alerts
    const major = newEvents.filter(e => e.magnitude >= 6.0);
    major.forEach(e => io.emit('major_alert', e));
  }

  return results;
}

// ─── Historical Backfill ──────────────────────────────────────────────────────

/**
 * Backfill historical data for a given time range.
 * Useful for initial database population.
 * Splits large windows into 24h chunks to avoid API limits.
 *
 * @param {object} Earthquake - Mongoose model
 * @param {Date}   starttime
 * @param {Date}   endtime
 * @param {number} minmagnitude
 */
export async function backfill(Earthquake, starttime, endtime, minmagnitude = 2.5) {
  const CHUNK_MS = 24 * 3600000; // 24h chunks
  let cursor = new Date(starttime);
  const summary = { chunks: 0, inserted: 0, errors: [] };

  while (cursor < endtime) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_MS, endtime.getTime()));

    try {
      const res = await fetchAndStore(Earthquake, null, {
        starttime: cursor,
        endtime:   chunkEnd,
        minmagnitude,
      });
      summary.inserted += res.inserted;
      summary.chunks++;
    } catch (err) {
      summary.errors.push(`Chunk ${cursor.toISOString()}: ${err.message}`);
    }

    // Rate-limit: wait 500ms between chunks
    await new Promise(r => setTimeout(r, 500));
    cursor = chunkEnd;
  }

  return summary;
}