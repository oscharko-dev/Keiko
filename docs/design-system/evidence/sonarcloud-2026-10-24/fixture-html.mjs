import { JSDOM } from "jsdom";

// This projects local QA fixtures, not arbitrary HTML for a product surface. Browser requests are
// blocked by the owning producers. The Git layout comparison also disables page JavaScript; the
// SVG producer permits its injected axe/measurement code and the grid's owned inline handlers.
export function projectFixtureHtml(source, { scriptSelector = "script", readStylesheet } = {}) {
  const dom = new JSDOM(source);
  try {
    const document = dom.window.document;
    for (const script of document.querySelectorAll(scriptSelector)) script.remove();
    if (readStylesheet !== undefined) {
      for (const link of document.querySelectorAll('link[rel~="stylesheet" i]')) {
        const name = link.getAttribute("href");
        if (name === null || !/^[A-Za-z0-9_-]+\.css$/u.test(name)) {
          throw new TypeError("Fixture stylesheets must use a local CSS filename.");
        }
        const css = readStylesheet(name);
        if (typeof css !== "string") throw new TypeError("Fixture stylesheets must contain text.");
        const style = document.createElement("style");
        style.textContent = css;
        const media = link.getAttribute("media");
        if (media !== null) style.setAttribute("media", media);
        link.replaceWith(style);
      }
    }
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}
