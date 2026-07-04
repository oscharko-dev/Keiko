import { describe, it, expect } from "vitest";
import { projectErrorMessage } from "./error-messages";

describe("projectErrorMessage", () => {
  // New SCREAMING_SNAKE_CASE wire codes (GEN-DUP-SEMANTIC-018).
  it("maps INVALID_PATH", () => {
    expect(projectErrorMessage("INVALID_PATH", "fallback")).toBe(
      "Path is not a valid absolute local directory.",
    );
  });

  it("maps PATH_NOT_DIRECTORY", () => {
    expect(projectErrorMessage("PATH_NOT_DIRECTORY", "fallback")).toBe(
      "That path exists but is not a directory.",
    );
  });

  it("maps PATH_NOT_FOUND", () => {
    expect(projectErrorMessage("PATH_NOT_FOUND", "fallback")).toBe(
      "No directory exists at that path.",
    );
  });

  it("maps PROJECT_EXISTS", () => {
    expect(projectErrorMessage("PROJECT_EXISTS", "fallback")).toBe(
      "This project is already in your sidebar.",
    );
  });

  it("maps INVALID_REQUEST", () => {
    expect(projectErrorMessage("INVALID_REQUEST", "fallback")).toBe(
      "Could not validate that request.",
    );
  });

  it("maps PAYLOAD_TOO_LARGE", () => {
    expect(projectErrorMessage("PAYLOAD_TOO_LARGE", "fallback")).toBe("Path is too long.");
  });

  // Legacy snake_case codes remain accepted (dual-key deploy-order safety). Same messages.
  it("maps invalid_path (legacy)", () => {
    expect(projectErrorMessage("invalid_path", "fallback")).toBe(
      "Path is not a valid absolute local directory.",
    );
  });

  it("maps path_not_directory (legacy)", () => {
    expect(projectErrorMessage("path_not_directory", "fallback")).toBe(
      "That path exists but is not a directory.",
    );
  });

  it("maps path_not_found (legacy)", () => {
    expect(projectErrorMessage("path_not_found", "fallback")).toBe(
      "No directory exists at that path.",
    );
  });

  it("maps project_exists (legacy)", () => {
    expect(projectErrorMessage("project_exists", "fallback")).toBe(
      "This project is already in your sidebar.",
    );
  });

  it("maps invalid_request (legacy)", () => {
    expect(projectErrorMessage("invalid_request", "fallback")).toBe(
      "Could not validate that request.",
    );
  });

  it("maps payload_too_large (legacy)", () => {
    expect(projectErrorMessage("payload_too_large", "fallback")).toBe("Path is too long.");
  });

  it("legacy and SCREAMING spellings resolve to the same message", () => {
    expect(projectErrorMessage("INVALID_PATH", "fallback")).toBe(
      projectErrorMessage("invalid_path", "fallback"),
    );
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
