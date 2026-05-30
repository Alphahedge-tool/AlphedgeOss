import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  CrosshairMode,
  Time,
  UTCTimestamp,
  BusinessDay,
} from 'lightweight-charts';
import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import './MtmAnalyzer.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuccessResponse {
  access_token: string;
  device_id: string;
  environment: 'PROD' | 'UAT';
  is_demo?: boolean;
}

interface OcLeg {
  sp?: number; strike_price?: number;
  ltp?: number; ltpchg?: number;
  oi?: number; volume?: number;
  iv?: number;
  delta?: number; gamma?: number; theta?: number; vega?: number;
}

interface OcChain {
  ce: OcLeg[];
  pe: OcLeg[];
  atm?: number;
  cp?: number;
  all_expiries?: string[];
}

interface SearchItem {
  stock_name?: string;
  nubra_name?: string;
  asset?: string;
  exchange?: string;
  derivative_type?: string;
  asset_type?: string;
  option_type?: string;
  expiry?: number | string;
  strike_price?: number;
}


const INTERVALS = ['1m','3m','5m','15m','30m','1h','1d'] as const;
type Interval = typeof INTERVALS[number];
const IST_OFFSET = 5.5 * 60 * 60;

const POPULAR: SearchItem[] = [
  { stock_name:'NIFTY 50',   nubra_name:'NIFTY',      exchange:'NSE', asset_type:'INDEX', derivative_type:'INDEX' },
  { stock_name:'BANKNIFTY',  nubra_name:'BANKNIFTY',  exchange:'NSE', asset_type:'INDEX', derivative_type:'INDEX' },
  { stock_name:'FINNIFTY',   nubra_name:'FINNIFTY',   exchange:'NSE', asset_type:'INDEX', derivative_type:'INDEX' },
  { stock_name:'MIDCPNIFTY', nubra_name:'MIDCPNIFTY', exchange:'NSE', asset_type:'INDEX', derivative_type:'INDEX' },
  { stock_name:'SENSEX',     nubra_name:'SENSEX',     exchange:'BSE', asset_type:'INDEX', derivative_type:'INDEX' },
];

const WATCHLIST_SEED: (SearchItem & { ltp?: number; chg?: number; chgPct?: number; up?: boolean; signal?: number })[] = [
  { stock_name:'RELAXO',     nubra_name:'RELAXO',     exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:339.25, chg:37.25, chgPct:12.33, up:true, signal:8 },
  { stock_name:'TEGA',       nubra_name:'TEGA',       exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:1714.00, chg:114.30, chgPct:7.15, up:true, signal:9 },
  { stock_name:'FEDERALBNK', nubra_name:'FEDERALBNK', exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:288.20, chg:-0.70, chgPct:-0.24, up:false, signal:11 },
  { stock_name:'SUPRIYA',    nubra_name:'SUPRIYA',    exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:968.70, chg:161.45, chgPct:20.00, up:true, signal:9 },
  { stock_name:'ELGIEQUIP',  nubra_name:'ELGIEQUIP',  exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:575.70, chg:-2.20, chgPct:-0.38, up:false, signal:1 },
  { stock_name:'ALKEM',      nubra_name:'ALKEM',      exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:5535.00, chg:83.50, chgPct:1.53, up:true, signal:8 },
  { stock_name:'HYUNDAI',    nubra_name:'HYUNDAI',    exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:1982.00, chg:68.40, chgPct:3.57, up:true, signal:10 },
  { stock_name:'BANCOINDIA', nubra_name:'BANCOINDIA', exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:655.00, chg:29.15, chgPct:4.66, up:true, signal:7 },
  { stock_name:'JUBLFOOD',   nubra_name:'JUBLFOOD',   exchange:'NSE', asset_type:'STOCK', derivative_type:'STOCK', ltp:430.20, chg:2.90, chgPct:0.68, up:true, signal:8 },
];

const TV_CHART_COLORS = {
  bg: '#0b0b0b',
  grid: 'rgba(148,163,184,0.12)',
  text: '#d6d8df',
  border: 'rgba(148,163,184,0.22)',
  crosshair: '#758696',
  up: '#54BA7C',
  down: '#F63C3C',
  upWick: '#54BA7C',
  downWick: '#F63C3C',
  upVolume: 'rgba(84,186,124,0.42)',
  downVolume: 'rgba(246,60,60,0.42)',
};

const INTRADAY = new Set(['1m','3m','5m','15m','30m','1h']);
function isIntraday(iv: string) { return INTRADAY.has(iv); }

function histDays(iv: string) {
  return ({ '1m':3,'3m':5,'5m':7,'15m':15,'30m':20,'1h':45,'1d':365 } as Record<string,number>)[iv] ?? 30;
}

function toChartTime(tsNs: string | number, iv: string): Time {
  const utcSec = Number(BigInt(tsNs) / 1_000_000_000n);
  if (isIntraday(iv)) return (utcSec + IST_OFFSET) as UTCTimestamp;
  const d = new Date((utcSec + IST_OFFSET) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } as BusinessDay;
}

function snapToCandle(utcSec: number, iv: string): Time {
  const intSec = ({ '1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'1d':86400 } as Record<string,number>)[iv] ?? 300;
  const istSec = utcSec + IST_OFFSET;
  const snapped = Math.floor(istSec / intSec) * intSec;
  if (isIntraday(iv)) return snapped as UTCTimestamp;
  const d = new Date(snapped * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } as BusinessDay;
}

function sortKey(t: Time) {
  if (typeof t === 'object') return (t as BusinessDay).year * 10000 + (t as BusinessDay).month * 100 + (t as BusinessDay).day;
  return t as number;
}

function nubraType(item: SearchItem) {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type || '').toUpperCase();
  if (dt === 'FUT'   || at === 'FUT')   return 'FUT';
  if (dt === 'OPT'   || at === 'OPT')   return 'OPT';
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  return 'STOCK';
}

function itemName(item: SearchItem) {
  return item.nubra_name || item.stock_name || item.asset || '';
}

function fmtPrice(v: number) {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtLakh(v: number | null | undefined) {
  if (v == null || v === 0) return '—';
  if (v >= 1e7)  return (v/1e7).toFixed(2) + 'Cr';
  if (v >= 1e5)  return (v/1e5).toFixed(2) + 'L';
  if (v >= 1000) return (v/1000).toFixed(1) + 'K';
  return v.toString();
}
function fmtExpiry(exp: string | number) {
  const s = String(exp);
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
  }
  return s;
}

function getTypeLabel(item: SearchItem) {
  const t = nubraType(item);
  return { INDEX:'INDEX', STOCK:'STOCK', FUT:'FUT', OPT:'OPT' }[t] ?? 'STOCK';
}
function getTypeCls(item: SearchItem) {
  const t = nubraType(item);
  return { INDEX:'mtm-type-index', STOCK:'mtm-type-stock', FUT:'mtm-type-fut', OPT:'mtm-type-opt' }[t] ?? 'mtm-type-stock';
}

// ── Option Chain Table (pure DOM for no-flicker live updates) ────────────────

function buildOcTable(
  chain: OcChain,
  onCeClick: (strike: number) => void,
  onPeClick: (strike: number) => void,
): { container: HTMLDivElement; cellMap: Map<string, HTMLTableCellElement> } {
  const cellMap = new Map<string, HTMLTableCellElement>();

  const cpPaise = chain.cp ?? null;
  const atmPaise = chain.atm ?? null;
  const cpRs = cpPaise != null ? cpPaise / 100 : null;
  const atmRs = atmPaise != null ? atmPaise / 100 : null;
  const refPrice = cpRs ?? atmRs;

  const map: Record<number, { ce: OcLeg | null; pe: OcLeg | null }> = {};
  for (const ce of chain.ce) {
    const sp = strikRs(ce);
    if (!map[sp]) map[sp] = { ce: null, pe: null };
    map[sp].ce = ce;
  }
  for (const pe of chain.pe) {
    const sp = strikRs(pe);
    if (!map[sp]) map[sp] = { ce: null, pe: null };
    map[sp].pe = pe;
  }

  const strikes = Object.keys(map).map(Number).sort((a, b) => a - b);
  const atm = refPrice != null
    ? strikes.reduce((b, s) => Math.abs(s - refPrice) < Math.abs(b - refPrice) ? s : b, strikes[0])
    : null;

  const maxCeOi = Math.max(1, ...chain.ce.map(c => c.oi ?? 0));
  const maxPeOi = Math.max(1, ...chain.pe.map(p => p.oi ?? 0));

  const table = document.createElement('table');
  table.className = 'mtm-oc-table';

  // thead
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th class="ce-head" style="width:8%">OI</th>
    <th class="ce-head" style="width:7%">Vol</th>
    <th class="ce-head" style="width:6%">IV%</th>
    <th class="ce-head" style="width:6%">Delta</th>
    <th class="ce-head" style="width:10%">LTP</th>
    <th class="strike-head" style="width:13%">Strike</th>
    <th class="pe-head" style="width:7%">IV%</th>
    <th class="pe-head" style="width:10%">LTP</th>
    <th class="pe-head" style="width:6%">Delta</th>
    <th class="pe-head" style="width:7%">Vol</th>
    <th class="pe-head" style="width:8%">OI</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const strike of strikes) {
    const { ce, pe } = map[strike];
    const isAtm = strike === atm;
    const tr = document.createElement('tr');
    if (isAtm) tr.className = 'atm-row';
    tr.dataset.strike = String(strike);

    const cePct = ce?.oi ? Math.min(100, ((ce.oi) / maxCeOi) * 100) : 0;
    const pePct = pe?.oi ? Math.min(100, ((pe.oi) / maxPeOi) * 100) : 0;

    const ceLtpVal = ce?.ltp != null ? ce.ltp / 100 : null;
    const peLtpVal = pe?.ltp != null ? pe.ltp / 100 : null;
    const ceUp = (ce?.ltpchg ?? 0) >= 0;
    const peUp = (pe?.ltpchg ?? 0) >= 0;

    tr.innerHTML = `
      <td class="ce-side" data-key="${strike}-ce-oi">${fmtLakh(ce?.oi ?? null)}<div class="oi-bar-wrap"><div class="oi-bar oi-bar-ce" style="width:${cePct.toFixed(0)}%"></div></div></td>
      <td class="ce-side" data-key="${strike}-ce-vol">${fmtLakh(ce?.volume ?? null)}</td>
      <td class="ce-side iv-cell" data-key="${strike}-ce-iv">${ce?.iv != null ? (ce.iv * 100).toFixed(1) : '—'}</td>
      <td class="ce-side" data-key="${strike}-ce-delta">${ce?.delta != null ? ce.delta.toFixed(3) : '—'}</td>
      <td class="ce-side ltp-cell ${ceUp?'up':'down'}" data-key="${strike}-ce-ltp">
        ${ceLtpVal != null ? `₹${fmtPrice(ceLtpVal)}<div class="ltp-chg ${ceUp?'up':'down'}">${ce?.ltpchg!=null?(ceUp?'+':'')+ce.ltpchg.toFixed(2)+'%':''}</div>` : '—'}
      </td>
      <td class="strike-cell">${isAtm ? '<span class="atm-label">ATM</span>' : ''}${strike.toLocaleString('en-IN')}</td>
      <td class="pe-side iv-cell" data-key="${strike}-pe-iv">${pe?.iv != null ? (pe.iv * 100).toFixed(1) : '—'}</td>
      <td class="pe-side ltp-cell ${peUp?'up':'down'}" data-key="${strike}-pe-ltp">
        ${peLtpVal != null ? `₹${fmtPrice(peLtpVal)}<div class="ltp-chg ${peUp?'up':'down'}">${pe?.ltpchg!=null?(peUp?'+':'')+pe.ltpchg.toFixed(2)+'%':''}</div>` : '—'}
      </td>
      <td class="pe-side" data-key="${strike}-pe-delta">${pe?.delta != null ? pe.delta.toFixed(3) : '—'}</td>
      <td class="pe-side" data-key="${strike}-pe-vol">${fmtLakh(pe?.volume ?? null)}</td>
      <td class="pe-side" data-key="${strike}-pe-oi">${fmtLakh(pe?.oi ?? null)}<div class="oi-bar-wrap"><div class="oi-bar oi-bar-pe" style="width:${pePct.toFixed(0)}%"></div></div></td>
    `;

    // register cells for live update
    tr.querySelectorAll('td[data-key]').forEach(td => {
      const key = (td as HTMLTableCellElement).dataset.key!;
      cellMap.set(key, td as HTMLTableCellElement);
    });

    // click handlers
    tr.addEventListener('click', (e) => {
      const tds = [...tr.querySelectorAll('td')];
      const idx = tds.indexOf((e.target as HTMLElement).closest('td') as HTMLTableCellElement);
      if (idx < 5)  onCeClick(strike);
      else if (idx > 5) onPeClick(strike);
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);

  const wrap = document.createElement('div');
  wrap.appendChild(table);

  // scroll ATM into view after render
  if (atm) {
    requestAnimationFrame(() => {
      const atmRow = tbody.querySelector('.atm-row') as HTMLElement | null;
      atmRow?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  return { container: wrap, cellMap };
}

function strikRs(row: OcLeg) {
  const raw = row.sp ?? row.strike_price;
  if (raw == null) return 0;
  return raw > 10000 ? raw / 100 : raw;
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  session: SuccessResponse | null;
  theme: 'dark' | 'light';
}

export default function MtmAnalyzer({ session, theme }: Props) {
  // Auth headers helper — passes session token + device id to Go proxy → Nubra
  const authHeaders = useCallback((): Record<string, string> => {
    if (!session?.access_token) return {};
    return {
      'Authorization': `Bearer ${session.access_token}`,
      'x-device-id': session.device_id || 'Nubra-OSS-mtm',
    };
  }, [session]);

  // layout — view state replaced by showChain toggle in new 3-column design

  // chart state
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const oiCanvasRef       = useRef<HTMLCanvasElement>(null);
  const oiPopupRef        = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  const candleRef         = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef            = useRef<ISeriesApi<'Histogram'> | null>(null);
  const [interval, setInterval] = useState<Interval>('5m');
  const [instrument, setInstrument] = useState<SearchItem | null>(WATCHLIST_SEED[0]);
  const [chartPrice, setChartPrice]   = useState('339.25');
  const [chartChange, setChartChange] = useState('+37.25 (12.33%)');
  const [chartPriceUp, setChartPriceUp] = useState(true);
  const [chartLoading, setChartLoading] = useState('Select a symbol to load chart');
  const [ohlc, setOhlc] = useState<{o:number;h:number;l:number;c:number;v?:number} | null>(null);
  const [oiEnabled, setOiEnabled]     = useState(false);
  const [oiPopupOpen, setOiPopupOpen] = useState(false);
  const [oiExpiries, setOiExpiries]   = useState<string[]>([]);
  const [oiSelExpiry, setOiSelExpiry] = useState('');
  const [showCalls, setShowCalls]     = useState(true);
  const [showPuts, setShowPuts]       = useState(true);
  const oiChainRef   = useRef<OcChain | null>(null);
  const oiWidthScale = useRef(1.0);
  const oiDragRef    = useRef({ dragging: false, startX: 0, startScale: 1.0 });
  const lastBarRef   = useRef<CandlestickData | null>(null);
  const dayOpenRef   = useRef<number | null>(null);
  const earliestRef  = useRef<Date | null>(null);
  const loadingMoreRef = useRef(false);
  const countdownRef = useRef<HTMLDivElement>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const oiLoopRef    = useRef<number | null>(null);
  const allBarsRef   = useRef<CandlestickData[]>([]);
  const allVolRef    = useRef<HistogramData[]>([]);

  // option chain state
  const ocScrollRef   = useRef<HTMLDivElement>(null);
  const cellMapRef    = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const ocPollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const [ocSymbol, setOcSymbol]   = useState('NIFTY');
  const [ocExchange, setOcExchange] = useState('NSE');
  const [ocExpiry, setOcExpiry]   = useState('');
  const [ocExpiries, setOcExpiries] = useState<string[]>([]);
  const [ocSpot, setOcSpot]       = useState('');
  const [ocLoading, setOcLoading] = useState(false);
  const ocSymbolRef  = useRef('NIFTY');
  const ocExchRef    = useRef('NSE');
  const ocExpiryRef  = useRef('');

  // search
  const [searchQ, setSearchQ]         = useState('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [searchOpen, setSearchOpen]   = useState(false);
  const searchRef  = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // watchlist
  type WatchItem = SearchItem & { ltp?: number; chg?: number; chgPct?: number; up?: boolean; signal?: number };
  const [watchlist, setWatchlist] = useState<WatchItem[]>(WATCHLIST_SEED);
  const [sideTab, setSideTab] = useState<'watchlist'|'positions'>('watchlist');
  const [showChain, setShowChain] = useState(false);
  const [watchlistOpen, setWatchlistOpen] = useState(true);

  const addToWatchlist = useCallback((item: SearchItem) => {
    const name = itemName(item).toUpperCase();
    setWatchlist(prev => {
      if (prev.some(w => itemName(w).toUpperCase() === name)) return prev;
      return [...prev, { ...item }];
    });
  }, []);

  const removeFromWatchlist = useCallback((name: string) => {
    setWatchlist(prev => prev.filter(w => itemName(w).toUpperCase() !== name.toUpperCase()));
  }, []);

  // ws
  const wsReady   = useRef(false);
  const [wsStatus, setWsStatus] = useState<'connecting'|'live'|'offline'>('connecting');

  // ── Init chart ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background:  { color: TV_CHART_COLORS.bg },
        textColor:   TV_CHART_COLORS.text,
        fontSize:    12,
        fontFamily:  "'Inter', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: TV_CHART_COLORS.grid },
        horzLines: { color: TV_CHART_COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: TV_CHART_COLORS.crosshair, width: 1, labelBackgroundColor: '#363a45' },
        horzLine: { color: TV_CHART_COLORS.crosshair, width: 1, labelBackgroundColor: TV_CHART_COLORS.up },
      },
      rightPriceScale: { borderColor: TV_CHART_COLORS.border, minimumWidth: 72 },
      timeScale: {
        borderColor: TV_CHART_COLORS.border, timeVisible: true, secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
      },
      handleScroll: true,
      handleScale:  true,
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: TV_CHART_COLORS.up, downColor: TV_CHART_COLORS.down,
      borderUpColor: TV_CHART_COLORS.up, borderDownColor: TV_CHART_COLORS.down,
      wickUpColor: TV_CHART_COLORS.upWick, wickDownColor: TV_CHART_COLORS.downWick,
    });
    candleRef.current = candle;

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'vol',
      lastValueVisible: false, priceLineVisible: false, visible: false,
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volRef.current = vol;

    chart.subscribeCrosshairMove(param => {
      updateCountdownPos();
      if (oiLoopRef.current) drawOIProfile();
      const bar = param.seriesData?.get(candle) as CandlestickData | undefined;
      const vBar = param.seriesData?.get(vol) as HistogramData | undefined;
      if (bar) setOhlc({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: vBar?.value });
      else if (lastBarRef.current) setOhlc({ o: lastBarRef.current.open, h: lastBarRef.current.high, l: lastBarRef.current.low, c: lastBarRef.current.close });
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (oiLoopRef.current) drawOIProfile();
      if (!range || loadingMoreRef.current || !instrument || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMoreHistory();
    });

    const ro = new ResizeObserver(() => {
      if (chartContainerRef.current)
        chart.resize(chartContainerRef.current.clientWidth, chartContainerRef.current.clientHeight);
    });
    ro.observe(chartContainerRef.current);

    return () => { chart.remove(); ro.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme sync
  useEffect(() => {
    if (!chartRef.current) return;
    const dark = theme === 'dark';
    chartRef.current.applyOptions({
      layout: { background: { color: dark ? TV_CHART_COLORS.bg : '#ffffff' }, textColor: dark ? TV_CHART_COLORS.text : '#131722' },
      grid: { vertLines: { color: dark ? TV_CHART_COLORS.grid : '#f0f3fa' }, horzLines: { color: dark ? TV_CHART_COLORS.grid : '#f0f3fa' } },
    });
  }, [theme]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.resize(chartContainerRef.current.clientWidth, chartContainerRef.current.clientHeight);
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [watchlistOpen]);

  // ── Chart data loading ───────────────────────────────────────────────────────
  const fetchChartRange = useCallback(async (instr: SearchItem, iv: string, start: Date, end: Date) => {
    const sym  = itemName(instr);
    const exch = instr.exchange || 'NSE';
    const type = nubraType(instr);
    const res  = await fetch('/api/historical', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ query: [{ exchange: exch, type, values: [sym], fields: ['open','high','low','close','cumulative_volume'], startDate: start.toISOString(), endDate: end.toISOString(), interval: iv, intraDay: false, realTime: false }] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const bars: CandlestickData[] = [], volBars: HistogramData[] = [];
    for (const g of data.result || [])
      for (const sm of g.values || [])
        for (const chart of Object.values(sm) as Record<string, { ts?: string; v: number }[][]>[]) {
          const c = chart as unknown as { open: {ts?:string;v:number}[]; high: {ts?:string;v:number}[]; low: {ts?:string;v:number}[]; close: {ts?:string;v:number}[]; cumulative_volume?: {ts?:string;v:number}[] };
          const opens = c.open || [], highs = c.high || [], lows = c.low || [], closes = c.close || [], vols = c.cumulative_volume || [];
          const len = Math.min(opens.length, highs.length, lows.length, closes.length);
          for (let i = 0; i < len; i++) {
            const tsNs = opens[i].ts;
            if (!tsNs) continue;
            const t = toChartTime(tsNs, iv);
            const o = opens[i].v/100, h = highs[i].v/100, l = lows[i].v/100, cl = closes[i].v/100;
            bars.push({ time: t, open: o, high: h, low: l, close: cl });
            if (vols[i]?.v) volBars.push({ time: t, value: vols[i].v, color: cl >= o ? TV_CHART_COLORS.upVolume : TV_CHART_COLORS.downVolume });
          }
        }
    bars.sort((a,b) => sortKey(a.time) - sortKey(b.time));
    volBars.sort((a,b) => sortKey(a.time) - sortKey(b.time));
    return { bars, volBars };
  }, []);

  const loadSymbol = useCallback(async (instr: SearchItem, iv?: string) => {
    const useIv = iv ?? interval;
    setInstrument(instr);
    setChartLoading('Loading historical data…');
    allBarsRef.current = [];
    allVolRef.current  = [];
    earliestRef.current = null;
    lastBarRef.current  = null;
    dayOpenRef.current  = null;
    stopCountdown();

    if (candleRef.current) candleRef.current.setData([]);
    if (volRef.current) volRef.current.setData([]);

    try {
      const end   = new Date();
      const start = new Date(end.getTime() - histDays(useIv) * 86400000);
      const { bars, volBars } = await fetchChartRange(instr, useIv, start, end);
      if (!bars.length) { setChartLoading('No historical data available.'); return; }

      allBarsRef.current = bars;
      allVolRef.current  = volBars;
      earliestRef.current = start;
      lastBarRef.current  = bars[bars.length - 1];
      dayOpenRef.current  = bars[0].open;

      candleRef.current?.setData(bars);
      volRef.current?.setData(volBars);

      const len = bars.length;
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 180), to: len + 5 });
      setChartLoading('');
      startCountdown();

      const lb = bars[bars.length - 1];
      updatePriceDisplay(lb.close, bars[0].open);

      // Connect Rust WS for live candle ticks
      connectIndexWs(itemName(instr).toUpperCase(), useIv);
    } catch (e) {
      setChartLoading(`Error: ${(e as Error).message}`);
    }
  }, [interval, fetchChartRange]);

  const loadMoreHistory = useCallback(async () => {
    if (loadingMoreRef.current || !earliestRef.current || !instrument) return;
    loadingMoreRef.current = true;
    try {
      const end   = new Date(earliestRef.current.getTime() - 60000);
      const start = new Date(end.getTime() - histDays(interval) * 86400000);
      const { bars, volBars } = await fetchChartRange(instrument, interval, start, end);
      if (bars.length) {
        allBarsRef.current = [...bars, ...allBarsRef.current];
        allVolRef.current  = [...volBars, ...allVolRef.current];
        earliestRef.current = start;
        dayOpenRef.current  = allBarsRef.current[0].open;
        candleRef.current?.setData(allBarsRef.current);
        volRef.current?.setData(allVolRef.current);
      }
    } catch { /* ignore */ }
    loadingMoreRef.current = false;
  }, [instrument, interval, fetchChartRange]);

  function updatePriceDisplay(price: number, open: number) {
    const diff = price - (open || price);
    const pct  = open ? ((diff / open) * 100).toFixed(2) : '0.00';
    const up   = diff >= 0;
    setChartPrice(`₹${price.toFixed(2)}`);
    setChartChange(`${up?'+':''}${diff.toFixed(2)} (${up?'+':''}${pct}%)`);
    setChartPriceUp(up);
  }

  // ── Candle countdown ──────────────────────────────────────────────────────────
  function startCountdown() {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = window.setInterval(tickCountdown, 1000) as unknown as ReturnType<typeof setInterval>;
    tickCountdown();
  }
  function stopCountdown() {
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    if (countdownRef.current) countdownRef.current.classList.add('hidden');
  }
  function tickCountdown() {
    const intSec = ({ '1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'1d':86400 } as Record<string,number>)[interval] ?? 300;
    const nowUtc = Math.floor(Date.now() / 1000);
    const remaining = intSec - ((nowUtc + IST_OFFSET) % intSec);
    const mm = Math.floor(remaining / 60).toString().padStart(2,'0');
    const ss = (remaining % 60).toString().padStart(2,'0');
    if (countdownRef.current) {
      countdownRef.current.textContent = `${mm}:${ss}`;
      countdownRef.current.classList.remove('hidden');
      updateCountdownPos();
    }
  }
  function updateCountdownPos() {
    if (!countdownRef.current || !lastBarRef.current || !candleRef.current) return;
    const y = candleRef.current.priceToCoordinate(lastBarRef.current.close);
    if (y != null) countdownRef.current.style.top = `${Math.round(y) + 20}px`;
  }

  // ── OI Profile ────────────────────────────────────────────────────────────────
  const drawOIProfile = useCallback(() => {
    const canvas = oiCanvasRef.current;
    const container = chartContainerRef.current;
    if (!canvas || !container || !oiChainRef.current || !candleRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w   = container.clientWidth;
    const h   = container.clientHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width  = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.scale(dpr, dpr);
    }
    ctx.clearRect(0, 0, w, h);

    const chain = oiChainRef.current;
    const mapOi: Record<number, { ceOi: number; peOi: number }> = {};
    for (const ce of chain.ce) {
      const sp = strikRs(ce);
      if (!mapOi[sp]) mapOi[sp] = { ceOi: 0, peOi: 0 };
      mapOi[sp].ceOi = ce.oi ?? 0;
    }
    for (const pe of chain.pe) {
      const sp = strikRs(pe);
      if (!mapOi[sp]) mapOi[sp] = { ceOi: 0, peOi: 0 };
      mapOi[sp].peOi = pe.oi ?? 0;
    }

    const allOi = Object.values(mapOi).flatMap(v => [v.ceOi, v.peOi]).filter(v => v > 0).sort((a,b) => b-a);
    const maxOi = allOi[Math.floor(allOi.length * 0.15)] || allOi[0] || 1;
    const priceScaleW = 72;
    const maxBarW = (w - priceScaleW) * 0.35 * oiWidthScale.current;

    for (const [strikeStr, { ceOi, peOi }] of Object.entries(mapOi)) {
      const strike = Number(strikeStr);
      const y = candleRef.current.priceToCoordinate(strike);
      if (y == null || y < 2 || y > h - 2) continue;
      const right = w - priceScaleW;
      if (showCalls && ceOi > 0) {
        const bw = Math.max(3, Math.min((ceOi / maxOi) * maxBarW, maxBarW));
        ctx.globalAlpha = 0.75;
        ctx.fillStyle   = '#26a69a';
        ctx.fillRect(right - bw, y - 10, bw, 10);
      }
      if (showPuts && peOi > 0) {
        const bw = Math.max(3, Math.min((peOi / maxOi) * maxBarW, maxBarW));
        ctx.globalAlpha = 0.75;
        ctx.fillStyle   = '#ef5350';
        ctx.fillRect(right - bw, y, bw, 10);
      }
    }
    ctx.globalAlpha = 1;
    // drag handle line
    const handleX = w - priceScaleW - maxBarW;
    ctx.strokeStyle = 'rgba(150,150,180,0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(handleX, 20); ctx.lineTo(handleX, h - 40); ctx.stroke();
    ctx.setLineDash([]);
  }, [showCalls, showPuts]);

  function startOILoop() {
    if (oiLoopRef.current) return;
    const loop = () => {
      drawOIProfile();
      oiLoopRef.current = requestAnimationFrame(() => setTimeout(loop, 100) as unknown as number);
    };
    oiLoopRef.current = requestAnimationFrame(loop);
  }

  async function loadOIChain() {
    if (!instrument) return;
    const sym = itemName(instrument);
    try {
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}`, { headers: authHeaders() });
      const data = await res.json();
      oiChainRef.current = data.chain || null;
      if (!oiChainRef.current) return;
      const expiries = oiChainRef.current.all_expiries || [];
      setOiExpiries(expiries);
      setOiSelExpiry(expiries[0] || '');
      setOiEnabled(true);
      if (oiCanvasRef.current) oiCanvasRef.current.classList.remove('hidden');
      startOILoop();
    } catch { /* ignore */ }
  }

  // OI canvas drag
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;
    const onDown = (e: MouseEvent) => {
      if (!oiEnabled) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const priceScaleW = 72;
      const maxBarW = (container.clientWidth - priceScaleW) * 0.35 * oiWidthScale.current;
      const handleX = container.clientWidth - priceScaleW - maxBarW;
      if (Math.abs(x - handleX) <= 10) {
        oiDragRef.current = { dragging: true, startX: x, startScale: oiWidthScale.current };
        container.style.cursor = 'ew-resize';
        e.preventDefault();
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!oiEnabled) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (oiDragRef.current.dragging) {
        const dx = oiDragRef.current.startX - x;
        const base = (container.clientWidth - 72) * 0.35;
        oiWidthScale.current = Math.max(0.2, Math.min(3.0, oiDragRef.current.startScale + dx / base));
        drawOIProfile();
      } else {
        const base = (container.clientWidth - 72) * 0.35;
        const handleX = container.clientWidth - 72 - base * oiWidthScale.current;
        container.style.cursor = Math.abs(x - handleX) <= 10 ? 'ew-resize' : '';
      }
    };
    const onUp = () => {
      if (oiDragRef.current.dragging) { oiDragRef.current.dragging = false; container.style.cursor = ''; }
    };
    container.addEventListener('mousedown', onDown);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseup', onUp);
    return () => { container.removeEventListener('mousedown', onDown); container.removeEventListener('mousemove', onMove); container.removeEventListener('mouseup', onUp); };
  }, [oiEnabled, drawOIProfile]);

  // ── WebSocket — connects to Rust realtime bridge (/ws/realtime) ─────────────
  // The Rust server proxies to Nubra's WS, decodes protobuf, and sends JSON.
  // Stream types: "index" for OHLCV candle ticks, "option" for OC updates.
  const indexWsRef  = useRef<WebSocket | null>(null);
  const ocWsRef     = useRef<WebSocket | null>(null);
  const indexWsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ocWsTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectIndexWs = useCallback((sym: string, iv: string) => {
    if (indexWsRef.current) { indexWsRef.current.onclose = null; indexWsRef.current.close(); }
    if (!session?.access_token) return;
    const token = encodeURIComponent(session.access_token); // JWT has +/= that break query strings
    const env   = session.environment || 'PROD';
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ivParam = encodeURIComponent(iv);
    const url   = `${proto}://127.0.0.1:3003/ws/realtime?token=${token}&instrument=${sym}&stream=ohlcv&interval=${ivParam}&env=${env}&exchange=NSE`;
    const ws = new WebSocket(url);
    indexWsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen  = () => { wsReady.current = true; setWsStatus('live'); };
    ws.onclose = () => {
      wsReady.current = false; setWsStatus('offline');
      indexWsTimer.current = setTimeout(() => connectIndexWs(sym, iv), 4000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as { type: string; payload?: { indexes?: RustIndex[]; instruments?: RustIndex[] } };
        // ohlcv = OHLCV candle buckets from index_bucket stream
        if ((msg.type === 'ohlcv' || msg.type === 'index') && msg.payload) handleRustIndexTick(msg.payload, sym);
      } catch { /* ignore malformed */ }
    };
  }, [session]);

  const connectOcWs = useCallback((sym: string, expiry: string) => {
    if (ocWsRef.current) { ocWsRef.current.onclose = null; ocWsRef.current.close(); }
    if (!session?.access_token || !expiry) return;
    const token = encodeURIComponent(session.access_token);
    const env   = session.environment || 'PROD';
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://127.0.0.1:3003/ws/realtime?token=${token}&instrument=${sym}&stream=option&expiry=${expiry}&env=${env}&exchange=NSE`;
    const ws = new WebSocket(url);
    ocWsRef.current = ws;

    ws.onclose = () => {
      ocWsTimer.current = setTimeout(() => connectOcWs(sym, expiry), 4000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as { type: string; payload?: OcChain & { asset?: string; expiry?: string } };
        if (msg.type === 'option' && msg.payload) handleOcTick(msg.payload);
      } catch { /* ignore */ }
    };
  }, [session]);

  // Clean up both WS on unmount
  useEffect(() => () => {
    if (indexWsTimer.current) clearTimeout(indexWsTimer.current);
    if (ocWsTimer.current)    clearTimeout(ocWsTimer.current);
    if (indexWsRef.current)   { indexWsRef.current.onclose = null; indexWsRef.current.close(); }
    if (ocWsRef.current)      { ocWsRef.current.onclose = null; ocWsRef.current.close(); }
  }, []);

  // Rust sends: { type:"index", payload:{ indexes:[{indexname,timestamp,open,high,low,close,bucket_timestamp,...}] } }
  interface RustIndex {
    indexname: string;
    timestamp: string | number;
    bucket_timestamp?: string | number;
    open: number; high: number; low: number; close: number;
    cumulative_volume?: number;
  }

  function handleRustIndexTick(payload: { indexes?: RustIndex[]; instruments?: RustIndex[] }, sym: string) {
    if (!candleRef.current) return;
    const all = [...(payload.indexes || []), ...(payload.instruments || [])];
    for (const b of all) {
      const bname = (b.indexname || '').toUpperCase();
      if (bname === sym || sym.startsWith(bname) || bname.startsWith(sym)) {
        applyOhlcvBucket(b);
        break;
      }
    }
  }

  function applyOhlcvBucket(b: RustIndex) {
    try {
      const tsStr = (b.bucket_timestamp && b.bucket_timestamp !== 0 && b.bucket_timestamp !== '0')
        ? String(b.bucket_timestamp) : String(b.timestamp);
      if (!tsStr || tsStr === '0') return;
      const utcSec = Number(BigInt(tsStr) / 1_000_000_000n);
      const barTime = snapToCandle(utcSec, interval);
      const candle: CandlestickData = {
        time: barTime,
        open:  b.open  / 100,
        high:  b.high  / 100,
        low:   b.low   / 100,
        close: b.close / 100,
      };
      if (!candle.open || !candle.close) return;
      candleRef.current?.update(candle);
      lastBarRef.current = candle;
      updatePriceDisplay(candle.close, dayOpenRef.current || candle.open);
      updateCountdownPos();
    } catch { /* ignore */ }
  }

  function handleOcTick(data: OcChain & { asset?: string; expiry?: string }) {
    if (!data) return;
    const asset  = (data.asset  || '').toUpperCase();
    const expiry = data.expiry  || '';
    if (asset !== ocSymbolRef.current || expiry !== ocExpiryRef.current) return;
    updateOcCells(data);
  }

  function updateOcCells(chain: OcChain) {
    const cpPaise = chain.cp ?? null;
    if (cpPaise != null) setOcSpot(`₹${fmtPrice(Number(cpPaise) / 100)}`);
    for (const ce of chain.ce) {
      const sp = strikRs(ce);
      updateCell(`${sp}-ce-ltp`,   fmtLtpCellHtml(ce, true));
      updateCell(`${sp}-ce-oi`,    fmtLakh(ce.oi ?? null));
      updateCell(`${sp}-ce-vol`,   fmtLakh(ce.volume ?? null));
      updateCell(`${sp}-ce-iv`,    ce.iv != null ? (ce.iv * 100).toFixed(1) : '—');
      updateCell(`${sp}-ce-delta`, ce.delta != null ? ce.delta.toFixed(3) : '—');
    }
    for (const pe of chain.pe) {
      const sp = strikRs(pe);
      updateCell(`${sp}-pe-ltp`,   fmtLtpCellHtml(pe, false));
      updateCell(`${sp}-pe-oi`,    fmtLakh(pe.oi ?? null));
      updateCell(`${sp}-pe-vol`,   fmtLakh(pe.volume ?? null));
      updateCell(`${sp}-pe-iv`,    pe.iv != null ? (pe.iv * 100).toFixed(1) : '—');
      updateCell(`${sp}-pe-delta`, pe.delta != null ? pe.delta.toFixed(3) : '—');
    }
  }

  function fmtLtpCellHtml(row: OcLeg, isCe: boolean) {
    const ltp = row.ltp;
    if (ltp == null) return '—';
    const price = ltp / 100;
    const up = (row.ltpchg ?? 0) >= 0;
    const pct = row.ltpchg != null ? `<div class="ltp-chg ${up?'up':'down'}">${up?'+':''}${Number(row.ltpchg).toFixed(2)}%</div>` : '';
    return `₹${fmtPrice(price)}${pct}`;
  }

  function updateCell(key: string, html: string) {
    const td = cellMapRef.current.get(key);
    if (td && td.innerHTML !== html) td.innerHTML = html;
  }

  // ── Option Chain loading ───────────────────────────────────────────────────────
  const loadOcChain = useCallback(async (symbol: string, exchange: string, expiry: string) => {
    ocSymbolRef.current  = symbol;
    ocExchRef.current    = exchange;
    ocExpiryRef.current  = expiry;
    setOcLoading(true);
    cellMapRef.current.clear();
    if (ocScrollRef.current) ocScrollRef.current.innerHTML = '';

    try {
      const params = new URLSearchParams({ exchange });
      if (expiry) params.set('expiry', expiry);
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(symbol)}?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const chain: OcChain = data.chain || {};

      const cpPaise = chain.cp ?? null;
      if (cpPaise != null) setOcSpot(`₹${fmtPrice(Number(cpPaise) / 100)}`);

      const expiries = chain.all_expiries || [];
      if (expiries.length && !expiry) {
        setOcExpiries(expiries);
        setOcExpiry(expiries[0]);
        ocExpiryRef.current = expiries[0];
        // reload with first expiry
        const p2 = new URLSearchParams({ exchange });
        p2.set('expiry', expiries[0]);
        const r2   = await fetch(`/api/optionchain/${encodeURIComponent(symbol)}?${p2}`, { headers: authHeaders() });
        const d2   = await r2.json();
        const ch2: OcChain = d2.chain || {};
        const cp2 = ch2.cp ?? null;
        if (cp2 != null) setOcSpot(`₹${fmtPrice(Number(cp2) / 100)}`);
        renderOcTable(ch2, symbol);
      } else {
        if (expiries.length) setOcExpiries(expiries);
        renderOcTable(chain, symbol);
      }

      // Connect Rust WS for live option chain ticks
      connectOcWs(symbol, ocExpiryRef.current);

      // REST poll fallback every 3s
      if (ocPollRef.current) clearInterval(ocPollRef.current);
      ocPollRef.current = window.setInterval(async () => {
        if (!ocSymbolRef.current || !ocExpiryRef.current) return;
        try {
          const pp = new URLSearchParams({ exchange: ocExchRef.current });
          pp.set('expiry', ocExpiryRef.current);
          const r = await fetch(`/api/optionchain/${encodeURIComponent(ocSymbolRef.current)}?${pp}`, { headers: authHeaders() });
          const d = await r.json();
          if (d.chain) updateOcCells(d.chain);
        } catch { /* ignore */ }
      }, 3000) as unknown as ReturnType<typeof setInterval>;

    } catch (e) {
      if (ocScrollRef.current) ocScrollRef.current.innerHTML = `<div style="padding:24px;color:#475569;font-size:12px">Error: ${(e as Error).message}</div>`;
    } finally {
      setOcLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectOcWs]);

  function renderOcTable(chain: OcChain, _symbol: string) {
    const scroll = ocScrollRef.current;
    if (!scroll) return;
    const { container, cellMap } = buildOcTable(
      chain,
      (strike) => navigateToOptionChart(_symbol, strike, 'CE'),
      (strike) => navigateToOptionChart(_symbol, strike, 'PE'),
    );
    cellMapRef.current = cellMap;
    // Use replaceChildren to avoid React/DOM removeChild mismatch
    scroll.replaceChildren(container);
  }

  async function navigateToOptionChart(underlying: string, strikeRs: number, optType: 'CE' | 'PE') {
    try {
      const q   = `${underlying}${Math.round(strikeRs)}${optType}`;
      const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=50`, { headers: authHeaders() });
      const data = await res.json();
      const match = (data.results || []).find((item: SearchItem) => {
        if ((item.derivative_type || '').toUpperCase() !== 'OPT') return false;
        if ((item.option_type || '').toUpperCase() !== optType) return false;
        const sp = Number(item.strike_price);
        return sp === Math.round(strikeRs) || sp === Math.round(strikeRs) * 100 || Math.round(sp / 100) === Math.round(strikeRs);
      });
      if (match) { setShowChain(false); loadSymbol(match); }
    } catch { /* ignore */ }
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  function handleSearchInput(q: string) {
    setSearchQ(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.length < 2) { setSearchResults(POPULAR); setSearchOpen(true); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=40`, { headers: authHeaders() });
        const data = await res.json();
        const matched = POPULAR.filter(p => (p.stock_name||'').toLowerCase().includes(q.toLowerCase()) || (p.nubra_name||'').toLowerCase().includes(q.toLowerCase()));
        setSearchResults([...matched, ...(data.results || [])]);
        setSearchOpen(true);
      } catch { setSearchOpen(false); }
    }, 250);
  }

  function selectSearchItem(item: SearchItem) {
    setSearchOpen(false);
    setSearchQ('');
    loadSymbol(item);
    // also seed option chain if in both/chain mode
    const sym = itemName(item).toUpperCase();
    setOcSymbol(sym);
    loadOcChain(sym, item.exchange || 'NSE', '');
  }

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
      if (oiPopupRef.current && !oiPopupRef.current.contains(e.target as Node)) setOiPopupOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // interval change reloads chart
  const handleIntervalChange = (iv: Interval) => {
    setInterval(iv);
    if (instrument) loadSymbol(instrument, iv);
  };

  // ── Quick pick ────────────────────────────────────────────────────────────────

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="mtm-root">
      {/* ── 3-column workspace — nav is rendered by parent .dash ── */}
      <div className={`mtm-workspace${watchlistOpen ? '' : ' watchlist-collapsed'}`}>

        {!watchlistOpen && (
          <button
            className="mtm-watchlist-toggle mtm-watchlist-toggle-open"
            onClick={() => setWatchlistOpen(true)}
            aria-label="Show watchlist"
            title="Show watchlist"
          >
            <span>›</span>
            <strong>Watchlist</strong>
          </button>
        )}

        {/* ════════════════ LEFT SIDEBAR ════════════════ */}
        <div className="mtm-sidebar">

          {/* Sidebar tab bar */}
          <div className="mtm-sidebar-tabs">
            <button
              className={`mtm-sidebar-tab${sideTab === 'watchlist' ? ' active' : ''}`}
              onClick={() => setSideTab('watchlist')}
            >My Watchlists</button>
            <button
              className={`mtm-sidebar-tab${sideTab === 'positions' ? ' active' : ''}`}
              onClick={() => setSideTab('positions')}
            >AI Watchlists</button>
            <button
              className="mtm-watchlist-close"
              onClick={() => setWatchlistOpen(false)}
              aria-label="Hide watchlist"
              title="Hide watchlist"
            >
              ‹
            </button>
          </div>

          {/* ── Watchlist ── */}
          {sideTab === 'watchlist' && (
            <div className="mtm-watchlist">

              <div className="mtm-watch-filter-tabs">
                <button>Top Gainers</button>
                <button>Top Losers</button>
                <button className="active"><span>Volume Surge</span><i /></button>
              </div>

              <div className="mtm-ai-watch-card">
                <div className="mtm-ai-watch-title">
                  <span>Volume Surge Watchlist</span>
                  <small>AI Digest</small>
                </div>

              {/* Search inside sidebar */}
              <div className="mtm-wl-search-wrap" ref={searchRef}>
                <div className="mtm-wl-search-row">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    className="mtm-wl-search-input"
                    placeholder="Search symbols or ask AI for volume opportunities"
                    value={searchQ}
                    onChange={e => handleSearchInput(e.target.value)}
                    onFocus={() => { if (searchQ.length < 2) { setSearchResults(POPULAR); setSearchOpen(true); } }}
                  />
                </div>
                {searchOpen && (
                  <div className="mtm-wl-dropdown">
                    {searchResults.length === 0
                      ? <div className="mtm-search-empty">No results</div>
                      : searchResults.slice(0, 12).map((item, i) => (
                        <div key={i} className="mtm-wl-drop-item"
                          onClick={() => {
                            selectSearchItem(item);
                            addToWatchlist(item);
                          }}
                        >
                          <div className="mtm-wl-drop-name">{item.stock_name || item.nubra_name || item.asset}</div>
                          <div className="mtm-wl-drop-meta">
                            <span className="mtm-wl-drop-exch">{item.exchange || 'NSE'}</span>
                            <span className={`mtm-search-type ${getTypeCls(item)}`}>{getTypeLabel(item)}</span>
                          </div>
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>

                <div className="mtm-ai-watch-meta">
                  <span>Last scan</span>
                  <strong>29 May 6:42PM</strong>
                  <span className="mtm-refresh-dot" />
                  <button>View rationale</button>
                </div>
                <div className="mtm-ai-watch-count">260 symbols matched the volume-surge criteria</div>
              </div>

              <div className="mtm-wl-head">
                <span>Instrument</span>
                <span>LTP</span>
              </div>

              {/* Watchlist rows */}
              <div className="mtm-wl-list">
                {watchlist.map((w, i) => {
                  const name = itemName(w).toUpperCase();
                  const active = instrument && itemName(instrument).toUpperCase() === name;
                  return (
                    <div
                      key={i}
                      className={`mtm-wl-row${active ? ' active' : ''}`}
                      onClick={() => selectSearchItem(w)}
                    >
                      <div className="mtm-wl-row-left">
                        <span className="mtm-wl-sym">{name}<small>{w.signal ?? 8}</small></span>
                        <span className="mtm-wl-exch">{w.exchange || 'NSE'}</span>
                      </div>
                      <div className="mtm-wl-row-right">
                        {w.ltp != null
                          ? <>
                              <span className={`mtm-wl-ltp ${w.up ? 'up' : 'down'}`}>
                                {w.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                              </span>
                              {w.chgPct != null && (
                                <span className={`mtm-wl-chg ${w.up ? 'up' : 'down'}`}>
                                  {w.chg != null ? `${w.chg >= 0 ? '+' : ''}${w.chg.toFixed(2)} ` : ''}
                                  ({w.chgPct.toFixed(2)}%)
                                </span>
                              )}
                            </>
                          : <span className="mtm-wl-ltp-empty">—</span>
                        }
                        <button className="mtm-wl-remove" onClick={e => { e.stopPropagation(); removeFromWatchlist(name); }} title="Remove">×</button>
                      </div>
                    </div>
                  );
                })}
                {watchlist.length === 0 && (
                  <div className="mtm-wl-empty">Search and add symbols to watchlist</div>
                )}
              </div>
            </div>
          )}

          {/* ── Positions (placeholder for next step) ── */}
          {sideTab === 'positions' && (
            <div className="mtm-positions-empty">
              <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
              <div>AI watchlists will appear here</div>
            </div>
          )}
        </div>

        {/* ════════════════ CENTER: TOOLBAR + CHART ════════════════ */}
        <div className="mtm-center">

          {/* Chart toolbar */}
          <div className="mtm-chart-toolbar">

            {/* Symbol + price */}
            <div className="mtm-ct-symbol">
              {instrument
                ? <>
                    <span className="mtm-symbol-name">{itemName(instrument)}</span>
                    <span className="mtm-ct-exch">{instrument.exchange || 'NSE'}</span>
                    {chartPrice && <span className={`mtm-price ${chartPriceUp ? 'up' : 'down'}`}>{chartPrice}</span>}
                    {chartChange && <span className={`mtm-change ${chartPriceUp ? 'up' : 'down'}`}>{chartChange}</span>}
                  </>
                : <span className="mtm-ct-placeholder">Select a symbol</span>
              }
            </div>

            <div className="mtm-market-tabs">
              <button className="active">Overview</button>
              <button>Fundamentals</button>
              <button onClick={() => setShowChain(v => !v)}>Option Chain</button>
            </div>

            {/* Interval pills */}
            <div className="mtm-interval-group">
              {INTERVALS.map(iv => (
                <button key={iv}
                  className={`mtm-interval-btn${interval === iv ? ' active' : ''}`}
                  onClick={() => handleIntervalChange(iv)}
                >{iv}</button>
              ))}
            </div>

            {/* OI Profile */}
            <div style={{ position:'relative' }} ref={oiPopupRef}>
              <button
                className={`mtm-btn${oiEnabled ? ' primary' : ''}`}
                onClick={() => { setOiPopupOpen(v => !v); if (!oiChainRef.current && instrument) loadOIChain(); }}
              >OI Profile</button>
              {oiPopupOpen && (
                <div className="mtm-oi-popup open">
                  <h4>OI Profile Settings</h4>
                  <div className="mtm-oi-expiry-list">
                    {oiExpiries.slice(0,6).map(exp => (
                      <label key={exp} className="mtm-oi-expiry-row">
                        <input type="radio" name="oi-expiry" value={exp} checked={oiSelExpiry === exp} onChange={() => setOiSelExpiry(exp)} />
                        {fmtExpiry(exp)}
                      </label>
                    ))}
                  </div>
                  <div className="mtm-oi-toggle-row">
                    <label><input type="checkbox" checked={showCalls} onChange={e => setShowCalls(e.target.checked)} /> Calls</label>
                    <label><input type="checkbox" checked={showPuts}  onChange={e => setShowPuts(e.target.checked)}  /> Puts</label>
                  </div>
                  <div className="mtm-oi-popup-btns">
                    <button className="mtm-btn primary" onClick={async () => {
                      if (oiSelExpiry && instrument) {
                        const sym = itemName(instrument);
                        const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?expiry=${oiSelExpiry}`, { headers: authHeaders() });
                        const data = await res.json();
                        oiChainRef.current = data.chain || null;
                        drawOIProfile();
                      }
                      setOiEnabled(true);
                      if (oiCanvasRef.current) oiCanvasRef.current.classList.remove('hidden');
                      startOILoop();
                      setOiPopupOpen(false);
                    }}>Apply</button>
                    <button className="mtm-btn" onClick={() => {
                      setOiEnabled(false);
                      if (oiCanvasRef.current) oiCanvasRef.current.classList.add('hidden');
                      if (oiLoopRef.current) { cancelAnimationFrame(oiLoopRef.current); oiLoopRef.current = null; }
                      setOiPopupOpen(false);
                    }}>Hide</button>
                  </div>
                </div>
              )}
            </div>

            {/* Option Chain toggle button */}
            <button
              className={`mtm-btn${showChain ? ' primary' : ''}`}
              onClick={() => setShowChain(v => !v)}
            >Option Chain</button>

            {/* Expiry when chain is visible */}
            {showChain && ocExpiries.length > 0 && (
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span className="mtm-toolbar-label">Expiry</span>
                <select className="mtm-select" value={ocExpiry}
                  onChange={e => { setOcExpiry(e.target.value); loadOcChain(ocSymbol, ocExchange, e.target.value); }}
                >
                  {ocExpiries.map(exp => <option key={exp} value={exp}>{fmtExpiry(exp)}</option>)}
                </select>
              </div>
            )}

            <div className="mtm-order-actions">
              <button className="buy">Buy</button>
              <button className="sell">Sell</button>
            </div>

            {/* WS status */}
            <div className="mtm-status-pill" style={{ marginLeft:'auto' }}>
              <div className={`mtm-status-dot${wsStatus === 'live' ? ' live' : ''}`} />
              {wsStatus === 'live' ? 'Live' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}
            </div>
          </div>

          <div className="mtm-tv-commandbar">
            <button className="mtm-tv-search">RELAXO</button>
            <button className="mtm-tv-plus">+</button>
            <span className="mtm-tv-sep" />
            <button>3m</button>
            <span className="mtm-tv-sep" />
            <button>⌘</button>
            <button>ƒx&nbsp; Indicators</button>
            <label className="mtm-tv-check"><span /> OI Profile</label>
            <span className="mtm-tv-sep" />
            <button>↶</button>
            <button>↷</button>
            <span className="mtm-tv-grow" />
            <button>▣</button>
            <button>Save</button>
            <button>⌁</button>
            <button>⬡</button>
            <button>▣</button>
            <button>↗</button>
          </div>

          {/* Chart area */}
          <div className="mtm-chart-panel">
            <div className="mtm-drawing-rail">
              {['+', '/', '=', 'o', '~', 'T', ':)', '[]', '?', 'U', 'p', '#', 'O', '@', 'x'].map(tool => (
                <button key={tool}>{tool}</button>
              ))}
            </div>
            <div ref={chartContainerRef} className="mtm-chart-container" />
            <canvas ref={oiCanvasRef} className="mtm-oi-canvas hidden" />
            <div ref={countdownRef} className="mtm-countdown hidden" />
            {ohlc && (
              <div className="mtm-ohlc">
                <span className="mtm-ohlc-symbol">{itemName(instrument || WATCHLIST_SEED[0]).toUpperCase()} · {interval} · {instrument?.exchange || 'NSE'}</span>
                <span className="mtm-ohlc-muted">−</span>
                <span className="mtm-ohlc-label">O</span><span className="mtm-ohlc-val">{ohlc.o.toFixed(2)}</span>
                <span className="mtm-ohlc-label">H</span><span className="mtm-ohlc-val">{ohlc.h.toFixed(2)}</span>
                <span className="mtm-ohlc-label">L</span><span className="mtm-ohlc-val">{ohlc.l.toFixed(2)}</span>
                <span className="mtm-ohlc-label">C</span><span className="mtm-ohlc-val">{ohlc.c.toFixed(2)}</span>
                <span className={`mtm-ohlc-chg ${ohlc.c >= ohlc.o ? 'up' : 'down'}`}>
                  {ohlc.c >= ohlc.o ? '+' : ''}{(ohlc.c - ohlc.o).toFixed(2)}
                  {' '}({ohlc.o ? (((ohlc.c - ohlc.o) / ohlc.o) * 100).toFixed(2) : '0.00'}%)
                </span>
                {ohlc.v != null && <span className="mtm-ohlc-volume">Volume <b>{fmtLakh(ohlc.v)}</b></span>}
              </div>
            )}
            {chartLoading && <div className="mtm-chart-loading">{chartLoading}</div>}
          </div>
        </div>

        {/* ════════════════ RIGHT: OPTION CHAIN (slide in/out) ════════════════ */}
        <div className={`mtm-oc-drawer${showChain ? ' open' : ''}`}>
          <div className="mtm-oc-panel">
            <div className="mtm-oc-header">
              <span style={{ fontSize:11, fontWeight:700, color:'#f1f5f9', fontFamily:"'Inter',sans-serif", letterSpacing:'-0.01em' }}>
                Option Chain
              </span>
              {ocLoading && <span style={{ fontSize:10, color:'#64748b' }}>Loading…</span>}
              {ocSpot && <span className="mtm-oc-spot">Spot {ocSpot}</span>}
            </div>
            {!ocLoading && !ocSpot && (
              <div className="mtm-empty">
                <div className="mtm-empty-icon">📊</div>
                <div>Select a symbol to load option chain</div>
              </div>
            )}
            <div className="mtm-oc-scroll" ref={ocScrollRef} style={{ display: ocSpot ? undefined : 'none' }} />
          </div>
        </div>

      </div>
    </div>
  );
}
