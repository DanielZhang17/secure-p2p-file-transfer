import { afterEach, describe, expect, it, vi } from "vitest";
import { saveReceivedFile } from "./receivedFileSave";

describe("saveReceivedFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as WindowWithSavePicker).showSaveFilePicker;
  });

  it("writes the file through the File System Access API when available", async () => {
    const writable = {
      close: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
    };
    const createWritable = vi.fn(async () => writable);
    const showSaveFilePicker = vi.fn(async () => ({ createWritable }));
    (window as WindowWithSavePicker).showSaveFilePicker = showSaveFilePicker;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    await expect(saveReceivedFile({ file, url: "blob:test" })).resolves.toBe("file-system-access");

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "hello.txt",
      types: [{ accept: { "text/plain": [".txt"] }, description: "text/plain" }],
    });
    expect(createWritable).toHaveBeenCalled();
    expect(writable.write).toHaveBeenCalledWith(file);
    expect(writable.close).toHaveBeenCalled();
  });

  it("falls back to an object URL download when file system save handles are unavailable", async () => {
    const click = vi.fn();
    const anchor = {
      click,
      download: "",
      href: "",
      rel: "",
    } as unknown as HTMLAnchorElement;
    vi.spyOn(document, "createElement").mockReturnValue(anchor);
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    await expect(saveReceivedFile({ file, url: "blob:test" })).resolves.toBe("download");

    expect(anchor.href).toBe("blob:test");
    expect(anchor.download).toBe("hello.txt");
    expect(anchor.rel).toBe("noopener");
    expect(click).toHaveBeenCalled();
  });
});

interface WindowWithSavePicker extends Window {
  showSaveFilePicker?: unknown;
}
