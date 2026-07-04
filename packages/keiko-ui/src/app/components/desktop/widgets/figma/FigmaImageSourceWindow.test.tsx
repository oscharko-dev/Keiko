// test-plan #37 — the FigmaImageSourceWindow names its section from the screen name, gives the
// preview image an alt matching that label, and surfaces a role=alert when no image source exists.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FigmaImageSourceWindow } from "./FigmaImageSourceWindow";

describe("FigmaImageSourceWindow — a11y (test-plan #37)", () => {
  it("names the section region from the screen name and gives the image a matching alt", () => {
    render(<FigmaImageSourceWindow imageSrc="/screens/login.png" screenName="Login screen" />);

    const region = screen.getByRole("region", { name: "Login screen" });
    expect(region).toBeInTheDocument();

    const image = screen.getByRole("img", { name: "Login screen" });
    expect(image).toBeInTheDocument();
  });

  it("falls back to a default label when the screen name is empty", () => {
    render(<FigmaImageSourceWindow imageSrc="/screens/login.png" screenName="   " />);

    expect(screen.getByRole("region", { name: "Figma image source" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Figma image source" })).toBeInTheDocument();
  });

  it("renders a role=alert when the image source is empty", () => {
    render(<FigmaImageSourceWindow imageSrc="" screenName="Login screen" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Image preview is unavailable.");
    // No image is rendered in the missing state.
    expect(screen.queryByRole("img")).toBeNull();
    // The named region is still present for orientation.
    expect(screen.getByRole("region", { name: "Login screen" })).toBeInTheDocument();
  });

  it("renders a role=alert when the image source is omitted", () => {
    render(<FigmaImageSourceWindow screenName="Login screen" />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
