/** ORPHE CORE の GATT を持つモックデバイス（DEVICE_INFORMATION / DATE_TIME / SENSOR_VALUES / STEP_ANALYSIS） */
import { ORPHE_UUID } from '../../src/protocol/uuids.ts';
import { encodeDateTime } from '../../src/protocol/datetime.ts';
import { MockDevice } from './mock-bluetooth.ts';

let serial = 0;

export function mockCoreDevice() {
  serial++;
  const device = new MockDevice(`core-${serial}`, `CR-${serial}`);
  const info = device.gatt.getOrCreateService(ORPHE_UUID.INFORMATION_SERVICE);
  const deviceInfo = info.getOrCreate(ORPHE_UUID.DEVICE_INFORMATION);
  const infoData = new DataView(new ArrayBuffer(20));
  infoData.setUint8(0, 2); // battery
  infoData.setUint8(1, 1); // lr
  infoData.setUint8(4, 100); // led_brightness
  infoData.setUint8(8, 3);
  infoData.setUint8(9, 3);
  deviceInfo.readValueData = infoData;
  const dateTime = info.getOrCreate(ORPHE_UUID.DATE_TIME);
  dateTime.readValueData = new DataView(encodeDateTime(new Date()).buffer);
  const other = device.gatt.getOrCreateService(ORPHE_UUID.OTHER_SERVICE);
  const sensor = other.getOrCreate(ORPHE_UUID.SENSOR_VALUES);
  const step = other.getOrCreate(ORPHE_UUID.STEP_ANALYSIS);
  return { device, deviceInfo, dateTime, sensor, step };
}
