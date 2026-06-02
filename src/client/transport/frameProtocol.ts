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
