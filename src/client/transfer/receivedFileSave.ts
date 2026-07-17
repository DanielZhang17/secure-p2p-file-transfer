export type ReceivedFileSaveMode = "file-system-access" | "download";

export interface SaveReceivedFileInput {
  file: File;
  url: string;
}

interface SaveFilePickerOptions {
  suggestedName: string;
  types?: Array<{
    accept: Record<string, string[]>;
    description: string;
  }>;
}

interface FileSystemFileHandleLike {
  createWritable: () => Promise<FileSystemWritableFileStreamLike>;
}

interface FileSystemWritableFileStreamLike {
  close: () => Promise<void> | void;
  write: (data: Blob) => Promise<void> | void;
}

interface WindowWithSaveFilePicker {
  showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;
}

export async function saveReceivedFile(input: SaveReceivedFileInput): Promise<ReceivedFileSaveMode> {
  const picker = (window as WindowWithSaveFilePicker).showSaveFilePicker;
  if (picker) {
    const handle = await picker(savePickerOptions(input.file));
    const writable = await handle.createWritable();
    await writable.write(input.file);
    await writable.close();
    return "file-system-access";
  }

  const anchor = document.createElement("a");
  anchor.href = input.url;
  anchor.download = input.file.name;
  anchor.rel = "noopener";
  anchor.click();
  return "download";
}

function savePickerOptions(file: File): SaveFilePickerOptions {
  const extension = fileExtension(file.name);
  if (!file.type) {
    return { suggestedName: file.name };
  }

  return {
    suggestedName: file.name,
    types: [{ accept: { [file.type]: extension ? [extension] : [] }, description: file.type }],
  };
}

function fileExtension(name: string): string | undefined {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) {
    return undefined;
  }

  return name.slice(index);
}
