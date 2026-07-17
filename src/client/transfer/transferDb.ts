export const TRANSFER_DB_NAME = "secure-p2p-transfer";
export const TRANSFER_DB_VERSION = 3;
export const PROGRESS_STORE_NAME = "progress";
export const RECEIVED_CHUNKS_STORE_NAME = "receivedChunks";
export const RECEIVED_MANIFESTS_STORE_NAME = "receivedManifests";

export function openTransferDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TRANSFER_DB_NAME, TRANSFER_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROGRESS_STORE_NAME)) {
        db.createObjectStore(PROGRESS_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(RECEIVED_CHUNKS_STORE_NAME)) {
        db.createObjectStore(RECEIVED_CHUNKS_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(RECEIVED_MANIFESTS_STORE_NAME)) {
        db.createObjectStore(RECEIVED_MANIFESTS_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
