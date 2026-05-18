import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { sendCommand } from './ble.js';
import { setLog } from './ui.js';
import { TITRATION_TYPES } from './titration-types.js';
import { findEquivalencePoints as computeEPs, populateEpTable } from './titration-analysis.js';

// ── State ──────────────────────────────────────────────────────────────
// IDLE → RUNNING → DONE
// RUNNING → PAUSED → RUNNING (continue) or IDLE (cancel)
let state              = 'IDLE';
let titrationConfig    = null;
let totalVolumeMl      = 0;
let dataPoints         = [];    // { volume, ph }
let equivalencePoints  = [];    // { volume, ph }
let chart              = null;
let highlightedEpIndex = null;
let resizeObserver     = null;

// ── Client-side pH conversion from millivolts (for live DATA_STREAM) ──
function mvToPh(mV, cal) {
    if (!cal) return null;
    if (cal.degree === 2) return cal.a * mV * mV + cal.b * mV + cal.c;
    return cal.a * mV + cal.b;
}

// ── Post-run equivalence point detection ─────────────────────────────
function detectAndDisplayEPs() {
    equivalencePoints = computeEPs(dataPoints, titrationConfig.expectDirection);
    updateEqTable();
    if (chart) chart.redraw();

    if (equivalencePoints.length === 0) {
        setLog('titrate-log', 'Titration complete — no equivalence point detected.', '');
    } else {
        equivalencePoints.forEach((ep, i) => {
            const label = ep.ph != null
                ? `EP${i + 1}: ${ep.volume.toFixed(3)} mL  pH ${ep.ph.toFixed(2)}`
                : `EP${i + 1}: ${ep.volume.toFixed(3)} mL`;
            setLog('titrate-log', label, 'ok');
        });
    }
}

// ── Chart ──────────────────────────────────────────────────────────────
function createChart() {
    const container = document.getElementById('titrate-chart-container');
    if (!container || chart) return;

    const parent = container.parentElement;
    const w = parent ? parent.getBoundingClientRect().width : 400;

    const eqLines = {
        draw(u) {
            const ctx = u.ctx;
            ctx.save();
            ctx.setLineDash([4, 4]);
            for (let i = 0; i < equivalencePoints.length; i++) {
                const highlighted = highlightedEpIndex === i;
                ctx.strokeStyle = highlighted ? '#ffffff' : '#ff9800';
                ctx.lineWidth   = highlighted ? 2 : 1;
                const x = Math.round(u.valToPos(equivalencePoints[i].volume, 'x', true));
                ctx.beginPath();
                ctx.moveTo(x, u.bbox.top);
                ctx.lineTo(x, u.bbox.top + u.bbox.height);
                ctx.stroke();
            }
            ctx.restore();
        },
    };

    const opts = {
        width:   w,
        height:  440,
        plugins: [{ hooks: { draw: [eqLines.draw] } }],
        scales: {
            x: { time: false, range: [0, totalVolumeMl || 10] },
            y: { auto: true },
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
                points: { size: 4, fill: '#00e5ff' },
            },
        ],
        cursor: { show: false },
        legend: { show: false },
    };

    chart = new uPlot(opts, [[], []], container);

    if (parent) {
        resizeObserver = new ResizeObserver(entries => {
            if (!chart) return;
            const newW = entries[0].contentRect.width;
            if (newW > 0) chart.setSize({ width: newW, height: 440 });
        });
        resizeObserver.observe(parent);
    }
}

function updateChart() {
    if (!chart) return;
    chart.setData([
        dataPoints.map(p => p.volume),
        dataPoints.map(p => p.ph),
    ]);
}

function destroyChart() {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (chart) { chart.destroy(); chart = null; }
    const container = document.getElementById('titrate-chart-container');
    if (container) container.innerHTML = '';
}

// ── UI helpers ────────────────────────────────────────────────────────
function updateReadouts() {
    const last = dataPoints[dataPoints.length - 1];
    if (!last) return;
    const volEl = document.getElementById('titrate-vol');
    if (volEl) volEl.textContent = `${last.volume.toFixed(3)} mL`;
}

function updateEqTable() {
    const tbody = document.getElementById('titrate-ep-tbody');
    populateEpTable(tbody, equivalencePoints);
    tbody?.querySelectorAll('tr').forEach((tr, i) => {
        tr.addEventListener('mouseenter', () => { highlightedEpIndex = i; if (chart) chart.redraw(); });
        tr.addEventListener('mouseleave', () => { highlightedEpIndex = null; if (chart) chart.redraw(); });
    });
}

// action btn: START / PAUSE / CONTINUE / NEW TITRATION
// cancel btn: CANCEL (paused) / DONE (done)
function updateControls() {
    const actionBtn = document.getElementById('titrate-action-btn');
    const cancelBtn = document.getElementById('titrate-cancel-btn');
    const finishBtn = document.getElementById('titrate-finish-btn');
    if (!actionBtn || !cancelBtn || !finishBtn) return;

    cancelBtn.style.display = 'none';
    finishBtn.style.display = 'none';
    actionBtn.style.display = 'block';

    switch (state) {
        case 'IDLE':
            actionBtn.textContent = 'START';
            actionBtn.className   = 'primary-btn';
            break;
        case 'RUNNING':
            actionBtn.textContent = 'PAUSE';
            actionBtn.className   = 'flush-btn';
            break;
        case 'PAUSED':
            actionBtn.textContent   = 'CONTINUE';
            actionBtn.className     = 'primary-btn';
            cancelBtn.textContent   = 'CANCEL';
            cancelBtn.style.display = 'block';
            finishBtn.style.display = 'block';
            break;
        case 'DONE':
            actionBtn.textContent   = 'NEW TITRATION';
            actionBtn.className     = 'primary-btn';
            cancelBtn.textContent   = 'DONE';
            cancelBtn.style.display = 'block';
            break;
    }
}

function showSetup(visible) {
    const setup   = document.getElementById('titrate-setup');
    const display = document.getElementById('titrate-display');
    if (setup)   setup.style.display   = visible ? 'flex' : 'none';
    if (display) display.style.display = visible ? 'none' : 'flex';
}

function clearData() {
    dataPoints         = [];
    equivalencePoints  = [];
    highlightedEpIndex = null;
    destroyChart();
    updateEqTable();
    const phEl  = document.getElementById('titrate-ph');
    const volEl = document.getElementById('titrate-vol');
    if (phEl)  phEl.textContent  = '—';
    if (volEl) volEl.textContent = '0.000 mL';
    setLog('titrate-log', '', '');
}

// ── Public reset — called from main.js when navigating to screen ──────
export async function resetMeasurement() {
    if (state === 'RUNNING') {
        try { await sendCommand('TSTOP'); } catch(e) {}
    }
    try { await sendCommand('STREAM_STOP'); } catch(e) {}
    state = 'IDLE';
    clearData();
    showSetup(true);
    updateControls();
}

// ── Module init ───────────────────────────────────────────────────────
export function initMeasurement({ getStepsPerMl, getPhCal, onCancel }) {
    const actionBtn   = document.getElementById('titrate-action-btn');
    const cancelBtn   = document.getElementById('titrate-cancel-btn');
    const backBtn     = document.getElementById('titrate-back-btn');
    const typeRow     = document.getElementById('titration-type-row');
    const volumeInput = document.getElementById('titrate-volume-input');

    // ── Build titration type buttons ──────────────────────────────
    let selectedType = Object.keys(TITRATION_TYPES)[0];
    titrationConfig = TITRATION_TYPES[selectedType];

    Object.entries(TITRATION_TYPES).forEach(([id, cfg], idx) => {
        const btn = document.createElement('button');
        btn.className = 'dir-btn' + (idx === 0 ? ' active' : '');
        btn.textContent = cfg.label;
        btn.addEventListener('click', () => {
            selectedType = id;
            titrationConfig = cfg;
            typeRow.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
        typeRow.appendChild(btn);
    });

    // ── Back button (setup only) ──────────────────────────────────
    backBtn.addEventListener('click', () => onCancel());

    // ── Helper: send TSTART ────────────────────────────────────────
    function sendTStart() {
        const cmd = `TSTART ${totalVolumeMl} ${getStepsPerMl()} ${titrationConfig.expectDirection}`;
        return sendCommand(cmd);
    }

    // ── Action button ─────────────────────────────────────────────
    actionBtn.addEventListener('click', async () => {
        const setupVisible = document.getElementById('titrate-setup').style.display !== 'none';

        switch (state) {
            case 'IDLE':
                if (setupVisible) {
                    const vol = parseFloat(volumeInput.value);
                    if (isNaN(vol) || vol <= 0) {
                        setLog('titrate-log', 'ERR enter a valid volume', 'err');
                        return;
                    }
                    totalVolumeMl = vol;
                    showSetup(false);
                    await new Promise(r => requestAnimationFrame(r));
                    if (!chart) createChart();
                    try { await sendCommand('STREAM_START'); } catch(e) {}
                } else {
                    // On display: START begins the titration
                    try {
                        await sendTStart();
                        state = 'RUNNING';
                        updateControls();
                    } catch(e) {
                        setLog('titrate-log', `ERR ${e.message}`, 'err');
                    }
                }
                break;

            case 'RUNNING':
                try {
                    await sendCommand('TPAUSE');
                    setLog('titrate-log', 'Pausing…', '');
                } catch(e) {
                    setLog('titrate-log', `ERR ${e.message}`, 'err');
                }
                break;

            case 'PAUSED':
                try {
                    await sendCommand('TRESUME');
                    state = 'RUNNING';
                    updateControls();
                } catch(e) {
                    setLog('titrate-log', `ERR ${e.message}`, 'err');
                }
                break;

            case 'DONE':
                // NEW TITRATION: clear data, stay on display, show START
                clearData();
                state = 'IDLE';
                updateControls();
                await new Promise(r => requestAnimationFrame(r));
                if (!chart) createChart();
                try { await sendCommand('STREAM_START'); } catch(e) {}
                break;
        }
    });

    // ── Finish button (stop early, keep data, run analysis) ───────
    const finishBtn = document.getElementById('titrate-finish-btn');
    finishBtn.addEventListener('click', async () => {
        if (state === 'RUNNING' || state === 'PAUSED') {
            try { await sendCommand('TSTOP'); } catch(e) {}
            // TRUN_DONE notification will trigger findEquivalencePoints() and state='DONE'
        }
    });

    // ── Cancel button ─────────────────────────────────────────────
    cancelBtn.addEventListener('click', async () => {
        if (state === 'PAUSED') {
            try { await sendCommand('TSTOP'); } catch(e) {}
            try { await sendCommand('STREAM_STOP'); } catch(e) {}
            state = 'IDLE';
            clearData();
            showSetup(true);
            updateControls();
        } else if (state === 'DONE') {
            try { await sendCommand('STREAM_STOP'); } catch(e) {}
            state = 'IDLE';
            clearData();
            showSetup(true);
            updateControls();
        }
    });

    // ── BLE notification handler ──────────────────────────────────
    function onMeasureNotify(msg) {
        // Live pH readout while streaming (before titration starts)
        if (msg.startsWith('DATA_STREAM ')) {
            const displayShown =
                document.getElementById('titrate-screen')?.style.display  !== 'none' &&
                document.getElementById('titrate-display')?.style.display !== 'none';
            if (displayShown) {
                const mV  = parseInt(msg.split(' ')[1]);
                const cal = getPhCal?.();
                const ph  = mvToPh(mV, cal);
                if (ph != null) {
                    const el = document.getElementById('titrate-ph');
                    if (el) el.textContent = ph.toFixed(2);
                }
            }
            return;
        }

        // Live titration data point from firmware
        if (msg.startsWith('TDATA ')) {
            const parts = msg.split(' ');
            const vol = parseFloat(parts[1]);
            const ph  = parseFloat(parts[2]);
            if (!isNaN(vol) && !isNaN(ph)) {
                dataPoints.push({ volume: vol, ph });
                updateChart();
                updateReadouts();
                const phEl = document.getElementById('titrate-ph');
                if (phEl) phEl.textContent = ph.toFixed(2);
            }
            return;
        }

        // Titration complete
        if (msg.startsWith('TRUN_DONE')) {
            if (state === 'RUNNING' || state === 'PAUSED') {
                state = 'DONE';
                detectAndDisplayEPs();
                updateControls();
            }
            return;
        }

        // Pause/resume acknowledgements
        if (msg === 'TPAUSED') {
            state = 'PAUSED';
            updateControls();
            setLog('titrate-log', 'Paused.', '');
            return;
        }
        if (msg === 'TRESUMED') {
            state = 'RUNNING';
            updateControls();
            return;
        }
    }

    return { onMeasureNotify };
}
