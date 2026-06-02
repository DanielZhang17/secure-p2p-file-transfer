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
