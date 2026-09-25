/**
 * Web Bluetooth API のモック実装（テスト用）。
 * 遅延・失敗の注入と呼び出し記録ができる。
 */
import type {
  BleBluetooth,
  BleBufferSource,
  BleCharacteristic,
  BleDevice,
  BleGattServer,
  BleGattService,
  BleRequestDeviceOptions,
  BleValueChangedEvent,
  StorageLike,
} from '../../src/ble/web-bluetooth.ts';

/** 手動で解決/拒否できる Promise */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを何周か回す（promise チェーンの安定化用） */
export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** 条件が真になるまでタイマーを挟んで待つ（タイマー越しの非同期処理の安定化用） */
export async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type Listener = (event: BleValueChangedEvent) => void;

export class MockCharacteristic implements BleCharacteristic {
  readonly uuid: string;
  notifying = false;
  startCalls = 0;
  stopCalls = 0;
  readCalls = 0;
  written: Uint8Array[] = [];
  listeners = new Set<Listener>();
  readValueData: DataView = new DataView(new ArrayBuffer(20));
  /** 次の startNotifications をこの promise の解決まで待たせる */
  startGate: Promise<unknown> | null = null;
  stopGate: Promise<unknown> | null = null;
  readGate: Promise<unknown> | null = null;
  failNextStart: unknown = null;
  failNextStop: unknown = null;
  failNextRead: unknown = null;
  failNextWrite: unknown = null;
  /** write への反応フック（fake FW 用）。written への記録後に呼ばれる */
  onWriteValue: ((bytes: Uint8Array) => void) | null = null;

  constructor(uuid: string) {
    this.uuid = uuid;
  }

  async readValue(): Promise<DataView> {
    this.readCalls++;
    if (this.readGate) {
      const gate = this.readGate;
      this.readGate = null;
      await gate;
    }
    if (this.failNextRead) {
      const e = this.failNextRead;
      this.failNextRead = null;
      throw e;
    }
    return this.readValueData;
  }

  async writeValue(data: BleBufferSource): Promise<void> {
    if (this.failNextWrite) {
      const e = this.failNextWrite;
      this.failNextWrite = null;
      throw e;
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    this.written.push(new Uint8Array(bytes));
    this.onWriteValue?.(new Uint8Array(bytes));
  }

  async startNotifications(): Promise<unknown> {
    this.startCalls++;
    if (this.startGate) {
      const gate = this.startGate;
      this.startGate = null;
      await gate;
    }
    if (this.failNextStart) {
      const e = this.failNextStart;
      this.failNextStart = null;
      throw e;
    }
    this.notifying = true;
    return this;
  }

  async stopNotifications(): Promise<unknown> {
    this.stopCalls++;
    if (this.stopGate) {
      const gate = this.stopGate;
      this.stopGate = null;
      await gate;
    }
    if (this.failNextStop) {
      const e = this.failNextStop;
      this.failNextStop = null;
      throw e;
    }
    this.notifying = false;
    return this;
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === 'characteristicvaluechanged') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'characteristicvaluechanged') this.listeners.delete(listener);
  }

  /** notify データの到着をシミュレートする */
  emit(value: DataView): void {
    for (const listener of [...this.listeners]) {
      listener({ target: { value } });
    }
  }
}

export class MockGattService implements BleGattService {
  characteristics = new Map<string, MockCharacteristic>();

  getOrCreate(uuid: string): MockCharacteristic {
    let c = this.characteristics.get(uuid);
    if (!c) {
      c = new MockCharacteristic(uuid);
      this.characteristics.set(uuid, c);
    }
    return c;
  }

  async getCharacteristic(uuid: string): Promise<BleCharacteristic> {
    return this.getOrCreate(uuid);
  }
}

export class MockGattServer implements BleGattServer {
  connected = false;
  connectCalls = 0;
  services = new Map<string, MockGattService>();
  /** 次の connect をこの promise の解決まで待たせる */
  connectGate: Promise<unknown> | null = null;
  failNextConnect: unknown = null;
  private readonly device: MockDevice;

  constructor(device: MockDevice) {
    this.device = device;
  }

  getOrCreateService(uuid: string): MockGattService {
    let s = this.services.get(uuid);
    if (!s) {
      s = new MockGattService();
      this.services.set(uuid, s);
    }
    return s;
  }

  async connect(): Promise<BleGattServer> {
    this.connectCalls++;
    if (this.connectGate) {
      const gate = this.connectGate;
      this.connectGate = null;
      await gate;
    }
    if (this.failNextConnect) {
      const e = this.failNextConnect;
      this.failNextConnect = null;
      throw e;
    }
    this.connected = true;
    return this;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatch('gattserverdisconnected', {});
  }

  /** リンクロス（デバイス起因の切断）をシミュレート */
  simulateLinkLoss(): void {
    this.disconnect();
  }

  async getPrimaryService(uuid: string): Promise<BleGattService> {
    if (!this.connected) throw new Error('GATT Server is disconnected.');
    return this.getOrCreateService(uuid);
  }
}

export class MockDevice implements BleDevice {
  readonly id: string;
  readonly name: string;
  readonly gatt: MockGattServer;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.gatt = new MockGattServer(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

export class MockBluetooth implements BleBluetooth {
  /** requestDevice が順に返すデバイス（尽きたら reject = chooser キャンセル相当） */
  chooserQueue: MockDevice[] = [];
  requestDeviceCalls: BleRequestDeviceOptions[] = [];
  /** getDevices() が返す一覧。null なら getDevices 自体が未対応 */
  knownDevices: MockDevice[] | null = [];

  constructor(options: { supportsGetDevices?: boolean } = {}) {
    if (options.supportsGetDevices === false) {
      this.knownDevices = null;
      // getDevices 未対応環境を再現
      delete (this as { getDevices?: unknown }).getDevices;
    }
  }

  async requestDevice(options: BleRequestDeviceOptions): Promise<BleDevice> {
    this.requestDeviceCalls.push(options);
    const device = this.chooserQueue.shift();
    if (!device) {
      const error = new Error('User cancelled the requestDevice() chooser.');
      error.name = 'NotFoundError';
      throw error;
    }
    return device;
  }

  async getDevices(): Promise<BleDevice[]> {
    if (this.knownDevices === null) throw new Error('getDevices not supported');
    return this.knownDevices;
  }
}

export class MemoryStorage implements StorageLike {
  map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}
