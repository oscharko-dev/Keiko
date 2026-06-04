import { describe, it, expect } from "vitest";
import { projectErrorMessage } from "./error-messages";

describe("projectErrorMessage", () => {
  it("maps invalid_path", () => {
    expect(projectErrorMessage("invalid_path", "fallback")).toBe(
      "Path is not a valid absolute local directory.",
    );
  });

  it("maps path_not_directory", () => {
    expect(projectErrorMessage("path_not_directory", "fallback")).toBe(
      "That path exists but is not a directory.",
    );
  });

  it("maps path_not_found", () => {
    expect(projectErrorMessage("path_not_found", "fallback")).toBe(
      "No directory exists at that path.",
    );
  });

  it("maps project_exists", () => {
    expect(projectErrorMessage("project_exists", "fallback")).toBe(
      "This project is already in your sidebar.",
    );
  });

  it("maps invalid_request", () => {
    expect(projectErrorMessage("invalid_request", "fallback")).toBe(
      "Could not validate that request.",
    );
  });

  it("maps payload_too_large", () => {
    expect(projectErrorMessage("payload_too_large", "fallback")).toBe("Path is too long.");
  });

  it("falls back to ApiError.message for unknown codes", () => {
    expect(projectErrorMessage("some_unknown_code", "Server error occurred")).toBe(
      "Server error occurred",
    );
  });

  it("falls back for empty code string", () => {
    expect(projectErrorMessage("", "Generic error")).toBe("Generic error");
  });
});
