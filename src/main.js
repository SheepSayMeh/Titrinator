import './style.css';
import { connect, sendCommand, disconnect, isSupported } from './ble.js';
import { els, showScanScreen, showControlScreen, showNoBle, setScanning, setLog } from './ui.js';

let direction = 1;

// ── Init ───────────────────────────────────────────────────────
if (!isSupported()) {
    showNoBle();
}

// ── Direction toggle ───────────────────────────────────────────
els.dirFwd.addEventListener('click', () => {
    direction = 1;
    els.dirFwd.classList.add('active');
    els.dirRev.classList.remove('active');
});

els.dirRev.addEventListener('click', () => {
    direction = -1;
    els.dirRev.classList.add('active');
    els.dirFwd.classList.remove('active');
});

// ── Scan / connect ─────────────────────────────────────────────
els.scanBtn.addEventListener('click', async () => {
    try {
        setScanning('Waiting for selection...');
        const name = await connect(onNotify, onDisconnected);
        showControlScreen(name);
    } catch (err) {
        console.error(err);
        showScanScreen(
            err.name === 'NotFoundError'
                ? 'No device selected.'
                : `Error: ${err.message}`
        );
    }
});

// ── BLE events ─────────────────────────────────────────────────
function onNotify(msg) {
    setLog(msg, msg.startsWith('ERR') ? 'err' : 'ok');
    els.stepBtn.disabled = false;
}

function onDisconnected() {
    showScanScreen('Disconnected. Press scan to reconnect.');
}

// ── Step command ───────────────────────────────────────────────
els.stepBtn.addEventListener('click', async () => {
    const steps = parseInt(els.stepsInput.value);
    if (isNaN(steps) || steps <= 0) {
        setLog('ERR invalid step count', 'err');
        return;
    }
    els.stepBtn.disabled = true;
    setLog(`Sending STEP ${steps * direction}...`, '');
    try {
        await sendCommand(`STEP ${steps * direction}`);
    } catch (err) {
        setLog(`ERR ${err.message}`, 'err');
        els.stepBtn.disabled = false;
    }
});

// ── Disconnect ─────────────────────────────────────────────────
els.disconnectBtn.addEventListener('click', () => {
    disconnect();
    onDisconnected();
});