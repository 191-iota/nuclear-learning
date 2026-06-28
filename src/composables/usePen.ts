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

  return { state, scanPen, disconnect };
}
