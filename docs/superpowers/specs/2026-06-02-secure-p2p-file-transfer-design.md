# Secure P2P File Transfer Design

Date: 2026-06-02

## Goal

Build a no-account web app on Cloudflare for secure browser-based file transfer. The app should prefer direct peer-to-peer transfer, handle difficult NAT4/network conditions, and resume interrupted transfers for up to 24 hours while the sender remains online and still has local access to the selected files.

The normal target file range is 100 MB to 100 GB. The upper-bound use case is 2 TB, which must be handled through streaming, chunking, bounded concurrency, retry, and resumable state rather than whole-file buffering.

## Approved Approach

Use a WebRTC-first architecture with Cloudflare coordination:

1. Direct WebRTC data channel for the primary transfer path.
2. Cloudflare TURN relay when direct WebRTC cannot traverse NAT/firewalls.
3. Encrypted Worker/R2 spillover only when needed for reconnect recovery or short-term buffering.

R2 is not the default storage path. It is a reliability tool for encrypted temporary chunks and incomplete state when live transfer conditions require it.

## Cloudflare Platform Components

- Cloudflare Worker: serves the app, handles HTTP APIs, validates room requests, routes WebSocket upgrades to Durable Objects, and exposes bounded relay/spillover endpoints.
- Durable Object: owns each transfer room and stores pairing state, WebSocket participants, signaling messages, reconnect tokens, transfer manifests, chunk acknowledgement bitmaps, and expiry alarms.
- Cloudflare TURN: improves WebRTC reliability when both peers are behind NAT or restrictive firewalls.
- Optional R2 bucket: stores encrypted temporary spillover chunks and multipart state only when fallback buffering is required.

Relevant Cloudflare constraints checked during design:

- Worker request body limits are plan-dependent: Free/Pro 100 MB, Business 200 MB, Enterprise 500 MB by default. Fallback upload requests must stay below 100 MB. Source: https://developers.cloudflare.com/workers/platform/limits/
- Worker/Durable Object WebSocket received messages are limited to 32 MiB, so relay messages must be subframed below that. Source: https://developers.cloudflare.com/durable-objects/platform/limits/
- R2 multipart upload supports large objects and resumable parts, with part/object constraints. Source: https://developers.cloudflare.com/r2/objects/multipart-objects/ and https://developers.cloudflare.com/r2/platform/limits/
- Cloudflare TURN is intended for WebRTC clients when direct communication is blocked by NATs/firewalls. Source: https://developers.cloudflare.com/calls/turn/

## User Experience

### Sender Flow

1. Sender opens the app and drops or selects one or more files.
2. The app calculates file metadata and builds a transfer manifest without reading whole files into memory.
3. Sender receives a short pairing code and share link.
4. Sender waits for the recipient and confirms the verification phrase.
5. Transfer begins and shows mode, progress, speed, ETA, retry count, and reconnect status.
6. Sender must keep the browser open and files locally available until transfer completes.

### Recipient Flow

1. Recipient opens the shared link or enters the pairing code.
2. Recipient joins the room through the Durable Object.
3. Both sides compare a human-readable verification phrase before transfer starts.
4. Recipient chooses where to save the incoming file when browser capabilities allow it, or receives a browser download stream/fallback.
5. Recipient can reconnect within the 24-hour recovery window and resume missing chunks.

### Transfer Status

The transfer screen shows the current path:

- Direct P2P
- TURN relay
- Recovery relay

The UI also shows chunk completion, active lanes, failed/retried chunks, estimated time remaining, and a warning when fallback spillover is in use.

## Security Model

- No accounts or persistent identity are required.
- Pairing codes only grant access to a short-lived transfer room.
- File content is encrypted in the browser before any Cloudflare relay or R2 spillover can see it.
- Cloudflare stores room metadata, signaling, chunk status, and encrypted spillover references, but not plaintext file content.
- Recovery tokens are scoped to a transfer session and expire after 24 hours by default.
- Integrity is verified per chunk and for the completed file using client-side hashes.

The implementation should avoid implying that WebRTC transport encryption alone is enough for fallback security. Application-level client-side encryption is required for any bytes that can pass through Worker relay or R2 spillover.

## Transfer Engine

### Chunking

- Files up to 1 GB use a lighter profile to reduce overhead.
- Files larger than 1 GB use 64 MiB logical chunks by default.
- Files larger than 1 GB use 8 concurrent chunk lanes by default.
- Transport subframes are smaller than logical chunks and stay below Cloudflare WebSocket limits. A practical starting range is 1-8 MiB per subframe.
- Chunk size and concurrency can adapt downward under high retry rates, browser memory pressure, or slow network conditions.

### Streaming And Memory

- The browser must read files using slices/streams.
- The app must never load a full file into memory.
- Hashing and encryption operate incrementally.
- Backpressure from WebRTC, Worker relay, or disk/download writes throttles read concurrency.

### Resume

Both browsers persist transfer progress in IndexedDB:

- Transfer ID
- File metadata
- Chunk size
- Total chunk count
- Completed chunk bitmap
- Per-chunk hashes
- Last successful transport mode
- Recovery token
- Expiry timestamp

On reconnect, clients rejoin the room, prove access with the recovery token, compare manifests and bitmaps, and resume only missing chunks.

### Expiry

Default expiry is 24 hours for:

- Rooms
- Pairing codes
- Reconnect tokens
- Incomplete manifests
- Temporary encrypted spillover chunks
- Incomplete R2 multipart uploads controlled by the app

If peers are actively connected, room state may remain active until completion. Once transfer completes or expires, Durable Object state and any temporary R2 objects should be cleaned up.

### Spillover Guardrails

The app must not silently buffer a full 2 TB transfer in R2. Spillover has a configurable cap and is used only for recovery windows or in-flight chunks. The UI must make fallback usage visible.

## Architecture Boundaries

### Frontend

- React + Vite by default for a greenfield app.
- Components should be split into app shell, pairing flow, file picker, transfer monitor, verification phrase, network mode indicator, and transfer controls.
- Transfer state should be separated from UI components through dedicated hooks/services.
- Heavy crypto, hashing, and chunk scheduling should use Web Workers where practical.

### Worker

- Validates HTTP requests before reaching Durable Objects.
- Uses streaming request/response handling.
- Avoids buffering large request bodies.
- Does not hardcode secrets.
- Uses structured logging within Cloudflare log-size limits.
- Uses `ctx.waitUntil()` for post-response cleanup where appropriate.
- Avoids module-level mutable request state.

### Durable Object

- One Durable Object instance per transfer room.
- Owns room lifecycle and WebSocket coordination.
- Uses WebSocket hibernation APIs where practical.
- Stores metadata and bitmaps, not large file chunks.
- Uses alarms for expiry cleanup.
- Batches signaling/status messages to avoid excessive message overhead.

### R2

- Optional binding for encrypted spillover only.
- Stores chunks under transfer-scoped keys.
- Enforces lifecycle cleanup for stale objects.
- Uses multipart patterns only when an object-based fallback is needed.

## Error Handling

- Invalid or expired pairing code: show a clear expired-room state.
- Verification mismatch: stop transfer and require a new room.
- WebRTC failure: attempt TURN.
- TURN failure or reconnect gap: use recovery relay/spillover if enabled.
- Chunk hash mismatch: discard and retry the chunk.
- Sender tab refresh: reconnect and reload selected file handles where browser permissions allow; otherwise prompt sender to reselect the same files.
- Recipient refresh: reconnect, compare bitmap, and resume missing chunks.
- Expired recovery window: fail closed and remove temporary state.

## Testing And Verification Plan

The implementation plan should include:

- Unit tests for manifest creation, chunk scheduling, retry state, and bitmap diffing.
- Crypto/integrity tests for chunk encryption, hash mismatch rejection, and final file verification.
- Worker tests for room creation, expired code handling, WebSocket routing, and bounded relay request sizes.
- Durable Object tests for room lifecycle, reconnect tokens, chunk acknowledgements, and expiry alarms.
- Browser tests for sender/recipient flow, mode transitions, progress UI, reconnect/resume, and large-file simulation.
- Network simulation tests for dropped WebRTC connection, IP-change style reconnect, and fallback path activation.

## Non-Goals For The First Version

- User accounts.
- Permanent cloud storage.
- Recipient download after sender has gone offline.
- Public file hosting.
- Multi-day transfer rooms.
- Server-side plaintext processing.
- Mobile-native app packaging.

## Implementation Defaults To Carry Into Planning

- Key agreement uses browser Web Crypto ECDH with HKDF-derived transfer keys, followed by AES-GCM for chunk encryption. The verification phrase is derived from the authenticated key material so both peers can detect pairing attacks before transfer.
- The first browser build prefers the File System Access API for recipient writes where supported, with a download-stream fallback for browsers that do not support direct file writes.
- Adaptive concurrency starts at 8 lanes for files larger than 1 GB, halves after repeated chunk failures or sustained backpressure, and only increases again after a stable success window.
- Logical chunks default to 64 MiB above 1 GB. Relay subframes default to 4 MiB and may adapt within 1-8 MiB while staying below Cloudflare WebSocket limits.
- Spillover is capped per room through deployment configuration, with a 10 GiB default cap. When the cap is reached, the app pauses recovery buffering and requires live sender-to-recipient transfer to continue.
- TURN credentials are issued through a Worker endpoint as short-lived credentials. Secrets or Cloudflare API tokens are never exposed to the browser or hardcoded in source.
