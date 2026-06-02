# Secure P2P File Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a no-account Cloudflare web app that transfers files securely browser-to-browser with WebRTC first, TURN second, and encrypted temporary spillover only for recovery.

**Architecture:** A React + Vite client owns file selection, chunking, crypto, progress, and WebRTC transfer. A Cloudflare Worker serves APIs and static assets, while one Durable Object per transfer room coordinates signaling, reconnect state, manifests, and expiry. R2 is optional and capped, used only for encrypted recovery spillover.

**Tech Stack:** React, TypeScript, Vite, Vitest, Cloudflare Workers, Durable Objects, optional R2, Web Crypto, IndexedDB, WebRTC data channels.

---

## Required Project Instruction

Every coding task in this project must load `karpathy-guidelines` first. Coding agents must state assumptions, keep changes surgical, prefer the simplest verifiable implementation, and include explicit verification commands.

## Source Spec

Use `docs/superpowers/specs/2026-06-02-secure-p2p-file-transfer-design.md` as the source of truth.

## File Structure

- `CODEX.md`: project-specific agent instruction to use `karpathy-guidelines`.
- `package.json`: scripts, dependencies, and dev dependencies.
- `tsconfig.json`: shared strict TypeScript config.
- `vite.config.ts`: React app and Vitest configuration.
- `vitest.config.ts`: unit test configuration for Node/jsdom.
- `worker/vitest.config.ts`: Worker test configuration.
- `wrangler.jsonc`: Cloudflare Worker config, Durable Object binding, optional R2 binding, compatibility settings, and observability.
- `src/shared/protocol.ts`: shared room, signaling, manifest, chunk, and transfer status types.
- `src/shared/limits.ts`: Cloudflare-aware limits and default transfer profile constants.
- `src/client/main.tsx`: React entrypoint.
- `src/client/App.tsx`: screen composition and high-level state.
- `src/client/styles.css`: app styling.
- `src/client/components/FilePicker.tsx`: sender file selection.
- `src/client/components/JoinRoom.tsx`: recipient pairing input.
- `src/client/components/VerifyPhrase.tsx`: human-readable phrase confirmation.
- `src/client/components/TransferMonitor.tsx`: progress, mode, retries, ETA, and spillover warning.
- `src/client/transfer/chunkProfile.ts`: chunk size, lane count, and subframe profile selection.
- `src/client/transfer/manifest.ts`: manifest creation from browser `File` objects.
- `src/client/transfer/bitmap.ts`: completed chunk bitmap helpers.
- `src/client/transfer/crypto.ts`: ECDH, HKDF, AES-GCM chunk encryption, and verification phrase derivation.
- `src/client/transfer/progressStore.ts`: IndexedDB persisted recovery state.
- `src/client/transfer/scheduler.ts`: bounded concurrent chunk scheduling, retries, and progress events.
- `src/client/transport/roomSocket.ts`: WebSocket room protocol client.
- `src/client/transport/webrtcPeer.ts`: WebRTC connection and data channel lifecycle.
- `src/client/transport/frameProtocol.ts`: logical chunk to transport subframe conversion.
- `src/worker/index.ts`: Worker entrypoint and routing.
- `src/worker/room.ts`: Durable Object room implementation.
- `src/worker/relay.ts`: bounded encrypted spillover and relay request handling.
- `src/worker/env.ts`: generated/binding type usage and runtime config helpers.
- `src/client/**/*.test.ts`: client unit tests.
- `src/worker/**/*.test.ts`: Worker and Durable Object tests.

## Assumptions

- This is a greenfield repository.
- Use `npm` for package scripts.
- The first implementation targets modern Chromium-based browsers for File System Access API support, with a browser download fallback for other browsers.
- The first implementation can simulate large files in tests rather than allocating 100 GB or 2 TB files.
- Real Cloudflare deployment credentials are not required for local unit tests.

## Task 1: Scaffold The Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `worker/vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`
- Create: `src/shared/limits.ts`
- Create: `src/shared/protocol.ts`

- [ ] **Step 1: Create the package manifest**

Create `package.json`:

```json
{
  "name": "secure-p2p-file-transfer",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview --host 127.0.0.1",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:worker": "vitest run --config worker/vitest.config.ts",
    "typecheck": "tsc --noEmit",
    "cf:typegen": "wrangler types",
    "deploy": "npm run build && wrangler deploy"
  },
  "dependencies": {
    "react": "latest",
    "react-dom": "latest"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "latest",
    "@cloudflare/workers-types": "latest",
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitejs/plugin-react": "latest",
    "fake-indexeddb": "latest",
    "happy-dom": "latest",
    "typescript": "latest",
    "vite": "latest",
    "vitest": "latest",
    "wrangler": "latest"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and installation exits with code 0.

- [ ] **Step 3: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["@cloudflare/workers-types", "vitest/globals"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts", "worker"]
}
```

- [ ] **Step 4: Create Vite and Vitest configs**

Create `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist/client",
    sourcemap: true,
  },
});
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["src/client/test/setup.ts"],
    include: ["src/client/**/*.test.ts", "src/shared/**/*.test.ts"],
  },
});
```

Create `worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
    include: ["src/worker/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create Wrangler config**

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "secure-p2p-file-transfer",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-06-02",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/client",
    "binding": "ASSETS"
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "ROOMS",
        "class_name": "TransferRoom"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["TransferRoom"]
    }
  ],
  "r2_buckets": [
    {
      "binding": "SPILLOVER",
      "bucket_name": "secure-p2p-spillover"
    }
  ],
  "vars": {
    "ROOM_TTL_SECONDS": "86400",
    "SPILLOVER_CAP_BYTES": "10737418240",
    "MAX_RELAY_REQUEST_BYTES": "67108864"
  },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

- [ ] **Step 6: Create shared limits and protocol stubs**

Create `src/shared/limits.ts`:

```ts
export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

export const SMALL_FILE_THRESHOLD_BYTES = 1 * GiB;
export const LARGE_FILE_CHUNK_BYTES = 64 * MiB;
export const SMALL_FILE_CHUNK_BYTES = 8 * MiB;
export const LARGE_FILE_LANES = 8;
export const SMALL_FILE_LANES = 2;
export const DEFAULT_RELAY_SUBFRAME_BYTES = 4 * MiB;
export const MIN_RELAY_SUBFRAME_BYTES = 1 * MiB;
export const MAX_RELAY_SUBFRAME_BYTES = 8 * MiB;
export const MAX_RELAY_REQUEST_BYTES = 64 * MiB;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
```

Create `src/shared/protocol.ts`:

```ts
export type TransferMode = "direct-p2p" | "turn-relay" | "recovery-relay";

export type RoomRole = "sender" | "recipient";

export interface FileManifest {
  transferId: string;
  fileId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  chunkSize: number;
  chunkCount: number;
  fileHash?: string;
}

export interface ChunkAck {
  transferId: string;
  fileId: string;
  chunkIndex: number;
  hash: string;
}

export interface TransferProgress {
  transferId: string;
  mode: TransferMode;
  totalBytes: number;
  sentBytes: number;
  receivedBytes: number;
  completedChunks: number;
  totalChunks: number;
  retryCount: number;
  activeLanes: number;
  spilloverBytes: number;
}

export type SignalPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

export type ClientRoomMessage =
  | { type: "join"; role: RoomRole; recoveryToken?: string }
  | { type: "signal"; payload: SignalPayload }
  | { type: "manifest"; manifest: FileManifest }
  | { type: "ack"; ack: ChunkAck }
  | { type: "heartbeat"; at: number };

export type ServerRoomMessage =
  | { type: "joined"; roomId: string; role: RoomRole; recoveryToken: string; expiresAt: number }
  | { type: "peer-joined"; role: RoomRole }
  | { type: "signal"; payload: SignalPayload }
  | { type: "manifest"; manifest: FileManifest }
  | { type: "ack"; ack: ChunkAck }
  | { type: "expired"; roomId: string }
  | { type: "error"; code: string; message: string };
```

- [ ] **Step 7: Create client entrypoint**

Create `src/client/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `src/client/App.tsx`:

```tsx
export function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="product-name">Secure P2P Transfer</p>
          <h1>Send large files directly, recover cleanly when networks shift.</h1>
          <p className="lede">
            No accounts. Direct browser transfer first. Cloudflare coordinates pairing,
            NAT traversal, and short-lived encrypted recovery state.
          </p>
        </div>
      </section>
    </main>
  );
}
```

Create `src/client/styles.css`:

```css
:root {
  color: #10201c;
  background: #f7f9f5;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

button,
input {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
}

.hero-panel {
  width: min(960px, 100%);
  padding: 48px;
  border: 1px solid #d9e4dc;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 24px 80px rgb(28 60 45 / 10%);
}

.product-name {
  margin: 0 0 16px;
  font-size: 0.875rem;
  font-weight: 700;
  color: #1d6f56;
}

h1 {
  margin: 0;
  max-width: 760px;
  font-size: clamp(2.25rem, 8vw, 5rem);
  line-height: 0.95;
  letter-spacing: 0;
}

.lede {
  max-width: 640px;
  margin: 24px 0 0;
  color: #53625c;
  font-size: 1.125rem;
  line-height: 1.6;
}
```

- [ ] **Step 8: Create test setup**

Create `src/client/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
```

- [ ] **Step 9: Verify scaffold**

Run:

```bash
npm run typecheck
npm run test
```

Expected: both commands exit with code 0. `npm run test` reports no failed tests.

- [ ] **Step 10: Commit scaffold**

Run:

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts worker/vitest.config.ts wrangler.jsonc src
git commit -m "chore: scaffold secure transfer app"
```

Expected: commit succeeds.

## Task 2: Add Chunk Profile Logic

**Files:**
- Create: `src/client/transfer/chunkProfile.ts`
- Create: `src/client/transfer/chunkProfile.test.ts`
- Modify: `src/shared/limits.ts`

- [ ] **Step 1: Write failing tests**

Create `src/client/transfer/chunkProfile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GiB, LARGE_FILE_CHUNK_BYTES, LARGE_FILE_LANES, SMALL_FILE_CHUNK_BYTES, SMALL_FILE_LANES } from "../../shared/limits";
import { selectChunkProfile } from "./chunkProfile";

describe("selectChunkProfile", () => {
  it("uses a light profile for files up to 1 GiB", () => {
    expect(selectChunkProfile(512 * 1024 * 1024)).toEqual({
      chunkSize: SMALL_FILE_CHUNK_BYTES,
      lanes: SMALL_FILE_LANES,
      subframeSize: 4 * 1024 * 1024,
    });
  });

  it("uses 64 MiB chunks and 8 lanes above 1 GiB", () => {
    expect(selectChunkProfile(2 * GiB)).toEqual({
      chunkSize: LARGE_FILE_CHUNK_BYTES,
      lanes: LARGE_FILE_LANES,
      subframeSize: 4 * 1024 * 1024,
    });
  });

  it("never selects a subframe larger than 8 MiB", () => {
    expect(selectChunkProfile(20 * GiB).subframeSize).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npm run test -- src/client/transfer/chunkProfile.test.ts
```

Expected: FAIL because `src/client/transfer/chunkProfile.ts` does not exist.

- [ ] **Step 3: Implement chunk profile selection**

Create `src/client/transfer/chunkProfile.ts`:

```ts
import {
  DEFAULT_RELAY_SUBFRAME_BYTES,
  LARGE_FILE_CHUNK_BYTES,
  LARGE_FILE_LANES,
  SMALL_FILE_CHUNK_BYTES,
  SMALL_FILE_LANES,
  SMALL_FILE_THRESHOLD_BYTES,
} from "../../shared/limits";

export interface ChunkProfile {
  chunkSize: number;
  lanes: number;
  subframeSize: number;
}

export function selectChunkProfile(fileSize: number): ChunkProfile {
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    throw new Error("fileSize must be a non-negative finite number");
  }

  if (fileSize <= SMALL_FILE_THRESHOLD_BYTES) {
    return {
      chunkSize: SMALL_FILE_CHUNK_BYTES,
      lanes: SMALL_FILE_LANES,
      subframeSize: DEFAULT_RELAY_SUBFRAME_BYTES,
    };
  }

  return {
    chunkSize: LARGE_FILE_CHUNK_BYTES,
    lanes: LARGE_FILE_LANES,
    subframeSize: DEFAULT_RELAY_SUBFRAME_BYTES,
  };
}
```

- [ ] **Step 4: Run the test and verify pass**

Run:

```bash
npm run test -- src/client/transfer/chunkProfile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit chunk profile logic**

Run:

```bash
git add src/client/transfer/chunkProfile.ts src/client/transfer/chunkProfile.test.ts
git commit -m "feat: add transfer chunk profile"
```

Expected: commit succeeds.

## Task 3: Add Manifests And Bitmaps

**Files:**
- Create: `src/client/transfer/manifest.ts`
- Create: `src/client/transfer/manifest.test.ts`
- Create: `src/client/transfer/bitmap.ts`
- Create: `src/client/transfer/bitmap.test.ts`

- [ ] **Step 1: Write manifest tests**

Create `src/client/transfer/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LARGE_FILE_CHUNK_BYTES } from "../../shared/limits";
import { createFileManifest } from "./manifest";

describe("createFileManifest", () => {
  it("creates deterministic metadata for a selected file", async () => {
    const file = new File(["hello"], "hello.txt", {
      type: "text/plain",
      lastModified: 1700000000000,
    });

    const manifest = await createFileManifest(file, "transfer-1");

    expect(manifest).toMatchObject({
      transferId: "transfer-1",
      name: "hello.txt",
      size: 5,
      type: "text/plain",
      lastModified: 1700000000000,
      chunkCount: 1,
    });
    expect(manifest.fileId).toMatch(/^file-/);
  });

  it("rounds chunk count upward", async () => {
    const file = new File([new Uint8Array(LARGE_FILE_CHUNK_BYTES + 1)], "large.bin");
    const manifest = await createFileManifest(file, "transfer-2");

    expect(manifest.chunkSize).toBe(LARGE_FILE_CHUNK_BYTES);
    expect(manifest.chunkCount).toBe(2);
  });
});
```

- [ ] **Step 2: Write bitmap tests**

Create `src/client/transfer/bitmap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createChunkBitmap, markChunkComplete, missingChunkIndexes } from "./bitmap";

describe("chunk bitmap", () => {
  it("tracks completed and missing chunks", () => {
    let bitmap = createChunkBitmap(5);
    bitmap = markChunkComplete(bitmap, 1);
    bitmap = markChunkComplete(bitmap, 3);

    expect(missingChunkIndexes(bitmap)).toEqual([0, 2, 4]);
  });

  it("rejects chunk indexes outside the bitmap", () => {
    const bitmap = createChunkBitmap(2);
    expect(() => markChunkComplete(bitmap, 2)).toThrow("chunk index out of range");
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm run test -- src/client/transfer/manifest.test.ts src/client/transfer/bitmap.test.ts
```

Expected: FAIL because the implementation files do not exist.

- [ ] **Step 4: Implement manifest creation**

Create `src/client/transfer/manifest.ts`:

```ts
import type { FileManifest } from "../../shared/protocol";
import { selectChunkProfile } from "./chunkProfile";

export async function createFileManifest(file: File, transferId: string): Promise<FileManifest> {
  const profile = selectChunkProfile(file.size);
  const stableInput = `${transferId}:${file.name}:${file.size}:${file.lastModified}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableInput));
  const fileId = `file-${toHex(new Uint8Array(digest)).slice(0, 16)}`;

  return {
    transferId,
    fileId,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
    chunkSize: profile.chunkSize,
    chunkCount: Math.max(1, Math.ceil(file.size / profile.chunkSize)),
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 5: Implement bitmap helpers**

Create `src/client/transfer/bitmap.ts`:

```ts
export interface ChunkBitmap {
  totalChunks: number;
  completed: boolean[];
}

export function createChunkBitmap(totalChunks: number): ChunkBitmap {
  if (!Number.isInteger(totalChunks) || totalChunks < 1) {
    throw new Error("totalChunks must be a positive integer");
  }

  return {
    totalChunks,
    completed: Array.from({ length: totalChunks }, () => false),
  };
}

export function markChunkComplete(bitmap: ChunkBitmap, chunkIndex: number): ChunkBitmap {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= bitmap.totalChunks) {
    throw new Error("chunk index out of range");
  }

  const completed = bitmap.completed.slice();
  completed[chunkIndex] = true;
  return { totalChunks: bitmap.totalChunks, completed };
}

export function missingChunkIndexes(bitmap: ChunkBitmap): number[] {
  const missing: number[] = [];
  for (let index = 0; index < bitmap.completed.length; index += 1) {
    if (!bitmap.completed[index]) {
      missing.push(index);
    }
  }
  return missing;
}
```

- [ ] **Step 6: Run tests and verify pass**

Run:

```bash
npm run test -- src/client/transfer/manifest.test.ts src/client/transfer/bitmap.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit manifest and bitmap**

Run:

```bash
git add src/client/transfer/manifest.ts src/client/transfer/manifest.test.ts src/client/transfer/bitmap.ts src/client/transfer/bitmap.test.ts
git commit -m "feat: add transfer manifests and bitmaps"
```

Expected: commit succeeds.

## Task 4: Add Client-Side Crypto Primitives

**Files:**
- Create: `src/client/transfer/crypto.ts`
- Create: `src/client/transfer/crypto.test.ts`

- [ ] **Step 1: Write crypto tests**

Create `src/client/transfer/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPeerKeyPair, decryptChunk, deriveSharedTransferKeys, encryptChunk, verificationPhrase } from "./crypto";

describe("transfer crypto", () => {
  it("derives matching keys for both peers", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();

    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-1");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-1");

    expect(await verificationPhrase(senderKeys.verificationKey)).toBe(await verificationPhrase(recipientKeys.verificationKey));
  });

  it("encrypts and decrypts a chunk", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();
    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-2");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-2");
    const plaintext = new TextEncoder().encode("chunk payload");

    const encrypted = await encryptChunk(senderKeys.contentKey, plaintext, "file-1", 7);
    const decrypted = await decryptChunk(recipientKeys.contentKey, encrypted, "file-1", 7);

    expect(new TextDecoder().decode(decrypted)).toBe("chunk payload");
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- src/client/transfer/crypto.test.ts
```

Expected: FAIL because `src/client/transfer/crypto.ts` does not exist.

- [ ] **Step 3: Implement crypto helpers**

Create `src/client/transfer/crypto.ts`:

```ts
export interface PeerKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface TransferKeys {
  contentKey: CryptoKey;
  verificationKey: ArrayBuffer;
}

export interface EncryptedChunk {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export async function createPeerKeyPair(): Promise<PeerKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as Promise<PeerKeyPair>;
}

export async function deriveSharedTransferKeys(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  transferId: string,
): Promise<TransferKeys> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
  const baseKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = new TextEncoder().encode(`secure-p2p:${transferId}`);
  const info = new TextEncoder().encode("file-content-key");
  const contentKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const verificationKey = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("verification-phrase") },
    baseKey,
    128,
  );

  return { contentKey, verificationKey };
}

export async function encryptChunk(contentKey: CryptoKey, plaintext: Uint8Array, fileId: string, chunkIndex: number): Promise<EncryptedChunk> {
  const iv = await chunkIv(fileId, chunkIndex);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, plaintext));
  return { iv, ciphertext };
}

export async function decryptChunk(contentKey: CryptoKey, encrypted: EncryptedChunk, fileId: string, chunkIndex: number): Promise<Uint8Array> {
  const expectedIv = await chunkIv(fileId, chunkIndex);
  if (!equalBytes(expectedIv, encrypted.iv)) {
    throw new Error("chunk IV mismatch");
  }
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: encrypted.iv }, contentKey, encrypted.ciphertext));
}

export async function verificationPhrase(verificationKey: ArrayBuffer): Promise<string> {
  const words = ["amber", "brook", "cobalt", "delta", "ember", "forest", "granite", "harbor", "indigo", "juniper", "kelp", "lantern", "mesa", "north", "opal", "prairie"];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", verificationKey));
  return [words[digest[0] % words.length], words[digest[1] % words.length], words[digest[2] % words.length]].join("-");
}

async function chunkIv(fileId: string, chunkIndex: number): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fileId)));
  const iv = digest.slice(0, 12);
  new DataView(iv.buffer).setUint32(8, chunkIndex, false);
  return iv;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}
```

- [ ] **Step 4: Run crypto tests and full unit tests**

Run:

```bash
npm run test -- src/client/transfer/crypto.test.ts
npm run test
```

Expected: both commands PASS.

- [ ] **Step 5: Commit crypto primitives**

Run:

```bash
git add src/client/transfer/crypto.ts src/client/transfer/crypto.test.ts
git commit -m "feat: add client transfer crypto"
```

Expected: commit succeeds.

## Task 5: Add Durable Object Room Coordination

**Files:**
- Create: `src/worker/env.ts`
- Create: `src/worker/room.ts`
- Create: `src/worker/index.ts`
- Create: `src/worker/room.test.ts`

- [ ] **Step 1: Write Worker room tests**

Create `src/worker/room.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("room worker", () => {
  it("creates a room with a short pairing code", async () => {
    const response = await SELF.fetch("https://example.com/api/rooms", { method: "POST" });
    const body = await response.json() as { roomId: string; code: string; expiresAt: number };

    expect(response.status).toBe(201);
    expect(body.roomId).toMatch(/^room-/);
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects unknown API routes", async () => {
    const response = await SELF.fetch("https://example.com/api/missing");
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run Worker tests and verify failure**

Run:

```bash
npm run test:worker
```

Expected: FAIL because Worker files are not implemented.

- [ ] **Step 3: Implement Worker environment helpers**

Create `src/worker/env.ts`:

```ts
export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  SPILLOVER?: R2Bucket;
  ROOM_TTL_SECONDS: string;
  SPILLOVER_CAP_BYTES: string;
  MAX_RELAY_REQUEST_BYTES: string;
}

export function roomTtlMs(env: Env): number {
  return Number.parseInt(env.ROOM_TTL_SECONDS, 10) * 1000;
}
```

- [ ] **Step 4: Implement Durable Object room shell**

Create `src/worker/room.ts`:

```ts
import type { ClientRoomMessage, ServerRoomMessage } from "../shared/protocol";
import type { Env } from "./env";

interface RoomRecord {
  roomId: string;
  code: string;
  expiresAt: number;
}

export class TransferRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      return this.initRoom(request);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptSocket(request);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async initRoom(request: Request): Promise<Response> {
    const existing = await this.state.storage.get<RoomRecord>("room");
    if (existing) {
      return Response.json(existing, { status: 200 });
    }

    const input = await request.json<{ roomId: string }>();
    const record: RoomRecord = {
      roomId: input.roomId,
      code: roomCode(),
      expiresAt: Date.now() + Number.parseInt(this.env.ROOM_TTL_SECONDS, 10) * 1000,
    };
    await this.state.storage.put("room", record);
    await this.state.storage.setAlarm(record.expiresAt);
    return Response.json(record, { status: 201 });
  }

  private acceptSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ClientRoomMessage;
      const reply: ServerRoomMessage = { type: "error", code: "not-ready", message: `received ${message.type}` };
      server.send(JSON.stringify(reply));
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

function roomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
```

- [ ] **Step 5: Implement Worker routing**

Create `src/worker/index.ts`:

```ts
import { TransferRoom } from "./room";
import type { Env } from "./env";

export { TransferRoom };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const roomId = `room-${crypto.randomUUID()}`;
        const id = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(id);
        return stub.fetch(new Request("https://room/init", {
          method: "POST",
          body: JSON.stringify({ roomId }),
          headers: { "content-type": "application/json" },
        }));
      }

      if (url.pathname.startsWith("/api/rooms/")) {
      const roomId = url.pathname.split("/")[3];
        const id = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(id);
        return stub.fetch(request);
      }

      if (url.pathname.startsWith("/api/")) {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      ctx.waitUntil(logError(error));
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
};

async function logError(error: unknown): Promise<void> {
  console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
}
```

- [ ] **Step 6: Run Worker tests**

Run:

```bash
npm run test:worker
```

Expected: PASS.

- [ ] **Step 7: Commit room coordination shell**

Run:

```bash
git add src/worker/env.ts src/worker/room.ts src/worker/index.ts src/worker/room.test.ts
git commit -m "feat: add transfer room coordination"
```

Expected: commit succeeds.

## Task 6: Add Transfer Scheduler

**Files:**
- Create: `src/client/transfer/scheduler.ts`
- Create: `src/client/transfer/scheduler.test.ts`

- [ ] **Step 1: Write scheduler tests**

Create `src/client/transfer/scheduler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scheduleChunks } from "./scheduler";

describe("scheduleChunks", () => {
  it("runs no more than the configured lane count", async () => {
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];

    await scheduleChunks({
      chunkIndexes: [0, 1, 2, 3, 4],
      lanes: 2,
      maxRetries: 1,
      sendChunk: async (index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        completed.push(index);
        active -= 1;
      },
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(completed.toSorted()).toEqual([0, 1, 2, 3, 4]);
  });

  it("retries failed chunks", async () => {
    const attempts = new Map<number, number>();

    await scheduleChunks({
      chunkIndexes: [0],
      lanes: 1,
      maxRetries: 2,
      sendChunk: async (index) => {
        attempts.set(index, (attempts.get(index) ?? 0) + 1);
        if (attempts.get(index) === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    expect(attempts.get(0)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- src/client/transfer/scheduler.test.ts
```

Expected: FAIL because `scheduler.ts` does not exist.

- [ ] **Step 3: Implement scheduler**

Create `src/client/transfer/scheduler.ts`:

```ts
export interface ScheduleChunksOptions {
  chunkIndexes: number[];
  lanes: number;
  maxRetries: number;
  sendChunk: (chunkIndex: number) => Promise<void>;
}

export async function scheduleChunks(options: ScheduleChunksOptions): Promise<void> {
  const queue = options.chunkIndexes.slice();
  const failures = new Map<number, number>();
  const workers = Array.from({ length: options.lanes }, () => runLane(queue, failures, options));
  await Promise.all(workers);
}

async function runLane(
  queue: number[],
  failures: Map<number, number>,
  options: ScheduleChunksOptions,
): Promise<void> {
  for (;;) {
    const chunkIndex = queue.shift();
    if (chunkIndex === undefined) {
      return;
    }

    try {
      await options.sendChunk(chunkIndex);
    } catch (error) {
      const nextFailures = (failures.get(chunkIndex) ?? 0) + 1;
      failures.set(chunkIndex, nextFailures);
      if (nextFailures > options.maxRetries) {
        throw error;
      }
      queue.push(chunkIndex);
    }
  }
}
```

- [ ] **Step 4: Run scheduler tests**

Run:

```bash
npm run test -- src/client/transfer/scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit scheduler**

Run:

```bash
git add src/client/transfer/scheduler.ts src/client/transfer/scheduler.test.ts
git commit -m "feat: add chunk scheduler"
```

Expected: commit succeeds.

## Task 7: Add Persisted Progress Store

**Files:**
- Create: `src/client/transfer/progressStore.ts`
- Create: `src/client/transfer/progressStore.test.ts`

- [ ] **Step 1: Write progress store tests**

Create `src/client/transfer/progressStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadProgress, saveProgress } from "./progressStore";

describe("progressStore", () => {
  it("saves and loads transfer recovery progress", async () => {
    await saveProgress({
      transferId: "transfer-1",
      fileId: "file-1",
      completed: [true, false, true],
      recoveryToken: "token-1",
      expiresAt: Date.now() + 1000,
    });

    await expect(loadProgress("transfer-1", "file-1")).resolves.toMatchObject({
      transferId: "transfer-1",
      fileId: "file-1",
      completed: [true, false, true],
      recoveryToken: "token-1",
    });
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- src/client/transfer/progressStore.test.ts
```

Expected: FAIL because `progressStore.ts` does not exist.

- [ ] **Step 3: Implement IndexedDB progress store**

Create `src/client/transfer/progressStore.ts`:

```ts
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
  await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(progress, keyFor(progress.transferId, progress.fileId)));
  db.close();
}

export async function loadProgress(transferId: string, fileId: string): Promise<StoredProgress | undefined> {
  const db = await openDb();
  const result = await requestToPromise<StoredProgress | undefined>(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(keyFor(transferId, fileId)),
  );
  db.close();
  if (!result || result.expiresAt <= Date.now()) {
    return undefined;
  }
  return result;
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
```

- [ ] **Step 4: Run progress store tests**

Run:

```bash
npm run test -- src/client/transfer/progressStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit progress store**

Run:

```bash
git add src/client/transfer/progressStore.ts src/client/transfer/progressStore.test.ts
git commit -m "feat: persist transfer recovery progress"
```

Expected: commit succeeds.

## Task 8: Add Room Socket Client

**Files:**
- Create: `src/client/transport/roomSocket.ts`
- Create: `src/client/transport/roomSocket.test.ts`

- [ ] **Step 1: Write room socket test with fake WebSocket**

Create `src/client/transport/roomSocket.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeRoomMessage, parseServerMessage } from "./roomSocket";

describe("roomSocket protocol helpers", () => {
  it("encodes client messages as JSON", () => {
    expect(encodeRoomMessage({ type: "join", role: "sender" })).toBe('{"type":"join","role":"sender"}');
  });

  it("parses server messages", () => {
    expect(parseServerMessage('{"type":"peer-joined","role":"recipient"}')).toEqual({
      type: "peer-joined",
      role: "recipient",
    });
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- src/client/transport/roomSocket.test.ts
```

Expected: FAIL because `roomSocket.ts` does not exist.

- [ ] **Step 3: Implement protocol helpers and socket wrapper**

Create `src/client/transport/roomSocket.ts`:

```ts
import type { ClientRoomMessage, ServerRoomMessage } from "../../shared/protocol";

export function encodeRoomMessage(message: ClientRoomMessage): string {
  return JSON.stringify(message);
}

export function parseServerMessage(payload: string): ServerRoomMessage {
  return JSON.parse(payload) as ServerRoomMessage;
}

export class RoomSocket {
  constructor(private readonly socket: WebSocket) {}

  send(message: ClientRoomMessage): void {
    this.socket.send(encodeRoomMessage(message));
  }

  onMessage(handler: (message: ServerRoomMessage) => void): void {
    this.socket.addEventListener("message", (event) => {
      handler(parseServerMessage(String(event.data)));
    });
  }

  close(): void {
    this.socket.close();
  }
}
```

- [ ] **Step 4: Run room socket tests**

Run:

```bash
npm run test -- src/client/transport/roomSocket.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit room socket client**

Run:

```bash
git add src/client/transport/roomSocket.ts src/client/transport/roomSocket.test.ts
git commit -m "feat: add room socket client"
```

Expected: commit succeeds.

## Task 9: Add Frame Protocol

**Files:**
- Create: `src/client/transport/frameProtocol.ts`
- Create: `src/client/transport/frameProtocol.test.ts`

- [ ] **Step 1: Write frame protocol tests**

Create `src/client/transport/frameProtocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitIntoFrames } from "./frameProtocol";

describe("splitIntoFrames", () => {
  it("splits a logical chunk into bounded subframes", () => {
    const chunk = new Uint8Array(10);
    const frames = splitIntoFrames({ transferId: "t1", fileId: "f1", chunkIndex: 3, bytes: chunk, frameSize: 4 });

    expect(frames.map((frame) => frame.bytes.byteLength)).toEqual([4, 4, 2]);
    expect(frames[0]).toMatchObject({ transferId: "t1", fileId: "f1", chunkIndex: 3, frameIndex: 0, finalFrame: false });
    expect(frames[2]).toMatchObject({ frameIndex: 2, finalFrame: true });
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- src/client/transport/frameProtocol.test.ts
```

Expected: FAIL because `frameProtocol.ts` does not exist.

- [ ] **Step 3: Implement frame splitter**

Create `src/client/transport/frameProtocol.ts`:

```ts
export interface TransferFrame {
  transferId: string;
  fileId: string;
  chunkIndex: number;
  frameIndex: number;
  finalFrame: boolean;
  bytes: Uint8Array;
}

export interface SplitIntoFramesInput {
  transferId: string;
  fileId: string;
  chunkIndex: number;
  bytes: Uint8Array;
  frameSize: number;
}

export function splitIntoFrames(input: SplitIntoFramesInput): TransferFrame[] {
  if (!Number.isInteger(input.frameSize) || input.frameSize < 1) {
    throw new Error("frameSize must be a positive integer");
  }

  const frames: TransferFrame[] = [];
  for (let offset = 0; offset < input.bytes.byteLength; offset += input.frameSize) {
    const bytes = input.bytes.slice(offset, Math.min(input.bytes.byteLength, offset + input.frameSize));
    frames.push({
      transferId: input.transferId,
      fileId: input.fileId,
      chunkIndex: input.chunkIndex,
      frameIndex: frames.length,
      finalFrame: offset + input.frameSize >= input.bytes.byteLength,
      bytes,
    });
  }
  return frames;
}
```

- [ ] **Step 4: Run frame protocol tests**

Run:

```bash
npm run test -- src/client/transport/frameProtocol.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit frame protocol**

Run:

```bash
git add src/client/transport/frameProtocol.ts src/client/transport/frameProtocol.test.ts
git commit -m "feat: add transfer frame protocol"
```

Expected: commit succeeds.

## Task 10: Add Sender And Recipient UI Shell

**Files:**
- Create: `src/client/components/FilePicker.tsx`
- Create: `src/client/components/JoinRoom.tsx`
- Create: `src/client/components/VerifyPhrase.tsx`
- Create: `src/client/components/TransferMonitor.tsx`
- Create: `src/client/App.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

- [ ] **Step 1: Write UI tests**

Create `src/client/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("shows sender and recipient entry points", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Send files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Receive files" })).toBeInTheDocument();
  });

  it("switches to receive mode", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Receive files" }));
    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run UI test and verify failure**

Run:

```bash
npm run test -- src/client/App.test.tsx
```

Expected: FAIL because the UI does not expose the expected controls.

- [ ] **Step 3: Create UI components**

Create `src/client/components/FilePicker.tsx`:

```tsx
export interface FilePickerProps {
  onFilesSelected: (files: File[]) => void;
}

export function FilePicker({ onFilesSelected }: FilePickerProps) {
  return (
    <label className="file-picker">
      <span>Drop files or choose from disk</span>
      <input
        aria-label="Choose files"
        type="file"
        multiple
        onChange={(event) => onFilesSelected(Array.from(event.currentTarget.files ?? []))}
      />
    </label>
  );
}
```

Create `src/client/components/JoinRoom.tsx`:

```tsx
export interface JoinRoomProps {
  code: string;
  onCodeChange: (code: string) => void;
}

export function JoinRoom({ code, onCodeChange }: JoinRoomProps) {
  return (
    <label className="field">
      <span>Pairing code</span>
      <input
        aria-label="Pairing code"
        value={code}
        maxLength={6}
        inputMode="text"
        onChange={(event) => onCodeChange(event.currentTarget.value.toUpperCase())}
      />
    </label>
  );
}
```

Create `src/client/components/VerifyPhrase.tsx`:

```tsx
export interface VerifyPhraseProps {
  phrase: string;
  confirmed: boolean;
  onConfirm: () => void;
}

export function VerifyPhrase({ phrase, confirmed, onConfirm }: VerifyPhraseProps) {
  return (
    <section className="verify-box">
      <span>Verification phrase</span>
      <strong>{phrase}</strong>
      <button type="button" disabled={confirmed} onClick={onConfirm}>
        {confirmed ? "Verified" : "Looks right"}
      </button>
    </section>
  );
}
```

Create `src/client/components/TransferMonitor.tsx`:

```tsx
import type { TransferProgress } from "../../shared/protocol";

export interface TransferMonitorProps {
  progress: TransferProgress;
}

export function TransferMonitor({ progress }: TransferMonitorProps) {
  const percent = progress.totalChunks === 0 ? 0 : Math.round((progress.completedChunks / progress.totalChunks) * 100);
  return (
    <section className="transfer-monitor">
      <div>
        <span>Mode</span>
        <strong>{progress.mode}</strong>
      </div>
      <div>
        <span>Progress</span>
        <strong>{percent}%</strong>
      </div>
      <div>
        <span>Active lanes</span>
        <strong>{progress.activeLanes}</strong>
      </div>
      <div>
        <span>Retries</span>
        <strong>{progress.retryCount}</strong>
      </div>
      {progress.spilloverBytes > 0 ? <p className="warning">Encrypted recovery spillover is active.</p> : null}
    </section>
  );
}
```

- [ ] **Step 4: Replace App composition**

Replace `src/client/App.tsx` with:

```tsx
import { useState } from "react";
import { FilePicker } from "./components/FilePicker";
import { JoinRoom } from "./components/JoinRoom";
import { TransferMonitor } from "./components/TransferMonitor";
import { VerifyPhrase } from "./components/VerifyPhrase";
import type { TransferProgress } from "../shared/protocol";

type Mode = "landing" | "send" | "receive";

const seedProgress: TransferProgress = {
  transferId: "pending",
  mode: "direct-p2p",
  totalBytes: 0,
  sentBytes: 0,
  receivedBytes: 0,
  completedChunks: 0,
  totalChunks: 0,
  retryCount: 0,
  activeLanes: 0,
  spilloverBytes: 0,
};

export function App() {
  const [mode, setMode] = useState<Mode>("landing");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="product-name">Secure P2P Transfer</p>
          <h1>Send large files directly, recover cleanly when networks shift.</h1>
          <p className="lede">
            No accounts. Direct browser transfer first. Cloudflare coordinates pairing,
            NAT traversal, and short-lived encrypted recovery state.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setMode("send")}>Send files</button>
            <button type="button" className="secondary" onClick={() => setMode("receive")}>Receive files</button>
          </div>
        </div>

        {mode === "send" ? (
          <section className="workflow">
            <FilePicker onFilesSelected={setSelectedFiles} />
            <p>{selectedFiles.length} file(s) selected</p>
            <VerifyPhrase phrase="amber-harbor-opal" confirmed={verified} onConfirm={() => setVerified(true)} />
            <TransferMonitor progress={{ ...seedProgress, activeLanes: selectedFiles.length > 0 ? 8 : 0 }} />
          </section>
        ) : null}

        {mode === "receive" ? (
          <section className="workflow">
            <JoinRoom code={code} onCodeChange={setCode} />
            <VerifyPhrase phrase="amber-harbor-opal" confirmed={verified} onConfirm={() => setVerified(true)} />
            <TransferMonitor progress={seedProgress} />
          </section>
        ) : null}
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Extend CSS for workflow controls**

Append to `src/client/styles.css`:

```css
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

button {
  border: 0;
  border-radius: 6px;
  padding: 12px 18px;
  color: #ffffff;
  background: #1d6f56;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
}

button.secondary {
  color: #1d6f56;
  background: #e6f1eb;
}

button:disabled {
  cursor: default;
  opacity: 0.62;
}

.workflow {
  display: grid;
  gap: 20px;
  margin-top: 36px;
}

.file-picker,
.field,
.verify-box,
.transfer-monitor {
  display: grid;
  gap: 10px;
  padding: 18px;
  border: 1px solid #d9e4dc;
  border-radius: 8px;
  background: #fbfdfb;
}

.field input {
  min-height: 44px;
  border: 1px solid #bdd0c4;
  border-radius: 6px;
  padding: 10px 12px;
}

.transfer-monitor {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}

.transfer-monitor span,
.verify-box span,
.field span,
.file-picker span {
  color: #53625c;
  font-size: 0.82rem;
  font-weight: 700;
}

.warning {
  grid-column: 1 / -1;
  margin: 0;
  color: #8b3a10;
  font-weight: 700;
}
```

- [ ] **Step 6: Run UI tests**

Run:

```bash
npm run test -- src/client/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit UI shell**

Run:

```bash
git add src/client/App.tsx src/client/App.test.tsx src/client/components src/client/styles.css
git commit -m "feat: add transfer UI shell"
```

Expected: commit succeeds.

## Task 11: Add WebRTC Peer Service

**Files:**
- Create: `src/client/transport/webrtcPeer.ts`
- Create: `src/client/transport/webrtcPeer.test.ts`

- [ ] **Step 1: Write WebRTC config tests**

Create `src/client/transport/webrtcPeer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRtcConfiguration } from "./webrtcPeer";

describe("buildRtcConfiguration", () => {
  it("uses ICE servers returned by the Worker TURN credential endpoint", () => {
    const iceServers: RTCIceServer[] = [
      { urls: ["turn:turn.example.com:3478"], username: "u", credential: "p" },
    ];

    const config = buildRtcConfiguration(iceServers);

    expect(config.iceServers).toEqual(iceServers);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- src/client/transport/webrtcPeer.test.ts
```

Expected: FAIL because `webrtcPeer.ts` does not exist.

- [ ] **Step 3: Implement WebRTC configuration helper**

Create `src/client/transport/webrtcPeer.ts`:

```ts
export function buildRtcConfiguration(iceServers: RTCIceServer[] = []): RTCConfiguration {
  return { iceServers };
}

export function createPeerConnection(iceServers: RTCIceServer[] = []): RTCPeerConnection {
  return new RTCPeerConnection(buildRtcConfiguration(iceServers));
}
```

- [ ] **Step 4: Run WebRTC tests**

Run:

```bash
npm run test -- src/client/transport/webrtcPeer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit WebRTC service**

Run:

```bash
git add src/client/transport/webrtcPeer.ts src/client/transport/webrtcPeer.test.ts
git commit -m "feat: add webrtc peer configuration"
```

Expected: commit succeeds.

## Task 12: Add Relay And Spillover Guardrails

**Files:**
- Create: `src/worker/relay.ts`
- Create: `src/worker/relay.test.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Write relay tests**

Create `src/worker/relay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertRelayRequestAllowed } from "./relay";

describe("assertRelayRequestAllowed", () => {
  it("accepts requests at or below the configured byte limit", () => {
    expect(() => assertRelayRequestAllowed(64 * 1024 * 1024, 64 * 1024 * 1024)).not.toThrow();
  });

  it("rejects requests above the configured byte limit", () => {
    expect(() => assertRelayRequestAllowed(64 * 1024 * 1024 + 1, 64 * 1024 * 1024)).toThrow("relay request exceeds configured limit");
  });
});
```

- [ ] **Step 2: Run relay test and verify failure**

Run:

```bash
npm run test:worker -- src/worker/relay.test.ts
```

Expected: FAIL because `relay.ts` does not exist.

- [ ] **Step 3: Implement relay guard**

Create `src/worker/relay.ts`:

```ts
export function assertRelayRequestAllowed(contentLength: number, maxBytes: number): void {
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error("content length is required");
  }
  if (contentLength > maxBytes) {
    throw new Error("relay request exceeds configured limit");
  }
}
```

- [ ] **Step 4: Wire relay guard into Worker route**

Modify `src/worker/index.ts` by adding this branch before the generic `/api/` 404 branch:

```ts
      if (url.pathname === "/api/relay" && request.method === "POST") {
        const { assertRelayRequestAllowed } = await import("./relay");
        const contentLength = Number.parseInt(request.headers.get("content-length") ?? "-1", 10);
        assertRelayRequestAllowed(contentLength, Number.parseInt(env.MAX_RELAY_REQUEST_BYTES, 10));
        return new Response(request.body, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
```

- [ ] **Step 5: Run Worker tests**

Run:

```bash
npm run test:worker
```

Expected: PASS.

- [ ] **Step 6: Commit relay guardrails**

Run:

```bash
git add src/worker/relay.ts src/worker/relay.test.ts src/worker/index.ts
git commit -m "feat: add relay request guardrails"
```

Expected: commit succeeds.

## Task 13: Integrate Transfer Flow State

**Files:**
- Create: `src/client/transfer/useTransferSession.ts`
- Create: `src/client/transfer/useTransferSession.test.tsx`
- Modify: `src/client/App.tsx`

- [ ] **Step 1: Write session hook test**

Create `src/client/transfer/useTransferSession.test.tsx`:

```tsx
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTransferSession } from "./useTransferSession";

describe("useTransferSession", () => {
  it("creates manifests when sender selects files", async () => {
    const { result } = renderHook(() => useTransferSession());
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    await act(async () => {
      await result.current.selectFiles([file]);
    });

    expect(result.current.manifests).toHaveLength(1);
    expect(result.current.progress.totalChunks).toBe(1);
  });
});
```

- [ ] **Step 2: Run hook test and verify failure**

Run:

```bash
npm run test -- src/client/transfer/useTransferSession.test.tsx
```

Expected: FAIL because `useTransferSession.ts` does not exist.

- [ ] **Step 3: Implement session hook**

Create `src/client/transfer/useTransferSession.ts`:

```ts
import { useCallback, useMemo, useState } from "react";
import type { FileManifest, TransferProgress } from "../../shared/protocol";
import { createFileManifest } from "./manifest";

export function useTransferSession() {
  const [files, setFiles] = useState<File[]>([]);
  const [manifests, setManifests] = useState<FileManifest[]>([]);

  const progress = useMemo<TransferProgress>(() => {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const totalChunks = manifests.reduce((sum, manifest) => sum + manifest.chunkCount, 0);
    return {
      transferId: manifests[0]?.transferId ?? "pending",
      mode: "direct-p2p",
      totalBytes,
      sentBytes: 0,
      receivedBytes: 0,
      completedChunks: 0,
      totalChunks,
      retryCount: 0,
      activeLanes: totalBytes > 1024 * 1024 * 1024 ? 8 : 2,
      spilloverBytes: 0,
    };
  }, [files, manifests]);

  const selectFiles = useCallback(async (nextFiles: File[]) => {
    const transferId = `transfer-${crypto.randomUUID()}`;
    setFiles(nextFiles);
    setManifests(await Promise.all(nextFiles.map((file) => createFileManifest(file, transferId))));
  }, []);

  return {
    files,
    manifests,
    progress,
    selectFiles,
  };
}
```

- [ ] **Step 4: Wire hook into App**

Modify `src/client/App.tsx` so the sender flow uses `useTransferSession`:

```tsx
const transfer = useTransferSession();
```

Replace sender `FilePicker` usage:

```tsx
<FilePicker onFilesSelected={(files) => void transfer.selectFiles(files)} />
<p>{transfer.files.length} file(s) selected</p>
<VerifyPhrase phrase="amber-harbor-opal" confirmed={verified} onConfirm={() => setVerified(true)} />
<TransferMonitor progress={transfer.progress} />
```

Add this import:

```tsx
import { useTransferSession } from "./transfer/useTransferSession";
```

- [ ] **Step 5: Run hook and UI tests**

Run:

```bash
npm run test -- src/client/transfer/useTransferSession.test.tsx src/client/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit transfer flow state**

Run:

```bash
git add src/client/transfer/useTransferSession.ts src/client/transfer/useTransferSession.test.tsx src/client/App.tsx
git commit -m "feat: integrate transfer session state"
```

Expected: commit succeeds.

## Task 14: Add End-To-End Verification Script

**Files:**
- Create: `docs/verification/manual-qa.md`
- Modify: `package.json`

- [ ] **Step 1: Add manual QA checklist**

Create `docs/verification/manual-qa.md`:

```md
# Manual QA Checklist

## Local App

1. Run `npm run build`.
2. Run `npm run dev`.
3. Open `http://127.0.0.1:5173`.
4. Verify the landing screen shows "Send files" and "Receive files".
5. Click "Send files" and select a file smaller than 1 GB.
6. Confirm the transfer monitor shows 2 active lanes.
7. Select a file larger than 1 GB when available.
8. Confirm the transfer monitor shows 8 active lanes.
9. Click "Receive files".
10. Confirm the pairing code input is visible.

## Cloudflare Worker

1. Run `npm run test:worker`.
2. Confirm room creation returns status 201.
3. Confirm unknown API routes return status 404.
4. Confirm relay request guard tests pass.

## Recovery Behavior

1. In unit tests, verify IndexedDB progress can be saved and loaded.
2. In unit tests, verify missing chunk bitmaps identify incomplete chunks.
3. In unit tests, verify the scheduler retries a temporary chunk failure.
```

- [ ] **Step 2: Add QA script alias**

Modify `package.json` scripts to include:

```json
"qa": "npm run typecheck && npm run test && npm run test:worker && npm run build"
```

- [ ] **Step 3: Run full QA**

Run:

```bash
npm run qa
```

Expected: typecheck, unit tests, Worker tests, and production build all pass.

- [ ] **Step 4: Commit verification docs**

Run:

```bash
git add package.json docs/verification/manual-qa.md
git commit -m "test: add secure transfer QA checklist"
```

Expected: commit succeeds.

## Task 15: Final Review

**Files:**
- Read: `docs/superpowers/specs/2026-06-02-secure-p2p-file-transfer-design.md`
- Read: `docs/verification/manual-qa.md`
- Read: changed source files

- [ ] **Step 1: Run final commands**

Run:

```bash
npm run qa
git status --short
```

Expected: `npm run qa` exits with code 0 and `git status --short` prints no unstaged or staged files.

- [ ] **Step 2: Verify spec coverage**

Confirm these source-spec requirements are implemented or explicitly listed as deferred in the final response:

```md
- No accounts.
- Sender remains online until completion.
- 24-hour room and recovery expiry.
- WebRTC-first architecture.
- TURN-aware configuration.
- Encrypted fallback design.
- R2 is optional and capped.
- 64 MiB logical chunks for files larger than 1 GB.
- 8 concurrent lanes for files larger than 1 GB.
- Relay subframes below Cloudflare WebSocket limits.
- IndexedDB recovery state.
- Per-chunk retry and bitmap resume.
- Worker request body guard below Cloudflare Free/Pro limit.
```

- [ ] **Step 3: Prepare final implementation summary**

Use this response shape:

```md
Implemented the first secure P2P transfer slice.

Changed:
- [short file/component summary]

Verified:
- `npm run qa`

Deferred:
- [specific deferred item, if any]
```

Do not claim deployed Cloudflare functionality unless `wrangler deploy` has actually succeeded.
