/**
 * ORPHE デバイス共通の UUID 定義（CORE / INSOLE 共通、FW 仕様に準拠）。
 * 何にも依存しない葉。chooser フィルタはデバイスごとに異なるため profiles/ 側にある。
 */

/** service/characteristic UUID のペア。論理名（'DEVICE_INFORMATION' 等）で登録する */
export interface CharacteristicId {
  /** 所属サービスの UUID */
  serviceUUID: string;
  /** characteristic の UUID */
  characteristicUUID: string;
}

/** ORPHE デバイスの service / characteristic UUID（CORE・INSOLE 共通）。 */
export const ORPHE_UUID = {
  /** Orphe Information Service */
  INFORMATION_SERVICE: '01a9d6b5-ff6e-444a-b266-0be75e85c064',
  /** Device Information characteristic（Information Service 配下） */
  DEVICE_INFORMATION: '24354f22-1c46-430e-a4ab-a1eeabbcdfc0',
  /** Date Time characteristic（Information Service 配下） */
  DATE_TIME: 'f53eeeb1-b2e8-492a-9673-10e0f1c29026',
  /** Orphe Other Service（センサーデータ系） */
  OTHER_SERVICE: 'db1b7aca-cda5-4453-a49b-33a53d3f0833',
  /** Sensor Values characteristic（Other Service 配下） */
  SENSOR_VALUES: 'f3f9c7ce-46ee-4205-89ac-abe64e626c0f',
  /** Step Analysis characteristic（Other Service 配下） */
  STEP_ANALYSIS: '4eb776dc-cf99-4af7-b2d3-ad0f791a79dd',
  /** Get FW Name characteristic（Other Service 配下・FW ビルド名の read） */
  GET_FW_NAME: '690ecd23-c460-4ce3-8b5c-c0de65eb02d2',
} as const;

/** 論理名 → UUID ペアの標準テーブル（TransportConfig.characteristics 用） */
export function orpheCharacteristics(): Record<string, CharacteristicId> {
  return {
    DEVICE_INFORMATION: {
      serviceUUID: ORPHE_UUID.INFORMATION_SERVICE,
      characteristicUUID: ORPHE_UUID.DEVICE_INFORMATION,
    },
    DATE_TIME: {
      serviceUUID: ORPHE_UUID.INFORMATION_SERVICE,
      characteristicUUID: ORPHE_UUID.DATE_TIME,
    },
    SENSOR_VALUES: {
      serviceUUID: ORPHE_UUID.OTHER_SERVICE,
      characteristicUUID: ORPHE_UUID.SENSOR_VALUES,
    },
    STEP_ANALYSIS: {
      serviceUUID: ORPHE_UUID.OTHER_SERVICE,
      characteristicUUID: ORPHE_UUID.STEP_ANALYSIS,
    },
    GET_FW_NAME: {
      serviceUUID: ORPHE_UUID.OTHER_SERVICE,
      characteristicUUID: ORPHE_UUID.GET_FW_NAME,
    },
  };
}
