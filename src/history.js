import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { sendCommand } from './ble.js';
import { findEquivalencePoints, populateEpTable } from './titration-analysis.js';

// ── State ──────────────────────────────────────────────────────────────
let pendingRows  = [];   // accumulating during GET_TITRATION
let pendingMeta  = null; // meta for the titration being retrieved
let historyChart = null;

// ── Chart ──────────────────────────────────────────────────────────────
function createHistoryChart(points, eps) {
    const container = document.getElementById('history-chart-container');
    if (!container) return;
    if (historyChart) { historyChart.destroy(); historyChart = null; }
    container.innerHTML = '';

    const parent = container.parentElement;
    const w = parent ? parent.getBoundingClientRect().width : 400;

    const eqLines = {
        draw(u) {
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = '#ff9800';
            ctx.lineWidth   = 1;
            ctx.setLineDash([4, 4]);
            for (const eq of eps) {
                const x = Math.round(u.valToPos(eq.volume, 'x', true));
                ctx.beginPath();
                ctx.moveTo(x, u.bbox.top);
                ctx.lineTo(x, u.bbox.top + u.bbox.height);
                ctx.stroke();
            }
            ctx.restore();
        },
    };

    const maxVol = points.length ? points[points.length - 1].volume : 10;

    historyChart = new uPlot(
        {
            width:   w,
            height:  300,
            plugins: [{ hooks: { draw: [eqLines.draw] } }],
            scales: {
                x: { time: false, range: [0, maxVol] },
                y: { range: [1, 13] },
            },
            axes: [
                {
                    label:     'Volume (mL)',
                    stroke:    '#858585',
                    grid:      { stroke: '#1e1e1e' },
                    font:      '11px Share Tech Mono',
                    labelFont: '11px Share Tech Mono',
                },
                {
                    label:     'pH',
                    stroke:    '#858585',
                    grid:      { stroke: '#1e1e1e' },
                    font:      '11px Share Tech Mono',
                    labelFont: '11px Share Tech Mono',
                },
            ],
            series: [
                { label: 'Volume (mL)' },
                {
                    label:  'pH',
                    stroke: '#00e5ff',
                    width:  2,
                    points: { size: 3, fill: '#00e5ff' },
                },
            ],
            cursor: { show: false },
            legend: { show: false },
        },
        [points.map(p => p.volume), points.map(p => p.ph)],
        container
    );
}

// ── View helpers ──────────────────────────────────────────────────────
function showLoading(meta) {
    document.getElementById('history-list').style.display    = 'none';
    document.getElementById('history-loading').style.display = 'flex';
    document.getElementById('history-detail').style.display  = 'none';
    const txt = document.getElementById('history-loading-text');
    if (txt) txt.textContent = `Loading ${meta.points} points…`;
}

function showDetail(points, meta) {
    document.getElementById('history-loading').style.display = 'none';
    document.getElementById('history-list').style.display    = 'none';
    document.getElementById('history-detail').style.display  = 'flex';

    const titleEl = document.getElementById('history-detail-title');
    if (titleEl)
        titleEl.textContent = `#${meta.id} — ${meta.totalMl.toFixed(1)} mL  (${meta.points} pts)`;

    const eps = findEquivalencePoints(points, meta.direction);
    requestAnimationFrame(() => createHistoryChart(points, eps));
    populateEpTable(document.getElementById('history-ep-tbody'), eps);

    const deleteBtn = document.getElementById('history-delete-btn');
    if (deleteBtn) {
        deleteBtn.onclick = async () => {
            try { await sendCommand(`DEL_TITRATION ${meta.id}`); } catch(e) {}
            showList();
        };
    }
}

function showList() {
    document.getElementById('history-list').style.display    = 'flex';
    document.getElementById('history-loading').style.display = 'none';
    document.getElementById('history-detail').style.display  = 'none';
    if (historyChart) { historyChart.destroy(); historyChart = null; }
}

// ── List builder ──────────────────────────────────────────────────────
let metaList = [];

function buildList() {
    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';

    if (metaList.length === 0) {
        const empty = document.createElement('div');
        empty.className   = 'cal-hint';
        empty.textContent = 'No stored titrations.';
        list.appendChild(empty);
        return;
    }

    const sorted = [...metaList].sort((a, b) => b.id - a.id);
    for (const meta of sorted) {
        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.innerHTML =
            `<span class="menu-btn-title">Titration #${meta.id}</span>` +
            `<span class="menu-btn-sub">${meta.totalMl.toFixed(1)} mL &nbsp;·&nbsp; ` +
            `${meta.points} points</span>`;
        btn.addEventListener('click', async () => {
            pendingMeta = meta;
            pendingRows = [];
            showLoading(meta);
            try { await sendCommand(`GET_TITRATION ${meta.id}`); } catch(e) {}
        });
        list.appendChild(btn);
    }
}

// ── Module init ───────────────────────────────────────────────────────
export function initHistory({ onEnter }) {
    const backBtn = document.getElementById('history-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => onEnter(false));

    return {
        onShow() {
            metaList    = [];
            pendingRows = [];
            pendingMeta = null;
            showList();
            const list = document.getElementById('history-list');
            if (list) list.innerHTML = '<div class="cal-hint">Loading…</div>';
            sendCommand('LIST_TITRATIONS').catch(() => {});
        },

        onHistoryNotify(msg) {
            if (msg.startsWith('TMETA ')) {
                const p = msg.split(' ');
                metaList.push({
                    id:        parseInt(p[1]),
                    totalMl:   parseFloat(p[2]),
                    points:    parseInt(p[3]),
                    direction: parseInt(p[4]),
                });
                return;
            }

            if (msg.startsWith('TMETA_END')) {
                buildList();
                return;
            }

            if (msg.startsWith('TROWS ')) {
                const pairs = msg.substring(6).split(';');
                for (const pair of pairs) {
                    const [v, rawPh] = pair.split(',');
                    const vol = parseFloat(v), ph = parseFloat(rawPh);
                    if (!isNaN(vol) && !isNaN(ph)) pendingRows.push({ volume: vol, ph });
                }
                sendCommand('TROWS_ACK').catch(() => {});
                return;
            }

            if (msg.startsWith('TDATA_END')) {
                const id   = parseInt(msg.split(' ')[1]);
                const meta = pendingMeta ?? metaList.find(m => m.id === id);
                if (meta && pendingRows.length) showDetail(pendingRows, meta);
                pendingRows = [];
                pendingMeta = null;
                return;
            }
        },
    };
}
