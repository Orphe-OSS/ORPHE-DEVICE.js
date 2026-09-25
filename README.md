# ORPHE Device.js

ORPHE CORE / ORPHE INSOLE を Web Bluetooth で扱う SDK。

```ts
import { OrpheCoreInsole, insoleProfile } from 'orphe-core-insole';

const ble = new OrpheCoreInsole({ profile: insoleProfile() });
ble.on('converted_press', (press) => console.log(press.values)); // 6ch 圧力 [N]
ble.on('euler', (euler) => console.log(euler.roll, euler.pitch, euler.yaw));
await ble.begin('SENSOR_VALUES', { autoReconnect: true });
```

## 特長

- CORE / INSOLE を同じ API で扱える
- 接続したデバイスで使えるモードだけを `availableModes` で返す
- 切断時の自動再接続と、記憶デバイスへの chooser なし再接続
- FIFO ロスレス収録と歩容解析（CSV 出力付き）
- タブ間の接続共有

## 動作環境

- Web Bluetooth に対応したブラウザ（Chrome / Edge。HTTPS または localhost）
- 開発には Node.js 22 以上

## インストール

npm には未公開です。クローンしてビルドします。

```bash
git clone <このリポジトリ>
cd orphe-device
npm install
npm run build   # dist/ に ESM と型定義を出力
```

## 開発

```bash
npm test             # ユニットテスト
npm run check        # 型チェック + テスト
npm run build        # dist/ に出力
npm run example      # サンプル（example/）を起動
```

## 使い方

### 接続と購読

```ts
import { OrpheCoreInsole, coreProfile, insoleProfile } from 'orphe-core-insole';

const ble = new OrpheCoreInsole({
  profile: insoleProfile(),   // CORE なら coreProfile()
  id: 0,                      // 複数台つなぐときのスロット番号
  events: {
    onConnect: () => console.log('接続'),
    onDisconnect: () => console.log('切断'),
    onError: (error) => console.error(error),
  },
});

ble.on('acc', (acc) => { /* 加速度 */ });
ble.on('*', (sample) => { /* 1 サンプル全体 */ });

await ble.begin('SENSOR_VALUES', { autoReconnect: true });
// ...
ble.stop();
```

### 購読できるフィールド

| プロファイル | フィールド |
|---|---|
| CORE | `acc` `gyro` `quat` `converted_acc` `converted_gyro` `gait` `stride` `pronation` `steps_number` `calorie` ほか |
| INSOLE | `acc` `gyro` `quat` `euler` `press` `converted_acc` `converted_gyro` `converted_press` `ble_frequency` `lost_data` |

### 取得モード

```ts
await ble.readFirmwareInfo();   // 接続だけ先に済ませる
ble.availableModes;             // [{ id: 'STREAMING_4', label: 'Full sensor 100 Hz' }, ...]
```

| プロファイル | `begin()` の種別 | オプション |
|---|---|---|
| CORE | `SENSOR_VALUES` / `STEP_ANALYSIS` / `STEP_ANALYSIS_AND_SENSOR_VALUES` | `range`（加速度・角速度のレンジ） |
| INSOLE | `SENSOR_VALUES` | `streamingMode`: 1（姿勢）/ 3（圧力 + IMU）/ 4（全センサー） |

`STREAMING_*` のモード id は `insoleStreamingModeOf(id)` で `streamingMode` の番号にできます。

### FIFO ロスレス収録

```ts
import { FifoRecorder } from 'orphe-core-insole';

const fifo = new FifoRecorder(ble);
fifo.onSamples = (deviceId, samples) => { /* 回収したサンプル */ };
fifo.onDataLoss = (info) => console.warn(`欠損 ${info.dropped}`);

await fifo.start();     // 使えないデバイスでは false
// ...
await fifo.stop();
fifo.download('capture.csv');
```

### 歩容解析（INSOLE）

```ts
import { InsoleGait } from 'orphe-core-insole';

const gait = new InsoleGait(ble);
gait.onGait = (deviceId, row) => { /* 1 歩ぶんの歩容パラメーター */ };
await gait.start();
// ...
await gait.stop();
gait.download('gait.csv');
```

### 自動再接続

```ts
await ble.begin('SENSOR_VALUES', {
  autoReconnect: true,
  reconnect: { intervalMs: 3000, maxAttempts: 120 },
});
```

進行は `onReconnectAttempt` / `onReconnectSuccess` / `onReconnectFailed` で受け取れます。

### 複数台とタブ間共有

- 複数台は `id` を変えて `OrpheCoreInsole` を台数ぶん作ります。`deviceGuard` で二重割当を防げます。
- `BleSharedBridge` で、接続を持つタブから他のタブへセンサーデータを配信できます。

### エラー

```ts
try {
  await ble.begin();
} catch (error) {
  if (error instanceof TransportError && error.code === 'NO_DEVICE') { /* chooser でキャンセル */ }
}
```
