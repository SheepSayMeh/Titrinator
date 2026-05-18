export function showOnly(id) {
    const screens = [
        'no-ble', 'scan-screen', 'reconnect-screen', 'landing-screen',
        'manual-screen', 'calibrate-screen',
        'pump-cal-screen', 'ph-cal-screen', 'titrate-screen', 'history-screen'
    ];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.style.display = s === id ? 'flex' : 'none';
    });
}

export function setLog(id, msg, type = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = 'log ' + type;
}

export function setScanning(scanning) {
    const dot   = document.getElementById('scan-dot');
    const label = document.getElementById('scan-label');
    const btn   = document.getElementById('scan-btn');
    if (scanning) {
        dot.classList.remove('idle');
        label.textContent = 'Waiting for selection...';
        btn.disabled = true;
    } else {
        dot.classList.add('idle');
        btn.disabled = false;
    }
}