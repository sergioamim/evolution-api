export type BaileysQrLifecycleTarget = {
  qrcode?: {
    count?: number;
    [key: string]: unknown;
  };
};

export type BaileysClientLifecycle = {
  endSession: boolean;
  isDeleting: boolean;
};

export class BaileysConnectionLifecycle {
  private generation = 0;
  private connectAttempt: Promise<unknown> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  public beginConnection(): number {
    this.cancelReconnect();
    this.generation += 1;
    return this.generation;
  }

  public invalidate(): void {
    this.cancelReconnect();
    this.generation += 1;
    this.connectAttempt = null;
  }

  public isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  public runSingleFlight<T>(operation: () => Promise<T>): Promise<T> {
    if (this.connectAttempt) {
      return this.connectAttempt as Promise<T>;
    }

    const attempt = operation().finally(() => {
      if (this.connectAttempt === attempt) {
        this.connectAttempt = null;
      }
    });
    this.connectAttempt = attempt;
    return attempt;
  }

  public scheduleReconnect(
    generation: number,
    operation: () => Promise<unknown>,
    delayMs: number,
    onError?: (error: unknown) => void,
  ): boolean {
    if (!this.isCurrent(generation) || this.reconnectTimer) {
      return false;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrent(generation)) {
        return;
      }
      void operation().catch((error) => onError?.(error));
    }, delayMs);
    return true;
  }

  public cancelReconnect(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export function resetBaileysQrLifecycle(target: BaileysQrLifecycleTarget): void {
  target.qrcode = { count: 0 };
}

export function resetBaileysClientLifecycle(): BaileysClientLifecycle {
  return {
    endSession: false,
    isDeleting: false,
  };
}
