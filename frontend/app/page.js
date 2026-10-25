'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Severity Config ──────────────────────────────────────────────────────────
const SEV = {
  micro:    { color: '#22c55e', bg: '#052e16', label: 'Micro',    ring: '#16a34a' },
  minor:    { color: '#84cc16', bg: '#1a2e05', label: 'Minor',    ring: '#65a30d' },
  light:    { color: '#eab308', bg: '#2d2008', label: 'Light',    ring: '#ca8a04' },
  moderate: { color: '#f97316', bg: '#2d1500', label: 'Moderate', ring: '#ea580c' },
  strong:   { color: '#ef4444', bg: '#2d0a0a', label: 'Strong',   ring: '#dc2626' },
  major:    { color: '#f87171', bg: '#1c0505', label: 'Major',    ring: '#b91c1c' },
  great:    { color: '#fca5a5', bg: '#130303', label: 'Great',    ring: '#991b1b' },
};

const MAG_COLOR = (m) => {
  if (m >= 8)   return '#fca5a5';
  if (m >= 7)   return '#f87171';
  if (m >= 6)   return '#ef4444';
  if (m >= 5)   return '#f97316';
  if (m >= 4)   return '#eab308';
  if (m >= 2.5) return '#84cc16';
  return '#22c55e';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const timeAgo = (dateStr) => {
  const diff = Date.now() - new Date(dateStr);
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}d ago`;
  if (h > 0)  return `${h}h ago`;
  if (m > 0)  return `${m}m ago`;
  return 'just now';
};

const fmtCoords = (coords) => {
  if (!coords?.length) return '—';
  const [lng, lat] = coords;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function LiveDot({ connected }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: connected ? '#22c55e' : '#ef4444',
        display: 'inline-block',
        boxShadow: connected ? '0 0 0 0 #22c55e' : 'none',
        animation: connected ? 'pulseDot 1.5s ease-out infinite' : 'none',
      }} />
      <style>{`@keyframes pulseDot {
        0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
        70% { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
        100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
      }`}</style>
      <span style={{ fontSize: 11, color: connected ? '#22c55e' : '#ef4444', fontFamily: 'Space Mono,monospace', letterSpacing: '0.5px' }}>
        {connected ? 'LIVE' : 'OFFLINE'}
      </span>
    </span>
  );
}

function StatCard({ label, value, sub, accent, icon }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: 6,
      position: 'relative', overflow: 'hidden',
      transition: 'border-color 0.2s',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, transparent, ${accent || '#4f7cff'}, transparent)`,
      }} />
      <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '1.5px', textTransform: 'uppercase', fontFamily: 'Space Mono,monospace' }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 800, color: accent || 'var(--text)', lineHeight: 1.1, fontFamily: 'Space Mono,monospace' }}>
        {value ?? '—'}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{sub}</div>}
    </div>
  );
}

function SeverityBadge({ severity }) {
  const s = SEV[severity] || SEV.micro;
  return (
    <span style={{
      background: s.bg, color: s.color,
      border: `1px solid ${s.ring}`,
      borderRadius: 4, padding: '2px 8px',
      fontSize: 10, fontWeight: 700, letterSpacing: '1px',
      textTransform: 'uppercase', fontFamily: 'Space Mono,monospace',
      whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  );
}

function MagCircle({ magnitude, size = 42 }) {
  const color = MAG_COLOR(magnitude);
  const mag = magnitude?.toFixed(1) ?? '?';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `radial-gradient(circle at 40% 35%, ${color}22, ${color}08)`,
      border: `2px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <span style={{ fontSize: size * 0.3, fontWeight: 800, color, fontFamily: 'Space Mono,monospace', lineHeight: 1 }}>
        {mag}
      </span>
    </div>
  );
}

function EqRow({ eq, onClick, selected }) {
  const [lng, lat] = eq.location?.coordinates || [];
  return (
    <div
      onClick={() => onClick(eq)}
      style={{
        display: 'grid',
        gridTemplateColumns: '52px 1fr auto',
        gap: 12, padding: '10px 14px',
        borderRadius: 8,
        background: selected ? 'var(--bg-3)' : 'transparent',
        border: `1px solid ${selected ? 'var(--border-2)' : 'transparent'}`,
        cursor: 'pointer',
        transition: 'all 0.15s',
        animation: 'slideIn 0.3s ease forwards',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-2)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <MagCircle magnitude={eq.magnitude} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {eq.place || 'Unknown location'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <SeverityBadge severity={eq.severity} />
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace' }}>
            {eq.depth != null ? `${eq.depth}km` : '—'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{eq.source}</span>
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace', whiteSpace: 'nowrap' }}>
          {timeAgo(eq.time)}
        </div>
        {eq.riskScore >= 60 && (
          <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2, fontFamily: 'Space Mono,monospace' }}>
            ⚠ RISK {eq.riskScore}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailPanel({ eq, onClose }) {
  if (!eq) return null;
  const [lng, lat] = eq.location?.coordinates || [];
  const s = SEV[eq.severity] || SEV.micro;
  const mapsUrl = lat && lng ? `https://www.google.com/maps?q=${lat},${lng}&z=7` : null;

  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${s.ring}`,
      borderRadius: 12, padding: 20, animation: 'fadeInUp 0.3s ease',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 4, fontFamily: 'Space Mono,monospace' }}>
            Selected Event
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', maxWidth: 220 }}>
            {eq.place || 'Unknown Location'}
          </div>
        </div>
        <button onClick={onClose} style={{
          background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text-2)', cursor: 'pointer', width: 28, height: 28,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        }}>✕</button>
      </div>

      {/* Magnitude highlight */}
      <div style={{
        background: `${s.bg}`, border: `1px solid ${s.ring}`,
        borderRadius: 10, padding: '12px 16px', marginBottom: 14,
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <MagCircle magnitude={eq.magnitude} size={56} />
        <div>
          <div style={{ fontSize: 28, fontWeight: 900, color: s.color, fontFamily: 'Space Mono,monospace', lineHeight: 1 }}>
            M{eq.magnitude?.toFixed(1)}
          </div>
          <div style={{ fontSize: 12, color: s.color, opacity: 0.7, marginTop: 2 }}>
            {eq.severity?.toUpperCase()} • {eq.magnitudeType?.toUpperCase() || 'MW'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: eq.riskScore >= 70 ? '#ef4444' : eq.riskScore >= 40 ? '#f97316' : '#22c55e', fontFamily: 'Space Mono,monospace' }}>
            {eq.riskScore}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '1px' }}>RISK SCORE</div>
        </div>
      </div>

      {/* Details grid */}
      {[
        ['📍 Location', fmtCoords(eq.location?.coordinates)],
        ['🕐 Time', new Date(eq.time).toLocaleString()],
        ['🌊 Depth', eq.depth != null ? `${eq.depth} km` : 'Unknown'],
        ['📡 Source', eq.source],
        ['🌊 Tsunami', eq.tsunami ? '⚡ WARNING' : 'None'],
        ['🔔 PAGER', eq.alert?.toUpperCase() || 'N/A'],
        ['👥 Felt', eq.felt || '0'],
        ['📊 Significance', eq.sig || '—'],
      ].map(([label, val]) => (
        <div key={label} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '7px 0', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{label}</span>
          <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'Space Mono,monospace', textAlign: 'right' }}>{val}</span>
        </div>
      ))}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {mapsUrl && (
          <a href={mapsUrl} target="_blank" rel="noreferrer" style={{
            flex: 1, background: '#1a3a8f', color: '#93c5fd',
            border: '1px solid #1e40af', borderRadius: 7, padding: '8px 12px',
            textAlign: 'center', fontSize: 12, fontWeight: 600, textDecoration: 'none',
            display: 'block',
          }}>
            🗺 View on Map
          </a>
        )}
        {eq.url && (
          <a href={eq.url} target="_blank" rel="noreferrer" style={{
            flex: 1, background: 'var(--bg-3)', color: 'var(--text-2)',
            border: '1px solid var(--border)', borderRadius: 7, padding: '8px 12px',
            textAlign: 'center', fontSize: 12, fontWeight: 600, textDecoration: 'none',
          }}>
            USGS Details →
          </a>
        )}
      </div>
    </div>
  );
}

function SeverityFilter({ active, onChange }) {
  const options = ['all', ...Object.keys(SEV)];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(sev => {
        const isActive = active === sev;
        const s = SEV[sev];
        return (
          <button key={sev} onClick={() => onChange(sev)} style={{
            padding: '4px 10px', borderRadius: 20,
            background: isActive ? (s?.bg || 'var(--accent)') : 'transparent',
            border: `1px solid ${isActive ? (s?.ring || 'var(--accent)') : 'var(--border)'}`,
            color: isActive ? (s?.color || '#fff') : 'var(--text-3)',
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
            textTransform: 'capitalize', letterSpacing: '0.5px',
            transition: 'all 0.15s',
          }}>
            {sev}
          </button>
        );
      })}
    </div>
  );
}

function AlertBanner({ events, onDismiss }) {
  if (!events.length) return null;
  return (
    <div style={{
      background: 'linear-gradient(135deg, #1c0505, #2d0a0a)',
      border: '1px solid #991b1b',
      borderRadius: 10, padding: '12px 16px', marginBottom: 16,
      display: 'flex', alignItems: 'center', gap: 12,
      animation: 'fadeInUp 0.4s ease',
    }}>
      <span style={{ fontSize: 20 }}>🚨</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginBottom: 2 }}>
          MAJOR EVENT DETECTED
        </div>
        <div style={{ fontSize: 12, color: '#fca5a5' }}>
          M{events[0].magnitude?.toFixed(1)} — {events[0].place}
        </div>
      </div>
      <button onClick={onDismiss} style={{
        background: 'transparent', border: 'none', color: '#f87171',
        cursor: 'pointer', fontSize: 16, padding: 4,
      }}>✕</button>
    </div>
  );
}

// ─── Map Component (dynamic to avoid SSR) ────────────────────────────────────

const EarthquakeMap = dynamic(() => import('./EarthquakeMap'), {
  ssr: false,
  loading: () => (
    <div style={{
      width: '100%', height: '100%', background: '#090b18',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 12, color: 'var(--text-3)',
    }}>
      <div style={{ fontSize: 24 }}>🌍</div>
      <div style={{ fontSize: 13, fontFamily: 'Space Mono,monospace' }}>Loading map...</div>
    </div>
  ),
});

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [earthquakes, setEarthquakes] = useState([]);
  const [stats, setStats]             = useState(null);
  const [loading, setLoading]         = useState(true);
  const [connected, setConnected]     = useState(false);
  const [selected, setSelected]       = useState(null);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [hoursFilter, setHoursFilter] = useState(24);
  const [minMag, setMinMag]           = useState(0);
  const [alerts, setAlerts]           = useState([]);
  const [lastFetch, setLastFetch]     = useState(null);
  const [tab, setTab]                 = useState('list'); // list | map | stats
  const socketRef = useRef(null);
  const listRef   = useRef(null);

  // ── Fetch data from REST API
  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        hours: hoursFilter,
        limit: 100,
        minMag,
        ...(severityFilter !== 'all' && { severity: severityFilter }),
      });

      const [eqRes, statsRes] = await Promise.all([
        fetch(`${API}/api/earthquakes?${params}`),
        fetch(`${API}/api/stats?hours=${hoursFilter}`),
      ]);

      if (eqRes.ok) {
        const data = await eqRes.json();
        setEarthquakes(data.earthquakes || []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
      }

      setLastFetch(new Date());
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [hoursFilter, severityFilter, minMag]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Socket.io real-time updates
  useEffect(() => {
    let socket;
    import('socket.io-client').then(({ io }) => {
      socket = io(API, { transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect',    () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));

      socket.on('new_earthquakes', ({ events }) => {
        setEarthquakes(prev => {
          const ids  = new Set(prev.map(e => e.eventId));
          const news = events.filter(e => !ids.has(e.eventId));
          return [...news, ...prev].slice(0, 200);
        });
        setLastFetch(new Date());
      });

      socket.on('major_alert', (eq) => {
        setAlerts(prev => [eq, ...prev].slice(0, 3));
        // Auto-dismiss after 30s
        setTimeout(() => setAlerts(prev => prev.filter(a => a.eventId !== eq.eventId)), 30000);
      });

      socket.on('fetch_complete', () => fetchData());

      socket.emit('subscribe', { minMagnitude: 0 });
    });

    return () => { socket?.disconnect(); };
  }, []);

  // ── Filtered list
  const filtered = earthquakes.filter(eq => {
    if (severityFilter !== 'all' && eq.severity !== severityFilter) return false;
    if (eq.magnitude < minMag) return false;
    return true;
  });

  // ─── Layout ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>

      {/* ── Header */}
      <header style={{
        borderBottom: '1px solid var(--border)',
        padding: '0 24px',
        display: 'flex', alignItems: 'center', gap: 16,
        height: 56, flexShrink: 0,
        background: 'linear-gradient(180deg, var(--bg-2) 0%, transparent 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>🌍</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.3px', color: 'var(--text)' }}>
              Earthquake Aggregator
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '1px', fontFamily: 'Space Mono,monospace' }}>
              USGS · EMSC · REAL-TIME
            </div>
          </div>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          {lastFetch && (
            <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace' }}>
              Updated {timeAgo(lastFetch)}
            </span>
          )}
          <LiveDot connected={connected} />
        </div>
      </header>

      {/* ── Alert Banner */}
      {alerts.length > 0 && (
        <div style={{ padding: '12px 24px 0' }}>
          <AlertBanner events={alerts} onDismiss={() => setAlerts([])} />
        </div>
      )}

      {/* ── Stats Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12, padding: '16px 24px',
      }}>
        <StatCard
          label="Total Events"
          value={stats?.total ?? (loading ? '...' : 0)}
          sub={`Last ${hoursFilter}h`}
          accent="#4f7cff"
          icon="📊"
        />
        <StatCard
          label="Avg Magnitude"
          value={stats?.avgMagnitude ?? '—'}
          sub="Normalized Mw"
          accent="#7b5cff"
          icon="📈"
        />
        <StatCard
          label="Max Magnitude"
          value={stats?.maxEarthquake?.magnitude?.toFixed(1) ?? '—'}
          sub={stats?.maxEarthquake?.place?.slice(0, 22) || ''}
          accent={stats?.maxEarthquake ? MAG_COLOR(stats.maxEarthquake.magnitude) : '#4f7cff'}
          icon="🔺"
        />
        <StatCard
          label="Significant"
          value={stats?.recentSignificant?.length ?? '—'}
          sub="M5.0+ events"
          accent="#f97316"
          icon="⚡"
        />
        <StatCard
          label="USGS Events"
          value={stats?.bySource?.USGS ?? '—'}
          sub="via FDSN API"
          accent="#06b6d4"
          icon="🛰"
        />
        <StatCard
          label="EMSC Events"
          value={stats?.bySource?.EMSC ?? '—'}
          sub="via SeismicPortal"
          accent="#8b5cf6"
          icon="📡"
        />
      </div>

      {/* ── Seismic divider */}
      <div style={{ margin: '0 24px', height: 1, background: 'linear-gradient(90deg, transparent, var(--accent), transparent)', opacity: 0.3 }} />

      {/* ── Tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '12px 24px 0', borderBottom: '1px solid var(--border)' }}>
        {[['list', '📋 Events'], ['map', '🗺 Map'], ['stats', '📊 Analysis']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '8px 16px', borderRadius: '8px 8px 0 0',
            background: tab === key ? 'var(--surface)' : 'transparent',
            border: tab === key ? '1px solid var(--border)' : '1px solid transparent',
            borderBottom: tab === key ? '1px solid var(--surface)' : '1px solid transparent',
            marginBottom: tab === key ? -1 : 0,
            color: tab === key ? 'var(--text)' : 'var(--text-3)',
            fontSize: 13, fontWeight: tab === key ? 700 : 400, cursor: 'pointer',
            transition: 'all 0.15s',
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ──── Events Tab */}
        {tab === 'list' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

            {/* Left: List */}
            <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>

              {/* Filters */}
              <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)' }}>
                <div style={{ marginBottom: 10 }}>
                  <SeverityFilter active={severityFilter} onChange={setSeverityFilter} />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={hoursFilter}
                    onChange={e => setHoursFilter(Number(e.target.value))}
                    style={{
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: 'var(--text)', borderRadius: 6, padding: '4px 8px',
                      fontSize: 12, fontFamily: 'Space Mono,monospace', cursor: 'pointer',
                    }}
                  >
                    {[1,6,12,24,48,72,168].map(h => (
                      <option key={h} value={h}>Last {h}h</option>
                    ))}
                  </select>
                  <select
                    value={minMag}
                    onChange={e => setMinMag(Number(e.target.value))}
                    style={{
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: 'var(--text)', borderRadius: 6, padding: '4px 8px',
                      fontSize: 12, fontFamily: 'Space Mono,monospace', cursor: 'pointer',
                    }}
                  >
                    {[0,1,2,3,4,5,6,7].map(m => (
                      <option key={m} value={m}>M{m}+</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace', marginLeft: 'auto' }}>
                    {filtered.length} events
                  </span>
                </div>
              </div>

              {/* List */}
              <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
                {loading ? (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
                    <div style={{ fontFamily: 'Space Mono,monospace', fontSize: 12 }}>Loading seismic data...</div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>🔇</div>
                    <div style={{ fontSize: 12 }}>No earthquakes match your filters</div>
                  </div>
                ) : (
                  filtered.map(eq => (
                    <EqRow
                      key={eq.eventId}
                      eq={eq}
                      onClick={setSelected}
                      selected={selected?.eventId === eq.eventId}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Right: Detail panel or empty state */}
            <div style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
              {selected ? (
                <DetailPanel eq={selected} onClose={() => setSelected(null)} />
              ) : (
                <div style={{
                  height: '100%', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 16,
                  color: 'var(--text-3)',
                }}>
                  <div style={{ fontSize: 48, opacity: 0.3 }}>🌏</div>
                  <div style={{ fontSize: 13 }}>Select an earthquake to view details</div>
                  <div style={{ fontSize: 11, fontFamily: 'Space Mono,monospace', opacity: 0.6 }}>
                    {filtered.length} events loaded
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ──── Map Tab */}
        {tab === 'map' && (
          <div style={{ flex: 1, position: 'relative' }}>
            <EarthquakeMap earthquakes={filtered} onSelect={setSelected} selected={selected} />
          </div>
        )}

        {/* ──── Analysis Tab */}
        {tab === 'stats' && (
          <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
            <AnalysisPanel stats={stats} earthquakes={filtered} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Analysis Panel ───────────────────────────────────────────────────────────

function AnalysisPanel({ stats, earthquakes }) {
  if (!stats) return (
    <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 60 }}>
      Loading analysis...
    </div>
  );

  const severityOrder = ['great', 'major', 'strong', 'moderate', 'light', 'minor', 'micro'];
  const maxCount = Math.max(...severityOrder.map(s => stats.bySeverity?.[s] || 0), 1);

  const hourly = stats.hourlyDistribution || [];
  const maxHourly = Math.max(...hourly.map(h => h.count), 1);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, maxWidth: 900 }}>

      {/* Severity Distribution */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 16, fontFamily: 'Space Mono,monospace' }}>
          Severity Distribution
        </div>
        {severityOrder.map(sev => {
          const count = stats.bySeverity?.[sev] || 0;
          const pct   = (count / maxCount) * 100;
          const s     = SEV[sev];
          return (
            <div key={sev} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: s.color, textTransform: 'capitalize' }}>{sev}</span>
                <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'Space Mono,monospace' }}>{count}</span>
              </div>
              <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: s.color, borderRadius: 3, transition: 'width 0.8s ease' }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Hourly activity */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 16, fontFamily: 'Space Mono,monospace' }}>
          Hourly Activity (UTC)
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 100 }}>
          {Array.from({ length: 24 }, (_, i) => {
            const h = hourly.find(x => x._id === i);
            const count = h?.count || 0;
            const pct = (count / maxHourly) * 100;
            return (
              <div key={i} title={`${i}:00 — ${count} events`} style={{
                flex: 1, height: `${Math.max(4, pct)}%`,
                background: pct > 50 ? '#ef4444' : pct > 20 ? '#f97316' : '#4f7cff',
                borderRadius: '2px 2px 0 0', opacity: 0.8,
                transition: 'height 0.5s ease',
                cursor: 'default',
              }} />
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace' }}>00:00</span>
          <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace' }}>12:00</span>
          <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'Space Mono,monospace' }}>23:00</span>
        </div>
      </div>

      {/* Recent significant */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, gridColumn: '1 / -1' }}>
        <div style={{ fontSize: 11, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 14, fontFamily: 'Space Mono,monospace' }}>
          ⚡ Recent Significant Events (M5+)
        </div>
        {(stats.recentSignificant || []).length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No M5+ events in this period</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(stats.recentSignificant || []).map(eq => (
              <div key={eq.eventId || eq._id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 12px', background: 'var(--bg-3)',
                borderRadius: 8, border: `1px solid ${MAG_COLOR(eq.magnitude)}22`,
              }}>
                <MagCircle magnitude={eq.magnitude} size={40} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{eq.place}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: 'Space Mono,monospace' }}>
                    {new Date(eq.time).toLocaleString()} • Depth: {eq.depth ?? '—'}km
                  </div>
                </div>
                <SeverityBadge severity={eq.severity} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}