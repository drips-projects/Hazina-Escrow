// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("Boom");
}

describe("ErrorBoundary", () => {
  it("renders a fallback UI and calls onReset", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReset = vi.fn();

    render(
      <ErrorBoundary label="Test" onReset={onReset}>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong in Test")).toBeTruthy();
    expect(screen.getByText("Boom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
