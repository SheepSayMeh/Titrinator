import { ESPLoader, Transport } from 'esptool-js';
import { showOnly, setLog } from './ui.js';

import esp32devBootloaderUrl from '../firmware/.pio/build/esp32dev/bootloader.bin?url';
import esp32devPartitionsUrl from '../firmware/.pio/build/esp32dev/partitions.bin?url';
import esp32devFirmwareUrl from '../firmware/.pio/build/esp32dev/firmware.bin?url';
import esp32c3BootloaderUrl from '../firmware/.pio/build/esp32-c3/bootloader.bin?url';
import esp32c3PartitionsUrl from '../firmware/.pio/build/esp32-c3/partitions.bin?url';
import esp32c3FirmwareUrl from '../firmware/.pio/build/esp32-c3/firmware.bin?url';

const BOOT_APP0_URL = `${import.meta.env.BASE_URL}firmware/boot_app0.bin`;

const BOARD_PRESETS = {
    esp32dev: {
        label: 'ESP32dev',
        pins: { STEP: 27, DIR: 26, EN: 25, SENSOR: 32 },
        files: {
            bootloader: esp32devBootloaderUrl,
            partitions: esp32devPartitionsUrl,
            firmware: esp32devFirmwareUrl,
        },
        flashMode: 'dio',
        bootBaudrate: 921600,
    },
    esp32c3: {
        label: 'ESP32-C3',
        pins: { STEP: 10, DIR: 3, EN: 1, SENSOR: 0 },
        files: {
            bootloader: esp32c3BootloaderUrl,
            partitions: esp32c3PartitionsUrl,
            firmware: esp32c3FirmwareUrl,
        },
        flashMode: 'dio',
        bootBaudrate: 460800,
    },
};

const FLASH_OFFSETS = {
    bootloader: 0x0000,
    partitions: 0x8000,
    bootApp0: 0xe000,
    firmware: 0x10000,
};

let selectedBoard = 'esp32dev';
let isFlashing = false;

function $id(id) {
    return document.getElementById(id);
}

function terminal() {
    return {
        clean() {},
        writeLine(data) { appendLog(data); },
        write(data) { appendLog(data); },
    };
}

function appendLog(msg, type = '') {
    const el = $id('flasher-log');
    if (!el || !msg) return;
    el.className = 'log flasher-log ' + type;
    el.textContent += `${msg}\n`;
    el.scrollTop = el.scrollHeight;
}

function setFlashStatus(msg, type = '') {
    setLog('flasher-status', msg, type);
}

function setProgress(percent) {
    const fill = $id('flasher-progress-fill');
    const text = $id('flasher-progress-text');
    const clamped = Math.max(0, Math.min(100, percent));
    if (fill) fill.style.width = `${clamped}%`;
    if (text) text.textContent = `${clamped.toFixed(0)}%`;
}

function setBusy(busy) {
    isFlashing = busy;
    ['flasher-program-btn', 'flasher-back-btn'].forEach(id => {
        const btn = $id(id);
        if (btn) btn.disabled = busy;
    });
}

function currentPins() {
    return {
        STEP: parseInt($id('flasher-pin-step')?.value, 10),
        DIR: parseInt($id('flasher-pin-dir')?.value, 10),
        EN: parseInt($id('flasher-pin-en')?.value, 10),
        SENSOR: parseInt($id('flasher-pin-sensor')?.value, 10),
    };
}

function currentConfig() {
    return {
        name: ($id('flasher-board-name')?.value || '').trim(),
        pins: currentPins(),
    };
}

function validateConfig() {
    const { name, pins } = currentConfig();
    if (!name || name.length > 31) return 'Use a board name from 1 to 31 characters.';

    const pinValues = Object.values(pins);
    if (pinValues.some(pin => Number.isNaN(pin) || pin < 0)) {
        return 'All pins must be non-negative numbers.';
    }
    if (new Set(pinValues).size !== pinValues.length) {
        return 'STEP, DIR, EN, and SENSOR pins must be unique.';
    }
    return '';
}

function applyPreset(boardId) {
    selectedBoard = boardId;
    const preset = BOARD_PRESETS[selectedBoard];

    document.querySelectorAll('[data-flasher-board]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.flasherBoard === selectedBoard);
    });

    $id('flasher-pin-step').value = preset.pins.STEP;
    $id('flasher-pin-dir').value = preset.pins.DIR;
    $id('flasher-pin-en').value = preset.pins.EN;
    $id('flasher-pin-sensor').value = preset.pins.SENSOR;
    setFlashStatus(`${preset.label} preset loaded.`, '');
}

async function fetchBinary(url) {
    console.log(`Fetching: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load firmware asset: ${url}`);
    const data = new Uint8Array(await res.arrayBuffer());
    console.log(`  → ${data.length} bytes`);
    return data;
}

async function firmwareFiles() {
    const preset = BOARD_PRESETS[selectedBoard];
    const [bootloader, partitions, bootApp0, firmware] = await Promise.all([
        fetchBinary(preset.files.bootloader),
        fetchBinary(preset.files.partitions),
        fetchBinary(BOOT_APP0_URL),
        fetchBinary(preset.files.firmware),
    ]);

    return [
        { data: bootloader, address: FLASH_OFFSETS.bootloader },
        { data: partitions, address: FLASH_OFFSETS.partitions },
        { data: bootApp0, address: FLASH_OFFSETS.bootApp0 },
        { data: firmware, address: FLASH_OFFSETS.firmware },
    ];
}

async function writeSerialCommands(port, commands) {
    console.log(`[Serial] Opening port to send ${commands.length} commands...`);
    try {
        await port.open({ baudRate: 115200 });
        console.log(`[Serial] Port opened`);
    } catch (e) {
        console.error(`[Serial] Failed to open port:`, e);
        throw e;
    }

    try {
        const writer = port.writable.getWriter();
        try {
            const encoder = new TextEncoder();
            for (let i = 0; i < commands.length; i++) {
                const command = commands[i];
                console.log(`[Serial] Sending command ${i + 1}/${commands.length}: ${command}`);
                try {
                    await writer.write(encoder.encode(`${command}\n`));
                    console.log(`[Serial] Command sent, waiting 300ms...`);
                    await new Promise(resolve => setTimeout(resolve, 300));
                } catch (e) {
                    console.error(`[Serial] Failed to send command:`, e);
                    throw e;
                }
            }
        } finally {
            console.log(`[Serial] Releasing writer lock`);
            writer.releaseLock();
        }
    } finally {
        console.log(`[Serial] Closing port`);
        await port.close();
    }
    console.log(`[Serial] All commands sent successfully`);
}

async function programBoard() {
    if (isFlashing) return;
    const validationError = validateConfig();
    if (validationError) {
        setFlashStatus(validationError, 'err');
        return;
    }
    if (!navigator.serial) {
        setFlashStatus('Web Serial is not supported in this browser.', 'err');
        return;
    }

    setBusy(true);
    setProgress(0);
    const log = $id('flasher-log');
    if (log) log.textContent = '';

    let transport = null;
    try {
        console.log(`[Flasher] Starting flash for board: ${selectedBoard}`);
        setFlashStatus('Select the ESP32 serial port.', '');
        const port = await navigator.serial.requestPort();
        console.log(`[Flasher] Port selected, creating transport...`);

        transport = new Transport(port, true);
        const preset = BOARD_PRESETS[selectedBoard];
        console.log(`[Flasher] Using preset:`, preset);

        const loader = new ESPLoader({
            transport,
            baudrate: preset.bootBaudrate,
            terminal: terminal(),
            debugLogging: false,
        });

        console.log(`[Flasher] Connecting to bootloader...`);
        setFlashStatus('Connecting to bootloader...', '');
        const chip = await loader.main('default_reset');
        console.log(`[Flasher] Connected to: ${chip}`);
        appendLog(`Connected to ${chip}.`);

        console.log(`[Flasher] Loading firmware assets...`);
        setFlashStatus('Loading firmware assets...', '');
        const files = await firmwareFiles();
        console.log(`[Flasher] Loaded ${files.length} files:`, files.map(f => ({ address: `0x${f.address.toString(16)}`, size: f.data.length })));
        let totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
        console.log(`[Flasher] Total bytes to flash: ${totalBytes} (${(totalBytes/1024).toFixed(1)} KB)`);
        let completedFiles = 0;

        console.log(`[Flasher] Starting write with mode=${preset.flashMode}...`);
        setFlashStatus('Writing flash...', '');
        await loader.writeFlash({
            fileArray: files,
            flashMode: preset.flashMode,
            flashFreq: '40m',
            flashSize: '4MB',
            eraseAll: false,
            compress: true,
            reportProgress: (fileIndex, written) => {
                const previous = files
                    .slice(0, fileIndex)
                    .reduce((sum, file) => sum + file.data.length, 0);
                completedFiles = Math.max(completedFiles, previous + written);
                const percent = (completedFiles / totalBytes) * 100;
                console.log(`[Flasher] Progress: ${percent.toFixed(1)}%`);
                setProgress(percent);
            },
        });

        console.log(`[Flasher] Flash write complete, resetting board...`);
        setFlashStatus('Resetting board...', '');
        await loader.after('hard_reset');
        await transport.disconnect();
        transport = null;

        setFlashStatus('Saving board config...', '');
        console.log(`[Flasher] Waiting for board to boot before sending config...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        const configCommand = `SET_DEVICE_CONFIG ${JSON.stringify(currentConfig())}`;
        console.log(`[Flasher] Sending config command:`, configCommand);
        await writeSerialCommands(port, [configCommand, 'RESTART']);
        console.log(`[Flasher] Config sent, board restarting...`);

        console.log(`[Flasher] Flashing complete!`);
        setProgress(100);
        setFlashStatus('Firmware programmed and config saved.', 'ok');
    } catch (err) {
        console.error(`[Flasher] Error:`, err);
        setFlashStatus(`ERR ${err.message}`, 'err');
        appendLog(err.stack || err.message, 'err');
    } finally {
        if (transport) {
            try { await transport.disconnect(); } catch(e) {}
        }
        setBusy(false);
    }
}

export function initFlasher({ onCancel }) {
    $id('flasher-back-btn')?.addEventListener('click', () => {
        if (!isFlashing) onCancel();
    });

    Object.entries(BOARD_PRESETS).forEach(([id, preset], idx) => {
        const btn = document.createElement('button');
        btn.className = 'dir-btn' + (idx === 0 ? ' active' : '');
        btn.dataset.flasherBoard = id;
        btn.textContent = preset.label;
        btn.addEventListener('click', () => applyPreset(id));
        $id('flasher-board-row')?.appendChild(btn);
    });

    $id('flasher-advanced-toggle')?.addEventListener('change', event => {
        const panel = $id('flasher-advanced-panel');
        if (panel) panel.style.display = event.target.checked ? 'flex' : 'none';
    });

    $id('flasher-program-btn')?.addEventListener('click', programBoard);
    applyPreset(selectedBoard);
}
