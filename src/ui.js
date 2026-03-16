export const els = {
    scanScreen:    document.getElementById('scan-screen'),
    controlScreen: document.getElementById('control-screen'),
    noBle:         document.getElementById('no-ble'),
    scanBtn:       document.getElementById('scan-btn'),
    scanDot:       document.getElementById('scan-dot'),
    scanLabel:     document.getElementById('scan-label'),
    connectedName: document.getElementById('connected-name'),
    stepBtn:       document.getElementById('step-btn'),
    stepsInput:    document.getElementById('steps'),
    log:           document.getElementById('log'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    dirFwd:        document.getElementById('dir-fwd'),
    dirRev:        document.getElementById('dir-rev'),
};

export function showScanScreen(label = 'Press scan to find devices') {
    els.scanScreen.style.display    = 'flex';
    els.controlScreen.style.display = 'none';
    els.noBle.style.display         = 'none';
    els.scanDot.classList.add('idle');
    els.scanLabel.textContent = label;
    els.scanBtn.disabled = false;
}

export function showControlScreen(name) {
    els.scanScreen.style.display    = 'none';
    els.controlScreen.style.display = 'flex';
    els.connectedName.textContent   = name;
    els.stepBtn.disabled = false;
}

export function showNoBle() {
    els.scanScreen.style.display = 'none';
    els.noBle.style.display      = 'flex';
}

export function setScanning(label) {
    els.scanDot.classList.remove('idle');
    els.scanLabel.textContent = label;
    els.scanBtn.disabled = true;
}

export function setLog(msg, type = '') {
    els.log.textContent = msg;
    els.log.className = type;
}