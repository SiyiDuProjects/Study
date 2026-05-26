import type { AppSettings, ClassSession } from "../types";

const SETTINGS_KEY = "korean-class-subtitler-settings";
const FALLBACK_PENDING_SESSIONS_KEY = "korean-class-subtitler-pending-sessions";
const DB_NAME = "korean-class-subtitler";
const DB_VERSION = 1;
const PENDING_SESSIONS_STORE = "pendingSessions";
const SETTINGS_VERSION = 3;

export const defaultSettings: AppSettings = {
  subtitleScale: 1,
  showKoreanInline: false,
  translationMode: "classic-websocket-translate",
  textTranslationModel: ""
};

export interface PendingSessionRecord {
  id: string;
  session: ClassSession;
  queuedAt: string;
  retryCount: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export async function loadSettings(): Promise<AppSettings> {
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  if (!raw) {
    return defaultSettings;
  }

  try {
    const value = JSON.parse(raw) as Partial<AppSettings> & { version?: number };
    const isCurrentSettings = value.version === SETTINGS_VERSION;
    return {
      ...defaultSettings,
      subtitleScale: typeof value.subtitleScale === "number" ? value.subtitleScale : defaultSettings.subtitleScale,
      showKoreanInline:
        typeof value.showKoreanInline === "boolean" ? value.showKoreanInline : defaultSettings.showKoreanInline,
      translationMode:
        isCurrentSettings &&
        (value.translationMode === "classic-websocket-translate" ||
          value.translationMode === "realtime-translate" ||
          value.translationMode === "transcribe-then-translate")
          ? value.translationMode
          : defaultSettings.translationMode,
      textTranslationModel: typeof value.textTranslationModel === "string" ? value.textTranslationModel : defaultSettings.textTranslationModel
    };
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
}

export async function queuePendingSession(session: ClassSession, lastError?: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getPendingSession(session.id);
  const record: PendingSessionRecord = {
    id: session.id,
    session,
    queuedAt: existing?.queuedAt ?? now,
    retryCount: existing?.retryCount ?? 0,
    lastAttemptAt: now,
    lastError
  };

  await putPendingSession(record);
}

export async function listPendingSessions(): Promise<PendingSessionRecord[]> {
  if (!canUseIndexedDb()) {
    return readFallbackPendingSessions();
  }

  try {
    const db = await openLocalDatabase();
    const records = await readAllFromStore<PendingSessionRecord>(db, PENDING_SESSIONS_STORE);
    db.close();
    return records.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
  } catch {
    return readFallbackPendingSessions();
  }
}

export async function removePendingSession(id: string): Promise<void> {
  if (!canUseIndexedDb()) {
    writeFallbackPendingSessions(readFallbackPendingSessions().filter((record) => record.id !== id));
    return;
  }

  try {
    const db = await openLocalDatabase();
    await deleteFromStore(db, PENDING_SESSIONS_STORE, id);
    db.close();
  } catch {
    writeFallbackPendingSessions(readFallbackPendingSessions().filter((record) => record.id !== id));
  }
}

export async function updatePendingSessionFailure(id: string, lastError: string): Promise<void> {
  const record = await getPendingSession(id);
  if (!record) {
    return;
  }

  await putPendingSession({
    ...record,
    retryCount: record.retryCount + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError
  });
}

async function getPendingSession(id: string): Promise<PendingSessionRecord | null> {
  if (!canUseIndexedDb()) {
    return readFallbackPendingSessions().find((record) => record.id === id) ?? null;
  }

  try {
    const db = await openLocalDatabase();
    const record = await readFromStore<PendingSessionRecord>(db, PENDING_SESSIONS_STORE, id);
    db.close();
    return record ?? null;
  } catch {
    return readFallbackPendingSessions().find((record) => record.id === id) ?? null;
  }
}

async function putPendingSession(record: PendingSessionRecord): Promise<void> {
  if (!canUseIndexedDb()) {
    upsertFallbackPendingSession(record);
    return;
  }

  try {
    const db = await openLocalDatabase();
    await putInStore(db, PENDING_SESSIONS_STORE, record);
    db.close();
  } catch {
    upsertFallbackPendingSession(record);
  }
}

function canUseIndexedDb(): boolean {
  return typeof window !== "undefined" && Boolean(window.indexedDB);
}

function openLocalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PENDING_SESSIONS_STORE)) {
        db.createObjectStore(PENDING_SESSIONS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function readAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return transactionRequest(db, storeName, "readonly", (store) => store.getAll() as IDBRequest<T[]>);
}

function readFromStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return transactionRequest(db, storeName, "readonly", (store) => store.get(key) as IDBRequest<T | undefined>);
}

function putInStore<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  return transactionRequest(db, storeName, "readwrite", (store) => store.put(value)).then(() => undefined);
}

function deleteFromStore(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return transactionRequest(db, storeName, "readwrite", (store) => store.delete(key)).then(() => undefined);
}

function transactionRequest<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = createRequest(transaction.objectStore(storeName));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function readFallbackPendingSessions(): PendingSessionRecord[] {
  const raw = window.localStorage.getItem(FALLBACK_PENDING_SESSIONS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const records = JSON.parse(raw) as PendingSessionRecord[];
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function writeFallbackPendingSessions(records: PendingSessionRecord[]): void {
  window.localStorage.setItem(FALLBACK_PENDING_SESSIONS_KEY, JSON.stringify(records));
}

function upsertFallbackPendingSession(record: PendingSessionRecord): void {
  const records = readFallbackPendingSessions().filter((item) => item.id !== record.id);
  records.push(record);
  writeFallbackPendingSessions(records);
}
