import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows sender and recipient entry points", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Send files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Receive files" })).toBeInTheDocument();
  });

  it("shows pairing code input when receiving files", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Receive files" }));

    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
  });

  it("shows file picker and starts selected file count at zero when sending files", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));

    expect(screen.getByLabelText("Choose files")).toBeInTheDocument();
    expect(screen.getByText("0 files selected")).toBeInTheDocument();
  });
});
