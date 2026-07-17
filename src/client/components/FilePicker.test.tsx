import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilePicker } from "./FilePicker";

describe("FilePicker", () => {
  it("selects files dropped onto the drop zone", () => {
    const onFilesSelected = vi.fn();
    const file = new File(["draft"], "draft.txt", { type: "text/plain" });

    render(<FilePicker onFilesSelected={onFilesSelected} />);

    fireEvent.drop(screen.getByLabelText("File drop zone"), {
      dataTransfer: { files: [file] },
    });

    expect(onFilesSelected).toHaveBeenCalledWith([file]);
  });
});
