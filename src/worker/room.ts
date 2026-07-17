import { DurableObject } from "cloudflare:workers";
import type {
  ClientRoomMessage,
  RoomRole,
  ServerRoomMessage,
  SignalPayload,
  TransferControlMessage,
} from "../shared/protocol";
import { ROOM_CODE_PATTERN } from "../shared/roomCode";
import {
  isBoundedBase64,
  isSafeChunkAck,
  isSafeFileManifest,
  isSafeIdentifier,
  isSafeSpilloverChunkRef,
  MAX_ROOM_MESSAGE_LENGTH,
  MAX_SIGNAL_SDP_LENGTH,
} from "../shared/protocolValidation";
import type { SpilloverChunkLocation } from "./relay";
import { spilloverObjectKey } from "./relay";
import type { Env } from "./env";

interface RoomRecord {
  roomId: string;
  code: string;
  expiresAt: number;
  clientKey?: string;
  recoveryTokens?: Partial<Record<RoomRole, string>>;
  spilloverBytes?: number;
  spilloverObjects?: Record<string, SpilloverReservation>;
  turnCredentialsIssued?: number;
}

interface InitRoomBody {
  roomId: string;
  code: string;
  clientKey: string;
  expiresAt: number;
}

interface AuthorizeSpilloverBody {
  action: "read" | "reserve";
  contentLength?: number;
  location: SpilloverChunkLocation;
  recoveryToken: string;
}

interface UpdateSpilloverBody {
  action: "commit" | "release";
  location: SpilloverChunkLocation;
}

interface SpilloverReservation {
  bytes: number;
  committed: boolean;
}

interface SocketAttachment {
  role?: RoomRole;
  recoveryToken?: string;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

const ROOM_STORAGE_KEY = "room";
const MAX_TURN_ISSUANCES_PER_ROOM = 16;
const MAX_SPILLOVER_OBJECTS_PER_ROOM = 2_048;
const textEncoder = new TextEncoder();

export class TransferRoom extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      return this.initRoom(request);
    }

    if (url.pathname.endsWith("/authorize-spillover") && request.method === "POST") {
      return this.authorizeSpillover(request);
    }

    if (url.pathname.endsWith("/update-spillover") && request.method === "POST") {
      return this.updateSpillover(request);
    }

    if (url.pathname.endsWith("/authorize-turn") && request.method === "POST") {
      return this.authorizeTurn(request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptSocket(request);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    if (record) {
      await this.expireRoom(record);
      return;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_ROOM_MESSAGE_LENGTH) {
      sendServerMessage(ws, { type: "error", code: "invalid_message", message: "Invalid room message." });
      return;
    }

    const parsed = parseRoomMessage(message);

    if (!parsed) {
      sendServerMessage(ws, { type: "error", code: "invalid_message", message: "Invalid room message." });
      return;
    }

    if (parsed.type === "join") {
      await this.joinRoom(ws, parsed.role, parsed.recoveryToken);
      return;
    }

    const record = await this.ctx.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    if (!record) {
      sendServerMessage(ws, { type: "error", code: "room_not_found", message: "Room no longer exists." });
      ws.close(4404, "room not found");
      return;
    }

    if (record.expiresAt <= Date.now()) {
      await this.expireRoom(record);
      return;
    }

    const role = socketAttachment(ws).role;
    if (!role) {
      sendServerMessage(ws, { type: "error", code: "join_required", message: "Join a room role before sending messages." });
      return;
    }

    if (!roleCanSend(role, parsed)) {
      sendServerMessage(ws, { type: "error", code: "role_not_authorized", message: "This room role cannot send that message." });
      return;
    }

    this.forwardToPeerRole(ws, oppositeRole(role), parsed);
  }

  webSocketClose(): void {}

  webSocketError(): void {}

  private async initRoom(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isInitRoomBody(input)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const result = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<RoomRecord>(ROOM_STORAGE_KEY);
      if (existing && existing.expiresAt > Date.now()) {
        return { record: existing, status: 409 };
      }

      const record: RoomRecord = {
        roomId: input.roomId,
        code: input.code,
        clientKey: input.clientKey,
        expiresAt: input.expiresAt,
        recoveryTokens: {},
        spilloverBytes: 0,
        spilloverObjects: {},
        turnCredentialsIssued: 0,
      };

      await txn.put(ROOM_STORAGE_KEY, record);
      await txn.setAlarm(record.expiresAt);

      return { record, status: 201 };
    });

    return Response.json(
      { roomId: result.record.roomId, code: result.record.code, expiresAt: result.record.expiresAt },
      { status: result.status },
    );
  }

  private async authorizeSpillover(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isAuthorizeSpilloverBody(input)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const record = await this.ctx.storage.get<RoomRecord>(ROOM_STORAGE_KEY);

    if (!record) {
      return Response.json({ error: "room_not_found" }, { status: 404 });
    }

    if (input.location.roomId !== record.roomId) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    if (record.expiresAt <= Date.now()) {
      await this.expireRoom(record);
      return Response.json({ error: "room_expired" }, { status: 410 });
    }

    const role = recordRecoveryRole(record, input.recoveryToken);
    if (!role) {
      return Response.json({ error: "invalid_recovery_token" }, { status: 403 });
    }

    const objectKey = spilloverObjectKey(input.location);
    const objects = { ...record.spilloverObjects };

    if (input.action === "read") {
      if (role !== "recipient") {
        return Response.json({ error: "spillover_recipient_required" }, { status: 403 });
      }
      if (!objects[objectKey]?.committed) {
        return Response.json({ error: "spillover_chunk_not_found" }, { status: 404 });
      }
      return Response.json({ roomId: record.roomId, expiresAt: record.expiresAt });
    }

    if (role !== "sender") {
      return Response.json({ error: "spillover_sender_required" }, { status: 403 });
    }
    if (typeof input.contentLength !== "number" || !Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      return Response.json({ error: "invalid_content_length" }, { status: 400 });
    }
    const contentLength = input.contentLength;
    if (objects[objectKey]) {
      return Response.json({ error: "spillover_chunk_exists" }, { status: 409 });
    }
    if (Object.keys(objects).length >= MAX_SPILLOVER_OBJECTS_PER_ROOM) {
      return Response.json({ error: "spillover_object_limit_reached" }, { status: 413 });
    }

    const spilloverBytes = record.spilloverBytes ?? 0;
    const capBytes = parsePositiveInteger(this.env.SPILLOVER_CAP_BYTES);
    if (spilloverBytes + contentLength > capBytes) {
      return Response.json({ error: "spillover_room_cap_exceeded" }, { status: 413 });
    }

    objects[objectKey] = { bytes: contentLength, committed: false };
    await this.ctx.storage.put(ROOM_STORAGE_KEY, {
      ...record,
      spilloverBytes: spilloverBytes + contentLength,
      spilloverObjects: objects,
    });

    return Response.json({ roomId: record.roomId, expiresAt: record.expiresAt });
  }

  private async updateSpillover(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isUpdateSpilloverBody(input)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const record = await this.ctx.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    if (!record) {
      return Response.json({ error: "room_not_found" }, { status: 404 });
    }
    if (input.location.roomId !== record.roomId) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (record.expiresAt <= Date.now()) {
      await this.expireRoom(record);
      return Response.json({ error: "room_expired" }, { status: 410 });
    }

    const key = spilloverObjectKey(input.location);
    const objects = { ...record.spilloverObjects };
    const reservation = objects[key];
    if (!reservation) {
      return input.action === "release"
        ? new Response(null, { status: 204 })
        : Response.json({ error: "spillover_reservation_not_found" }, { status: 404 });
    }

    if (input.action === "commit") {
      objects[key] = { ...reservation, committed: true };
    } else {
      delete objects[key];
    }

    await this.ctx.storage.put(ROOM_STORAGE_KEY, {
      ...record,
      spilloverBytes:
        input.action === "release" ? Math.max(0, (record.spilloverBytes ?? 0) - reservation.bytes) : record.spilloverBytes,
      spilloverObjects: objects,
    });
    return new Response(null, { status: 204 });
  }

  private async authorizeTurn(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isAuthorizeTurnBody(input)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const result = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<RoomRecord>(ROOM_STORAGE_KEY);
      if (!record) {
        return { error: "room_not_found" as const };
      }
      if (record.expiresAt <= Date.now()) {
        return { error: "room_expired" as const, record };
      }
      if (!recordRecoveryRole(record, input.recoveryToken)) {
        return { error: "invalid_recovery_token" as const };
      }

      const issued = record.turnCredentialsIssued ?? 0;
      if (issued >= MAX_TURN_ISSUANCES_PER_ROOM) {
        return { error: "turn_issuance_limit_reached" as const };
      }

      await txn.put(ROOM_STORAGE_KEY, { ...record, turnCredentialsIssued: issued + 1 });
      return { expiresAt: record.expiresAt };
    });

    if (result.error === "room_expired") {
      await this.expireRoom(result.record);
      return Response.json({ error: result.error }, { status: 410 });
    }
    if (result.error) {
      return Response.json(
        { error: result.error },
        { status: result.error === "room_not_found" ? 404 : result.error === "invalid_recovery_token" ? 403 : 429 },
      );
    }

    return Response.json(result);
  }

  private async acceptSocket(request: Request): Promise<Response> {
    const record = await this.ctx.storage.get<RoomRecord>(ROOM_STORAGE_KEY);

    if (!record) {
      return Response.json({ error: "room_not_found" }, { status: 404 });
    }

    if (record.expiresAt <= Date.now()) {
      await this.expireRoom(record);
      return Response.json({ error: "room_expired" }, { status: 410 });
    }

    const url = new URL(request.url);
    if (!roomCodesEqual(url.searchParams.get("code"), record.code)) {
      return Response.json({ error: "invalid_room_code" }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async joinRoom(ws: WebSocket, role: RoomRole, requestedRecoveryToken?: string): Promise<void> {
    const currentAttachment = socketAttachment(ws);
    if (currentAttachment.role) {
      sendServerMessage(ws, { type: "error", code: "already_joined", message: "This socket already owns a room role." });
      return;
    }

    const result = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<RoomRecord>(ROOM_STORAGE_KEY);

      if (!record) {
        return { error: "room_not_found" as const };
      }

      if (record.expiresAt <= Date.now()) {
        return { error: "room_expired" as const, record };
      }

      const recoveryTokens = { ...record.recoveryTokens };
      const existingToken = recoveryTokens[role];
      if (existingToken && (!requestedRecoveryToken || !recoveryTokensEqual(requestedRecoveryToken, existingToken))) {
        return { error: "role_unavailable" as const };
      }

      const recoveryToken = existingToken ?? crypto.randomUUID();

      recoveryTokens[role] = recoveryToken;
      await txn.put(ROOM_STORAGE_KEY, { ...record, recoveryTokens });

      return { record: { ...record, recoveryTokens }, recoveryToken };
    });

    if (result.error === "room_not_found") {
      sendServerMessage(ws, { type: "error", code: "room_not_found", message: "Room no longer exists." });
      ws.close(4404, "room not found");
      return;
    }

    if (result.error === "room_expired") {
      await this.expireRoom(result.record);
      return;
    }

    if (result.error === "role_unavailable") {
      sendServerMessage(ws, { type: "error", code: "role_unavailable", message: "That room role is already owned." });
      ws.close(4409, "role unavailable");
      return;
    }

    const { record, recoveryToken } = result;
    this.closeStaleRecoveredSockets(ws, role, recoveryToken);
    ws.serializeAttachment({ role, recoveryToken } satisfies SocketAttachment);
    sendServerMessage(ws, {
      type: "joined",
      roomId: record.roomId,
      role,
      recoveryToken,
      expiresAt: record.expiresAt,
    });

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) {
        continue;
      }

      const attachment = socketAttachment(peer);
      if (attachment.role) {
        sendServerMessage(peer, { type: "peer-joined", role });
        sendServerMessage(ws, { type: "peer-joined", role: attachment.role });
      }
    }
  }

  private closeStaleRecoveredSockets(currentSocket: WebSocket, role: RoomRole, recoveryToken: string): void {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === currentSocket) {
        continue;
      }

      const attachment = socketAttachment(peer);
      if (attachment.role === role && attachment.recoveryToken === recoveryToken) {
        peer.close(4000, "replaced by recovered socket");
      }
    }
  }

  private forwardToPeerRole(sender: WebSocket, targetRole: RoomRole, message: ClientRoomMessage): void {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== sender && socketAttachment(peer).role === targetRole) {
        peer.send(JSON.stringify(message));
      }
    }
  }

  private async expireRoom(record: RoomRecord): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      sendServerMessage(socket, { type: "expired", roomId: record.roomId });
      socket.close(4410, "room expired");
    }

    await deleteSpilloverObjects(this.env.SPILLOVER, `rooms/${record.roomId}/`);
    if (record.clientKey) {
      const limiter = this.env.SESSION_LIMITERS.get(this.env.SESSION_LIMITERS.idFromName(record.clientKey));
      await limiter.fetch(
        new Request("https://limiter/release", {
          method: "POST",
          body: JSON.stringify({ roomId: record.roomId }),
          headers: { "content-type": "application/json" },
        }),
      );
    }
    await this.ctx.storage.deleteAll();
  }
}

export function roomCodesEqual(candidate: string | null, expected: string): boolean {
  if (candidate === null || !ROOM_CODE_PATTERN.test(candidate) || !ROOM_CODE_PATTERN.test(expected)) {
    return false;
  }

  const subtle = crypto.subtle as TimingSafeSubtleCrypto;

  return subtle.timingSafeEqual(textEncoder.encode(candidate), textEncoder.encode(expected));
}

function parseRoomMessage(message: string | ArrayBuffer): ClientRoomMessage | null {
  if (typeof message !== "string") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(message);
    if (isClientRoomMessage(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function isClientRoomMessage(value: unknown): value is ClientRoomMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "join") {
    return (
      isRoomRole(value.role) &&
      (value.recoveryToken === undefined ||
        (typeof value.recoveryToken === "string" && value.recoveryToken.length > 0 && value.recoveryToken.length <= 128))
    );
  }

  if (value.type === "signal") {
    return isSignalPayload(value.payload);
  }

  if (value.type === "transfer") {
    return isTransferControlMessage(value.message);
  }

  if (value.type === "spillover-chunk") {
    return isSafeSpilloverChunkRef(value.chunk);
  }

  if (value.type === "manifest") {
    return isSafeFileManifest(value.manifest);
  }

  if (value.type === "ack") {
    return isSafeChunkAck(value.ack);
  }

  return value.type === "heartbeat" && typeof value.at === "number" && Number.isSafeInteger(value.at) && value.at >= 0;
}

function isSignalPayload(value: unknown): value is SignalPayload {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "offer" || value.type === "answer") {
    return typeof value.sdp === "string" && value.sdp.length > 0 && value.sdp.length <= MAX_SIGNAL_SDP_LENGTH;
  }

  return value.type === "ice" && isIceCandidate(value.candidate);
}

function isTransferControlMessage(value: unknown): value is TransferControlMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "key-exchange") {
    return isSafeIdentifier(value.transferId) && isBoundedBase64(value.publicKeyBase64, 128);
  }

  if (value.type === "verification-confirmed") {
    return isSafeIdentifier(value.transferId);
  }

  return value.type === "manifest" && isSafeFileManifest(value.manifest);
}

function isRoomRole(value: unknown): value is RoomRole {
  return value === "sender" || value === "recipient";
}

function isInitRoomBody(value: unknown): value is InitRoomBody {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.roomId) &&
    typeof value.code === "string" &&
    ROOM_CODE_PATTERN.test(value.code) &&
    isSafeIdentifier(value.clientKey) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > Date.now()
  );
}

function isAuthorizeSpilloverBody(value: unknown): value is AuthorizeSpilloverBody {
  return (
    isRecord(value) &&
    (value.action === "read" || value.action === "reserve") &&
    isSpilloverLocation(value.location) &&
    typeof value.recoveryToken === "string" &&
    value.recoveryToken.length > 0 &&
    value.recoveryToken.length <= 128 &&
    (value.contentLength === undefined ||
      (typeof value.contentLength === "number" && Number.isSafeInteger(value.contentLength) && value.contentLength > 0))
  );
}

function isUpdateSpilloverBody(value: unknown): value is UpdateSpilloverBody {
  return isRecord(value) && (value.action === "commit" || value.action === "release") && isSpilloverLocation(value.location);
}

function isAuthorizeTurnBody(value: unknown): value is { recoveryToken: string } {
  return isRecord(value) && typeof value.recoveryToken === "string" && value.recoveryToken.length > 0 && value.recoveryToken.length <= 128;
}

function isSpilloverLocation(value: unknown): value is SpilloverChunkLocation {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.roomId) &&
    isSafeIdentifier(value.transferId) &&
    isSafeIdentifier(value.fileId) &&
    typeof value.chunkIndex === "number" &&
    Number.isSafeInteger(value.chunkIndex) &&
    value.chunkIndex >= 0
  );
}

function recordRecoveryRole(record: RoomRecord, candidate: string): RoomRole | undefined {
  return (Object.entries(record.recoveryTokens ?? {}) as Array<[RoomRole, string | undefined]>).find(([, expected]) =>
    recoveryTokensEqual(candidate, expected),
  )?.[0];
}

function recoveryTokensEqual(candidate: string, expected: string | undefined): boolean {
  if (!expected || candidate.length !== expected.length) {
    return false;
  }

  const subtle = crypto.subtle as TimingSafeSubtleCrypto;

  return subtle.timingSafeEqual(textEncoder.encode(candidate), textEncoder.encode(expected));
}

function roleCanSend(role: RoomRole, message: ClientRoomMessage): boolean {
  if (message.type === "signal" || message.type === "heartbeat") {
    return true;
  }
  if (
    message.type === "transfer" &&
    (message.message.type === "key-exchange" || message.message.type === "verification-confirmed")
  ) {
    return true;
  }
  if (message.type === "ack") {
    return role === "recipient";
  }

  return role === "sender";
}

function oppositeRole(role: RoomRole): RoomRole {
  return role === "sender" ? "recipient" : "sender";
}

function isIceCandidate(value: unknown): value is RTCIceCandidateInit {
  if (!isRecord(value)) {
    return false;
  }

  return (
    optionalBoundedString(value.candidate, 8_192) &&
    optionalBoundedString(value.sdpMid, 256, true) &&
    (value.sdpMLineIndex === undefined || value.sdpMLineIndex === null ||
      (typeof value.sdpMLineIndex === "number" && Number.isSafeInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0)) &&
    optionalBoundedString(value.usernameFragment, 256, true)
  );
}

function optionalBoundedString(value: unknown, maxLength: number, nullable = false): boolean {
  return value === undefined || (nullable && value === null) || (typeof value === "string" && value.length <= maxLength);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("positive integer configuration required");
  }
  return parsed;
}

async function deleteSpilloverObjects(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const list = await bucket.list({ prefix, cursor });
    if (list.objects.length > 0) {
      await bucket.delete(list.objects.map((object) => object.key));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

function sendServerMessage(ws: WebSocket, message: ServerRoomMessage): void {
  ws.send(JSON.stringify(message));
}

function socketAttachment(ws: WebSocket): SocketAttachment {
  const attachment: unknown = ws.deserializeAttachment();
  if (!isRecord(attachment)) {
    return {};
  }

  return {
    role: isRoomRole(attachment.role) ? attachment.role : undefined,
    recoveryToken: typeof attachment.recoveryToken === "string" ? attachment.recoveryToken : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
