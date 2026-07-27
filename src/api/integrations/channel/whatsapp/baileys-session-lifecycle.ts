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

export function resetBaileysQrLifecycle(target: BaileysQrLifecycleTarget): void {
  target.qrcode = { count: 0 };
}

export function resetBaileysClientLifecycle(): BaileysClientLifecycle {
  return {
    endSession: false,
    isDeleting: false,
  };
}
