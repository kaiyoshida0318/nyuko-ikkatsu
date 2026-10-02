// 作業状態（処理結果・修正内容など）の保存先。
// localStorage は github.io の同じドメインで動く全アプリと容量（約5MB）を共有するため、
// 他のアプリの保存データが多いと入庫一括の保存が失敗する。
// そのため IndexedDB（容量の上限がはるかに大きい）に保存し、
// 旧バージョンが localStorage に残したデータは読み込み時に引き継ぐ。

const DB_NAME = "nyuko-ikkatsu";
const DB_VERSION = 1;
const STORE_NAME = "work-state";
const RECORD_KEY = "current";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // 別タブでバージョンが上がった場合などに接続を作り直せるようにする
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function runRequest<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = action(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? request.error ?? new Error("IndexedDB error"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      }),
  );
}

function readLegacy(legacyKey: string): string | null {
  try {
    return window.localStorage.getItem(legacyKey);
  } catch {
    return null;
  }
}

function removeLegacy(legacyKey: string) {
  try {
    window.localStorage.removeItem(legacyKey);
  } catch {
    // 何もしない
  }
}

/** 保存済みの作業状態（JSON文字列）を読み込む。IndexedDB → 旧localStorage の順に探す。 */
export async function loadWorkStateRaw(legacyKey: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const value = await runRequest<unknown>("readonly", (store) => store.get(RECORD_KEY));
    if (typeof value === "string" && value) return value;
  } catch (err) {
    console.warn("Work state load from IndexedDB failed:", err);
  }
  return readLegacy(legacyKey);
}

/**
 * 作業状態を保存する。IndexedDB に保存できたら旧 localStorage のデータは削除する。
 * IndexedDB が使えない環境では localStorage に保存する。
 */
export async function saveWorkStateRaw(legacyKey: string, raw: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    await runRequest("readwrite", (store) => store.put(raw, RECORD_KEY));
    removeLegacy(legacyKey);
    return true;
  } catch (err) {
    console.warn("Work state save to IndexedDB failed:", err);
  }
  try {
    window.localStorage.setItem(legacyKey, raw);
    return true;
  } catch (err) {
    console.warn("Work state save to localStorage failed:", err);
    return false;
  }
}

/** 保存済みの作業状態を削除する（IndexedDB・旧localStorage の両方）。 */
export async function clearWorkStateRaw(legacyKey: string): Promise<void> {
  if (typeof window === "undefined") return;
  removeLegacy(legacyKey);
  try {
    await runRequest("readwrite", (store) => store.delete(RECORD_KEY));
  } catch (err) {
    console.warn("Work state clear failed:", err);
  }
}
