/**
 * 接続成功デバイスの記憶と、navigator.bluetooth.getDevices() による
 * ダイアログなし復元。
 *
 * storage 例外（プライベートモード等）と getDevices 未対応環境は
 * すべて「記憶なし」として静かに扱う。
 */
import type { BleBluetooth, BleDevice, StorageLike } from './web-bluetooth.ts';

/** localStorage に保存する「前回つないだデバイス」の情報。 */
export interface RememberedDeviceInfo {
  /** Web Bluetooth のデバイス id（BluetoothDevice.id） */
  bluetoothId: string;
  /** デバイス名（表示用） */
  bluetoothName: string;
  /** 最終接続時刻（epoch ms） */
  lastConnectedAt: number;
}


/** 記憶デバイスの在圏確認で広告を待つ既定時間 [ms] */
const DEFAULT_ADVERTISEMENT_TIMEOUT_MS = 2000;

/** {@link DeviceMemory.restore} のオプション。 */
export interface RestoreOptions {
  /**
   * 広告を待つ上限 [ms]。既定 2000。
   * これを過ぎても広告が来なければ圏外とみなし、復元を諦める。
   */
  advertisementTimeoutMs?: number;
}

/**
 * 接続に成功したデバイスを storage へ記憶し、次回は chooser なしで復元する。
 * storage 例外や getDevices() 未対応は「記憶なし」として静かに扱う。
 */
export class DeviceMemory {
  private readonly storageKey: string;
  private readonly storage: StorageLike;
  /** 復元を試みたが接続に失敗した場合に立てる（次回は chooser へフォールバック） */
  private unavailable = false;
  /** 直近の在圏確認で広告を受信するまでにかかった時間 [ms]（診断用） */
  lastAdvertisementWaitMs: number | null = null;

  constructor(storageKey: string, storage: StorageLike) {
    this.storageKey = storageKey;
    this.storage = storage;
  }

  /** 接続に成功したデバイスを記憶する（storage が使えなければ何もしない）。 */
  remember(device: BleDevice): void {
    if (!device) return;
    this.unavailable = false;
    try {
      const info: RememberedDeviceInfo = {
        bluetoothId: device.id || '',
        bluetoothName: device.name || '',
        lastConnectedAt: Date.now(),
      };
      this.storage.setItem(this.storageKey, JSON.stringify(info));
    } catch { /* storage 不可の環境では記憶しないだけ */ }
  }

  /** 記憶しているデバイス情報を読む。無効・不在なら null。 */
  load(): RememberedDeviceInfo | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const info = JSON.parse(raw) as Partial<RememberedDeviceInfo> | null;
      if (!info || (!info.bluetoothId && !info.bluetoothName)) return null;
      return {
        bluetoothId: info.bluetoothId || '',
        bluetoothName: info.bluetoothName || '',
        lastConnectedAt: Number(info.lastConnectedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  /** 記憶を消す（次回は必ず chooser を出す）。 */
  forget(): void {
    this.unavailable = false;
    try {
      this.storage.removeItem(this.storageKey);
    } catch { /* noop */ }
  }

  /** 復元を試みて失敗したことを記録し、以降は chooser へフォールバックさせる。 */
  markUnavailable(): void {
    this.unavailable = true;
  }

  /** 記憶があり、かつ前回の復元が失敗マークされていないか */
  shouldTryRestore(): boolean {
    return !this.unavailable && this.load() !== null;
  }

  /**
   * getDevices() の一覧から記憶デバイスを探し、在圏を確かめてから返す。
   * id 完全一致 → 名前の一意一致 の順。見つからない・圏外なら null。
   */
  async restore(bluetooth: BleBluetooth, options: RestoreOptions = {}): Promise<BleDevice | null> {
    if (typeof bluetooth.getDevices !== 'function') return null;
    const info = this.load();
    if (!info) return null;
    try {
      const devices = await bluetooth.getDevices();
      const device = this.find(devices, info);
      if (!device) return null;
      const timeoutMs = options.advertisementTimeoutMs ?? DEFAULT_ADVERTISEMENT_TIMEOUT_MS;
      return (await this.isReachable(device, timeoutMs)) ? device : null;
    } catch {
      return null;
    }
  }

  /**
   * 広告を受信できるか（＝電波の届く範囲にいるか）を確かめる。
   *
   * getDevices() が返すのは「権限を与えたことがあるデバイス」であって在圏は保証しない。
   * ここを省いて直接 gatt.connect() すると、圏外のデバイスに対して
   * 「Bluetooth Device is no longer in range.」で失敗し、chooser への
   * フォールバックが次回接続まで持ち越されてしまう（接続ボタンを2回押す羽目になる）。
   *
   * 判定できない環境（watchAdvertisements 未対応・呼び出し自体が失敗）では true を返し、
   * そのまま接続を試みる。
   */
  private isReachable(device: BleDevice, timeoutMs: number): Promise<boolean> {
    if (device.gatt?.connected) return Promise.resolve(true);
    if (typeof device.watchAdvertisements !== 'function') return Promise.resolve(true);

    return new Promise<boolean>(resolve => {
      let settled = false;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const finish = (reachable: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        device.removeEventListener('advertisementreceived', onAdvertisement);
        try { controller?.abort(); } catch { /* 監視の停止失敗は無視 */ }
        resolve(reachable);
      };
      const startedAt = Date.now();
      const onAdvertisement = () => {
        this.lastAdvertisementWaitMs = Date.now() - startedAt;
        finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      device.addEventListener('advertisementreceived', onAdvertisement);
      Promise.resolve(device.watchAdvertisements!(controller ? { signal: controller.signal } : undefined))
        .catch(() => finish(true));
    });
  }

  private find(devices: BleDevice[], info: RememberedDeviceInfo): BleDevice | null {
    if (!Array.isArray(devices)) return null;

    if (info.bluetoothId) {
      const matchedById = devices.find(device => device.id === info.bluetoothId);
      if (matchedById) return matchedById;
    }

    if (info.bluetoothName) {
      const matchedByName = devices.filter(device => device.name === info.bluetoothName);
      if (matchedByName.length === 1) return matchedByName[0]!;
    }

    return null;
  }
}
