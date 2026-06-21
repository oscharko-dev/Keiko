/* ============================================================
   ds-nav.js — single source of truth for the Keiko DS sidebar nav.
   Each page ships an empty <nav class="nav" data-ds-nav></nav> followed
   by <script src="ds-nav.js"></script>; this fills it and marks the
   current page active (derived from the file name). Removes the per-page
   nav duplication that used to drift. The .theme-toggle it renders is
   upgraded in place by theme-control.js.
   ============================================================ */
(function () {
  "use strict";
  var GROUPS = [
    { label: "Overview", items: [["index.html", "Start here"]] },
    { label: "Foundations", items: [
      ["foundations.html", "Foundations"],
      ["Keiko Icon System.html", "Icons &middot; Lift"],
      ["motion.html", "Motion"],
      ["accessibility.html", "Accessibility"],
      ["a11y-audit.html", "Measured Contrast"],
      ["content.html", "Content &amp; Voice"]
    ] },
    { label: "Components", items: [
      ["components.html", "Components"],
      ["inputs.html", "Inputs &amp; Forms"],
      ["nav-components.html", "Navigation"],
      ["data-grid.html", "Table &amp; Data Grid"],
      ["ai-components.html", "AI &amp; Agent"],
      ["messages.html", "Messages &amp; Feedback"],
      ["states.html", "States"],
      ["dataviz.html", "Data Visualisation"]
    ] },
    { label: "Patterns", items: [
      ["patterns.html", "Patterns"],
      ["flows.html", "Flows"]
    ] },
    { label: "Editor", items: [
      ["editor-theme.html", "Theme &amp; Syntax"],
      ["editor-chrome.html", "Chrome &amp; Tabs"],
      ["editor-gutter.html", "Gutter"],
      ["editor-navigation.html", "Navigation &amp; Search"],
      ["editor-panels.html", "Tool Windows"],
      ["editor-markdown.html", "Markdown Views"],
      ["editor-agent.html", "Agent in Editor"]
    ] },
    { label: "Review", items: [
      ["audit.html", "System Audit"],
      ["governance.html", "Governance &amp; Docs"]
    ] }
  ];

  var THEME_TOGGLE =
    '<button class="theme-toggle" type="button" onclick="dsToggleTheme &amp;&amp; dsToggleTheme()" aria-label="Toggle colour theme">' +
      '<span class="ti">' +
        '<svg class="ti-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 13.5 A8 8 0 1 1 10.5 4.2 a6.5 6.5 0 0 0 9.3 9.1"/></svg>' +
        '<svg class="ti-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5 V5 M12 19 V21.5 M2.5 12 H5 M19 12 H21.5 M5.1 5.1 L6.9 6.9 M17.1 17.1 l1.8 1.8 M18.9 5.1 L17.1 6.9 M6.9 17.1 L5.1 18.9"/></svg>' +
      '</span>' +
      '<span class="tspace">Theme</span><span data-theme-label>Dark</span>' +
    '</button>';

  function current() {
    var path = location.pathname;
    var file = path.substring(path.lastIndexOf("/") + 1);
    try { file = decodeURIComponent(file); } catch (e) {}
    if (!file) file = "index.html";
    return file;
  }

  function build(nav) {
    var here = current();
    var html =
      '<a class="nav-brand" href="index.html"><img src="assets/keiko-logo.svg" alt="Keiko logo" />' +
      '<span><span class="bt">Keiko</span><span class="bs">Design System</span></span></a>';
    GROUPS.forEach(function (g) {
      html += '<div class="nav-label">' + g.label + "</div>";
      g.items.forEach(function (it) {
        var href = it[0], label = it[1];
        var on = href === here;
        html += '<a class="nav-item' + (on ? " on" : "") + '" href="' + href + '"' +
          (on ? ' aria-current="page"' : "") + '><span class="ni-dot"></span>' + label + "</a>";
      });
    });
    html += THEME_TOGGLE;
    html += '<div class="nav-foot">Keiko · v0.4.0</div>';
    nav.innerHTML = html;
    nav.setAttribute("aria-label", "Design system");
  }

  var nav = document.querySelector("nav.nav[data-ds-nav]") || document.querySelector("nav.nav");
  if (nav) build(nav);
})();
