import type { AppSettings, ClassSession } from "../types";

const DB_NAME = "korean-class-subtitler";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const SETTINGS_STORE = "settings";
const SETTINGS_KEY = "app";

export const defaultSettings: AppSettings = {
  rememberApiKey: false,
  subtitleScale: 1,
  showKoreanInline: false
};

export async function loadSettings(): Promise<AppSettings> {
  const db = await openDb();
  const value = await readValue<AppSettings>(db, SETTINGS_STORE, SETTINGS_KEY);
  return {
    ...defaultSettings,
    ...value,
    apiKey: value?.rememberApiKey ? value.apiKey : undefined
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await openDb();
  const safeSettings: AppSettings = {
    ...settings,
    apiKey: settings.rememberApiKey ? settings.apiKey : undefined
  };
  await writeValue(db, SETTINGS_STORE, safeSettings, SETTINGS_KEY);
}

export async function saveSession(session: ClassSession): Promise<void> {
  const db = await openDb();
  await writeValue(db, SESSION_STORE, session);
}

export async function listSessions(): Promise<ClassSession[]> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const request = tx.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => {
      const sessions = (request.result as ClassSession[]).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      resolve(sessions);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readValue<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function writeValue<T>(db: IDBDatabase, storeName: string, value: T, key?: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    if (key !== undefined) {
      store.put(value, key);
    } else {
      store.put(value);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
