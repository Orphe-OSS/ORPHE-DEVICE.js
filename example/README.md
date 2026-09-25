# examples

`OrpheCoreInsole` の実機動作サンプル。Vite が TypeScript をそのまま配信するので事前ビルドは不要。

```bash
npm run example
```

Web Bluetooth に対応したブラウザ（Chrome / Edge）で開く。

| ページ | 内容 |
|---|---|
| `core.html` | ORPHE CORE。quat / euler / gyro / acc / gait / stride / pronation の表示と姿勢キューブ。FIFO 収録 |
| `insole.html` | ORPHE INSOLE。6ch 圧力バーと IMU の表示。歩容解析、FIFO 収録 |
| `auto.html` | CORE / INSOLE を名前で自動判別。判別した種別のリアルタイム計測モードを選べる。共通の IMU に加え、INSOLE は圧力、CORE は歩数を表示 |

操作は「接続 → モードを選ぶ」だけ。モード一覧は接続したデバイスで使えるものだけが出る。
1 ページ 1 台なので、複数台つなぐときはページを台数ぶん開く。

```
[接続]  →  ble.readFirmwareInfo()   chooser → GATT 接続
        →  ble.availableModes       このデバイスで使えるモード
        →  ble.begin(type)          選んだモードで計測開始
```
