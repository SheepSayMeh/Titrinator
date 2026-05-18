import { sendCommand } from './ble.js';
import { setLog } from './ui.js';

let numPoints  = 2;
const readings = [];
let currentMv  = null;

const defaultPh = ['4.00', '10.01', '7.00'];

export function initPhCalibration(onPhCalSaved) {
    const container   = document.getElementById('ph-cal-points-container');
    const fitBtn      = document.getElementById('ph-cal-fit-btn');
    const pts2Btn     = document.getElementById('ph-points-2');
    const pts3Btn     = document.getElementById('ph-points-3');
    const liveEl      = document.getElementById('voltage-live-readout');
    const linDevEl    = document.getElementById('ph-linearity-value');

    // ── Point selector ────────────────────────────────────────────
    pts2Btn.addEventListener('click', () => {
        numPoints = 2;
        pts2Btn.classList.add('active');
        pts3Btn.classList.remove('active');
        buildPoints();
    });

    pts3Btn.addEventListener('click', () => {
        numPoints = 3;
        pts3Btn.classList.add('active');
        pts2Btn.classList.remove('active');
        buildPoints();
    });

    // ── Build point rows ──────────────────────────────────────────
    function buildPoints() {
        readings.length = 0;
        container.innerHTML = '';
        fitBtn.disabled = true;

        for (let i = 0; i < numPoints; i++) {
            const row = document.createElement('div');
            row.className = 'ph-point-row';
            row.id = `ph-point-${i}`;
            row.innerHTML = `
                <div class="ph-point-header">
                    <span class="ph-point-title">Buffer ${i + 1}</span>
                </div>
                <div class="input-row">
                    <div class="input-col">
                        <div class="step-label">pH value</div>
                        <input type="number" id="ph-val-${i}" step="0.01"
                               value="${defaultPh[i] || ''}" placeholder="7.00" />
                    </div>
                    <div class="input-col ph-capture-col">
                        <button class="voltage-read-btn" id="voltage-read-${i}">CAPTURE</button>
                    </div>
                </div>
                <div class="input-row">
                    <div class="input-col">
                        <span class="ph-point-adc" id="ph-adc-${i}" style="display:none;">ADC: —</span>
                    </div>
                    <div class="input-col"></div>
                </div>
            `;
            container.appendChild(row);

            document.getElementById(`voltage-read-${i}`).addEventListener('click', () => {
                if (currentMv === null) {
                    setLog('ph-cal-log', 'ERR no reading available yet', 'err');
                    return;
                }
                const phVal = parseFloat(
                    document.getElementById(`ph-val-${i}`).value
                );
                if (isNaN(phVal)) {
                    setLog('ph-cal-log', 'ERR enter a pH value first', 'err');
                    return;
                }
                // Capture current live values
                readings[i] = { mV: currentMv, ph: phVal };
                const adcEl = document.getElementById(`ph-adc-${i}`);
                adcEl.textContent = `${currentMv} mV`;
                adcEl.style.display = '';
                const btn = document.getElementById(`voltage-read-${i}`);
                btn.textContent = '✓ CAPTURED';
                btn.classList.add('done');

                setLog('ph-cal-log',
                    `Point ${i + 1} captured: ${currentMv} mV  pH=${phVal.toFixed(2)}`,
                    'ok'
                );

                // Enable fit button when all points captured
                const allDone = Array.from(
                    { length: numPoints }, (_, j) => readings[j]
                ).every(r => r !== undefined);
                if (allDone) fitBtn.disabled = false;
            });
        }
    }

    // ── Save calibration ──────────────────────────────────────────
    fitBtn.addEventListener('click', async () => {
        const sorted = [...readings].sort((a, b) => a.ph - b.ph);
        try {
            await sendCommand('PH_CAL_RESET');
            for (const r of sorted) {
                await sendCommand(`PH_CAL_SET ${r.mV} ${r.ph.toFixed(3)}`);
            }
            await sendCommand('PH_CAL_FIT');
        } catch (err) {
            setLog('ph-cal-log', `ERR ${err.message}`, 'err');
        }
    });

    // ── Linearity display helper ────────────────────────────────────
    function updateLinDev(msg) {
        const m = msg.match(/lindev=([\d.]+)/);
        linDevEl.textContent = m ? `${parseFloat(m[1]).toFixed(2)}%` : 'n/a';
    }

    // ── Handle BLE notifications ──────────────────────────────────
    function onPhNotify(msg) {
        if (msg.startsWith('DATA_STREAM ')) {
            currentMv = parseInt(msg.split(' ')[1]);
            if (liveEl) {
                liveEl.textContent = `${currentMv} mV`;
                liveEl.className = 'voltage-live-value';
            }

        } else if (msg.startsWith('PH_CAL_SAVED') || msg.startsWith('PH_CAL degree')) {
            updateLinDev(msg);
            if (msg.startsWith('PH_CAL_SAVED')) {
                const lindevMatch = msg.match(/lindev=([\d.]+)/);
                if (lindevMatch) {
                    const lindev = parseFloat(lindevMatch[1]);
                    setLog('ph-cal-log',
                        `pH calibration saved. Linearity deviation: ${lindev.toFixed(2)}%`, 'ok');
                } else {
                    setLog('ph-cal-log', 'pH calibration saved.', 'ok');
                }
            }
            onPhCalSaved();

        } else if (msg.startsWith('ERR')) {
            setLog('ph-cal-log', msg, 'err');
        }
    }

    buildPoints();
    return { onPhNotify };
}