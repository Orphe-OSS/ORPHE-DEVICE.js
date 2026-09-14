/**
 * ORPHE 共通 UUID 定義。CORE / INSOLE 両SDKで完全一致していた定数の共通化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORPHE_UUID, orpheCharacteristics } from '../../src/protocol/uuids.ts';

test('UUID 定数は両SDKの実機値と一致する', () => {
  assert.equal(ORPHE_UUID.INFORMATION_SERVICE, '01a9d6b5-ff6e-444a-b266-0be75e85c064');
  assert.equal(ORPHE_UUID.DEVICE_INFORMATION, '24354f22-1c46-430e-a4ab-a1eeabbcdfc0');
  assert.equal(ORPHE_UUID.DATE_TIME, 'f53eeeb1-b2e8-492a-9673-10e0f1c29026');
  assert.equal(ORPHE_UUID.OTHER_SERVICE, 'db1b7aca-cda5-4453-a49b-33a53d3f0833');
  assert.equal(ORPHE_UUID.SENSOR_VALUES, 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f');
  assert.equal(ORPHE_UUID.STEP_ANALYSIS, '4eb776dc-cf99-4af7-b2d3-ad0f791a79dd');
  // core3 FW: BLE_UUID_GET_FW_NAME_BASE_UUID（Get FW Name の read）
  assert.equal(ORPHE_UUID.GET_FW_NAME, '690ecd23-c460-4ce3-8b5c-c0de65eb02d2');
});

test('orpheCharacteristics: 論理名 → service/characteristic の対応', () => {
  const table = orpheCharacteristics();
  assert.equal(table.DEVICE_INFORMATION!.serviceUUID, ORPHE_UUID.INFORMATION_SERVICE);
  assert.equal(table.DATE_TIME!.serviceUUID, ORPHE_UUID.INFORMATION_SERVICE);
  assert.equal(table.SENSOR_VALUES!.serviceUUID, ORPHE_UUID.OTHER_SERVICE);
  assert.equal(table.STEP_ANALYSIS!.serviceUUID, ORPHE_UUID.OTHER_SERVICE);
  assert.equal(table.STEP_ANALYSIS!.characteristicUUID, ORPHE_UUID.STEP_ANALYSIS);
  assert.equal(table.GET_FW_NAME!.serviceUUID, ORPHE_UUID.OTHER_SERVICE);
  assert.equal(table.GET_FW_NAME!.characteristicUUID, ORPHE_UUID.GET_FW_NAME);
});
