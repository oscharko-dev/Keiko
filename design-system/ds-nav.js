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
    {
      label: "Foundations",
      items: [
        ["foundations.html", "Foundations"],
        ["Keiko Icon System.html", "Icons &middot; Lift"],
        ["motion.html", "Motion"],
        ["accessibility.html", "Accessibility"],
        ["a11y-audit.html", "Measured Contrast"],
        ["content.html", "Content &amp; Voice"],
      ],
    },
    {
      label: "Components",
      items: [
        ["components.html", "Components"],
        ["inputs.html", "Inputs &amp; Forms"],
        ["nav-components.html", "Navigation"],
        ["data-grid.html", "Table &amp; Data Grid"],
        ["ai-components.html", "AI &amp; Agent"],
        ["messages.html", "Messages &amp; Feedback"],
        ["states.html", "States"],
        ["dataviz.html", "Data Visualisation"],
      ],
    },
    {
      label: "Patterns",
      items: [
        ["patterns.html", "Patterns"],
        ["flows.html", "Flows"],
        ["git-window.html", "Git Window"],
      ],
    },
    {
      label: "Editor",
      items: [
        ["editor-theme.html", "Theme &amp; Syntax"],
        ["editor-chrome.html", "Chrome &amp; Tabs"],
        ["editor-gutter.html", "Gutter"],
        ["editor-navigation.html", "Navigation &amp; Search"],
        ["editor-panels.html", "Tool Windows"],
        ["editor-markdown.html", "Markdown Views"],
        ["editor-agent.html", "Agent in Editor"],
      ],
    },
    {
      label: "Review",
      items: [
        ["audit.html", "System Audit"],
        ["governance.html", "Governance &amp; Docs"],
      ],
    },
  ];

  /* Moon/sun geometry is sourced from lift-glyphs.js (window.LiftGlyph), the single
     source of truth for icon paths — see KEIKO-0911. lift-glyphs.js is required to
     load before this script on every page that renders the nav (checked/ordered in
     each page's <head>/<body>), so window.LiftGlyph is always available here. */
  var THEME_TOGGLE =
    '<button class="theme-toggle" type="button" onclick="dsToggleTheme &amp;&amp; dsToggleTheme()" aria-label="Toggle colour theme">' +
    '<span class="ti">' +
    '<span class="ti-moon">' +
    (window.LiftGlyph ? window.LiftGlyph.svg("moon", 16) : "") +
    "</span>" +
    '<span class="ti-sun">' +
    (window.LiftGlyph ? window.LiftGlyph.svg("sun", 16) : "") +
    "</span>" +
    "</span>" +
    '<span class="tspace">Theme</span><span data-theme-label>Dark</span>' +
    "</button>";

  function current() {
    var path = location.pathname;
    var file = path.substring(path.lastIndexOf("/") + 1);
    try {
      file = decodeURIComponent(file);
    } catch {}
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
        var href = it[0],
          label = it[1];
        var on = href === here;
        html +=
          '<a class="nav-item' +
          (on ? " on" : "") +
          '" href="' +
          href +
          '"' +
          (on ? ' aria-current="page"' : "") +
          '><span class="ni-dot"></span>' +
          label +
          "</a>";
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
