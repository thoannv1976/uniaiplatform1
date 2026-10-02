import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { KillSwitchStore } from '@uniai/firestore';
import { DEFAULT_KILL_SWITCH, type KillSwitch } from '@uniai/shared';

export const KILL_SWITCH_STORE = Symbol('KILL_SWITCH_STORE');
/** Fallback refresh when the realtime listener is broken. */
const RELOAD_MS = 5_000;

/**
 * The kill switch as this instance sees it (spec 8.8: effective in < 5 s). A Firestore
 * listener keeps it current; if the listener fails, the state is re-read every 5 s.
 */
@Injectable()
export class KillSwitchService implements OnModuleDestroy {
  private readonly logger = new Logger('KillSwitch');
  private state: KillSwitch = DEFAULT_KILL_SWITCH;
  private loadedAt = 0;
  private live = false;
  private stop: (() => void) | null = null;

  constructor(@Inject(KILL_SWITCH_STORE) private readonly store: KillSwitchStore) {}

  private listen() {
    if (this.stop) return;
    this.stop = this.store.watch(
      (value) => {
        this.state = value;
        this.loadedAt = Date.now();
        this.live = true;
      },
      (err) => {
        this.logger.warn(`Mất kết nối listener kill switch: ${err.message}`);
        this.live = false;
        this.stop = null;
      },
    );
  }

  /** Current state; the first call starts the listener. Re-read when the listener is down. */
  async current(): Promise<KillSwitch> {
    this.listen();
    const maxAge = this.live ? 60_000 : RELOAD_MS;
    if (Date.now() - this.loadedAt > maxAge) {
      this.state = await this.store.get();
      this.loadedAt = Date.now();
    }
    return this.state;
  }

  /** After an admin change on this instance: no need to wait for the listener. */
  set(value: KillSwitch) {
    this.state = value;
    this.loadedAt = Date.now();
  }

  onModuleDestroy() {
    this.stop?.();
    this.stop = null;
  }
}
