const SERVICE_UUID = '1aa974de-6f63-4a76-8a1f-aab707432a77';
const CMD_UUID     = 'd3951d7f-bf1e-4ad7-9da9-04cef4d5aabb';
const STATUS_UUID  = 'a493eaf8-8638-4375-8445-14fef39fb459';

let device  = null;
let cmdChar = null;

export async function connect(onNotify, onDisconnect) {
    device = await navigator.bluetooth.requestDevice({
        filters: [
            { namePrefix: 'Titrinator-' },
            { services: [SERVICE_UUID] }
        ],
        optionalServices: [SERVICE_UUID]
    });

    device.addEventListener('gattserverdisconnected', onDisconnect);

    const server     = await device.gatt.connect();
    const service    = await server.getPrimaryService(SERVICE_UUID);
    cmdChar          = await service.getCharacteristic(CMD_UUID);
    const statusChar = await service.getCharacteristic(STATUS_UUID);

    await statusChar.startNotifications();
    statusChar.addEventListener('characteristicvaluechanged', (e) => {
        onNotify(new TextDecoder().decode(e.target.value));
    });

    return device.name;
}

export async function sendCommand(cmd) {
    if (!cmdChar) throw new Error('not connected');
    await cmdChar.writeValueWithoutResponse(new TextEncoder().encode(cmd));
}

export function disconnect() {
    if (device && device.gatt.connected) device.gatt.disconnect();
}

export function isSupported() {
    return !!navigator.bluetooth;
}