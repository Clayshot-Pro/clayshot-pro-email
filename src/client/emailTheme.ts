/**
 * Native reader for HTML email (v3.11). After the sandboxed email document
 * loads, the reader inspects its computed styles:
 *
 * - "native": ordinary mail (no designed backgrounds) is shown in the app's
 *   own theme: transparent background, app font, and only the colours that
 *   would be unreadable on the theme's background are replaced.
 * - "paper": designed mail (newsletters, receipts with coloured or image
 *   backgrounds) keeps its own colours on a light card, as native mail apps
 *   do, because recolouring it would break its contrast.
 *
 * Colour helpers are pure; classifyEmail and applyNativeColors work on any Document.
 */
export type Rgba = { r: number; g: number; b: number; a: number };
/** `scheme` is the app's color-scheme: the email must match it, or the browser paints the frame on an opaque canvas. */
export type EmailTheme = { text: string; link: string; background: string; font: string; scheme: string };
export type EmailMode = "native" | "paper";

const NAMED: Record<string, string> = {
  black: "#000", white: "#fff", red: "#f00", green: "#008000", blue: "#00f", navy: "#000080", gray: "#808080",
  grey: "#808080", silver: "#c0c0c0", maroon: "#800000", purple: "#800080", teal: "#008080", olive: "#808000",
  orange: "#ffa500", yellow: "#ff0", lime: "#0f0", aqua: "#0ff", fuchsia: "#f0f", transparent: "#0000",
};

export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  let text = value.trim().toLowerCase();
  if (NAMED[text]) text = NAMED[text];
  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map(d => d + d).join("");
    if (digits.length !== 6 && digits.length !== 8) return null;
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: alpha };
  }
  return null;
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Paint-wise invisible, or white/near-white paper that ordinary mail uses as a default. */
export const isClear = (c: Rgba | null) => !c || c.a < 0.05;
export const isNearWhite = (c: Rgba) => c.a >= 0.05 && c.r >= 240 && c.g >= 240 && c.b >= 240;

/** Readable text needs 4.5:1; anything lower is replaced with the theme colour. */
export const READABLE = 4.5;
/** Coloured backgrounds covering this share of the email make it "designed". */
const DESIGNED_AREA = 0.2;

/** "paper" for designed mail (background images, or coloured backgrounds over a real part of it), else "native". */
export function classifyEmail(doc: Document): EmailMode {
  const view = doc.defaultView;
  const body = doc.body;
  if (!view || !body) return "paper";
  const bodyArea = Math.max(1, body.scrollWidth * body.scrollHeight);
  let colouredArea = 0;
  for (const element of [body, ...Array.from(body.querySelectorAll<HTMLElement>("*"))]) {
    const style = view.getComputedStyle(element);
    if (style.backgroundImage && style.backgroundImage !== "none") return "paper";
    const background = parseColor(style.backgroundColor);
    // Small badges and buttons do not make an email "designed".
    if (!isClear(background) && !isNearWhite(background!)) {
      // SVG elements have no offset box; they count as no area.
      colouredArea += (element.offsetWidth || 0) * (element.offsetHeight || 0);
      if (colouredArea / bodyArea > DESIGNED_AREA) return "paper";
    }
  }
  return "native";
}

/**
 * Native mode: drop white "paper" backgrounds and replace only the text
 * colours that would be unreadable on what is actually behind them.
 */
export function applyNativeColors(doc: Document, theme: EmailTheme): void {
  const view = doc.defaultView;
  const body = doc.body;
  if (!view || !body) return;
  const page = parseColor(theme.background) ?? { r: 18, g: 18, b: 18, a: 1 };
  const text = parseColor(theme.text);
  const link = parseColor(theme.link);
  // Decide from the original styles first, then write, so an element never
  // sees its parent's already-adapted colour as its own.
  const writes: Array<() => void> = [];
  const behindOf = new Map<Element, Rgba>();
  for (const element of [body, ...Array.from(body.querySelectorAll<HTMLElement>("*"))]) {
    const style = view.getComputedStyle(element);
    const own = parseColor(style.backgroundColor);
    let behind = (element.parentElement && behindOf.get(element.parentElement)) || page;
    if (!isClear(own)) {
      if (isNearWhite(own!)) writes.push(() => element.style.setProperty("background-color", "transparent", "important"));
      else behind = own!;
    }
    behindOf.set(element, behind);
    const colour = parseColor(style.color);
    if (colour && contrast(colour, behind) < READABLE && text && contrast(text, behind) >= READABLE) {
      const replacement = element.closest("a") && link && contrast(link, behind) >= READABLE ? theme.link : theme.text;
      writes.push(() => element.style.setProperty("color", replacement, "important"));
    }
  }
  for (const write of writes) write();
}

/** Base styles for the email document in each mode (fonts, link colour, spacing). */
export function emailBaseStyles(mode: EmailMode, theme: EmailTheme): string {
  // The reader sizes the frame to the document, so the document must size to its content.
  const sizing = "html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }";
  // Unstyled text uses the app font instead of the browser's serif default.
  const font = `body { font: 14px/1.6 ${theme.font}; }`;
  if (mode === "paper") return `${sizing} ${font} :root { color-scheme: light; } html, body { background: #fff !important; } body { padding: 16px !important; color: #1f1f1f; }`;
  return `${sizing} ${font} :root { color-scheme: ${theme.scheme}; } html, body { background: transparent !important; } body { color: ${theme.text}; } a { color: ${theme.link}; }`;
}

/** Wide fixed-width mail (600px newsletters on a phone) is scaled down to fit, as mail apps do. */
export function fitEmailWidth(doc: Document): number {
  const body = doc.body;
  const available = doc.documentElement.clientWidth;
  body.style.removeProperty("zoom");
  const natural = Math.max(body.scrollWidth, doc.documentElement.scrollWidth);
  const scale = available > 0 && natural > available + 1 ? Math.max(0.3, available / natural) : 1;
  if (scale < 1) body.style.setProperty("zoom", String(scale));
  return scale;
}
