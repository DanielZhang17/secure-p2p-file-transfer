import { ROOM_TTL_MS } from "../../shared/limits";
import type { FileManifest } from "../../shared/protocol";

const OUTGOING_MANIFEST_STORAGE_KEY = "secure-p2p-transfer:outgoing-manifests";

interface StoredOutgoingManifests {
  expiresAt: number;
  manifests: FileManifest[];
  recoveryToken: string;
  roomId: string;
}

export interface OutgoingManifestRecoveryScope {
  recoveryToken?: string;
  roomId?: string;
}

export function saveOutgoingManifests(
  manifests: FileManifest[],
  scope: OutgoingManifestRecoveryScope = {},
): void {
  if (manifests.length === 0 || !hasRecoveryScope(scope)) {
    clearOutgoingManifests();
    return;
  }

  try {
    browserStorage()?.setItem(
      OUTGOING_MANIFEST_STORAGE_KEY,
      JSON.stringify({
        expiresAt: Date.now() + ROOM_TTL_MS,
        manifests,
        recoveryToken: scope.recoveryToken,
        roomId: scope.roomId,
      } satisfies StoredOutgoingManifests),
    );
  } catch {
    // The sender can still transfer after reselecting files; this only improves refresh resume.
  }
}

export function loadOutgoingManifests(scope: OutgoingManifestRecoveryScope = {}): FileManifest[] {
  try {
    const raw = browserStorage()?.getItem(OUTGOING_MANIFEST_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isStoredOutgoingManifests(parsed) || parsed.expiresAt <= Date.now() || !storedScopeMatches(parsed, scope)) {
      clearOutgoingManifests();
      return [];
    }

    return parsed.manifests;
  } catch {
    clearOutgoingManifests();
    return [];
  }
}

export function findReusableOutgoingManifests(
  files: File[],
  scope: OutgoingManifestRecoveryScope = {},
): FileManifest[] | undefined {
  const manifests = loadOutgoingManifests(scope);
  if (!sameFileSelection(files, manifests)) {
    return undefined;
  }

  return manifests;
}

function clearOutgoingManifests(): void {
  try {
    browserStorage()?.removeItem(OUTGOING_MANIFEST_STORAGE_KEY);
  } catch {
    // Ignore storage failures; clearing is best-effort.
  }
}

function sameFileSelection(files: File[], manifests: FileManifest[]): boolean {
  return (
    files.length > 0 &&
    files.length === manifests.length &&
    files.every((file, index) => fileMatchesManifest(file, manifests[index]))
  );
}

function hasRecoveryScope(scope: OutgoingManifestRecoveryScope): scope is Required<OutgoingManifestRecoveryScope> {
  return Boolean(scope.recoveryToken && scope.roomId);
}

function storedScopeMatches(stored: StoredOutgoingManifests, scope: OutgoingManifestRecoveryScope): boolean {
  return hasRecoveryScope(scope) && stored.recoveryToken === scope.recoveryToken && stored.roomId === scope.roomId;
}

function fileMatchesManifest(file: File, manifest: FileManifest | undefined): boolean {
  return (
    Boolean(manifest) &&
    file.name === manifest?.name &&
    file.size === manifest.size &&
    (file.type || "application/octet-stream") === manifest.type &&
    file.lastModified === manifest.lastModified
  );
}

function isStoredOutgoingManifests(value: unknown): value is StoredOutgoingManifests {
  return (
    typeof value === "object" &&
    value !== null &&
    "expiresAt" in value &&
    "manifests" in value &&
    "recoveryToken" in value &&
    "roomId" in value &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.recoveryToken === "string" &&
    typeof value.roomId === "string" &&
    Array.isArray(value.manifests) &&
    value.manifests.every(isFileManifest)
  );
}

function isFileManifest(value: unknown): value is FileManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "transferId" in value &&
    "fileId" in value &&
    "name" in value &&
    "size" in value &&
    "type" in value &&
    "lastModified" in value &&
    "chunkSize" in value &&
    "chunkCount" in value &&
    typeof value.transferId === "string" &&
    typeof value.fileId === "string" &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.type === "string" &&
    typeof value.lastModified === "number" &&
    typeof value.chunkSize === "number" &&
    typeof value.chunkCount === "number" &&
    Number.isFinite(value.size) &&
    Number.isFinite(value.lastModified) &&
    Number.isFinite(value.chunkSize) &&
    Number.isInteger(value.chunkCount)
  );
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.localStorage;
}
