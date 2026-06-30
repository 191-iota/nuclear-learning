import { reactive } from 'vue';
import { PenHelper, PenMessageType } from 'web_pen_sdk';

export interface PenDot {
  x: number;
  y: number;
  f: number;
  dotType: number;
  [key: string]: unknown;
}

export interface PenState {
  supported: boolean;
  scanning: boolean;
  connected: boolean;
  battery: number | null;
}

export interface UsePenOptions {
  onDot?: (dot: PenDot) => void;
}

/**
 * Thin wrapper around the Neo `web_pen_sdk` PenHelper.
 *
 * The SDK exposes two global callback slots (`messageCallback`, `dotCallback`).
 * We wire them once here and forward dots to the caller. NoteServer / Firebase
 * and ncode page registration are deliberately not used, dots arrive in raw
 * ncode coordinates and `useCanvas` normalises them.
 */
export function usePen(options: UsePenOptions = {}) {
  const state = reactive<PenState>({
    supported: typeof navigator !== 'undefined' && 'bluetooth' in navigator,
    scanning: false,
    connected: false,
    battery: null,
  });

  const T = PenMessageType as Record<string, unknown>;

  // PenHelper.scanPen() swallows a cancelled chooser / failed connect and resolves
  // anyway, and there is no "scan failed" message, so a watchdog is the only
  // reliable way to stop showing "scanning" when nothing connected.
  let scanWatchdog: number | undefined;
  function clearWatchdog() {
    if (scanWatchdog !== undefined) {
      window.clearTimeout(scanWatchdog);
      scanWatchdog = undefined;
    }
  }

  PenHelper.messageCallback = (_mac: unknown, type: unknown, args: any) => {
    if (T.PEN_CONNECTION_SUCCESS !== undefined && type === T.PEN_CONNECTION_SUCCESS) {
      clearWatchdog();
      state.connected = true;
      state.scanning = false;
    } else if (T.PEN_AUTHORIZED !== undefined && type === T.PEN_AUTHORIZED) {
      clearWatchdog();
      state.connected = true;
      state.scanning = false;
    } else if (T.PEN_DISCONNECTED !== undefined && type === T.PEN_DISCONNECTED) {
      clearWatchdog();
      state.connected = false;
      state.battery = null;
      state.scanning = false;
    } else if (T.PEN_SETTING_INFO !== undefined && type === T.PEN_SETTING_INFO) {
      // Settings info only arrives on an authorised connection.
      clearWatchdog();
      state.connected = true;
      state.scanning = false;
      if (args && typeof args.Battery === 'number') {
        state.battery = args.Battery;
      }
    }
    // On any successful connection (manual OR auto), wire the pen for automatic
    // reconnection so a later power-cycle / out-of-range drop comes back on its own.
    if (state.connected) connectedDevices().forEach(wireAutoReconnect);
  };

  PenHelper.dotCallback = (_mac: unknown, dot: any) => {
    options.onDot?.(dot as PenDot);
  };

  async function scanPen(): Promise<void> {
    if (!state.supported) {
      throw new Error(
        'Web Bluetooth is not available here. Use Chrome or Edge over https:// or localhost.',
      );
    }
    state.scanning = true;
    clearWatchdog();
    try {
      await PenHelper.scanPen();
      // scanPen resolved whether or not a pen connected. If it did, a connection
      // message has (or soon will have) cleared `scanning`; otherwise give the
      // handshake a brief grace period, then stop showing "scanning".
      clearWatchdog();
      scanWatchdog = window.setTimeout(() => {
        scanWatchdog = undefined;
        if (!state.connected) state.scanning = false;
      }, 6000);
    } catch (err) {
      clearWatchdog();
      state.scanning = false;
      throw err;
    }
  }

  // Devices already wired for auto-reconnect (so listeners don't stack), and the set
  // of devices a reconnect poll is currently running for (so loops don't stack).
  const wired = new Set<any>();
  const reconnecting = new Set<any>();

  // The BluetoothDevice objects behind the SDK's currently-connected controllers.
  function connectedDevices(): any[] {
    const pens = (PenHelper as any).pens as any[] | undefined;
    if (!Array.isArray(pens)) return [];
    return pens.map((p) => p?.device).filter(Boolean);
  }

  async function tryConnect(device: any): Promise<void> {
    try {
      // connectDevice does NOT call requestDevice, so it needs no user gesture; it is
      // a no-op if the device is already connected or connecting.
      await PenHelper.connectDevice(device);
    } catch {
      /* out of range / powered off — the reconnect poll will try again */
    }
  }

  // Keep retrying gatt.connect() on a device we already hold until the pen comes back
  // in range (you power it on again) or we give up after ~2 minutes. This is what makes
  // a power-cycle reconnect on its own with no chooser: gatt.connect() on a device the
  // browser already knows this session needs no user gesture.
  function reconnectLoop(device: any): void {
    if (reconnecting.has(device)) return;
    reconnecting.add(device);
    let attempts = 0;
    const tick = async () => {
      if (state.connected || device.gatt?.connected) {
        reconnecting.delete(device);
        return;
      }
      attempts += 1;
      await tryConnect(device);
      if (state.connected || device.gatt?.connected || attempts >= 40) {
        reconnecting.delete(device);
        return;
      }
      window.setTimeout(tick, 3000);
    };
    void tick();
  }

  function wireAutoReconnect(device: any): void {
    if (wired.has(device)) return;
    wired.add(device);
    // Reconnect whenever the pen drops (out of range, sleep, power-off).
    device.addEventListener('gattserverdisconnected', () => {
      state.connected = false;
      state.battery = null;
      reconnectLoop(device);
    });
    // Where the browser supports it, also connect the moment the pen starts
    // advertising. Best-effort; the reconnect poll above is the reliable path.
    if (typeof device.watchAdvertisements === 'function') {
      device.addEventListener('advertisementreceived', () => {
        if (!state.connected) void tryConnect(device);
      });
      try {
        const p = device.watchAdvertisements();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* advertisement watching not available here */
      }
    }
  }

  /**
   * Reconnect to a pen this origin was already granted, without showing the chooser.
   * `requestDevice` (the Connect button) needs a click; `getDevices` + GATT connect do
   * not, so this can run on page load. It is a silent no-op before any pen has ever
   * been paired (getDevices returns nothing) or on browsers without the permitted-
   * device API.
   */
  async function autoConnect(): Promise<void> {
    if (!state.supported || state.connected || state.scanning) return;
    const bt = navigator.bluetooth as any;
    if (typeof bt.getDevices !== 'function') return;
    let devices: any[] = [];
    try {
      devices = await bt.getDevices();
    } catch {
      return;
    }
    if (import.meta.env.DEV) {
      console.debug('[nuclear-learning] autoConnect: getDevices() →', devices.length, 'remembered pen(s)');
    }
    if (!devices.length) return;
    state.scanning = true;
    for (const device of devices) {
      wireAutoReconnect(device);
      await tryConnect(device);
    }
    // Drop the "scanning" indicator if nothing connected within the grace period; an
    // advertisement watcher (where supported) can still connect later.
    clearWatchdog();
    scanWatchdog = window.setTimeout(() => {
      scanWatchdog = undefined;
      if (!state.connected) state.scanning = false;
    }, 6000);
  }

  function disconnect(): void {
    const pens = (PenHelper as any).pens as unknown[] | undefined;
    if (Array.isArray(pens)) {
      for (const p of [...pens]) {
        try {
          PenHelper.disconnect(p as any);
        } catch {
          /* ignore */
        }
      }
    }
    state.connected = false;
    state.battery = null;
  }

  return { state, scanPen, autoConnect, disconnect };
}
