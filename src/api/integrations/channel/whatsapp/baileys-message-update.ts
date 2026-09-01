const MESSAGE_STATUS_PROGRESS: Record<string, number> = {
  PENDING: 0,
  SERVER_ACK: 1,
  DELIVERY_ACK: 2,
  READ: 3,
  PLAYED: 4,
};

export function shouldAdvanceBaileysMessageStatus(
  currentStatus: string | null | undefined,
  incomingStatus: string | null | undefined,
) {
  if (!incomingStatus || incomingStatus === currentStatus) {
    return false;
  }

  const currentProgress = currentStatus ? MESSAGE_STATUS_PROGRESS[currentStatus] : undefined;
  const incomingProgress = MESSAGE_STATUS_PROGRESS[incomingStatus];

  if (incomingStatus === 'ERROR') {
    return currentProgress === undefined || currentProgress < MESSAGE_STATUS_PROGRESS.DELIVERY_ACK;
  }

  if (currentStatus === 'ERROR' && incomingStatus === 'PENDING') {
    return false;
  }

  if (incomingProgress !== undefined) {
    return currentProgress === undefined || incomingProgress > currentProgress;
  }

  return true;
}

export function resolveBaileysMessageUpdateRemoteJid(
  eventRemoteJid: string | null | undefined,
  storedRemoteJid: string | null | undefined,
) {
  return storedRemoteJid?.trim() || eventRemoteJid?.trim();
}

export function buildBaileysMessageUpdateCacheKey(
  instanceId: string,
  messageId: string | null | undefined,
  status: number | null | undefined,
  message: unknown,
) {
  const updateKind = status ?? (message === null ? 'DELETED' : 'CONTENT');
  return `${instanceId}_${messageId || 'unknown'}_${updateKind}`;
}

export type BaileysMessageUpdatePayload = Record<string, unknown> & {
  messageId?: string;
  message?: unknown;
};

type BaileysInboundMessagePayload = Record<string, unknown> & {
  key?: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    addressingMode?: string | null;
  };
};

export function normalizeBaileysInboundMessageRemoteJid<T extends BaileysInboundMessagePayload>(payload: T) {
  const key = payload.key;
  if (!key?.remoteJid?.includes('@lid') || !key.remoteJidAlt?.includes('@s.whatsapp.net')) {
    return payload;
  }

  const lid = key.remoteJid;
  key.remoteJid = key.remoteJidAlt;
  key.remoteJidAlt = lid;
  key.addressingMode = 'pn';

  return payload;
}

type DispatchBaileysInboundWebhookParams<T extends BaileysInboundMessagePayload> = {
  payload: T;
  requiresEnrichment: boolean;
  sendWebhook: (payload: T) => void | Promise<void>;
};

export async function dispatchBaileysInboundWebhookBeforeSideEffects<T extends BaileysInboundMessagePayload>({
  payload,
  requiresEnrichment,
  sendWebhook,
}: DispatchBaileysInboundWebhookParams<T>) {
  if (requiresEnrichment) {
    return { dispatched: false };
  }

  await sendWebhook(payload);
  return { dispatched: true };
}

type ScheduleBaileysContactSyncParams = {
  remoteJid: string;
  inFlight: Map<string, Promise<void>>;
  sync: () => void | Promise<void>;
  onError: (error: unknown) => void;
};

export function scheduleBaileysContactSync({ remoteJid, inFlight, sync, onError }: ScheduleBaileysContactSyncParams) {
  if (inFlight.has(remoteJid)) {
    return false;
  }

  const task = Promise.resolve().then(sync);
  inFlight.set(remoteJid, task);

  void task.catch(onError).finally(() => {
    if (inFlight.get(remoteJid) === task) {
      inFlight.delete(remoteJid);
    }
  });

  return true;
}

type DispatchBaileysMessageUpdateParams<T extends BaileysMessageUpdatePayload> = {
  payload: T;
  persist: boolean;
  sendWebhook: (payload: T) => void | Promise<void>;
  persistUpdate: (payload: Omit<T, 'message'>) => unknown | Promise<unknown>;
};

export async function dispatchBaileysMessageUpdate<T extends BaileysMessageUpdatePayload>({
  payload,
  persist,
  sendWebhook,
  persistUpdate,
}: DispatchBaileysMessageUpdateParams<T>) {
  await sendWebhook(payload);

  if (!persist || !payload.messageId) {
    return { persisted: false };
  }

  const persistedPayload = { ...payload };
  delete persistedPayload.message;
  await persistUpdate(persistedPayload);

  return { persisted: true };
}
