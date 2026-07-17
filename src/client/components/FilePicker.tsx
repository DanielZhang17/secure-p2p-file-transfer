import { useState, type DragEvent } from "react";

export interface FilePickerProps {
  labels?: FilePickerLabels;
  onFilesSelected: (files: File[]) => void;
}

export interface FilePickerLabels {
  choose: string;
  copy: string;
  dropZone: string;
  title: string;
}

const defaultLabels: FilePickerLabels = {
  choose: "Choose files",
  copy: "64 MiB chunks and up to 8 lanes are planned for files over 1 GB.",
  dropZone: "File drop zone",
  title: "Drop files to stage transfer",
};

export function FilePicker({ labels = defaultLabels, onFilesSelected }: FilePickerProps) {
  const [dragging, setDragging] = useState(false);

  const selectFiles = (files: FileList | File[] | null) => {
    const nextFiles = Array.from(files ?? []);
    if (nextFiles.length > 0) {
      onFilesSelected(nextFiles);
    }
  };

  const handleDrag = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <label
      aria-label={labels.dropZone}
      className={`file-picker${dragging ? " drag-active" : ""}`}
      onDragEnter={(event) => {
        handleDrag(event);
        setDragging(true);
      }}
      onDragOver={handleDrag}
      onDragLeave={(event) => {
        handleDrag(event);
        setDragging(false);
      }}
      onDrop={(event) => {
        handleDrag(event);
        setDragging(false);
        selectFiles(event.dataTransfer.files);
      }}
    >
      <span className="file-picker-title">{labels.title}</span>
      <span className="file-picker-copy">{labels.copy}</span>
      <span className="button-like primary">{labels.choose}</span>
      <input
        aria-label={labels.choose}
        type="file"
        multiple
        onChange={(event) => {
          const input = event.currentTarget;
          selectFiles(input.files);
          input.value = "";
        }}
      />
    </label>
  );
}
