import JSZip from 'jszip';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { sendCommand } from './ble.js';
import { findEquivalencePoints, populateEpTable } from './titration-analysis.js';

// ── State ──────────────────────────────────────────────────────────────
let pendingRows     = [];   // accumulating during GET_TITRATION
let pendingMeta     = null; // meta for the titration being retrieved
let historyChart    = null;
let oneTimeCallback = null; // set by primeReconnect or loadSequential, cleared after one TDATA_END
let metaList        = [];
let selectedIds     = new Set();

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
    document.getElementById('history-list').style.display       = 'none';
    document.getElementById('history-loading').style.display    = 'flex';
    document.getElementById('history-detail').style.display     = 'none';
    document.getElementById('history-action-bar').style.display = 'none';
    document.getElementById('history-mem-bar').style.display = 'none';
    const txt = document.getElementById('history-loading-text');
    if (txt) txt.textContent = `Loading ${meta.points} points…`;
}

function showDetail(points, meta) {
    document.getElementById('history-loading').style.display    = 'none';
    document.getElementById('history-list').style.display       = 'none';
    document.getElementById('history-action-bar').style.display = 'none';
    document.getElementById('history-mem-bar').style.display = 'none';
    document.getElementById('history-detail').style.display     = 'flex';

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
            metaList = metaList.filter(m => m.id !== meta.id);
            selectedIds.delete(meta.id);
            buildList();
            showList();
        };
    }
}

function showList() {
    document.getElementById('history-list').style.display       = 'flex';
    document.getElementById('history-loading').style.display    = 'none';
    document.getElementById('history-detail').style.display     = 'none';
    document.getElementById('history-action-bar').style.display = 'flex';
    document.getElementById('history-mem-bar').style.display = 'flex';
    if (historyChart) { historyChart.destroy(); historyChart = null; }
    updateActionBar();
}

// ── Action bar ────────────────────────────────────────────────────────
function updateActionBar() {
    const countEl  = document.getElementById('history-sel-count');
    const n        = selectedIds.size;
    const disabled = n === 0;
    if (countEl) countEl.textContent = `${n} selected`;
    for (const id of ['hist-export-fast-btn', 'hist-export-slow-btn', 'hist-delete-sel-btn']) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = disabled;
    }
}

function updateMemBar(used, total) {
    const pct    = total > 0 ? (used / total) * 100 : 0;
    const fill   = document.getElementById('history-mem-fill');
    const text   = document.getElementById('history-mem-text');
    const toMb   = b => (b / (1024 * 1024)).toFixed(2);
    if (fill) {
        fill.style.width = `${pct.toFixed(1)}%`;
        fill.className   = 'mem-bar-fill' +
            (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
    }
    if (text) text.textContent = `Storage: ${pct.toFixed(0)}%  (${toMb(used)} / ${toMb(total)} MB)`;
}

// ── List builder ──────────────────────────────────────────────────────
function buildList() {
    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';

    if (metaList.length === 0) {
        const empty = document.createElement('div');
        empty.className   = 'cal-hint';
        empty.textContent = 'No stored titrations.';
        list.appendChild(empty);
        updateActionBar();
        return;
    }

    const sorted = [...metaList].sort((a, b) => b.id - a.id);
    for (const meta of sorted) {
        const item = document.createElement('div');
        item.className = 'hist-item';

        const cb = document.createElement('input');
        cb.type      = 'checkbox';
        cb.className = 'hist-checkbox';
        cb.checked   = selectedIds.has(meta.id);
        cb.addEventListener('change', () => {
            if (cb.checked) selectedIds.add(meta.id);
            else            selectedIds.delete(meta.id);
            updateActionBar();
        });

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

        item.appendChild(cb);
        item.appendChild(btn);
        list.appendChild(item);
    }

    updateActionBar();
}

// ── CSV + download helpers ─────────────────────────────────────────────
function toCsv(rows) {
    return 'volume_ml,ph\n' + rows.map(r => `${r.volume},${r.ph}`).join('\n');
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Sequential batch loader ────────────────────────────────────────────
// Loads titrations one at a time (BLE ACK protocol enforces serialisation).
// stride=0 → auto (firmware calculates); stride=1 → full dataset.
function loadSequential(queue, stride, results, onDone) {
    if (queue.length === 0) { onDone(results); return; }
    const [meta, ...rest] = queue;
    pendingMeta     = meta;
    pendingRows     = [];
    oneTimeCallback = (m, rows) => {
        results.push({ meta: m, rows });
        loadSequential(rest, stride, results, onDone);
    };
    const strideArg = stride > 0 ? ` ${stride}` : '';
    sendCommand(`GET_TITRATION ${meta.id}${strideArg}`).catch(() => {});
}

// ── Export ────────────────────────────────────────────────────────────
function startExport(stride) {
    const metas = metaList.filter(m => selectedIds.has(m.id));
    if (!metas.length) return;

    const totalPoints = metas.reduce((s, m) => s + m.points, 0);
    showLoading({ points: totalPoints });

    loadSequential(metas, stride, [], async (results) => {
        if (results.length === 1) {
            const { meta, rows } = results[0];
            downloadBlob(new Blob([toCsv(rows)], { type: 'text/csv' }),
                         `titration_${meta.id}.csv`);
        } else {
            const zip = new JSZip();
            for (const { meta, rows } of results)
                zip.file(`titration_${meta.id}.csv`, toCsv(rows));
            const blob = await zip.generateAsync({ type: 'blob' });
            downloadBlob(blob, 'titrations.zip');
        }
        showList();
    });
}

// ── Delete selected ────────────────────────────────────────────────────
async function startDelete() {
    const ids = [...selectedIds];
    for (const id of ids) {
        try { await sendCommand(`DEL_TITRATION ${id}`); } catch(e) {}
    }
    metaList = metaList.filter(m => !ids.includes(m.id));
    selectedIds.clear();
    buildList();
    showList();
}

// ── Module init ───────────────────────────────────────────────────────
export function initHistory({ onEnter }) {
    const backBtn = document.getElementById('history-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => onEnter(false));

    document.getElementById('hist-export-fast-btn')
        .addEventListener('click', () => startExport(0));
    document.getElementById('hist-export-slow-btn')
        .addEventListener('click', () => startExport(1));
    document.getElementById('hist-delete-sel-btn')
        .addEventListener('click', startDelete);

    return {
        onShow() {
            metaList    = [];
            pendingRows = [];
            pendingMeta = null;
            selectedIds.clear();
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

            if (msg.startsWith('MEM_INFO ')) {
                const p = msg.split(' ');
                updateMemBar(parseInt(p[1]), parseInt(p[2]));
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
                if (meta && pendingRows.length) {
                    if (oneTimeCallback) {
                        const cb = oneTimeCallback;
                        oneTimeCallback = null;
                        cb(meta, pendingRows);
                    } else {
                        showDetail(pendingRows, meta);
                    }
                }
                pendingRows = [];
                pendingMeta = null;
                return;
            }
        },

        primeReconnect(meta, callback) {
            pendingMeta     = meta;
            pendingRows     = [];
            oneTimeCallback = callback;
        },
    };
}
