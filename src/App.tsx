import { Activity, ArrowRight, BarChart2, ChevronRight, Globe, KeyRound, Lock, LockKeyhole, Moon, Server, ShieldCheck, Smartphone, Sun, TrendingUp, Webhook, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';

type AuthMethod = 'otp' | 'totp';
type AuthStep = 'start' | 'otp' | 'totp' | 'mpin' | 'success';
type Environment = 'PROD' | 'UAT';
type View = 'landing' | 'login' | 'dashboard' | 'positioning' | 'scanner' | 'webhook' | 'scalper' | 'options';
type Theme = 'dark' | 'light';

interface StartResponse {
  flow_id: string;
  next_step: 'otp' | 'totp';
  masked_phone: string;
  environment: Environment;
  device_id: string;
  message: string;
}

interface SuccessResponse {
  access_token: string;
  refresh_token: string;
  user_name: string;
  account_id: string;
  device_id: string;
  environment: Environment;
  broker: 'Nubra';
  expires_in: number;
  message: string;
  is_demo?: boolean;
}

interface ApiErrorPayload {
  detail?: unknown;
  message?: unknown;
  error?: unknown;
}

const DEMO_SESSION: SuccessResponse = {
  access_token: 'demo-access-token',
  refresh_token: 'demo-refresh-token',
  user_name: 'Demo User',
  account_id: 'NUBRA-DEMO',
  device_id: 'Nubra-OSS-DEMO',
  environment: 'PROD',
  broker: 'Nubra',
  expires_in: 3600,
  message: 'Demo mode — explore the UI without a real Nubra login.',
  is_demo: true,
};

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback;
  const r = payload as ApiErrorPayload;
  if (typeof r.detail === 'string') return r.detail;
  if (r.detail && typeof r.detail === 'object') {
    const n = r.detail as Record<string, unknown>;
    if (typeof n.message === 'string') return n.message;
    if (typeof n.error === 'string') return n.error;
  }
  if (typeof r.message === 'string') return r.message;
  if (typeof r.error === 'string') return r.error;
  return fallback;
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function loadSession(): SuccessResponse | null {
  const raw = localStorage.getItem('nubra_session_payload');
  if (!raw) return null;
  try { return JSON.parse(raw) as SuccessResponse; } catch { return null; }
}

function MiniSparkline() {
  const points = useMemo(() => Array.from({ length: 30 }, (_, i) => {
    const v = 42 + Math.sin(i * 0.6) * 16 + Math.cos(i * 0.19) * 10 + i * 0.8;
    return `${(i / 29) * 260},${92 - v}`;
  }).join(' '), []);
  return (
    <svg viewBox="0 0 260 100" style={{ width: '100%', height: 60 }}>
      <defs>
        <linearGradient id="spFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgb(120,201,255)" stopOpacity=".3" />
          <stop offset="100%" stopColor="rgb(120,201,255)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,100 ${points} 260,100`} fill="url(#spFill)" stroke="none" />
      <polyline points={points} fill="none" stroke="rgb(120,201,255)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button className="theme-toggle" onClick={onToggle} aria-label="Toggle theme">
      <span className={`tt-track ${theme}`}>
        <span className="tt-thumb">
          {theme === 'dark'
            ? <Moon size={10} />
            : <Sun size={10} />}
        </span>
      </span>
    </button>
  );
}

function OtpCells({ value, length, secure }: { value: string; length: number; secure?: boolean }) {
  return (
    <div className={length === 4 ? 'mpin-row' : 'otp-row'}>
      {Array.from({ length }, (_, i) => (
        <div key={i} className={length === 4 ? 'mpin-cell' : 'otp-cell'} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {value[i] ? (secure ? '•' : value[i]) : ''}
        </div>
      ))}
    </div>
  );
}

// ── SCANNER ROW TYPE ────────────────────────────────────────────────────────
interface ScannerRow {
  rank: number;
  symbol: string;
  display_name: string;
  exchange: string;
  last_price: number;
  current_volume: number;
  average_volume: number;
  volume_ratio: number;
  price_change_pct: number;
  is_green: boolean;
}

interface ScannerResult {
  status: string;
  message: string;
  rows: ScannerRow[];
}

type ColorFilter = 'all' | 'green' | 'red';

function ScannerView({
  theme,
  session,
  renderNav,
}: {
  theme: Theme;
  session: SuccessResponse | null;
  renderNav: (active: View) => React.ReactNode;
}) {
  const [rows, setRows] = useState<ScannerRow[]>([]);
  const [scanMsg, setScanMsg] = useState('');
  const [scanErr, setScanErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastScanned, setLastScanned] = useState<Date | null>(null);
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');

  async function runScan() {
    if (!session || session.is_demo) return;
    setLoading(true);
    setScanErr('');
    setScanMsg('Fetching 2 days of 5m candles from Nubra…');
    try {
      const res = await fetch('/api/market/scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_token: session.access_token,
          device_id: session.device_id,
          environment: session.environment,
        }),
      });
      const data = (await res.json()) as ScannerResult | ApiErrorPayload;
      if (!res.ok) throw new Error(apiError(data, 'Scanner request failed.'));
      const result = data as ScannerResult;
      setRows(result.rows ?? []);
      setScanMsg(result.message);
      setLastScanned(new Date());
    } catch (err) {
      setScanErr(err instanceof Error ? err.message : 'Scanner request failed.');
      setScanMsg('');
    } finally {
      setLoading(false);
    }
  }

  const displayed = rows.filter(r =>
    colorFilter === 'all' ? true : colorFilter === 'green' ? r.is_green : !r.is_green
  );

  const fmtPrice = (v: number) =>
    v > 0 ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

  const fmtVol = (v: number) => {
    if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
    if (v >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return String(v);
  };

  return (
    <div className="dash" data-theme={theme}>
      {renderNav('scanner')}
      <main className="subview-main">
        <div className="panel-heading">
          <div>
            <h2>Volume Breakout Scanner</h2>
            <p>Detects stocks where current 5m candle volume exceeds the prior-day same-candle average by ≥1.5×, across 30 liquid NSE equities.</p>
          </div>
          <span className={`pill-v2 ${session?.is_demo ? '' : 'pill-accent'}`}>{session?.is_demo ? 'Demo' : 'Live'}</span>
        </div>

        {/* SUMMARY TILES */}
        <div className="volume-summary-grid">
          {[
            { label: 'Universe', value: '30', sub: 'Liquid NSE stocks' },
            { label: 'Breakouts', value: rows.length > 0 ? String(rows.length) : '—', sub: 'Vol ratio ≥ 1.5×' },
            { label: 'Green', value: rows.length > 0 ? String(rows.filter(r => r.is_green).length) : '—', sub: 'Rising price' },
            { label: 'Last scan', value: lastScanned ? lastScanned.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—', sub: 'IST' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="summary-card">
              <span className="summary-label">{label}</span>
              <strong style={{ fontFamily: 'JetBrains Mono, monospace' }}>{value}</strong>
              <small>{sub}</small>
            </div>
          ))}
        </div>

        {/* CONTROLS */}
        {session?.is_demo ? (
          <div className="msg-banner">
            Demo mode — log in with a real Nubra account, then click <strong>Run Scanner</strong> to fetch live volume data.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="primary-button" onClick={runScan} disabled={loading}>
              {loading ? 'Scanning…' : lastScanned ? 'Refresh Scan' : 'Run Scanner'}
            </button>
            {lastScanned && (
              <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>
                Last run {lastScanned.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} IST
              </span>
            )}
          </div>
        )}

        {/* FEEDBACK */}
        {scanErr && <div className="err-banner">{scanErr}</div>}
        {scanMsg && !scanErr && <div className="msg-banner">{scanMsg}</div>}

        {/* RESULTS TABLE */}
        {(rows.length > 0 || lastScanned) && (
          <div className="sb-card">
            <div className="sb-card-head">
              <div>
                <span className="sb-card-kicker">Active Breakouts</span>
                <h3>Volume Leaders — 5m Interval</h3>
              </div>
              <div className="mode-toggle">
                {(['all', 'green', 'red'] as ColorFilter[]).map(f => (
                  <button
                    key={f}
                    className={`indicator-box${colorFilter === f ? ' active' : ''}`}
                    onClick={() => setColorFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="table-shell">
              <div className="table-row table-head volume-stock-grid">
                <span>#&nbsp;Symbol</span>
                <span>LTP</span>
                <span>Vol Ratio</span>
                <span>Change</span>
                <span>Status</span>
              </div>
              {displayed.length === 0 ? (
                <div className="table-empty">No breakouts match the selected filter.</div>
              ) : (
                displayed.map(row => (
                  <div key={row.symbol} className="table-row volume-stock-grid">
                    <span>
                      <strong style={{ display: 'block' }}>
                        <span style={{ color: 'var(--fg-faint)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, marginRight: 6 }}>{row.rank}</span>
                        {row.symbol}
                      </strong>
                      <small style={{ color: 'var(--fg-faint)', fontSize: 10 }}>{row.exchange}</small>
                    </span>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{fmtPrice(row.last_price)}</span>
                    <span>
                      <span className="pill-v2 pill-accent" style={{ fontSize: 10 }}>{row.volume_ratio.toFixed(1)}×</span>
                      <small style={{ display: 'block', color: 'var(--fg-faint)', fontSize: 10, marginTop: 2 }}>
                        {fmtVol(row.current_volume)} / {fmtVol(row.average_volume)}
                      </small>
                    </span>
                    <span className={row.is_green ? 'text-success' : 'text-danger'} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
                      {row.price_change_pct >= 0 ? '+' : ''}{row.price_change_pct.toFixed(2)}%
                    </span>
                    <span>
                      <span className={`pill-v2 ${row.is_green ? 'pill-success' : 'pill-danger'}`} style={{ fontSize: 10 }}>
                        {row.is_green ? 'Breakout ▲' : 'Breakout ▼'}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ── OPTION CHAIN TYPES ───────────────────────────────────────────────────────
interface OptionLeg {
  ref_id: number;
  strike: number;
  ltp: number;
  ltp_chg: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  oi: number;
  oi_chg: number;
  volume: number;
}
interface OptionChainData {
  instrument: string;
  expiry: string;
  all_expiries: string[];
  atm: number;
  current_price: number;
  ce: OptionLeg[];
  pe: OptionLeg[];
  pcr: number;
  total_ce_oi: number;
  total_pe_oi: number;
}
interface IVRankData {
  instrument: string;
  iv_rank: number;
  iv_percent: number;
  iv_high_52: number;
  iv_low_52: number;
  message: string;
}

// ── SHARED STYLE CONSTANTS (used inside OptionsDesk) ────────────────────────
const LBL: React.CSSProperties = { fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-faint)', whiteSpace: 'nowrap' };
const SEL: React.CSSProperties = { width: 100, padding: '6px 9px', fontSize: 12, borderRadius: 8 };

function STAT({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>{label}</span>
      <strong style={{ fontSize: 13.5, color: color ?? 'var(--fg)', fontFamily: mono ? "'JetBrains Mono', monospace" : "'Inter', sans-serif", letterSpacing: '-0.015em', fontWeight: 700 }}>{value}</strong>
    </div>
  );
}

function LEGEND({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 500, letterSpacing: '-0.005em' }}>
      <span style={{ width: 8, height: 3, borderRadius: 2, background: color, flexShrink: 0 }} />{label}
    </span>
  );
}

function CARD({ kicker, title, badge, children }: { kicker: string; title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--hairline)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
      background: 'linear-gradient(180deg,rgba(255,255,255,.038),rgba(255,255,255,.01))',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <span style={{ fontSize: 8.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-faint)', display: 'block' }}>{kicker}</span>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 2, letterSpacing: '-0.01em' }}>{title}</h3>
        </div>
        {badge && <span style={{ fontSize: 9, padding: '2px 7px', border: '1px solid var(--hairline-2)', color: 'var(--fg-faint)', whiteSpace: 'nowrap' }}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

// Recharts custom tooltip that matches the dark/light theme
function ChartTooltip({ active, payload, label, prefix = '', suffix = '', labelFormatter }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[];
  label?: string | number; prefix?: string; suffix?: string; labelFormatter?: (v: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  const displayLabel = label != null ? (labelFormatter ? labelFormatter(label) : label) : null;
  return (
    <div style={{ background: 'var(--panel-solid)', border: '1px solid var(--hairline-2)', borderRadius: 10, padding: '8px 12px', fontSize: 11 }}>
      {displayLabel && <div style={{ color: 'var(--fg-dim)', marginBottom: 4, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{displayLabel}</div>}
      {payload.map(p => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--fg-dim)' }}>{p.name}</span>
          <span style={{ color: 'var(--fg)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{prefix}{typeof p.value === 'number' ? p.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : p.value}{suffix}</span>
        </div>
      ))}
    </div>
  );
}

// IV Rank radial gauge
function IVRankGauge({ rank, ivPct, high, low }: { rank: number; ivPct: number; high: number; low: number }) {
  const clamped = Math.min(100, Math.max(0, rank));
  const color = clamped >= 70 ? 'var(--neg)' : clamped >= 40 ? '#f59e0b' : 'var(--pos)';
  const label = clamped >= 70 ? 'HIGH' : clamped >= 40 ? 'MID' : 'LOW';
  // SVG arc: semicircle gauge
  const r = 54, cx = 70, cy = 68;
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const angle = startAngle + (clamped / 100) * Math.PI;
  const x = cx + r * Math.cos(angle);
  const y = cy + r * Math.sin(angle);
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const fillPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg width={140} height={80} viewBox="0 0 140 80">
        <path d={arcPath} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={10} strokeLinecap="round" />
        <path d={fillPath} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round" />
        <circle cx={x} cy={y} r={5} fill={color} />
        <text x={cx} y={cy - 6} textAnchor="middle" fill="var(--fg)" fontSize={22} fontWeight={700} fontFamily="'Inter', system-ui, sans-serif" letterSpacing="-1">{clamped.toFixed(0)}</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill={color} fontSize={8.5} fontWeight={700} fontFamily="'Inter', sans-serif" letterSpacing="1.5">{label}</text>
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
        <span>IV {ivPct.toFixed(1)}%</span>
        <span>L {low.toFixed(1)}%</span>
        <span>H {high.toFixed(1)}%</span>
      </div>
    </div>
  );
}

// ── OPTIONS DESK COMPONENT ────────────────────────────────────────────────────
function OptionsDesk({
  theme, session, renderNav,
}: {
  theme: Theme;
  session: SuccessResponse | null;
  renderNav: (v: View) => React.ReactNode;
}) {
  const [instrument, setInstrument] = useState('NIFTY');
  const [expiry, setExpiry] = useState('');
  const [chain, setChain] = useState<OptionChainData | null>(null);
  const [ivRank, setIVRank] = useState<IVRankData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [strikes, setStrikes] = useState(10); // strikes around ATM
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ACCENT = 'rgb(120,201,255)';
  const NEG    = 'rgb(241,66,66)';
  const POS    = 'rgb(124,207,94)';
  const AMBER  = '#f59e0b';

  const headers = useCallback(() => ({
    'Content-Type': 'application/json',
  }), []);

  const body = useCallback((extra?: Record<string, string>) => JSON.stringify({
    session_token: session?.access_token ?? '',
    device_id: session?.device_id ?? '',
    environment: session?.environment ?? 'PROD',
    instrument,
    expiry,
    ...extra,
  }), [session, instrument, expiry]);

  const fetchAll = useCallback(async () => {
    if (!session || session.is_demo) return;
    setLoading(true); setErr('');
    try {
      const [chainRes, ivRes] = await Promise.all([
        fetch('/api/market/option-chain', { method: 'POST', headers: headers(), body: body() }),
        fetch('/api/market/iv-rank',      { method: 'POST', headers: headers(), body: body() }),
      ]);
      if (!chainRes.ok) throw new Error(await chainRes.text());
      if (!ivRes.ok)    throw new Error(await ivRes.text());
      const chainData: OptionChainData = await chainRes.json();
      const ivData: IVRankData         = await ivRes.json();
      setChain(chainData);
      setIVRank(ivData);
      // auto-select first expiry returned
      if (!expiry && chainData.all_expiries?.length) setExpiry(chainData.all_expiries[0]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setLoading(false);
    }
  }, [session, body, headers, expiry]);

  // Connect Nubra WebSocket for live index price
  useEffect(() => {
    if (!session || session.is_demo) return;
    const base = session.environment === 'UAT' ? 'wss://uatapi.nubra.io/apibatch/ws' : 'wss://api.nubra.io/apibatch/ws';
    const ws = new WebSocket(base);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(`batch_subscribe ${session.access_token} index {"indexes":["${instrument}"]} NSE`);
    };
    ws.onmessage = (ev) => {
      // Nubra sends protobuf binary — we decode the JSON fallback via index_value field
      // For text frames (post-market / debug), parse directly
      if (typeof ev.data === 'string') {
        try {
          const d = JSON.parse(ev.data);
          if (d.index_value) setLivePrice(d.index_value / 100);
        } catch { /* ignore */ }
      }
      // Binary protobuf frames are decoded by the browser as ArrayBuffer;
      // without the proto schema in the browser we can't decode them here —
      // live price from REST snapshot is used as fallback.
    };
    ws.onerror = () => {};
    return () => { ws.close(); };
  }, [session, instrument]);

  // Derive chart data from chain
  const atmStrike = chain?.atm ?? 0;

  const oiData = useMemo(() => {
    if (!chain) return [];
    const ceMap = new Map(chain.ce.map(l => [l.strike, l]));
    const peMap = new Map(chain.pe.map(l => [l.strike, l]));
    const allStrikes = [...new Set([...chain.ce.map(l => l.strike), ...chain.pe.map(l => l.strike)])].sort((a, b) => a - b);
    const atmIdx = allStrikes.findIndex(s => s >= atmStrike);
    const lo = Math.max(0, atmIdx - strikes);
    const hi = Math.min(allStrikes.length, atmIdx + strikes + 1);
    return allStrikes.slice(lo, hi).map(s => ({
      strike: s,
      ceOI: (ceMap.get(s)?.oi ?? 0) / 1e5,
      peOI: (peMap.get(s)?.oi ?? 0) / 1e5,
      isATM: s === atmStrike,
    }));
  }, [chain, atmStrike, strikes]);

  const ivSmileData = useMemo(() => {
    if (!chain) return [];
    const ceMap = new Map(chain.ce.map(l => [l.strike, l]));
    const peMap = new Map(chain.pe.map(l => [l.strike, l]));
    const allStrikes = [...new Set([...chain.ce.map(l => l.strike), ...chain.pe.map(l => l.strike)])].sort((a, b) => a - b);
    const atmIdx = allStrikes.findIndex(s => s >= atmStrike);
    const lo = Math.max(0, atmIdx - strikes);
    const hi = Math.min(allStrikes.length, atmIdx + strikes + 1);
    return allStrikes.slice(lo, hi).map(s => {
      const ce = ceMap.get(s); const pe = peMap.get(s);
      // iv is a decimal like 0.134 — multiply by 100 for percentage display
      // use null only when iv is truly absent/undefined, not when it's 0
      const ceIV = (ce?.iv != null && ce.iv > 0) ? +(ce.iv * 100).toFixed(2) : null;
      const peIV = (pe?.iv != null && pe.iv > 0) ? +(pe.iv * 100).toFixed(2) : null;
      return { strike: s, ceIV, peIV, isATM: s === atmStrike };
    }).filter(d => d.ceIV !== null || d.peIV !== null);
  }, [chain, atmStrike, strikes]);

  const greeksData = useMemo(() => {
    if (!chain) return [];
    const atm = chain.ce.find(l => l.strike === atmStrike) ?? chain.ce[Math.floor(chain.ce.length / 2)];
    if (!atm) return [];
    return [
      { name: 'Delta', value: +(atm.delta).toFixed(4) },
      { name: 'Gamma', value: +(atm.gamma * 1000).toFixed(4) },
      { name: 'Theta', value: +(atm.theta).toFixed(2) },
      { name: 'Vega',  value: +(atm.vega).toFixed(2) },
    ];
  }, [chain, atmStrike]);

  const fmtK = (n: number) => n >= 100 ? `${n.toFixed(1)}L` : n >= 1 ? `${n.toFixed(2)}L` : `${(n * 1e5).toFixed(0)}`;

  const tickStyle = { fill: 'var(--fg-faint)', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' };

  // Go backend already divides paise by 100 before sending JSON.
  // So strike=23800 means ₹23,800. No further division needed.
  const fmtStrike = (v: number) =>
    v >= 10000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);

  const fmtStrikeLabel = (v: number | string) =>
    `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  // shared axis tick style — brighter so values are legible on dark bg
  const TX = { fill: '#94a3b8', fontSize: 10.5, fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 500 };
  // grid color
  const GC = 'rgba(255,255,255,0.06)';
  // card container style
  const PANEL = { background: '#0b1119', border: '1px solid rgba(255,255,255,0.08)', padding: '14px 16px 12px' } as React.CSSProperties;
  // card eyebrow — uppercase category label, clearly visible
  const EYE  = { fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 600, marginBottom: 3 };
  // card title — primary heading, clearly readable
  const TTL  = { fontSize: 13.5, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.015em', marginBottom: 10, fontFamily: "'Inter', sans-serif" } as React.CSSProperties;

  return (
    <div className="dash" data-theme={theme}>
      {renderNav('options')}

      {/* ── TOOLBAR ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '0 18px', borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#060a0f', position: 'sticky', top: 64, zIndex: 5, minHeight: 48,
      }}>
        {[
          { label: 'Underlying', node: (
            <select className="field-select" style={{ ...SEL, fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: '-0.01em' }}
              value={instrument} onChange={e => { setInstrument(e.target.value); setExpiry(''); setChain(null); }}>
              {['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'].map(i => <option key={i}>{i}</option>)}
            </select>
          )},
          { label: 'Expiry', node: (
            <select className="field-select" style={{ ...SEL, width: 108, fontFamily: "'Inter', sans-serif", fontSize: 12 }}
              value={expiry} onChange={e => setExpiry(e.target.value)}>
              {chain?.all_expiries?.length ? chain.all_expiries.map(e => <option key={e}>{e}</option>) : <option value="">—</option>}
            </select>
          )},
          { label: 'Strikes ±', node: (
            <select className="field-select" style={{ ...SEL, width: 64, fontFamily: "'Inter', sans-serif", fontSize: 12 }}
              value={strikes} onChange={e => setStrikes(+e.target.value)}>
              {[5,8,10,15,20].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )},
        ].map(({ label, node }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>
            {node}
          </div>
        ))}
        <button className="primary-button" onClick={fetchAll}
          disabled={loading || !session || !!session.is_demo}
          style={{ padding: '6px 16px', fontSize: 12, fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>
          {loading ? 'Loading…' : chain ? '↻ Refresh' : 'Load Data'}
        </button>

        {chain && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 22 }}>
            {[
              { label: 'SPOT', value: `₹${(livePrice ?? chain.current_price).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, color: '#7dd3fc' },
              { label: 'ATM',  value: `₹${chain.atm.toLocaleString('en-IN')}`,  color: '#e2e8f0' },
              { label: 'PCR',  value: chain.pcr.toFixed(2), color: chain.pcr > 1.2 ? '#4ade80' : chain.pcr < 0.8 ? '#f87171' : '#fbbf24' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>{label}</span>
                <strong style={{ fontSize: 14, color, fontFamily: "'Inter', sans-serif", fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</strong>
              </div>
            ))}
            <span className={`pill-v2 ${session?.is_demo ? '' : 'pill-accent'}`}>{session?.environment ?? 'PROD'}</span>
          </div>
        )}
      </div>

      {/* ── BODY ── */}
      <div style={{ overflow: 'auto', height: 'calc(100dvh - 110px)', padding: '10px 14px 14px', display: 'grid', gap: 8, alignContent: 'start', background: '#080d14' }}>

        {err && <div className="err-banner">{err}</div>}
        {session?.is_demo && <div className="msg-banner">Demo mode — log in with a real Nubra account to load live option chain data.</div>}

        {chain && <>

          {/* ── METRIC STRIP ── 8 tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
            {[
              { label: 'Total CE OI',  value: `${(chain.total_ce_oi/1e5).toFixed(2)}L`, color: '#4ade80', accent: '#4ade8022' },
              { label: 'Total PE OI',  value: `${(chain.total_pe_oi/1e5).toFixed(2)}L`, color: '#f87171', accent: '#f8717122' },
              { label: 'Put-Call Ratio', value: chain.pcr.toFixed(3),
                color: chain.pcr > 1.2 ? '#4ade80' : chain.pcr < 0.8 ? '#f87171' : '#fbbf24',
                accent: chain.pcr > 1.2 ? '#4ade8018' : chain.pcr < 0.8 ? '#f8717118' : '#fbbf2418' },
              { label: 'ATM Strike',    value: `₹${chain.atm.toLocaleString('en-IN')}`, color: '#7dd3fc', accent: '#7dd3fc18' },
              { label: 'Spot Price',    value: `₹${(livePrice ?? chain.current_price).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, color: '#e2e8f0', accent: '#ffffff0a' },
              { label: 'IV Rank',       value: ivRank ? `${ivRank.iv_rank.toFixed(0)} / 100` : '—',
                color: ivRank ? (ivRank.iv_rank >= 70 ? '#f87171' : ivRank.iv_rank >= 40 ? '#fbbf24' : '#4ade80') : '#475569',
                accent: ivRank ? (ivRank.iv_rank >= 70 ? '#f8717118' : ivRank.iv_rank >= 40 ? '#fbbf2418' : '#4ade8018') : '#ffffff0a' },
              { label: 'ATM IV',        value: ivRank ? `${ivRank.iv_percent.toFixed(1)}%` : '—', color: '#94a3b8', accent: '#ffffff0a' },
              { label: 'Expiry',        value: chain.expiry ?? '—', color: '#94a3b8', accent: '#ffffff0a' },
            ].map(({ label, value, color, accent }) => (
              <div key={label} style={{ background: accent, border: '1px solid rgba(255,255,255,0.07)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 600, lineHeight: 1 }}>{label}</span>
                <strong style={{ fontSize: 17, color, fontFamily: "'Inter', sans-serif", fontWeight: 700, letterSpacing: '-0.025em', lineHeight: 1 }}>{value}</strong>
              </div>
            ))}
          </div>

          {/* ── CHARTS ROW ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>

            {/* OI BAR CHART */}
            <div style={PANEL}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div><div style={EYE}>Open Interest</div><div style={TTL}>CE vs PE OI by Strike</div></div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <LEGEND color="#4ade80" label="Call OI" /><LEGEND color="#f87171" label="Put OI" /><LEGEND color="#7dd3fc" label="ATM" />
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={oiData} margin={{ top: 2, right: 4, left: 4, bottom: 0 }} barCategoryGap="20%" barGap={1}>
                  <CartesianGrid vertical={false} stroke={GC} strokeDasharray="3 4" />
                  <XAxis dataKey="strike" tick={TX} tickFormatter={fmtStrike} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                  <YAxis tick={TX} tickFormatter={fmtK} width={44} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip suffix="L" labelFormatter={fmtStrikeLabel} />} />
                  <ReferenceLine x={atmStrike} stroke="#7dd3fc" strokeDasharray="4 3" strokeWidth={1.5}
                    label={{ value: 'ATM', position: 'top', fill: '#7dd3fc', fontSize: 10, fontFamily: "'Inter', sans-serif", fontWeight: 700 }} />
                  <Bar dataKey="ceOI" name="Call OI" radius={[3,3,0,0]}>
                    {oiData.map((d,i) => <Cell key={i} fill={d.isATM ? '#93c5fd' : '#4ade80'} fillOpacity={d.isATM ? 1 : 0.7} />)}
                  </Bar>
                  <Bar dataKey="peOI" name="Put OI" radius={[3,3,0,0]}>
                    {oiData.map((d,i) => <Cell key={i} fill={d.isATM ? '#93c5fd' : '#f87171'} fillOpacity={d.isATM ? 1 : 0.7} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* IV SMILE */}
            <div style={PANEL}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <div style={EYE}>Implied Volatility</div>
                  <div style={TTL}>IV Skew — Calls & Puts</div>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <LEGEND color="#4ade80" label="Call IV" /><LEGEND color="#f87171" label="Put IV" />
                </div>
              </div>
              {ivSmileData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={ivSmileData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke={GC} strokeDasharray="3 4" />
                    <XAxis dataKey="strike" tick={TX} tickFormatter={fmtStrike} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                    <YAxis tick={TX} tickFormatter={v => `${v.toFixed(0)}%`} width={44} domain={['auto','auto']} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip suffix="%" labelFormatter={fmtStrikeLabel} />} />
                    <ReferenceLine x={atmStrike} stroke="#7dd3fc" strokeDasharray="4 3" strokeWidth={1.5}
                      label={{ value: 'ATM', position: 'top', fill: '#7dd3fc', fontSize: 10, fontFamily: "'Inter', sans-serif", fontWeight: 700 }} />
                    <Line dataKey="ceIV" name="Call IV" stroke="#4ade80" dot={false} strokeWidth={2.5} connectNulls activeDot={{ r: 5, fill: '#4ade80', stroke: '#0d1520', strokeWidth: 2 }} />
                    <Line dataKey="peIV" name="Put IV" stroke="#f87171" dot={false} strokeWidth={2.5} connectNulls activeDot={{ r: 5, fill: '#f87171', stroke: '#0d1520', strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#334155' }}>
                  <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M3 3l18 18M9 9c0-1.66 1.34-3 3-3 .34 0 .67.06.98.16M12 15c-1.66 0-3-1.34-3-3M15 12a3 3 0 00-3-3"/></svg>
                  <span style={{ fontSize: 12, fontFamily: 'Inter, sans-serif' }}>No IV data for this expiry</span>
                </div>
              )}
            </div>
          </div>

          {/* ── BOTTOM ROW: IV Rank + Greeks + OI Area ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr 1fr', gap: 8 }}>

            {/* IV RANK */}
            <div style={{ ...PANEL, justifyContent: 'flex-start' }}>
              <div style={EYE}>Volatility Regime</div>
              <div style={{ ...TTL, marginBottom: 6 }}>IV Rank</div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                {ivRank ? <>
                  <IVRankGauge rank={ivRank.iv_rank} ivPct={ivRank.iv_percent} high={ivRank.iv_high_52} low={ivRank.iv_low_52} />
                  <p style={{ fontSize: 10.5, color: '#94a3b8', textAlign: 'center', lineHeight: 1.6, maxWidth: 180, fontFamily: "'Inter', sans-serif", fontWeight: 400 }}>{ivRank.message}</p>
                </> : <span style={{ color: '#64748b', fontSize: 12, fontFamily: "'Inter', sans-serif" }}>Load data to compute</span>}
              </div>
            </div>

            {/* GREEKS */}
            <div style={PANEL}>
              <div style={EYE}>ATM Call — Sensitivities</div>
              <div style={TTL}>Greeks</div>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={greeksData} layout="vertical" margin={{ top: 2, right: 20, left: 12, bottom: 2 }}>
                  <CartesianGrid horizontal={false} stroke={GC} strokeDasharray="3 4" />
                  <XAxis type="number" tick={TX} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ ...TX, fontSize: 11, fill: '#cbd5e1' }} width={44} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="value" name="Value" radius={[0,4,4,0]}>
                    {greeksData.map((_,i) => <Cell key={i} fill={['#7dd3fc','#4ade80','#f87171','#fbbf24'][i%4]} fillOpacity={0.88} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* OI AREA */}
            <div style={PANEL}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div><div style={EYE}>OI Distribution</div><div style={TTL}>CE vs PE — Overlap View</div></div>
                <div style={{ display: 'flex', gap: 10 }}><LEGEND color="#4ade80" label="CE" /><LEGEND color="#f87171" label="PE" /></div>
              </div>
              <ResponsiveContainer width="100%" height={170}>
                <AreaChart data={oiData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="#4ade80" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#4ade80" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="#f87171" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#f87171" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GC} strokeDasharray="3 4" />
                  <XAxis dataKey="strike" tick={TX} tickFormatter={fmtStrike} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                  <YAxis tick={TX} tickFormatter={fmtK} width={44} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip suffix="L" labelFormatter={fmtStrikeLabel} />} />
                  <ReferenceLine x={atmStrike} stroke="#7dd3fc" strokeDasharray="4 3" strokeWidth={1} />
                  <Area dataKey="ceOI" name="CE OI" stroke="#4ade80" fill="url(#g1)" strokeWidth={2} dot={false} />
                  <Area dataKey="peOI" name="PE OI" stroke="#f87171" fill="url(#g2)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── CHAIN TABLE ── */}
          <div style={{ background: '#0b1018', border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
            {/* header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#f1f5f9', fontFamily: "'Inter', sans-serif", letterSpacing: '-0.01em' }}>Option Chain</span>
                <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>{chain.instrument} · {chain.expiry} · {oiData.length} strikes shown</span>
              </div>
              <div style={{ display: 'flex', gap: 14 }}>
                <LEGEND color="#4ade80" label="Calls (CE)" /><LEGEND color="#f87171" label="Puts (PE)" /><LEGEND color="#7dd3fc" label="ATM" />
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontFamily: 'Inter, system-ui, sans-serif' }}>
                <colgroup>
                  {[10,8,8,10,14,10,8,8,10].map((w,i) => <col key={i} style={{ width: `${w}%` }} />)}
                </colgroup>
                <thead>
                  <tr style={{ background: 'rgba(74,222,128,0.04)' }}>
                    {['OI (K)','IV %','Delta','LTP'].map((h,i) => (
                      <th key={i} style={{ padding: '7px 10px', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#4ade80', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.07)', fontWeight: 600 }}>{h}</th>
                    ))}
                    <th style={{ padding: '7px 10px', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#7dd3fc', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.07)', fontWeight: 700, borderLeft: '1px solid rgba(125,211,252,0.18)', borderRight: '1px solid rgba(125,211,252,0.18)', background: 'rgba(125,211,252,0.05)' }}>Strike</th>
                    {['LTP','Delta','IV %','OI (K)'].map((h,i) => (
                      <th key={i} style={{ padding: '7px 10px', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#f87171', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.07)', fontWeight: 600, background: 'rgba(248,113,113,0.04)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {oiData.map(({ strike, isATM }) => {
                    const ce = chain.ce.find(l => l.strike === strike);
                    const pe = chain.pe.find(l => l.strike === strike);
                    const N = (v: number | undefined, d = 2) =>
                      v != null && v !== 0
                        ? v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
                        : <span style={{ color: '#334155' }}>—</span>;
                    const maxOI = Math.max(...oiData.map(d => Math.max(d.ceOI, d.peOI)));
                    const cePct = Math.min(100, ((ce?.oi ?? 0) / 1e5 / maxOI) * 100);
                    const pePct = Math.min(100, ((pe?.oi ?? 0) / 1e5 / maxOI) * 100);
                    return (
                      <tr key={strike}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: isATM ? 'rgba(125,211,252,0.055)' : undefined }}
                        onMouseEnter={e => { if (!isATM) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.025)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isATM ? 'rgba(125,211,252,0.055)' : 'transparent'; }}>

                        {/* CE OI + background bar */}
                        <td style={{ padding: '5px 10px', textAlign: 'right', position: 'relative', fontSize: 11.5 }}>
                          <div style={{ position: 'absolute', inset: 0, right: 'auto', width: `${cePct}%`, background: 'rgba(74,222,128,0.08)', left: `${100-cePct}%` }} />
                          <span style={{ position: 'relative', color: '#4ade80', fontWeight: 500 }}>{N(ce?.oi ? ce.oi/1000 : undefined, 1)}</span>
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', fontSize: 11.5, color: '#64748b' }}>{N(ce?.iv ? ce.iv*100 : undefined, 1)}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', fontSize: 11.5, color: '#64748b' }}>{N(ce?.delta, 3)}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', fontSize: 12, color: '#4ade80', fontWeight: 600 }}>{N(ce?.ltp, 2)}</td>

                        {/* Strike */}
                        <td style={{ padding: '5px 10px', textAlign: 'center', fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: 13, color: isATM ? '#7dd3fc' : '#cbd5e1', borderLeft: '1px solid rgba(125,211,252,0.13)', borderRight: '1px solid rgba(125,211,252,0.13)', background: isATM ? 'rgba(125,211,252,0.07)' : undefined, letterSpacing: '-0.01em' }}>
                          {strike.toLocaleString('en-IN')}
                          {isATM && <span style={{ display: 'block', fontSize: 7, color: '#7dd3fc', letterSpacing: '0.14em', fontWeight: 700, marginTop: 1, textTransform: 'uppercase' }}>ATM</span>}
                        </td>

                        <td style={{ padding: '5px 10px', textAlign: 'left', fontSize: 12, color: '#f87171', fontWeight: 600 }}>{N(pe?.ltp, 2)}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'left', fontSize: 11.5, color: '#64748b' }}>{N(pe?.delta, 3)}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'left', fontSize: 11.5, color: '#64748b' }}>{N(pe?.iv ? pe.iv*100 : undefined, 1)}</td>

                        {/* PE OI + background bar */}
                        <td style={{ padding: '5px 10px', textAlign: 'left', position: 'relative', fontSize: 11.5 }}>
                          <div style={{ position: 'absolute', inset: 0, width: `${pePct}%`, background: 'rgba(248,113,113,0.08)' }} />
                          <span style={{ position: 'relative', color: '#f87171', fontWeight: 500 }}>{N(pe?.oi ? pe.oi/1000 : undefined, 1)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

        </>}

        {!chain && !loading && !err && (
          <div className="msg-banner" style={{ fontFamily: 'Inter, sans-serif' }}>
            Select an <strong>underlying</strong> and <strong>expiry</strong>, then click <strong>Load Data</strong> to fetch the live option chain.
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [view, setView] = useState<View>(() => loadSession() ? 'dashboard' : 'landing');
  const [step, setStep] = useState<AuthStep>('start');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('otp');
  const [environment, setEnvironment] = useState<Environment>(() =>
    localStorage.getItem('nubra_environment') === 'UAT' ? 'UAT' : 'PROD'
  );
  const [phone, setPhone] = useState(() => localStorage.getItem('nubra_phone') ?? '');
  const [flowId, setFlowId] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');
  const [code, setCode] = useState('');
  const [mpin, setMpin] = useState('');
  const [session, setSession] = useState<SuccessResponse | null>(() => loadSession());
  const [message, setMessage] = useState('Choose SMS OTP or TOTP, complete verification, then confirm MPIN.');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const phoneReady = phone.replace(/\D/g, '').length === 10;
  const codeLength = 6;
  const currentStep = step === 'start' ? 0 : step === 'mpin' || step === 'success' ? 2 : 1;
  const initials = (session?.user_name ?? 'N').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function resetAuth() {
    setStep('start');
    setCode('');
    setMpin('');
    setFlowId('');
    setMaskedPhone('');
    setError('');
    setMessage('Choose SMS OTP or TOTP, complete verification, then confirm MPIN.');
  }

  function signOut() {
    localStorage.removeItem('nubra_session_payload');
    localStorage.removeItem('nubra_session_token');
    localStorage.removeItem('nubra_device_id');
    localStorage.removeItem('nubra_login_date');
    localStorage.removeItem('nubra_raw_cookie');
    setSession(null);
    setProfileOpen(false);
    resetAuth();
    setView('landing');
  }

  async function startLogin(e: React.FormEvent) {
    e.preventDefault();
    const cleanPhone = phone.replace(/\D/g, '').slice(0, 10);
    if (cleanPhone.length < 10) { setError('Enter the 10-digit phone number linked to Nubra.'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone, environment, auth_method: authMethod }),
      });
      const data = (await res.json()) as StartResponse | ApiErrorPayload;
      if (!res.ok || !('flow_id' in data)) throw new Error(apiError(data, 'Unable to start Nubra login.'));
      setFlowId(data.flow_id);
      setMaskedPhone(data.masked_phone);
      setMessage(data.message);
      setStep(data.next_step);
      setCode(''); setMpin('');
      localStorage.setItem('nubra_phone', cleanPhone);
      localStorage.setItem('nubra_environment', data.environment);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start Nubra login.');
    } finally { setLoading(false); }
  }

  async function verifyFactor(e: React.FormEvent) {
    e.preventDefault();
    if (!flowId || code.length < codeLength) { setError(`Enter the ${step === 'totp' ? 'TOTP' : 'OTP'} code.`); return; }
    setLoading(true); setError('');
    try {
      const path = step === 'totp' ? '/api/auth/verify-totp' : '/api/auth/verify-otp';
      const body = step === 'totp' ? { flow_id: flowId, totp: code } : { flow_id: flowId, otp: code };
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as { message?: string } | ApiErrorPayload;
      if (!res.ok) throw new Error(apiError(data, 'Code verification failed.'));
      setMessage(typeof data.message === 'string' ? data.message : 'Continue with MPIN verification.');
      setMpin(''); setStep('mpin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Code verification failed.');
    } finally { setLoading(false); }
  }

  async function verifyMPIN(e: React.FormEvent) {
    e.preventDefault();
    if (!flowId || mpin.length < 4) { setError('Enter your Nubra MPIN.'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/verify-mpin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow_id: flowId, mpin }),
      });
      const data = (await res.json()) as SuccessResponse | ApiErrorPayload;
      if (!res.ok || !('access_token' in data)) throw new Error(apiError(data, 'MPIN verification failed.'));
      setSession(data); setStep('success'); setMessage(data.message);
      localStorage.setItem('nubra_session_payload', JSON.stringify(data));
      localStorage.setItem('nubra_session_token', data.access_token);
      localStorage.setItem('nubra_device_id', data.device_id);
      localStorage.setItem('nubra_login_date', todayIST());
      localStorage.setItem('nubra_raw_cookie', `authToken=${data.access_token}; sessionToken=${data.access_token}; deviceId=${data.device_id}`);
      setView('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MPIN verification failed.');
    } finally { setLoading(false); }
  }

  function enterDemo() {
    setSession(DEMO_SESSION);
    setView('dashboard');
  }

  /* ── NAV BAR ── */
  function renderNav(active: View) {
    const tabs: [View, string][] = [
      ['dashboard', 'Dashboard'],
      ['options', 'Options Desk'],
      ['positioning', 'Positioning'],
      ['scanner', 'Scanner'],
      ['webhook', 'Webhook'],
      ['scalper', 'Scalper'],
    ];
    return (
      <header className="dash-top">
        <div className="dash-top-l">
          <div className="logo">
            <div style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(120,201,255,0.12)', border: '1px solid rgba(120,201,255,0.18)', display: 'grid', placeItems: 'center', color: 'rgb(120,201,255)' }}>
              <Activity size={17} />
            </div>
            <span className="wm" style={{ fontSize: 15 }}>AlphedgeOSS</span>
          </div>
          <span className="topbar-sep" />
          <nav className="topbar-nav" aria-label="Primary navigation">
            {tabs.map(([v, label]) => (
              <button key={v} type="button" className={v === active ? 'nav-item active' : 'nav-item'} onClick={() => setView(v)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="dash-top-r">
          <div className="session-pill">
            <span className="live-dot" />
            {session?.environment ?? 'PROD'} / NSE
          </div>
          {session?.is_demo && (
            <span className="pill-v2 pill-accent">Demo</span>
          )}
          <ThemeToggle theme={theme} onToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} />
          <div className="profile-menu" ref={profileRef}>
            <button type="button" className="avatar" onClick={() => setProfileOpen(o => !o)} aria-expanded={profileOpen} aria-haspopup="menu">
              {initials}
            </button>
            {profileOpen && (
              <div className="profile-popover-v2" role="menu">
                <div>
                  <strong style={{ fontSize: 14, fontWeight: 500 }}>{session?.user_name ?? 'Nubra User'}</strong>
                  <div style={{ fontSize: 11, color: 'var(--fg-faint)', marginTop: 2 }}>{session?.account_id ?? 'NUBRA'}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="pill-v2">{session?.broker?.toLowerCase() ?? 'nubra'}</span>
                  <span className="pill-v2 pill-accent">{session?.environment ?? 'PROD'}</span>
                </div>
                <button type="button" className="ghost-inline" style={{ width: '100%', textAlign: 'center' }} onClick={signOut}>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
    );
  }

  /* ── LANDING ── */
  if (view === 'landing') {
    return (
      <div className="auth-scene landing-scene" data-theme={theme}>
        <div className="auth-bg">
          <div className="ambient a1" />
          <div className="ambient a2" />
          <div className="grid-pattern" />
        </div>
        <header className="auth-chrome">
          <div className="logo">
            <div style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(120,201,255,0.12)', border: '1px solid rgba(120,201,255,0.18)', display: 'grid', placeItems: 'center', color: 'rgb(120,201,255)' }}>
              <Activity size={17} />
            </div>
            <span className="wm" style={{ fontSize: 15 }}>AlphedgeOSS</span>
          </div>
          <div className="chrome-right">
            <span className="chrome-meta">
              <span className="live-dot" /> Nubra REST Terminal
            </span>
            <ThemeToggle theme={theme} onToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} />
          </div>
        </header>
        <main className="landing-stage">
          <div className="landing-halo" />
          <div className="eyebrow">
            <span className="live-dot" /> Secure Nubra Access
          </div>
          <h1 className="landing-title">AlphedgeOSS</h1>
          <p className="landing-sub">
            Sign in to your Nubra account and access live options data, positioning intelligence, volume scanners, TradingView webhooks and a real-time scalper — all in one terminal.
          </p>
          <div className="landing-cta">
            <button className="primary-btn" style={{ padding: '14px 28px', fontSize: 14 }} onClick={() => setView('login')}>
              Sign in with Nubra <ArrowRight size={16} />
            </button>
            <button className="ghost-inline" onClick={enterDemo}>
              Try Demo
            </button>
          </div>
          <div className="landing-pills">
            {[
              [<Lock size={14} />, 'OTP + MPIN'],
              [<TrendingUp size={14} />, 'Live Options'],
              [<Globe size={14} />, 'PROD & UAT'],
            ].map(([icon, label], i) => (
              <span key={i} className="lpill">
                {icon as React.ReactNode} {label as string}
              </span>
            ))}
          </div>
        </main>
        <footer className="auth-foot">
          <span>Copyright 2026 AlphedgeOSS</span>
          <span>Nubra REST Terminal</span>
        </footer>
      </div>
    );
  }

  /* ── LOGIN FLOW ── */
  if (view === 'login') {
    return (
      <div className="auth-scene" data-theme={theme}>
        <div className="auth-bg">
          <div className="ambient a1" />
          <div className="ambient a2" />
          <div className="grid-pattern" />
        </div>
        <header className="auth-chrome">
          <div className="logo">
            <div style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(120,201,255,0.12)', border: '1px solid rgba(120,201,255,0.18)', display: 'grid', placeItems: 'center', color: 'rgb(120,201,255)' }}>
              <Activity size={17} />
            </div>
            <span className="wm" style={{ fontSize: 15 }}>AlphedgeOSS</span>
          </div>
          <div className="chrome-right">
            <span className="chrome-meta">
              <span className="live-dot" /> {environment} / Nubra
            </span>
            <ThemeToggle theme={theme} onToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} />
          </div>
        </header>

        <div className="auth-stage">
          <div />
          <div className="glass-panel">
            <div className="panel-edge" />

            <div className="panel-head">
              <div className="eyebrow">
                <span className="env-dot prod" /> {environment} / NUBRA
              </div>
              <h2 className="panel-title">{step === 'success' ? 'Connected' : 'Sign in'}</h2>
              <p className="panel-sub">
                {step === 'success' ? 'Your Nubra REST session is active.' : 'Access live market data with your Nubra account.'}
              </p>
            </div>

            {/* ENV TOGGLE */}
            <div className="seg-control" style={{ marginBottom: 20 }}>
              <span className={`seg-pill${environment === 'UAT' ? ' right' : ''}`} />
              {(['PROD', 'UAT'] as const).map(env => (
                <button key={env} type="button" className={`seg-btn${environment === env ? ' on' : ''}`} onClick={() => {
                  if (step !== 'start') return;
                  setEnvironment(env);
                  localStorage.setItem('nubra_environment', env);
                  setError('');
                }}>
                  <span className={`env-dot ${env.toLowerCase()}`} /> {env}
                </button>
              ))}
            </div>

            {/* STEP RAIL */}
            {step !== 'start' && (
              <div className="step-rail">
                {['Identity', 'Verification', 'MPIN'].map((label, i) => (
                  <div key={label} className={`step${i === currentStep ? ' active' : ''}${i < currentStep ? ' done' : ''}`}>
                    <span className="step-n">{i < currentStep ? '✓' : `0${i + 1}`}</span>
                    <span className="step-l">{label}</span>
                  </div>
                ))}
              </div>
            )}

            {/* START */}
            {step === 'start' && (
              <form onSubmit={startLogin} className="form-body">
                <div className="seg-control" style={{ marginBottom: 0 }}>
                  <span className={`seg-pill${authMethod === 'totp' ? ' right' : ''}`} />
                  <button type="button" className={`seg-btn${authMethod === 'otp' ? ' on' : ''}`} onClick={() => setAuthMethod('otp')}>SMS OTP</button>
                  <button type="button" className={`seg-btn${authMethod === 'totp' ? ' on' : ''}`} onClick={() => setAuthMethod('totp')}>TOTP</button>
                </div>
                <div className="field">
                  <label className="field-label">Phone number</label>
                  <div className="field-row">
                    <span className="prefix">+91</span>
                    <input autoFocus type="tel" inputMode="numeric" value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="00000 00000" style={{ fontSize: 19 }} />
                    <span className="field-hint">{phone.length}/10</span>
                  </div>
                  <span className="field-line" />
                </div>
                <button type="submit" disabled={loading || !phoneReady} className="primary-btn">
                  {loading ? (authMethod === 'otp' ? 'Sending OTP…' : 'Preparing TOTP…') : authMethod === 'otp' ? 'Send OTP' : 'Continue with TOTP'}
                  <ArrowRight size={16} />
                </button>
                <button type="button" className="link-btn" style={{ textAlign: 'center' }} onClick={() => setView('landing')}>← Back to landing</button>
                <button type="button" className="ghost-inline" style={{ textAlign: 'center' }} onClick={enterDemo}>Try Demo instead</button>
              </form>
            )}

            {/* OTP / TOTP */}
            {(step === 'otp' || step === 'totp') && (
              <form onSubmit={verifyFactor} className="form-body">
                <div className="field">
                  <label className="field-label field-label-center" style={{ textAlign: 'center' }}>
                    {step === 'totp' ? 'Authenticator code' : `OTP sent to +91 ${maskedPhone}`}
                  </label>
                  <OtpCells value={code} length={codeLength} />
                  <div className="field-row" style={{ marginTop: 8 }}>
                    {step === 'totp' ? <KeyRound size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} /> : <Smartphone size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                    <input autoFocus inputMode="numeric" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, codeLength))} placeholder="000000" style={{ textAlign: 'center', letterSpacing: '0.16em', fontSize: 19 }} />
                  </div>
                  <span className="field-line" />
                </div>
                <button type="submit" disabled={loading || code.length < codeLength} className="primary-btn">
                  {loading ? 'Verifying…' : step === 'totp' ? 'Verify TOTP' : 'Verify OTP'}
                </button>
                <button type="button" className="link-btn" style={{ textAlign: 'center' }} onClick={() => { setStep('start'); setCode(''); setError(''); }}>← Back</button>
              </form>
            )}

            {/* MPIN */}
            {step === 'mpin' && (
              <form onSubmit={verifyMPIN} className="form-body">
                <div className="field">
                  <label className="field-label" style={{ textAlign: 'center' }}>Enter your MPIN</label>
                  <OtpCells value={mpin} length={4} secure />
                  <div className="field-row" style={{ marginTop: 8 }}>
                    <LockKeyhole size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <input autoFocus type="password" inputMode="numeric" value={mpin} onChange={e => setMpin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="0000" style={{ textAlign: 'center', letterSpacing: '0.16em', fontSize: 19 }} />
                  </div>
                  <span className="field-line" />
                </div>
                <button type="submit" disabled={loading || mpin.length < 4} className="primary-btn">
                  {loading ? 'Entering platform…' : 'Enter Platform'}
                </button>
                <button type="button" className="link-btn" style={{ textAlign: 'center' }} onClick={() => { setStep(authMethod === 'totp' ? 'totp' : 'otp'); setMpin(''); setError(''); }}>← Back</button>
              </form>
            )}

            {/* SUCCESS */}
            {step === 'success' && session && (
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, border: '1px solid rgba(124,207,94,0.25)', background: 'rgba(124,207,94,0.08)', borderRadius: 14 }}>
                  <ShieldCheck size={20} style={{ color: 'var(--pos)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{session.account_id}</div>
                    <div style={{ fontSize: 11, color: 'var(--pos-soft)', marginTop: 2 }}>{session.environment} / {session.broker}</div>
                  </div>
                </div>
                <button onClick={() => setView('dashboard')} className="primary-btn">Open Dashboard <ChevronRight size={16} /></button>
                <button onClick={signOut} className="ghost-inline" style={{ textAlign: 'center' }}>Sign Out</button>
              </div>
            )}

            {/* FEEDBACK */}
            {error
              ? <div className="err-banner" style={{ marginTop: 16 }}>{error}</div>
              : <div className="msg-banner" style={{ marginTop: 16 }}>{message}</div>
            }
          </div>
          <div />
        </div>

        <footer className="auth-foot">
          <span>Copyright 2026 AlphedgeOSS</span>
          <span>Nubra REST Terminal</span>
        </footer>
      </div>
    );
  }

  /* ── DASHBOARD ── */
  if (view === 'dashboard') {
    return (
      <div className="dash" data-theme={theme}>
        {renderNav('dashboard')}
        <main className="dash-main">
          {/* HERO */}
          <div className="hero">
            <div className="hero-l">
              <div className="eyebrow"><span className="live-dot" /> Nubra Session Active</div>
              <h1 className="hero-title">
                Welcome{session?.user_name ? `, ${session.user_name.split(' ')[0]}` : ''}.
              </h1>
              <p className="hero-sub">
                Your Nubra REST terminal is ready.{' '}
                {session?.is_demo
                  ? 'You are in demo mode — log in with a real account to enable live data and order placement.'
                  : `Account <strong>${session?.account_id}</strong> connected on ${session?.environment ?? 'PROD'}.`
                }
              </p>
            </div>
          </div>

          {/* SUMMARY TILES */}
          <div className="summary-grid">
            {[
              { label: 'Account ID', value: session?.account_id ?? '—', sub: session?.broker ?? 'Nubra' },
              { label: 'Environment', value: session?.environment ?? 'PROD', sub: 'Active session' },
              { label: 'Session', value: session?.is_demo ? 'Demo' : 'Live', sub: session?.is_demo ? 'Read-only mode' : 'Full access' },
              { label: 'Expires in', value: session?.expires_in ? `${Math.floor(session.expires_in / 60)}m` : '—', sub: 'Remaining time' },
            ].map(({ label, value, sub }) => (
              <div key={label} className="summary-card">
                <span className="summary-label">{label}</span>
                <strong style={{ fontFamily: 'JetBrains Mono, monospace' }}>{value}</strong>
                <small>{sub}</small>
              </div>
            ))}
          </div>

          {/* MODULE GRID */}
          <div>
            <div className="section-head">
              <h2>Terminal Modules</h2>
              <span className="section-meta">All systems nominal</span>
            </div>
            <div className="module-grid">
              {[
                { view: 'positioning' as View, icon: <BarChart2 size={20} />, title: 'Positioning', sub: 'Market internals, sector rotation, breadth, options pressure and opportunity scanner.' },
                { view: 'scanner' as View, icon: <TrendingUp size={20} />, title: 'Volume Scanner', sub: 'Real-time volume breakout detection across NIFTY 300 stocks.' },
                { view: 'webhook' as View, icon: <Webhook size={20} />, title: 'TV Webhook', sub: 'Connect TradingView alerts to live Nubra order execution.' },
                { view: 'scalper' as View, icon: <Zap size={20} />, title: 'Scalper', sub: 'Live NIFTY / BANKNIFTY option charts with delta-neutral pair finder.' },
                { view: 'dashboard' as View, icon: <Server size={20} />, title: 'API Terminal', sub: 'Raw Nubra REST session with direct backend proxy access.', active: true },
                { view: 'dashboard' as View, icon: <ShieldCheck size={20} />, title: 'Session Info', sub: `Connected as ${session?.account_id ?? '—'} · ${session?.environment ?? 'PROD'} · ${session?.broker ?? 'Nubra'}` },
              ].map(({ view: v, icon, title, sub, active }) => (
                <button key={title} type="button" className={`module-card${active ? ' active' : ''}`} onClick={() => setView(v)}>
                  <div className="mc-top">
                    <div className="mc-icon">{icon}</div>
                  </div>
                  <div className="mc-body">
                    <div className="mc-title">{title}</div>
                    <div className="mc-sub">{sub}</div>
                  </div>
                  <div className="mc-foot">
                    <span className="mc-cta">Open <ChevronRight size={13} /></span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* MINI CHART */}
          <div style={{ maxWidth: 1400, margin: '0 auto', width: '100%' }}>
            <div className="sb-card">
              <div className="sb-card-head">
                <div>
                  <span className="sb-card-kicker">Market Pulse</span>
                  <h3>NIFTY Options Desk</h3>
                </div>
                <span className="pill-v2 pill-success">Live</span>
              </div>
              <MiniSparkline />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {[['Delta Tilt', '+0.42', 'var(--pos)'], ['IV Rank', '68%', 'var(--accent)'], ['PCR', '1.18', 'var(--neg)']].map(([l, v, c]) => (
                  <div key={l} style={{ border: '1px solid var(--hairline)', background: 'rgba(255,255,255,0.025)', padding: '10px 12px', borderRadius: 8 }}>
                    <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-faint)' }}>{l}</div>
                    <strong style={{ display: 'block', marginTop: 6, fontSize: 20, color: c }}>{v}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ── POSITIONING ── */
  if (view === 'positioning') {
    return (
      <div className="dash positioning-view" data-theme={theme}>
        {renderNav('positioning')}
        <div className="positioning-shell">
          <div className="positioning-hero">
            <span className="positioning-eyebrow">Market Intelligence</span>
            <h1>Positioning Dashboard</h1>
            <p>Real-time market internals, sector rotation, breadth analysis, options pressure and opportunity scanner.</p>
          </div>

          {/* STATE STRIP */}
          <div className="positioning-state-strip">
            {[
              { label: 'Market Regime', value: 'Bull Trend', sub: 'Momentum' },
              { label: 'Breadth', value: '68%', sub: 'Advancing' },
              { label: 'IV Rank', value: '42', sub: 'Percentile' },
              { label: 'PCR', value: '1.18', sub: 'Put/Call Ratio' },
              { label: 'VIX', value: '14.2', sub: 'India VIX' },
            ].map(({ label, value, sub }) => (
              <div key={label} className="positioning-metric-tile">
                <div className="positioning-metric-top">
                  <span>{label}</span>
                </div>
                <strong>{value}</strong>
                <small>{sub}</small>
              </div>
            ))}
          </div>

          {/* TERMINAL LAYOUT */}
          <div className="positioning-terminal-layout">
            <div>
              <div className="positioning-grid">
                {/* BREADTH */}
                <div className="positioning-widget" style={{ gridColumn: 'span 6' }}>
                  <div className="positioning-widget-head">
                    <div><h2>Market Breadth</h2><span>Advance / Decline</span></div>
                    <span className="positioning-direction-badge bullish">Bullish</span>
                  </div>
                  <div className="positioning-score-row">
                    <strong>68</strong>
                    <span className="positioning-signal-chip positive">Advancing</span>
                  </div>
                  <div className="positioning-breadth-bar"><div style={{ width: '68%' }} /></div>
                  <div className="positioning-metric-grid">
                    {[['Advancing', '204'], ['Declining', '96'], ['Unchanged', '0']].map(([l, v]) => (
                      <div key={l}><span>{l}</span><strong>{v}</strong></div>
                    ))}
                  </div>
                </div>

                {/* OPTIONS PRESSURE */}
                <div className="positioning-widget" style={{ gridColumn: 'span 6' }}>
                  <div className="positioning-widget-head"><h2>Options Pressure</h2><span>CE vs PE OI</span></div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {[
                      { side: 'CE', oi: '28.4L', pct: 58, cls: 'pos-text' },
                      { side: 'PE', oi: '20.6L', pct: 42, cls: 'neg-text' },
                    ].map(({ side, oi, pct, cls }) => (
                      <div key={side} style={{ border: '1px solid var(--hairline)', background: 'rgba(255,255,255,.025)', padding: '8px 10px' }}>
                        <div style={{ fontSize: 10, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '.1em' }}>{side} Open Interest</div>
                        <strong className={cls} style={{ display: 'block', fontSize: 22, margin: '2px 0 6px' }}>{oi}</strong>
                        <div style={{ height: 6, background: 'rgba(255,255,255,.07)', overflow: 'hidden', border: '1px solid rgba(255,255,255,.055)' }}>
                          <i style={{ display: 'block', height: '100%', width: `${pct}%`, background: side === 'CE' ? 'var(--pos)' : 'var(--neg)' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* SECTOR MAP */}
                <div className="positioning-widget positioning-widget-wide">
                  <div className="positioning-widget-head"><h2>Sector Rotation</h2><span>NSE Sector Performance</span></div>
                  <div className="positioning-sector-map">
                    {[
                      { name: 'BANK', score: 72, color: '#22c55e' },
                      { name: 'IT', score: 61, color: '#22c55e' },
                      { name: 'AUTO', score: 54, color: '#22c55e' },
                      { name: 'PHARMA', score: 38, color: '#f59e0b' },
                      { name: 'ENERGY', score: 29, color: '#ef4444' },
                      { name: 'METAL', score: 45, color: '#f59e0b' },
                      { name: 'REALTY', score: 58, color: '#22c55e' },
                      { name: 'FMCG', score: 33, color: '#ef4444' },
                    ].map(({ name, score, color }) => (
                      <div key={name} className="positioning-sector-tile" style={{ background: `color-mix(in oklch, ${color} 8%, transparent)` }}>
                        <div className="positioning-sector-top">
                          <strong>{name}</strong>
                        </div>
                        <div className="positioning-sector-score">
                          <span style={{ color }}>{score}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* OPPORTUNITY TABLE */}
                <div className="positioning-widget positioning-widget-wide">
                  <div className="positioning-widget-head"><h2>Opportunity Scanner</h2><span>Top setups</span></div>
                  <div className="positioning-realtime-table">
                    <div className="positioning-rt-row positioning-rt-head">
                      <span>#</span><span>Symbol</span><span>Setup</span><span>Score</span><span>MOM</span><span>Signal</span>
                    </div>
                    {[
                      { rank: 1, sym: 'RELIANCE', setup: 'Breakout', score: 84, mom: '+2.1%', signal: 'BUY' },
                      { rank: 2, sym: 'HDFCBANK', setup: 'Retest', score: 77, mom: '+1.3%', signal: 'BUY' },
                      { rank: 3, sym: 'INFY', setup: 'Pullback', score: 65, mom: '-0.4%', signal: 'WAIT' },
                      { rank: 4, sym: 'ITC', setup: 'Range Break', score: 71, mom: '+0.8%', signal: 'BUY' },
                    ].map(({ rank, sym, setup, score, mom, signal }) => (
                      <div key={sym} className="positioning-rt-row">
                        <span style={{ color: 'var(--fg-faint)', fontFamily: 'monospace', fontSize: 10 }}>{rank}</span>
                        <span><strong>{sym}</strong><small>NSE</small></span>
                        <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{setup}</span>
                        <span><span className={`positioning-score-pill ${score > 70 ? 'positive' : 'negative'}`}>{score}</span></span>
                        <span className={score > 0 && mom.startsWith('+') ? 'pos-text' : 'neg-text'} style={{ fontSize: 11 }}>{mom}</span>
                        <span><span className={`positioning-direction-badge ${signal === 'BUY' ? 'bullish' : ''}`}>{signal}</span></span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* SIDE RAIL */}
            <div className="positioning-side-rail">
              <div className="positioning-widget">
                <div className="positioning-widget-head"><h2>Alerts</h2><span>Live</span></div>
                <div className="positioning-rail">
                  {[
                    { title: 'NIFTY CE OI spike', msg: 'Large call writing at 24500 CE — potential resistance.', severity: '' },
                    { title: 'VIX compression', msg: 'VIX below 14 — favourable for option selling strategies.', severity: '' },
                    { title: 'PCR elevated', msg: 'PCR crossed 1.2 — contrarian bullish signal.', severity: 'warning' },
                  ].map(({ title, msg, severity }) => (
                    <div key={title} className={`positioning-rail-item ${severity}`}>
                      <strong style={{ fontSize: 11 }}>{title}</strong>
                      <p>{msg}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="positioning-widget">
                <div className="positioning-widget-head"><h2>Commentary</h2><span>AI Digest</span></div>
                <div className="positioning-rail" style={{ maxHeight: '30vh' }}>
                  {[
                    'Market breadth holding above 65% — breadth thrust intact.',
                    'Bank Nifty futures premium expanding — institutional accumulation.',
                    'Options pain point at 24,300 — max pain analysis.',
                  ].map((line, i) => (
                    <div key={i} className="positioning-rail-item">
                      <p>{line}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── SCANNER ── */
  if (view === 'scanner') {
    return <ScannerView theme={theme} session={session} renderNav={renderNav} />;
  }

  /* ── OPTIONS DESK ── */
  if (view === 'options') {
    return <OptionsDesk theme={theme} session={session} renderNav={renderNav} />;
  }

  /* ── WEBHOOK ── */
  if (view === 'webhook') {
    const webhookPath = '/api/webhooks/tradingview';
    return (
      <div className="dash" data-theme={theme}>
        {renderNav('webhook')}
        <main className="subview-main">
          <div className="panel-heading">
            <div>
              <h2>TradingView Webhook</h2>
              <p>Connect TradingView strategy alerts to live Nubra order execution via a local webhook tunnel.</p>
            </div>
            <span className={`pill-v2 ${session?.is_demo ? '' : 'pill-accent'}`}>{session?.is_demo ? 'Demo' : 'Configured'}</span>
          </div>

          {/* STEP 1 — Configure */}
          <div className="sb-card">
            <div className="step-heading">
              <span className={`step-badge${session?.is_demo ? '' : ' done'}`}>1</span>
              <div>
                <h2>Configure Webhook</h2>
                <p>Set your Nubra session and a secret token to authenticate incoming TradingView requests.</p>
              </div>
            </div>
            <div className="settings-grid-v2">
              <div className="setting-field-v2">
                <span className="setting-label-v2">Environment</span>
                <span className="setting-value-v2">{session?.environment ?? 'PROD'}</span>
              </div>
              <div className="setting-field-v2">
                <span className="setting-label-v2">Account ID</span>
                <span className="setting-value-v2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{session?.account_id ?? '—'}</span>
              </div>
              <div className="setting-field-v2">
                <span className="setting-label-v2">Webhook Path</span>
                <span className="setting-value-v2" style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{webhookPath}</span>
              </div>
              <div className="setting-field-v2">
                <span className="setting-label-v2">Execution</span>
                <span className="setting-value-v2">{session?.is_demo ? 'Disabled (Demo)' : 'INTRADAY'}</span>
              </div>
            </div>
          </div>

          {/* STEP 2 — Alert JSON */}
          <div className="sb-card">
            <div className="step-heading">
              <span className="step-badge">2</span>
              <div>
                <h2>Alert JSON Template</h2>
                <p>Paste this JSON into your TradingView alert message. Edit the symbol and quantity as needed.</p>
              </div>
            </div>
            <pre className="code-block">{JSON.stringify({
              secret: 'YOUR_SECRET_TOKEN',
              strategy: 'My Strategy',
              instrument: 'RELIANCE',
              exchange: 'NSE',
              action: '{{strategy.order.action}}',
              quantity: 1,
              tag: 'alphedge_tv',
            }, null, 2)}</pre>
            <button className="ghost-inline-accent ghost-inline" onClick={() => navigator.clipboard?.writeText('{}')}>
              Copy JSON
            </button>
          </div>

          {/* STEP 3 — History */}
          <div className="sb-card">
            <div className="step-heading">
              <span className="step-badge">3</span>
              <div>
                <h2>Webhook History</h2>
                <p>Recent events received by the webhook endpoint.</p>
              </div>
            </div>
            {session?.is_demo
              ? <div className="msg-banner">Demo mode — no real webhook events. Start a live session and trigger alerts from TradingView to see events here.</div>
              : <div className="table-empty" style={{ border: '1px dashed var(--hairline-2)', padding: 24, borderRadius: 12, textAlign: 'center', color: 'var(--fg-faint)' }}>No webhook events received yet.</div>
            }
          </div>
        </main>
      </div>
    );
  }

  /* ── SCALPER ── */
  if (view === 'scalper') {
    return (
      <div className="dash" data-theme={theme}>
        {renderNav('scalper')}
        <main className="subview-main">
          <div className="panel-heading">
            <div>
              <h2>Options Scalper</h2>
              <p>Live NIFTY / BANKNIFTY option charts with delta-neutral pair finder, indicator builder, and automated execution.</p>
            </div>
            <span className={`pill-v2 ${session?.is_demo ? '' : 'pill-accent'}`}>{session?.is_demo ? 'Demo' : 'Live'}</span>
          </div>

          {/* CONTROLS */}
          <div className="sb-card">
            <div className="sb-card-head"><div><span className="sb-card-kicker">Instrument</span><h3>Scalper Controls</h3></div></div>
            <div className="scalper-controls">
              <label>
                Underlying
                <select className="field-select" style={{ minWidth: 140 }}>
                  <option>NIFTY</option>
                  <option>BANKNIFTY</option>
                </select>
              </label>
              <label>
                CE Strike
                <input type="text" className="field-input" defaultValue="24300" style={{ minWidth: 110 }} />
              </label>
              <label>
                PE Strike
                <input type="text" className="field-input" defaultValue="24300" style={{ minWidth: 110 }} />
              </label>
              <label>
                Interval
                <select className="field-select" style={{ minWidth: 90 }}>
                  {['1m', '3m', '5m', '15m'].map(i => <option key={i}>{i}</option>)}
                </select>
              </label>
              <label>
                Expiry
                <input type="text" className="field-input" placeholder="Nearest" style={{ minWidth: 110 }} />
              </label>
              <button className="primary-button" style={{ alignSelf: 'flex-end' }}>Load Snapshot</button>
            </div>
          </div>

          {/* DELTA NEUTRAL */}
          <div className="sb-card">
            <div className="sb-card-head">
              <div><span className="sb-card-kicker">Delta Neutral Pairs</span><h3>Ranked by Neutrality Score</h3></div>
            </div>
            {session?.is_demo
              ? (
                <div className="positioning-realtime-table">
                  <div className="positioning-rt-row positioning-rt-head" style={{ gridTemplateColumns: '.2fr .6fr .6fr .5fr .4fr .4fr .4fr' }}>
                    <span>#</span><span>CE</span><span>PE</span><span>Spot</span><span>Δ CE</span><span>Δ PE</span><span>Score</span>
                  </div>
                  {[
                    { r: 1, ce: 'NIFTY 24300 CE', pe: 'NIFTY 24300 PE', spot: '24,312', dce: '0.49', dpe: '-0.51', score: 98 },
                    { r: 2, ce: 'NIFTY 24350 CE', pe: 'NIFTY 24250 PE', spot: '24,312', dce: '0.44', dpe: '-0.47', score: 91 },
                    { r: 3, ce: 'NIFTY 24400 CE', pe: 'NIFTY 24200 PE', spot: '24,312', dce: '0.38', dpe: '-0.42', score: 84 },
                  ].map(({ r, ce, pe, spot, dce, dpe, score }) => (
                    <div key={r} className="positioning-rt-row" style={{ gridTemplateColumns: '.2fr .6fr .6fr .5fr .4fr .4fr .4fr' }}>
                      <span style={{ color: 'var(--fg-faint)', fontFamily: 'monospace', fontSize: 10 }}>{r}</span>
                      <span><strong style={{ fontSize: 10 }}>{ce}</strong></span>
                      <span><strong style={{ fontSize: 10 }}>{pe}</strong></span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>₹{spot}</span>
                      <span className="pos-text" style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{dce}</span>
                      <span className="neg-text" style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{dpe}</span>
                      <span><span className="positioning-score-pill positive">{score}</span></span>
                    </div>
                  ))}
                </div>
              )
              : <div className="msg-banner">Load a snapshot to display delta-neutral pairs for this expiry.</div>
            }
          </div>

          {/* TRADE BUTTONS */}
          <div className="sb-card">
            <div className="sb-card-head"><div><span className="sb-card-kicker">Order Placement</span><h3>Scalper Execution</h3></div></div>
            {session?.is_demo
              ? <div className="msg-banner">Order placement requires a live (non-demo) Nubra session with UAT access.</div>
              : (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {[
                    { label: 'BUY CE', cls: 'pill-success' },
                    { label: 'SELL CE', cls: 'pill-danger' },
                    { label: 'BUY PE', cls: 'pill-success' },
                    { label: 'SELL PE', cls: 'pill-danger' },
                  ].map(({ label, cls }) => (
                    <button key={label} className={`pill-v2 ${cls}`} style={{ cursor: 'pointer', padding: '10px 20px', fontSize: 12 }}>{label}</button>
                  ))}
                </div>
              )
            }
          </div>
        </main>
      </div>
    );
  }

  return null;
}
