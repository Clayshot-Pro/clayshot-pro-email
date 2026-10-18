/*
 * theme-boot.js (v3.03) — applies the cached appearance before React mounts,
 * so the first paint already uses the right theme. Classic script (no
 * modules); it must be an external file because the CSP is script-src 'self'.
 *
 * localStorage["ltm:appearance"] = JSON {
 *   theme:    "ltm-dark" | "light" | "ltm-ember" | "graphite" | "high-contrast" | "system",
 *   accent:   "#rrggbb" (optional custom accent),
 *   density:  "compact" | "comfortable" | "spacious",
 *   textSize: "sm" | "md" | "lg" | "xl"
 * }
 *
 * Sets on <html>: data-theme, data-density, data-text-size, data-custom-accent
 * plus the inline custom property --user-accent, then copies the active
 * theme's --color-bg into <meta name="theme-color">. Never throws. The only
 * global it exposes is window.__ltmApplyAppearance(appearance), which React
 * can call with the same object shape to apply a change immediately.
 */
(function () {
  "use strict";
  var STORAGE_KEY = "ltm:appearance";
  var DEFAULT_THEME = "ltm-dark";
  var DENSITIES = { compact: 1, spacious: 1 };
  var TEXT_SIZES = { sm: 1, lg: 1, xl: 1 };
  var systemQuery = null;
  var current = null;

  function prefersLight() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    } catch (e) {
      return false;
    }
  }

  function resolveTheme(theme) {
    if (theme === "system") return prefersLight() ? "light" : DEFAULT_THEME;
    if (typeof theme === "string" && /^[a-z0-9-]{1,40}$/.test(theme)) return theme;
    return DEFAULT_THEME;
  }

  function syncThemeColor() {
    try {
      var root = document.documentElement;
      var bg = window.getComputedStyle(root).getPropertyValue("--color-bg").trim();
      if (!bg) return;
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", bg);
    } catch (e) { /* ignore */ }
  }

  function setOrRemove(root, name, value) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }

  function apply(appearance) {
    try {
      var a = appearance && typeof appearance === "object" ? appearance : {};
      var root = document.documentElement;
      current = a;
      root.setAttribute("data-theme", resolveTheme(a.theme));
      setOrRemove(root, "data-density", typeof a.density === "string" && DENSITIES[a.density] ? a.density : null);
      setOrRemove(root, "data-text-size", typeof a.textSize === "string" && TEXT_SIZES[a.textSize] ? a.textSize : null);
      if (typeof a.accent === "string" && /^#[0-9a-f]{6}$/i.test(a.accent)) {
        root.style.setProperty("--user-accent", a.accent);
        root.setAttribute("data-custom-accent", "");
      } else {
        root.style.removeProperty("--user-accent");
        root.removeAttribute("data-custom-accent");
      }
      watchSystem(a.theme === "system");
      syncThemeColor();
    } catch (e) { /* never block start-up */ }
  }

  function onSystemChange() {
    if (current && current.theme === "system") apply(current);
  }

  function watchSystem(enabled) {
    try {
      if (!window.matchMedia) return;
      if (!systemQuery) systemQuery = window.matchMedia("(prefers-color-scheme: light)");
      if (enabled) {
        if (systemQuery.addEventListener) systemQuery.addEventListener("change", onSystemChange);
        else if (systemQuery.addListener) systemQuery.addListener(onSystemChange);
      } else if (systemQuery.removeEventListener) {
        systemQuery.removeEventListener("change", onSystemChange);
      } else if (systemQuery.removeListener) {
        systemQuery.removeListener(onSystemChange);
      }
    } catch (e) { /* ignore */ }
  }

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  try {
    window.__ltmApplyAppearance = apply;
    apply(readStored());
    // Stylesheets may not be loaded yet when this runs in <head>; copy the
    // theme colour again once they are.
    document.addEventListener("DOMContentLoaded", syncThemeColor);
    window.addEventListener("load", syncThemeColor);
  } catch (e) { /* ignore */ }
})();
