export interface StoredProgress {
  transferId: string;
  fileId: string;
  completed: boolean[];
  recoveryToken: string;
  expiresAt: number;
}

const DB_NAME = "secure-p2p-transfer";
const STORE_NAME = "progress";
const DB_VERSION = 1;

export async function saveProgress(progress: StoredProgress): Promise<void> {
  const db = await openDb();

  try {
    await requestToPromise(
      db.transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(progress, keyFor(progress.transferId, progress.fileId)),
    );
  } finally {
    db.close();
  }
}

export async function loadProgress(transferId: string, fileId: string): Promise<StoredProgress | undefined> {
  const db = await openDb();

  try {
    const progress = await requestToPromise<StoredProgress | undefined>(
      db.transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(keyFor(transferId, fileId)),
    );

    if (!progress || progress.expiresAt <= Date.now()) {
      return undefined;
    }

    return progress;
  } finally {
    db.close();
  }
}

function keyFor(transferId: string, fileId: string): string {
  return `${transferId}:${fileId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
