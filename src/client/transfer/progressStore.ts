import { openTransferDb, PROGRESS_STORE_NAME, requestToPromise, transactionToPromise } from "./transferDb";

export interface StoredProgress {
  transferId: string;
  fileId: string;
  completed: boolean[];
  ackHashes?: string[];
  recoveryToken: string;
  expiresAt: number;
}

export async function saveProgress(progress: StoredProgress): Promise<void> {
  const db = await openTransferDb();

  try {
    const transaction = db.transaction(PROGRESS_STORE_NAME, "readwrite");
    transaction.objectStore(PROGRESS_STORE_NAME).put(progress, keyFor(progress.transferId, progress.fileId));
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

export async function loadProgress(transferId: string, fileId: string): Promise<StoredProgress | undefined> {
  const db = await openTransferDb();

  try {
    const progress = await requestToPromise<StoredProgress | undefined>(
      db.transaction(PROGRESS_STORE_NAME, "readonly")
        .objectStore(PROGRESS_STORE_NAME)
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

function keyFor(transferId: string, fileId: string): [string, string] {
  return [transferId, fileId];
}
