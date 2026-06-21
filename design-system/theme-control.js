/* ============================================================
   Keiko DS — appearance + contrast control
   Upgrades the legacy 2-way theme toggle into a first-class
   Appearance (Dark / Light) + Contrast (Auto / High) control.

   State model
     • keiko-ds-theme    : "dark" | "light"        → html[data-theme]
     • keiko-ds-contrast : "auto" | "more"         → html[data-hc="more"] when "more"
   "Auto" follows the OS via @media (prefers-contrast: more); "High" forces it.
   Pre-paint application happens inline in each page <head>; this file only
   builds the UI and keeps it in sync, so there is never a flash.
   ============================================================ */
(function () {
  "use strict";
  var THEME_KEY = "keiko-ds-theme";
  var CONTRAST_KEY = "keiko-ds-contrast";
  var root = document.documentElement;

  var ICON = {
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 13.5 A8 8 0 1 1 10.5 4.2 a6.5 6.5 0 0 0 9.3 9.1"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5 V5 M12 19 V21.5 M2.5 12 H5 M19 12 H21.5 M5.1 5.1 L6.9 6.9 M17.1 17.1 l1.8 1.8 M18.9 5.1 L17.1 6.9 M6.9 17.1 L5.1 18.9"/></svg>',
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6 v16.8" /><path d="M12 3.6 a8.4 8.4 0 0 1 0 16.8 z" fill="currentColor" stroke="none"/></svg>',
    high: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6 a8.4 8.4 0 0 0 0 16.8 z" fill="currentColor" stroke="none"/></svg>'
  };

  function readTheme() {
    try { var t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch {}
    return root.dataset.theme === "light" ? "light" : "dark";
  }
  function readContrast() {
    try { var c = localStorage.getItem(CONTRAST_KEY); if (c === "more" || c === "auto") return c; } catch {}
    return root.dataset.hc === "more" ? "more" : "auto";
  }
  function store(key, val) { try { localStorage.setItem(key, val); } catch {} }

  var osHC = null;
  try { osHC = window.matchMedia("(prefers-contrast: more)"); } catch {}

  function applyTheme(t) {
    root.dataset.theme = t;
    store(THEME_KEY, t);
    // keep legacy label spans (if any survive) in sync
    var l = t === "light";
    document.querySelectorAll("[data-theme-label]").forEach(function (e) { e.textContent = l ? "Light" : "Dark"; });
  }
  function applyContrast(c) {
    if (c === "more") root.dataset.hc = "more"; else root.removeAttribute("data-hc");
    store(CONTRAST_KEY, c);
  }

  /* Back-compat globals — the per-page inline copies of these were removed and
     centralised here. ds-nav.js's fallback toggle calls window.dsToggleTheme. */
  window.dsToggleTheme = function () { applyTheme(readTheme() === "light" ? "dark" : "light"); };
  window.dsSyncToggle = function () {
    var l = root.dataset.theme === "light";
    document.querySelectorAll("[data-theme-label]").forEach(function (e) { e.textContent = l ? "Light" : "Dark"; });
  };

  function seg(labelText, ariaLabel, opts) {
    var row = document.createElement("div");
    row.className = "tc-row";
    var label = document.createElement("span");
    label.className = "tc-label";
    label.textContent = labelText;
    var group = document.createElement("div");
    group.className = "tc-seg";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", ariaLabel);
    row.appendChild(label);
    row.appendChild(group);

    var buttons = [];
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tc-opt";
      b.setAttribute("role", "radio");
      b.dataset.val = o.val;
      b.innerHTML = (o.icon ? ICON[o.icon] : "") + "<span>" + o.label + "</span>";
      b.setAttribute("aria-label", o.aria || o.label);
      b.addEventListener("click", function () { select(o.val); });
      group.appendChild(b);
      buttons.push(b);
    });

    function paint(active) {
      buttons.forEach(function (b) {
        var on = b.dataset.val === active;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
    }
    function select(val, focus) {
      paint(val);
      opts.forEach(function (o) { if (o.val === val) o.onpick(); });
      if (focus) buttons.forEach(function (b) { if (b.dataset.val === val) b.focus(); });
    }
    // roving focus with arrow keys
    group.addEventListener("keydown", function (e) {
      var idx = buttons.findIndex(function (b) { return b.getAttribute("aria-checked") === "true"; });
      if (idx < 0) idx = 0;
      var next;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % buttons.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = buttons.length - 1;
      else return;
      e.preventDefault();
      select(buttons[next].dataset.val, true);
    });

    return { row: row, paint: paint, buttons: buttons };
  }

  function build() {
    var legacy = document.querySelector(".theme-toggle");
    var control = document.createElement("div");
    control.className = "theme-control";
    control.setAttribute("role", "group");
    control.setAttribute("aria-label", "Appearance and contrast");

    var appearance = seg("Appearance", "Appearance", [
      { val: "dark", label: "Dark", icon: "moon", aria: "Dark appearance", onpick: function () { applyTheme("dark"); } },
      { val: "light", label: "Light", icon: "sun", aria: "Light appearance", onpick: function () { applyTheme("light"); } }
    ]);
    var contrast = seg("Contrast", "Contrast", [
      { val: "auto", label: "Auto", icon: "auto", aria: "Contrast follows the operating system", onpick: function () { applyContrast("auto"); reflectOS(); } },
      { val: "more", label: "High", icon: "high", aria: "High contrast", onpick: function () { applyContrast("more"); reflectOS(); } }
    ]);

    control.appendChild(appearance.row);
    control.appendChild(contrast.row);

    if (legacy && legacy.parentNode) legacy.parentNode.replaceChild(control, legacy);
    else {
      var nav = document.querySelector(".nav .nav-foot") || document.querySelector(".nav");
      if (nav && nav.parentNode) nav.parentNode.insertBefore(control, nav);
    }

    appearance.paint(readTheme());
    contrast.paint(readContrast());

    // mark the High pill when Auto currently resolves to high via the OS
    function reflectOS() {
      var highBtn = contrast.buttons.find(function (b) { return b.dataset.val === "more"; });
      var isAuto = readContrast() === "auto";
      var osOn = osHC && osHC.matches;
      if (highBtn) highBtn.setAttribute("data-os-resolved", (isAuto && osOn) ? "true" : "false");
    }
    reflectOS();
    if (osHC && osHC.addEventListener) osHC.addEventListener("change", reflectOS);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
