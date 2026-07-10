export interface FeedbackReservedWindow {
  opener: unknown;
  close(): void;
  readonly document: Document;
  readonly location: { replace(url: string): void };
}

export type FeedbackPublicWindowOpener = () => FeedbackReservedWindow | null;

export interface FeedbackPublicWindowContent {
  readonly language: string | undefined;
  readonly status: string;
  readonly title: string;
}

interface HeldReservation {
  readonly generation: number;
  readonly window: FeedbackReservedWindow;
}

function closeWindow(window: FeedbackReservedWindow): void {
  try {
    window.close();
  } catch {
    // Closing a failed reservation is best-effort and never exposes payload details.
  }
}

export function reserveFeedbackPublicWindow(): FeedbackReservedWindow | null {
  return window.open("about:blank", "_blank");
}

function validLanguage(language: string | undefined): language is string {
  return (
    language !== undefined &&
    language.length <= 35 &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language)
  );
}

export function initializeFeedbackPublicWindow(
  window: FeedbackReservedWindow,
  content: FeedbackPublicWindowContent,
): boolean {
  try {
    const document = window.document;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    status.textContent = content.status;
    document.title = content.title;
    if (validLanguage(content.language)) document.documentElement.lang = content.language;
    document.body.replaceChildren(status);
    return true;
  } catch {
    closeWindow(window);
    return false;
  }
}

export function isolateFeedbackPublicWindow(window: FeedbackReservedWindow): boolean {
  try {
    window.opener = null;
    return true;
  } catch {
    closeWindow(window);
    return false;
  }
}

export class FeedbackPublicWindowGuard {
  private digest: string | undefined;
  private generation = 0;
  private inFlight = false;
  private reservation: HeldReservation | undefined;

  public activate(digest: string): void {
    this.closeReservation();
    this.digest = digest;
    this.generation += 1;
    this.inFlight = false;
  }

  public deactivate(): void {
    this.closeReservation();
    this.digest = undefined;
    this.generation += 1;
    this.inFlight = false;
  }

  public begin(digest: string): number | undefined {
    if (this.inFlight || this.digest !== digest) return undefined;
    this.inFlight = true;
    this.generation += 1;
    return this.generation;
  }

  public current(digest: string, generation: number): boolean {
    return this.digest === digest && this.generation === generation;
  }

  public finish(digest: string, generation: number): boolean {
    if (!this.current(digest, generation)) return false;
    this.inFlight = false;
    return true;
  }

  public hold(digest: string, generation: number, window: FeedbackReservedWindow): boolean {
    if (!this.current(digest, generation)) {
      closeWindow(window);
      return false;
    }
    this.reservation = { generation, window };
    return true;
  }

  public closeHeld(generation: number): void {
    if (this.reservation?.generation !== generation) return;
    this.closeReservation();
  }

  public release(generation: number): void {
    if (this.reservation?.generation === generation) this.reservation = undefined;
  }

  private closeReservation(): void {
    const held = this.reservation;
    this.reservation = undefined;
    if (held !== undefined) closeWindow(held.window);
  }
}
