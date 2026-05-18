import { sendCommand } from './ble.js';
import { setLog } from './ui.js';

const CALIBRATION_STEPS = 50000;

export function initPumpCalibration(onPumpCalSaved) {
    const flushBtn    = document.getElementById('pump-flush-btn');
    const runBtn      = document.getElementById('pump-cal-run-btn');
    const modal       = document.getElementById('pump-cal-modal');
    const startBtn    = document.getElementById('pump-cal-start-btn');
    const submitBtn   = document.getElementById('pump-cal-submit-btn');
    const cancelBtn   = document.getElementById('pump-cal-cancel-btn');
    const massInput   = document.getElementById('pump-cal-mass');
    const massGroup   = document.getElementById('pump-mass-group');
    const modalLog    = document.getElementById('pump-modal-log');
    const resultEl    = document.getElementById('pump-cal-result');

    let flushing = false;

    function setModalLog(msg, type) {
        modalLog.textContent = msg;
        modalLog.className = 'modal-log ' + type;
    }

    function closeModal() {
        modal.style.display   = 'none';
        startBtn.style.display  = 'block';
        startBtn.disabled       = false;
        massGroup.style.display = 'none';
        massInput.value         = '';
        resultEl.textContent    = '';
        setModalLog('', '');
    }

    flushBtn.addEventListener('click', async () => {
        try {
            if (!flushing) {
                await sendCommand('FLUSH');
                flushing = true;
                flushBtn.textContent = 'STOP FLUSH';
                flushBtn.classList.add('active');
            } else {
                await sendCommand('STOP');
                flushing = false;
                flushBtn.textContent = 'FLUSH';
                flushBtn.classList.remove('active');
            }
        } catch (err) {
            setLog('pump-cal-log', `ERR ${err.message}`, 'err');
        }
    });

    runBtn.addEventListener('click', () => {
        if (flushing) return;
        closeModal();
        modal.style.display = 'flex';
        setModalLog('Place collection vessel and press Start.', '');
    });

    cancelBtn.addEventListener('click', closeModal);

    startBtn.addEventListener('click', async () => {
        try {
            startBtn.disabled = true;
            setModalLog(`Running ${CALIBRATION_STEPS} steps...`, '');
            await sendCommand('CALIBRATE');
        } catch (err) {
            setModalLog(`ERR ${err.message}`, 'err');
            startBtn.disabled = false;
        }
    });

    submitBtn.addEventListener('click', async () => {
        const mass = parseFloat(massInput.value);
        if (isNaN(mass) || mass <= 0) {
            setModalLog('ERR enter a valid mass', 'err');
            return;
        }
        const stepsPerMl = CALIBRATION_STEPS / mass;
        try {
            await sendCommand(`SET_CAL ${stepsPerMl.toFixed(4)}`);
            resultEl.textContent = `${stepsPerMl.toFixed(1)} steps/ml`;
            onPumpCalSaved(stepsPerMl);
            setModalLog('Calibration saved.', 'ok');
            setTimeout(closeModal, 1500);
        } catch (err) {
            setModalLog(`ERR ${err.message}`, 'err');
        }
    });

    function onPumpNotify(msg) {
        if (msg.startsWith('CAL_DONE')) {
            setModalLog('Pump done. Weigh collected water and enter mass.', 'ok');
            startBtn.style.display  = 'none';
            massGroup.style.display = 'flex';
            submitBtn.disabled      = false;
        } else if (msg.startsWith('FLUSHING')) {
            setLog('pump-cal-log', 'Flushing...', '');
        } else if (msg.startsWith('STOPPED')) {
            setLog('pump-cal-log', 'Stopped.', '');
            flushing = false;
            flushBtn.textContent = 'FLUSH';
            flushBtn.classList.remove('active');
        }
    }

    return { onPumpNotify };
}