import type { FileManifest } from "../../shared/protocol";
import {
  openTransferDb,
  RECEIVED_MANIFESTS_STORE_NAME,
  requestToPromise,
  transactionToPromise,
} from "./transferDb";
import { isSafeFileManifest, MAX_FILES_PER_TRANSFER } from "../../shared/protocolValidation";

export interface SaveReceivedManifestInput {
  expiresAt: number;
  manifest: FileManifest;
  recoveryToken: string;
}

interface StoredReceivedManifest extends FileManifest {
  expiresAt: number;
  recoveryToken: string;
}

export async function saveReceivedManifest(input: SaveReceivedManifestInput): Promise<void> {
  if (!isSafeFileManifest(input.manifest)) {
    throw new Error("invalid file manifest");
  }
  const db = await openTransferDb();

  try {
    const transaction = db.transaction(RECEIVED_MANIFESTS_STORE_NAME, "readwrite");
    transaction.objectStore(RECEIVED_MANIFESTS_STORE_NAME).put(
      {
        ...input.manifest,
        expiresAt: input.expiresAt,
        recoveryToken: input.recoveryToken,
      } satisfies StoredReceivedManifest,
      keyFor(input.recoveryToken, input.manifest.transferId, input.manifest.fileId),
    );
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

export async function loadReceivedManifests(recoveryToken: string): Promise<FileManifest[]> {
  const db = await openTransferDb();

  try {
    const manifests = await requestToPromise<StoredReceivedManifest[]>(
      db.transaction(RECEIVED_MANIFESTS_STORE_NAME, "readonly").objectStore(RECEIVED_MANIFESTS_STORE_NAME).getAll(),
    );

    return manifests
      .filter(
        (manifest) =>
          manifest.recoveryToken === recoveryToken && manifest.expiresAt > Date.now() && isSafeFileManifest(manifest),
      )
      .slice(0, MAX_FILES_PER_TRANSFER)
      .map(({ expiresAt: _expiresAt, recoveryToken: _recoveryToken, ...manifest }) => manifest);
  } finally {
    db.close();
  }
}

function keyFor(recoveryToken: string, transferId: string, fileId: string): [string, string, string] {
  return [recoveryToken, transferId, fileId];
}
