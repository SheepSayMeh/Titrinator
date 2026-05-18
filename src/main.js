import './style.css';
import { connect, sendCommand, disconnect, isSupported } from './ble.js';
import { showOnly, setLog, setScanning } from './ui.js';
import { initPumpCalibration } from './pump-calibration.js';
import { initPhCalibration }   from './ph-calibration.js';
import { initMeasurement, resetMeasurement, resumeWithData } from './measurement.js';
import { initHistory } from './history.js';

// ── State ──────────────────────────────────────────────────────
let stepsPerMl  = 36000;    // 36000 is the default value, but will be overwritten on connect if calibration exists
let phCalValid  = false;    // This value will be overwritten once valid calibration data is stored in ESP32 persistent storage
let phCalCoeffs = null;     // { degree, a, b, c } in mV-space
let direction   = 1;
let manualFlush  = false;
let reconnectMeta = null;   // set when STATUS_TITRATING received on connect

// ── Init calibration modules ───────────────────────────────────
const { onPumpNotify } = initPumpCalibration((val) => {
    stepsPerMl = val;
    updatePumpCalStatus();
    updateMeasureBtn();
});

const { onPhNotify } = initPhCalibration(() => {
    phCalValid = true;
    updatePhCalStatus();
    updateMeasureBtn();
});

const { onMeasureNotify } = initMeasurement({
    getStepsPerMl: () => stepsPerMl,
    getPhCal:      () => phCalCoeffs,
    onCancel:      goToLanding,
});

const { onShow: onHistoryShow, onHistoryNotify, primeReconnect } = initHistory({
    onEnter: (visible) => { if (!visible) showOnly('landing-screen'); },
});

// ── BLE init ───────────────────────────────────────────────────
if (!isSupported()) {
    showOnly('no-ble');
} else {
    showOnly('scan-screen');
}

// ── Navigation helpers ─────────────────────────────────────────
async function goToLanding() {
    showOnly('landing-screen');
    try { await sendCommand('STREAM_START'); } catch(e) {}
}

async function leaveToManual() {
    try { await sendCommand('STREAM_STOP'); } catch(e) {}
    showOnly('manual-screen');
}

async function leaveToCalibrate() {
    try { await sendCommand('STREAM_STOP'); } catch(e) {}
    showOnly('calibrate-screen');
}

async function enterPhCal() {
    showOnly('ph-cal-screen');
    try { await sendCommand('STREAM_START'); } catch(e) {}
}

async function leavePhCal() {
    try { await sendCommand('STREAM_STOP'); } catch(e) {}
    showOnly('calibrate-screen');
    // Restart landing stream if going back through calibrate to landing
}

// ── Scan ───────────────────────────────────────────────────────
document.getElementById('scan-btn').addEventListener('click', async () => {
    try {
        setScanning(true);
        const name = await connect(onNotify, onDisconnected);
        document.getElementById('connected-name').textContent = name;
        await sendCommand('GET_PUMP_CAL');
        // GET_PH_CAL is sent when PUMP_CAL arrives, GET_STATUS when PH_CAL_* arrives,
        // navigation when STATUS_* arrives — each step chained in onNotify to avoid
        // rapid BLE notification overwrites.
    } catch (err) {
        setScanning(false);
        document.getElementById('scan-label').textContent =
            err.name === 'NotFoundError'
                ? 'No device selected.'
                : `Error: ${err.message}`;
    }
});

// ── BLE notifications ──────────────────────────────────────────
function onNotify(msg) {
    // Split batched multi-line messages and process each line individually
    if (msg.includes('\n')) {
        msg.split('\n').forEach(line => { if (line) onNotify(line); });
        return;
    }

    console.log('notify:', msg);

    // pH stream — route to ph module, measurement module, and landing readout
    if (msg.startsWith('DATA_STREAM ')) {
        onPhNotify(msg);
        onMeasureNotify(msg);
        if (phCalCoeffs) {
            const mV = parseInt(msg.split(' ')[1]);
            const ph = phCalCoeffs.degree === 2
                ? phCalCoeffs.a * mV * mV + phCalCoeffs.b * mV + phCalCoeffs.c
                : phCalCoeffs.a * mV + phCalCoeffs.b;
            const el = document.getElementById('ph-readout');
            if (el) el.textContent = ph.toFixed(2);
        }
        return;
    }

    // Pump calibration messages
    if (msg.startsWith('CAL_DONE') || msg.startsWith('CAL_SAVED') ||
        msg.startsWith('FLUSHING') || msg.startsWith('STOPPED')) {
        onPumpNotify(msg);
    }

    // Pump calibration value retrieved on connect — chain to GET_PH_CAL
    if (msg.startsWith('PUMP_CAL ')) {
        const val = parseFloat(msg.substring(9));
        if (val > 0) { stepsPerMl = val; updatePumpCalStatus(); }
        sendCommand('GET_PH_CAL').catch(() => {});
        return;
    }

    // pH calibration messages
    if (msg.startsWith('PH_RAW')   || msg.startsWith('PH_CAL') ||
        msg.startsWith('PH_POINT') || msg.startsWith('PH_CAL_SAVED')) {
        onPhNotify(msg);
    }

    // pH calibration status retrieved on connect — chain to GET_STATUS
    if (msg === 'PH_CAL_NONE') {
        phCalValid = false;
        updatePhCalStatus();
        sendCommand('GET_STATUS').catch(() => {});
        return;
    }
    if (msg.startsWith('PH_CAL degree')) {
        phCalValid = true;
        updatePhCalStatus();
        const m = msg.match(/degree=(\d+)\s+a=([-\d.eE+]+)\s+b=([-\d.eE+]+)\s+c=([-\d.eE+]+)/);
        if (m) phCalCoeffs = { degree: parseInt(m[1]), a: parseFloat(m[2]), b: parseFloat(m[3]), c: parseFloat(m[4]) };
        sendCommand('GET_STATUS').catch(() => {});
        return;
    }
    // pH calibration saved after user-initiated calibration (not on connect)
    if (msg.startsWith('PH_CAL_SAVED')) {
        phCalValid = true;
        updatePhCalStatus();
        const m = msg.match(/degree=(\d+)\s+a=([-\d.eE+]+)\s+b=([-\d.eE+]+)\s+c=([-\d.eE+]+)/);
        if (m) phCalCoeffs = { degree: parseInt(m[1]), a: parseFloat(m[2]), b: parseFloat(m[3]), c: parseFloat(m[4]) };
    }

    // Reconnect status — navigates to landing or reconnect screen
    if (msg === 'STATUS_IDLE') {
        goToLanding();
        return;
    }
    if (msg.startsWith('STATUS_TITRATING ')) {
        const p = msg.split(' ');
        reconnectMeta = { id: parseInt(p[1]), totalMl: parseFloat(p[2]), direction: parseInt(p[3]) };
        showOnly('reconnect-screen');
        return;
    }

    // Titration data / control — route to measurement module
    if (msg.startsWith('TDATA ') || msg.startsWith('TRUN_DONE') || msg === 'TRESUMED') {
        onMeasureNotify(msg);
        return;
    }

    // TPAUSED: if in reconnect flow, load history data; otherwise pass to measurement
    if (msg === 'TPAUSED') {
        if (reconnectMeta) {
            primeReconnect(reconnectMeta, (meta, points) => {
                resumeWithData(meta, points);
                showOnly('titrate-screen');
                sendCommand('TRESUME').catch(() => {});
                reconnectMeta = null;
            });
            sendCommand(`GET_TITRATION ${reconnectMeta.id}`).catch(() => {});
        } else {
            onMeasureNotify(msg);
        }
        return;
    }

    // History data — route to history module
    if (msg.startsWith('TMETA')   || msg.startsWith('TROWS ') ||
        msg.startsWith('TDATA_END') || msg.startsWith('MEM_INFO ')) {
        onHistoryNotify(msg);
        return;
    }

    // Measurement module — gets DONE and ERR (DATA_STREAM routed above)
    if (msg.startsWith('DONE') || msg.startsWith('ERR')) {
        onMeasureNotify(msg);
    }

    // Step responses — only when manual screen is active
    const manualVisible = document.getElementById('manual-screen').style.display !== 'none';
    if (manualVisible && msg.startsWith('DONE')) {
        setLog('manual-log', msg, 'ok');
        document.getElementById('step-btn').disabled = false;
    }
    if (manualVisible && msg.startsWith('ERR')) {
        setLog('manual-log', msg, 'err');
        document.getElementById('step-btn').disabled = false;
    }
}

function onDisconnected() {
    showOnly('scan-screen');
    setScanning(false);
    document.getElementById('scan-label').textContent =
        'Disconnected. Press scan to reconnect.';
}

// ── Reconnect screen ───────────────────────────────────────
document.getElementById('reconnect-resume-btn').addEventListener('click', async () => {
    try { await sendCommand('TPAUSE'); } catch(e) {}
    // TPAUSED notification triggers primeReconnect + GET_TITRATION in onNotify
});

document.getElementById('reconnect-interrupt-btn').addEventListener('click', async () => {
    try { await sendCommand('TSTOP'); } catch(e) {}
    reconnectMeta = null;
    goToLanding();
});

// ── Landing navigation ─────────────────────────────────────────
document.getElementById('btn-manual').addEventListener('click', leaveToManual);
document.getElementById('btn-calibrate').addEventListener('click', leaveToCalibrate);
document.getElementById('btn-history').addEventListener('click', async () => {
    try { await sendCommand('STREAM_STOP'); } catch(e) {}
    showOnly('history-screen');
    onHistoryShow();
});
document.getElementById('disconnect-btn').addEventListener('click', () => {
    disconnect();
    onDisconnected();
});

// ── Manual screen ──────────────────────────────────────────────
document.getElementById('manual-back-btn').addEventListener('click', goToLanding);

const stepsInput  = document.getElementById('steps-input');
const volumeInput = document.getElementById('volume-input');

stepsInput.addEventListener('input', () => {
    const steps = parseInt(stepsInput.value);
    if (!isNaN(steps) && stepsPerMl > 0)
        volumeInput.value = (steps / stepsPerMl).toFixed(3);
});

volumeInput.addEventListener('input', () => {
    const vol = parseFloat(volumeInput.value);
    if (!isNaN(vol) && stepsPerMl > 0)
        stepsInput.value = Math.round(vol * stepsPerMl);
});

document.getElementById('dir-fwd').addEventListener('click', () => {
    direction = 1;
    document.getElementById('dir-fwd').classList.add('active');
    document.getElementById('dir-rev').classList.remove('active');
});

document.getElementById('dir-rev').addEventListener('click', () => {
    direction = -1;
    document.getElementById('dir-rev').classList.add('active');
    document.getElementById('dir-fwd').classList.remove('active');
});

['slow', 'normal', 'fast'].forEach(s => {
    document.getElementById(`speed-${s}`).addEventListener('click', async () => {
        try {
            await sendCommand(`SET_SPEED ${s.toUpperCase()}`);
            ['slow', 'normal', 'fast'].forEach(b =>
                document.getElementById(`speed-${b}`).classList.remove('active'));
            document.getElementById(`speed-${s}`).classList.add('active');
        } catch (err) {
            setLog('manual-log', `ERR ${err.message}`, 'err');
        }
    });
});

document.getElementById('step-btn').addEventListener('click', async () => {
    const steps = parseInt(stepsInput.value);
    if (isNaN(steps) || steps <= 0) {
        setLog('manual-log', 'ERR invalid step count', 'err');
        return;
    }
    document.getElementById('step-btn').disabled = true;
    setLog('manual-log', `Sending STEP ${steps * direction}...`, '');
    try {
        await sendCommand(`STEP ${steps * direction}`);
    } catch (err) {
        setLog('manual-log', `ERR ${err.message}`, 'err');
        document.getElementById('step-btn').disabled = false;
    }
});

document.getElementById('manual-flush-btn').addEventListener('click', async () => {
    const btn = document.getElementById('manual-flush-btn');
    try {
        if (!manualFlush) {
            await sendCommand('FLUSH');
            manualFlush = true;
            btn.textContent = 'STOP FLUSH';
            btn.classList.add('active');
        } else {
            await sendCommand('STOP');
            manualFlush = false;
            btn.textContent = 'FLUSH';
            btn.classList.remove('active');
        }
    } catch (err) {
        setLog('manual-log', `ERR ${err.message}`, 'err');
    }
});

// ── Calibrate screen ───────────────────────────────────────────
document.getElementById('cal-back-btn').addEventListener('click', goToLanding);
document.getElementById('btn-pump-cal').addEventListener('click', () =>
    showOnly('pump-cal-screen'));
document.getElementById('btn-ph-cal').addEventListener('click', enterPhCal);

// ── Measure screen ─────────────────────────────────────────────
document.getElementById('btn-titrate').addEventListener('click', async () => {
    if (!phCalValid || stepsPerMl <= 0) return;
    try { await sendCommand('STREAM_STOP'); } catch(e) {}
    await resetMeasurement();
    showOnly('titrate-screen');
});

// ── Pump cal screen ────────────────────────────────────────────
document.getElementById('pump-cal-back-btn').addEventListener('click', () =>
    showOnly('calibrate-screen'));

// ── pH cal screen ──────────────────────────────────────────────
document.getElementById('ph-cal-back-btn').addEventListener('click', leavePhCal);

// ── Status helpers ─────────────────────────────────────────────
function updatePumpCalStatus() {
    const main = document.getElementById('pump-cal-status');
    const sub  = document.getElementById('pump-cal-sub');
    const text = `${stepsPerMl.toFixed(0)} steps/ml`;
    if (main) main.textContent = text;
    if (sub)  sub.textContent  = text;
}

function updatePhCalStatus() {
    const sub     = document.getElementById('ph-cal-sub');
    const readout = document.getElementById('ph-readout');
    if (sub) sub.textContent = phCalValid ? 'Calibrated' : 'Not calibrated';
    if (readout && !phCalValid) readout.textContent = '—';
}

function updateMeasureBtn() {
    const btn  = document.getElementById('btn-titrate');
    const sub  = document.getElementById('titrate-btn-sub');
    const ready = phCalValid && stepsPerMl > 0;
    btn.disabled = !ready;
    btn.classList.toggle('disabled', !ready);
    if (ready) {
        sub.textContent = 'Run a titration';
    } else {
        const missing = [
            ...(!phCalValid      ? ['pH']   : []),
            ...(!(stepsPerMl > 0) ? ['pump'] : []),
        ];
        sub.textContent = `Disabled — calibrate ${missing.join(' & ')} first`;
    }
}

// ── Initial status ─────────────────────────────────────────────
updatePumpCalStatus();
updatePhCalStatus();
updateMeasureBtn();