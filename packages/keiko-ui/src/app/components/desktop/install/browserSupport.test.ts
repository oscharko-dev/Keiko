import { describe, expect, it } from "vitest";
import { detectSupport, type SupportLevel } from "./browserSupport";

// UA string fixtures (real-world condensed for testability)
const CHROME_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51";
const EDGE_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.67";
const CHROMIUM_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/124.0.6367.60 Chrome/124.0.6367.60 Safari/537.36";
const CRIOS_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1";
const FIREFOX_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0";
const SAFARI_IOS_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SAFARI_IOS_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SAFARI_IOS_IPOD =
  "Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SAFARI_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const UNKNOWN_BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) UnknownBrowser/1.0 Safari/537.36";

interface Fixture {
  readonly ua: string;
  readonly expected: SupportLevel;
  readonly label: string;
}

const fixtures: readonly Fixture[] = [
  { ua: CHROME_MACOS, expected: "supported", label: "Chrome on macOS" },
  { ua: CHROME_WINDOWS, expected: "supported", label: "Chrome on Windows" },
  { ua: CHROME_LINUX, expected: "supported", label: "Chrome on Linux" },
  { ua: CHROME_ANDROID, expected: "manual", label: "Chrome on Android (mobile)" },
  { ua: EDGE_WINDOWS, expected: "supported", label: "Edge on Windows" },
  { ua: EDGE_MACOS, expected: "supported", label: "Edge on macOS" },
  { ua: CHROMIUM_LINUX, expected: "supported", label: "Chromium on Linux" },
  { ua: CRIOS_IPHONE, expected: "manual", label: "Chrome on iOS (CriOS)" },
  { ua: FIREFOX_MACOS, expected: "manual", label: "Firefox on macOS" },
  { ua: FIREFOX_WINDOWS, expected: "manual", label: "Firefox on Windows" },
  { ua: FIREFOX_LINUX, expected: "manual", label: "Firefox on Linux" },
  { ua: SAFARI_IOS_IPHONE, expected: "ios-add-to-home", label: "Safari on iOS (iPhone)" },
  { ua: SAFARI_IOS_IPAD, expected: "ios-add-to-home", label: "Safari on iOS (iPad)" },
  { ua: SAFARI_IOS_IPOD, expected: "ios-add-to-home", label: "Safari on iOS (iPod touch)" },
  { ua: SAFARI_MACOS, expected: "manual", label: "Safari on macOS" },
  { ua: UNKNOWN_BROWSER, expected: "manual", label: "Unknown browser" },
  { ua: "", expected: "manual", label: "Empty UA string" },
];

describe("detectSupport", () => {
  it.each(fixtures)("$label → $expected", ({ ua, expected }: Fixture) => {
    expect(detectSupport(ua)).toBe(expected);
  });

  it("is case-insensitive (uppercase UA string)", () => {
    expect(detectSupport(CHROME_MACOS.toUpperCase())).toBe("supported");
  });

  it("treats Chrome/mobile as manual (no beforeinstallprompt on mobile Chrome)", () => {
    expect(detectSupport(CHROME_ANDROID)).toBe("manual");
  });
});
