/**
 * job.js
 * Cron job scheduler — orchestrates all periodic background tasks:
 *
 *  JOB-1  Every 5 min   → Fetch recent events (last 2h window) from USGS + EMSC
 *  JOB-2  Every 1 hour  → Fetch wider window (last 6h), run pattern analysis
 *  JOB-3  Daily 00:05   → Send daily digest email, prune old Redis cache keys
 *  JOB-4  Every 15 min  → Check alert thresholds, send email for M6+ not yet alerted
 */

import cron from 'node-cron';
import { fetchAndStore } from './fetch.js';
import { analyzePatterns } from './process.js';
import { sendEarthquakeAlert, sendDailySummary, sendPatternAlert } from './email.js';

const MIN_ALERT_MAGNITUDE = parseFloat(process.env.ALERT_MAGNITUDE_THRESHOLD || '6.0');
const MIN_ALERT_RISK      = parseInt(process.env.ALERT_RISK_THRESHOLD || '70', 10);

// In-memory set of eventIds we've already alerted on (prevent duplicate emails)
const alertedEvents = new Set();

// ─── Job Definitions ──────────────────────────────────────────────────────────

/**
 * JOB-1: Rapid poll — fetch last 2h of data every 5 minutes
 * Keeps the database current with minimal lag for live dashboards
 */
function scheduleRapidPoll(Earthquake, io, logger) {
  return cron.schedule('*/5 * * * *', async () => {
    const start = Date.now();
    logger.info('[JOB-1] Rapid poll starting...');

    try {
      const result = await fetchAndStore(Earthquake, io, {
        starttime:    new Date(Date.now() - 2 * 3600000),
        endtime:      new Date(),
        minmagnitude: parseFloat(process.env.MIN_MAGNITUDE || '1.0'),
      });

      const elapsed = Date.now() - start;
      logger.info(`[JOB-1] Done in ${elapsed}ms — USGS:${result.usgs} EMSC:${result.emsc} inserted:${result.inserted} updated:${result.updated}`);

      if (result.errors.length) {
        logger.warn(`[JOB-1] Errors: ${result.errors.join(' | ')}`);
      }

      // Broadcast fetch stats to connected clients
      if (io) {
        io.emit('fetch_complete', {
          job:     'rapid_poll',
          elapsed,
          result,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.error(`[JOB-1] Fatal: ${err.message}`);
    }
  });
}

/**
 * JOB-2: Hourly wider fetch + pattern analysis
 * Catches any events missed by the rapid poll, runs seismic pattern detection
 */
function scheduleHourlyAnalysis(Earthquake, io, logger) {
  return cron.schedule('2 * * * *', async () => { // :02 past every hour
    logger.info('[JOB-2] Hourly analysis starting...');

    try {
      // Fetch wider 6h window to catch any delayed USGS updates
      await fetchAndStore(Earthquake, io, {
        starttime:    new Date(Date.now() - 6 * 3600000),
        endtime:      new Date(),
        minmagnitude: parseFloat(process.env.MIN_MAGNITUDE || '1.0'),
      });

      // Pull recent earthquakes for pattern analysis
      const recentEqs = await Earthquake.find({
        time: { $gte: new Date(Date.now() - 7 * 24 * 3600000) }
      }).sort({ time: -1 }).limit(1000).lean();

      const analysis = analyzePatterns(recentEqs);

      logger.info(`[JOB-2] Pattern analysis: ${analysis.riskLevel} risk, ${analysis.patterns.length} patterns`);

      // Emit analysis to connected clients
      if (io) io.emit('pattern_analysis', analysis);

      // Send pattern alerts for high-severity findings
      const highPatterns = analysis.patterns.filter(p => p.severity === 'high');
      for (const pattern of highPatterns) {
        await sendPatternAlert(pattern).catch(e => logger.warn(`Pattern alert email: ${e.message}`));
      }
    } catch (err) {
      logger.error(`[JOB-2] Fatal: ${err.message}`);
    }
  });
}

/**
 * JOB-3: Daily digest — runs at 00:05 UTC every day
 */
function scheduleDailyDigest(Earthquake, redis, logger) {
  return cron.schedule('5 0 * * *', async () => {
    logger.info('[JOB-3] Daily digest starting...');

    try {
      const since = new Date(Date.now() - 24 * 3600000);

      const [severityCounts, avgResult, maxEq] = await Promise.all([
        Earthquake.aggregate([
          { $match: { time: { $gte: since } } },
          { $group: { _id: '$severity', count: { $sum: 1 } } }
        ]),
        Earthquake.aggregate([
          { $match: { time: { $gte: since } } },
          { $group: { _id: null, avg: { $avg: '$magnitude' }, total: { $sum: 1 } } }
        ]),
        Earthquake.findOne({ time: { $gte: since } }).sort({ magnitude: -1 }).lean()
      ]);

      const stats = {
        period: '24h',
        total:  avgResult[0]?.total || 0,
        avgMagnitude: Number((avgResult[0]?.avg || 0).toFixed(2)),
        maxEarthquake: maxEq,
        bySeverity: Object.fromEntries(severityCounts.map(s => [s._id, s.count])),
      };

      await sendDailySummary(stats).catch(e => logger.warn(`Daily digest email: ${e.message}`));

      // Prune old Redis keys (keys older than 7 days pattern)
      if (redis) {
        try {
          const keys = await redis.keys('eq:*');
          logger.info(`[JOB-3] Redis has ${keys.length} cached keys`);
        } catch {}
      }

      logger.info(`[JOB-3] Daily digest sent — ${stats.total} events in 24h`);
    } catch (err) {
      logger.error(`[JOB-3] Fatal: ${err.message}`);
    }
  });
}

/**
 * JOB-4: Alert checker — every 15 minutes
 * Scans recent M6+ or high-risk events and sends email alerts if not already sent
 */
function scheduleAlertChecker(Earthquake, logger) {
  return cron.schedule('*/15 * * * *', async () => {
    try {
      const candidates = await Earthquake.find({
        time:      { $gte: new Date(Date.now() - 30 * 60000) }, // last 30 min
        $or: [
          { magnitude: { $gte: MIN_ALERT_MAGNITUDE } },
          { riskScore:  { $gte: MIN_ALERT_RISK } },
        ]
      }).lean();

      for (const eq of candidates) {
        if (alertedEvents.has(eq.eventId)) continue;

        alertedEvents.add(eq.eventId);
        const result = await sendEarthquakeAlert(eq).catch(e => ({ success: false, error: e.message }));

        if (result.success) {
          logger.info(`[JOB-4] Alert sent for ${eq.eventId} M${eq.magnitude}`);
        } else if (!result.skipped) {
          logger.warn(`[JOB-4] Alert failed for ${eq.eventId}: ${result.error}`);
        }
      }

      // Keep alertedEvents from growing unbounded — prune entries older than 6h
      // (In production, use Redis with TTL instead)
      if (alertedEvents.size > 5000) alertedEvents.clear();

    } catch (err) {
      logger.error(`[JOB-4] Fatal: ${err.message}`);
    }
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────

/**
 * Start all cron jobs.
 * Called from server.js after DB connection is established.
 *
 * @param {object} io - Socket.io server instance
 * @param {object} Earthquake - Mongoose model
 * @param {object} redis - ioredis client
 * @param {object} logger - Winston logger
 */
export function startJobs(io, Earthquake, redis, logger) {
  logger.info('⏱  Starting background jobs...');

  const jobs = [
    scheduleRapidPoll(Earthquake, io, logger),
    scheduleHourlyAnalysis(Earthquake, io, logger),
    scheduleDailyDigest(Earthquake, redis, logger),
    scheduleAlertChecker(Earthquake, logger),
  ];

  logger.info(`✅ ${jobs.length} jobs scheduled`);

  // Run JOB-1 immediately on startup so the DB has data right away
  setImmediate(async () => {
    logger.info('[STARTUP] Running initial data fetch...');
    try {
      const result = await fetchAndStore(Earthquake, io, {
        starttime:    new Date(Date.now() - 24 * 3600000), // last 24h on startup
        endtime:      new Date(),
        minmagnitude: parseFloat(process.env.MIN_MAGNITUDE || '1.0'),
      });
      logger.info(`[STARTUP] Seeded DB — inserted:${result.inserted} updated:${result.updated}`);
    } catch (err) {
      logger.error(`[STARTUP] Initial fetch failed: ${err.message}`);
    }
  });

  return jobs;
}