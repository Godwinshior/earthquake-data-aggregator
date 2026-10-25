/**
 * server.js
 * Main application entry point.
 *  - Express REST API with full CRUD + analytics endpoints
 *  - Socket.io for real-time earthquake broadcasts
 *  - MongoDB via Mongoose (earthquake storage + geospatial queries)
 *  - Redis for API response caching
 *  - Winston structured logging
 */

import express        from 'express';
import { createServer } from 'http';
import { Server }     from 'socket.io';
import mongoose       from 'mongoose';
import cors           from 'cors';
import helmet         from 'helmet';
import rateLimit      from 'express-rate-limit';
import Redis          from 'ioredis';
import { createLogger, format, transports } from 'winston';
import dotenv         from 'dotenv';

import { startJobs }  from './job.js';

dotenv.config();

// ─── Logger ───────────────────────────────────────────────────────────────────

export const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.colorize(),
    format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' }),
  ],
});

// ─── Mongoose Schema & Model ──────────────────────────────────────────────────

const earthquakeSchema = new mongoose.Schema({
  eventId:       { type: String, unique: true, required: true, index: true },
  source:        { type: String, enum: ['USGS', 'EMSC'], required: true },
  time:          { type: Date, required: true, index: true },
  updatedAt:     Date,
  place:         String,
  location: {
    type:        { type: String, default: 'Point' },
    coordinates: { type: [Number], index: '2dsphere' }, // [lng, lat]
  },
  depth:         Number,        // km
  magnitude:     Number,        // normalized Mw equivalent
  magnitudeRaw:  Number,        // original reported magnitude
  magnitudeType: String,        // ML, mb, Mw, Ms, mww, etc.
  severity: {
    type:  String,
    enum:  ['micro', 'minor', 'light', 'moderate', 'strong', 'major', 'great'],
    index: true,
  },
  riskScore:  { type: Number, min: 0, max: 100 },
  felt:       Number,
  cdi:        Number,           // Community Decimal Intensity
  mmi:        Number,           // Max Instrumental Intensity
  alert:      String,           // PAGER: green, yellow, orange, red
  tsunami:    Number,           // 0 | 1
  sig:        Number,           // USGS significance (0–1000+)
  url:        String,
  rawData:    mongoose.Schema.Types.Mixed,
}, {
  timestamps: true,
  toJSON: { virtuals: true },
});

// Compound indexes for common query patterns
earthquakeSchema.index({ time: -1, magnitude: -1 });
earthquakeSchema.index({ time: -1, severity: 1 });
earthquakeSchema.index({ riskScore: -1, time: -1 });

export const Earthquake = mongoose.model('Earthquake', earthquakeSchema);

// ─── Redis ────────────────────────────────────────────────────────────────────

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy:   (times) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
  lazyConnect:     true,
  enableOfflineQueue: false,
});

redis.on('connect', () => logger.info('✅ Redis connected'));
redis.on('error',   (e) => logger.warn(`⚠️  Redis: ${e.message}`));

/** Cache helper — returns cached JSON or executes fn() and caches result */
async function cached(key, ttlSeconds, fn) {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch {}

  const data = await fn();
  try { await redis.setex(key, ttlSeconds, JSON.stringify(data)); } catch {}
  return data;
}

// ─── Express + Socket.io ──────────────────────────────────────────────────────

const app        = express();
const httpServer = createServer(app);

export const io = new Server(httpServer, {
  cors: {
    origin:  process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// Rate limiting
app.use('/api/', rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please try again later.' },
}));

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * System health check — returns DB, Redis, uptime status
 */
app.get('/api/health', async (req, res) => {
  const mongoState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  let redisOk = false;

  try { await redis.ping(); redisOk = true; } catch {}

  res.json({
    status:    'ok',
    mongo:     mongoState[mongoose.connection.readyState] || 'unknown',
    redis:     redisOk ? 'connected' : 'unavailable',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
    version:   '1.0.0',
  });
});

/**
 * GET /api/earthquakes
 * Query params:
 *   minMag      (default 0)
 *   maxMag      (default 10)
 *   severity    (micro|minor|light|moderate|strong|major|great)
 *   hours       (default 24, max 720)
 *   limit       (default 50, max 500)
 *   page        (default 1)
 *   lat,lng,radius  (km) — geospatial filter
 *   sortBy      (time|magnitude|riskScore|depth)
 *   order       (asc|desc)
 *   source      (USGS|EMSC)
 *   tsunami     (1 to filter tsunami events only)
 */
app.get('/api/earthquakes', async (req, res) => {
  try {
    const {
      minMag = 0, maxMag = 10,
      severity, hours = 24,
      limit = 50, page = 1,
      lat, lng, radius,
      sortBy = 'time', order = 'desc',
      source, tsunami,
    } = req.query;

    const safeHours  = Math.min(Number(hours), 720);
    const safeLimit  = Math.min(Number(limit), 500);
    const safePage   = Math.max(1, Number(page));

    const query = {
      time:      { $gte: new Date(Date.now() - safeHours * 3600000) },
      magnitude: { $gte: Number(minMag), $lte: Number(maxMag) },
    };

    if (severity) query.severity = { $in: Array.isArray(severity) ? severity : severity.split(',') };
    if (source)   query.source   = source.toUpperCase();
    if (tsunami === '1') query.tsunami = 1;

    if (lat && lng && radius) {
      query.location = {
        $nearSphere: {
          $geometry:   { type: 'Point', coordinates: [Number(lng), Number(lat)] },
          $maxDistance: Number(radius) * 1000,
        },
      };
    }

    const allowedSort = ['time', 'magnitude', 'riskScore', 'depth', 'felt'];
    const sortField   = allowedSort.includes(sortBy) ? sortBy : 'time';
    const sort        = { [sortField]: order === 'asc' ? 1 : -1 };
    const cacheKey    = `eq:list:${JSON.stringify({ ...req.query, p: safePage })}`;

    const data = await cached(cacheKey, 60, async () => {
      const skip = (safePage - 1) * safeLimit;
      const [earthquakes, total] = await Promise.all([
        Earthquake.find(query).sort(sort).skip(skip).limit(safeLimit).lean(),
        Earthquake.countDocuments(query),
      ]);
      return { earthquakes, total, page: safePage, pages: Math.ceil(total / safeLimit), limit: safeLimit };
    });

    res.json({ success: true, ...data });
  } catch (err) {
    logger.error(`GET /api/earthquakes: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/earthquakes/:eventId
 * Single earthquake by USGS/EMSC event ID
 */
app.get('/api/earthquakes/:eventId', async (req, res) => {
  try {
    const eq = await Earthquake.findOne({ eventId: req.params.eventId }).lean();
    if (!eq) return res.status(404).json({ success: false, error: 'Earthquake not found' });
    res.json({ success: true, earthquake: eq });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/stats
 * Aggregated statistics for a time window
 * Query: hours (default 24)
 */
app.get('/api/stats', async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours || 24), 720);
    const since = new Date(Date.now() - hours * 3600000);

    const data = await cached(`eq:stats:${hours}`, 90, async () => {
      const [severityCounts, sourceCounts, aggResult, maxEq, hourlyDist, recentSig] = await Promise.all([
        Earthquake.aggregate([
          { $match: { time: { $gte: since } } },
          { $group: { _id: '$severity', count: { $sum: 1 } } },
        ]),
        Earthquake.aggregate([
          { $match: { time: { $gte: since } } },
          { $group: { _id: '$source', count: { $sum: 1 } } },
        ]),
        Earthquake.aggregate([
          { $match: { time: { $gte: since } } },
          { $group: { _id: null, avg: { $avg: '$magnitude' }, max: { $max: '$magnitude' }, total: { $sum: 1 } } },
        ]),
        Earthquake.findOne({ time: { $gte: since } }).sort({ magnitude: -1 }).lean(),
        Earthquake.aggregate([
          { $match: { time: { $gte: since } } },
          { $group: {
              _id:    { $hour: '$time' },
              count:  { $sum: 1 },
              avgMag: { $avg: '$magnitude' },
          }},
          { $sort: { _id: 1 } },
        ]),
        Earthquake.find({ time: { $gte: since }, magnitude: { $gte: 5.0 } })
          .sort({ time: -1 }).limit(10).lean(),
      ]);

      return {
        period:       `${hours}h`,
        total:        aggResult[0]?.total || 0,
        avgMagnitude: Number((aggResult[0]?.avg || 0).toFixed(2)),
        maxMagnitude: Number((aggResult[0]?.max || 0).toFixed(2)),
        maxEarthquake: maxEq,
        bySeverity:   Object.fromEntries(severityCounts.map(s => [s._id, s.count])),
        bySource:     Object.fromEntries(sourceCounts.map(s => [s._id, s.count])),
        hourlyDistribution: hourlyDist,
        recentSignificant:  recentSig,
      };
    });

    res.json({ success: true, stats: data });
  } catch (err) {
    logger.error(`GET /api/stats: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/heatmap
 * Lightweight coordinate list for map visualization
 * Query: hours, minMag
 */
app.get('/api/heatmap', async (req, res) => {
  try {
    const { hours = 168, minMag = 1.0 } = req.query;
    const since = new Date(Date.now() - Number(hours) * 3600000);

    const points = await cached(`eq:heatmap:${hours}:${minMag}`, 180, async () =>
      Earthquake.find(
        { time: { $gte: since }, magnitude: { $gte: Number(minMag) } },
        { 'location.coordinates': 1, magnitude: 1, severity: 1, place: 1, time: 1, _id: 0 }
      ).lean()
    );

    res.json({ success: true, count: points.length, points });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/magnitude-distribution
 * Histogram data for Gutenberg-Richter analysis
 */
app.get('/api/magnitude-distribution', async (req, res) => {
  try {
    const hours = Number(req.query.hours || 168);
    const since = new Date(Date.now() - hours * 3600000);

    const data = await cached(`eq:magdist:${hours}`, 300, async () => {
      const buckets = await Earthquake.aggregate([
        { $match: { time: { $gte: since } } },
        { $bucket: {
            groupBy:    '$magnitude',
            boundaries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10],
            default:    'other',
            output: { count: { $sum: 1 }, avgDepth: { $avg: '$depth' } },
        }},
      ]);
      return buckets;
    });

    res.json({ success: true, distribution: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/recent?limit=10
 * Most recent earthquakes (bypasses cache for freshness)
 */
app.get('/api/recent', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 100);
    const earthquakes = await Earthquake.find({})
      .sort({ time: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, earthquakes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/significant?days=30&minMag=6.0
 * Historical significant events
 */
app.get('/api/significant', async (req, res) => {
  try {
    const { days = 30, minMag = 6.0 } = req.query;
    const since = new Date(Date.now() - Number(days) * 86400000);

    const data = await cached(`eq:sig:${days}:${minMag}`, 600, async () =>
      Earthquake.find({ time: { $gte: since }, magnitude: { $gte: Number(minMag) } })
        .sort({ magnitude: -1 })
        .limit(50)
        .lean()
    );

    res.json({ success: true, earthquakes: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Socket.io Event Handlers ─────────────────────────────────────────────────

io.on('connection', (socket) => {
  logger.debug(`Socket connected: ${socket.id}`);

  socket.emit('welcome', {
    message:   'Connected to Earthquake Data Aggregator',
    timestamp: new Date().toISOString(),
  });

  // Client can subscribe with magnitude filter preference
  socket.on('subscribe', ({ minMagnitude = 0 } = {}) => {
    socket.data.minMagnitude = minMagnitude;
    socket.join(`mag_${Math.floor(minMagnitude)}`);
    socket.emit('subscribed', { minMagnitude });
  });

  socket.on('disconnect', (reason) => {
    logger.debug(`Socket disconnected: ${socket.id} (${reason})`);
  });
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  // MongoDB
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/earthquake_db', {
    serverSelectionTimeoutMS: 5000,
  });
  logger.info('✅ MongoDB connected');

  // Redis (non-fatal if unavailable)
  try {
    await redis.connect();
  } catch (err) {
    logger.warn(`⚠️  Redis unavailable — running without cache: ${err.message}`);
  }

  // Start background jobs
  startJobs(io, Earthquake, redis, logger);

  // Start HTTP server
  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    logger.info(`🌍 Server ready → http://localhost:${PORT}`);
    logger.info(`📡 Socket.io  → ws://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  logger.error(`Bootstrap failed: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await mongoose.disconnect();
  redis.disconnect();
  process.exit(0);
});