// Hostile HTML corpus through every layer the app uses: the Worker's
// sanitizer, the browser sanitizer, then the same sandboxed iframe (no
// scripts, restrictive CSP). Nothing may run and nothing may leave the page.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { launchBrowser, steps } from "./harness.mjs";

const SAME_ORIGIN = "http://sanitizer.test";
const PAYLOADS = [
  // CSS cannot reach the app's own image proxy or API while remote images are hidden.
  `<div style="background-image:url('${SAME_ORIGIN}/api/image-proxy?url=https%3A%2F%2Ftracker.test%2Fo')">x</div>`,
  `<style>.t{background:url("${SAME_ORIGIN}/api/image-proxy?url=https%3A%2F%2Ftracker.test%2Fs")}</style><div class=t>x</div>`,
  `<div style="background:url('${SAME_ORIGIN}/api/messages/m1?accountId=native%3Awork')">x</div>`,
  "<script>top.__x='script'</script>",
  "<img src=x onerror=\"top.__x='onerror'\">",
  "<svg onload=\"top.__x='svg'\"><circle r=1></svg>",
  "<body onload=\"top.__x='body'\"><p>hi</p></body>",
  "<a id=a href=\"javascript:top.__x='href'\">x</a>",
  "<a id=a href=\"&#x6A;avascript:top.__x='entity'\">x</a>",
  "<a id=a href=\"  JaVaScRiPt:top.__x='mixed'\">x</a>",
  "<a id=a href=\"data:text/html,<script>top.__x='data'</script>\">x</a>",
  "<iframe srcdoc=\"<script>top.__x='srcdoc'</script>\"></iframe>",
  "<object data=\"javascript:top.__x='object'\"></object><embed src=\"javascript:top.__x='embed'\">",
  "<math><mtext><table><mglyph><style><img src=x onerror=\"top.__x='mxss'\">",
  "<noscript><p title=\"</noscript><img src=x onerror=top.__x='noscript'>\"></p></noscript>",
  "<scr<script>ipt>top.__x='split'</scr</script>ipt>",
  "<details open ontoggle=\"top.__x='toggle'\"><summary>s</summary></details>",
  "<input autofocus onfocus=\"top.__x='focus'\">",
  "<form action=\"https://evil.test/\"><button formaction=\"javascript:top.__x='formaction'\">go</button></form>",
  "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.test/\">",
  "<base href=\"https://evil.test/\"><a href=\"/relative\">rel</a>",
  "<link rel=stylesheet href=\"https://evil.test/x.css\">",
  "<style>@import url('https://evil.test/import.css'); div { background: url('https://evil.test/bg.png') }</style><div>bg</div>",
  "<div style=\"background-image:url(https://evil.test/inline.png)\">inline bg</div>",
  "<img src=\"https://evil.test/pixel.png\"><img srcset=\"https://evil.test/a.png 1x\">",
  "<video poster=\"https://evil.test/poster.png\"></video><audio src=\"https://evil.test/a.mp3\"></audio>",
  "<table background=\"https://evil.test/table.png\"><tr><td>t</td></tr></table>",
  "<a href=\"https://example.com/ok\" ping=\"https://evil.test/ping\">tracked</a>",
  "<object data=\"https://evil.test/x.swf\"></object>",
  "<template><img src=x onerror=\"top.__x='template'\"></template>",
];

export async function run() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const leaks = [];
  try {
    const bundle = await build({
      stdin: {
        contents: `import { buildSafeEmailDocument } from "./src/client/emailHtml.ts";
import { sanitizeEmailHtml } from "./src/worker/email/html.ts";
window.render = html => buildSafeEmailDocument(sanitizeEmailHtml(html));`,
        resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts",
      },
      bundle: true, format: "iife", write: false, logLevel: "error",
    });
    const origin = "http://sanitizer.test";
    await page.route("**/*", route => {
      const url = route.request().url();
      if (url === `${origin}/`) {
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><body><script>${bundle.outputFiles[0].text}</script></body>` });
      }
      if (!url.startsWith("about:") && !url.startsWith("data:")) leaks.push(url);
      return route.abort();
    });
    await page.goto(`${origin}/`);

    const failed = await steps([
      ...PAYLOADS.map((payload, index) => [`payload ${index + 1}: ${payload.slice(0, 60)}`, async () => {
        const result = await page.evaluate(async html => {
          delete window.__x;
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
          frame.srcdoc = window.render(html);
          document.body.replaceChildren(frame);
          await new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
          await new Promise(resolve => setTimeout(resolve, 150));
          const doc = frame.contentDocument;
          doc.querySelectorAll("details").forEach(element => { element.open = !element.open; });
          doc.querySelector("input")?.focus();
          await new Promise(resolve => setTimeout(resolve, 100));
          const anchor = doc.querySelector("a");
          return {
            top: window.__x ?? null,
            frame: doc.defaultView?.__x ?? null,
            scripts: doc.querySelectorAll("script").length,
            handlers: [...doc.querySelectorAll("*")].flatMap(element => [...element.attributes].map(a => a.name)).filter(name => name.startsWith("on")),
            href: anchor?.getAttribute("href") ?? null,
            ping: anchor?.getAttribute("ping") ?? null,
            dangerous: doc.querySelectorAll("iframe,object,embed,form,meta[http-equiv]:not([http-equiv=\"Content-Security-Policy\"]),base,link,video,audio").length,
          };
        }, payload);
        assert.equal(result.top, null, "no script ran in the app");
        assert.equal(result.frame, null, "no script ran in the email");
        assert.equal(result.scripts, 0, "no script elements");
        assert.deepEqual(result.handlers, [], "no event handler attributes");
        if (result.href !== null) assert.doesNotMatch(result.href, /^\s*(javascript|vbscript|data):/i, "no script URLs in links");
        assert.equal(result.ping, null, "no link pings");
        assert.equal(result.dangerous, 0, "no frames, plugins, forms, refresh, base, stylesheets or media");
      }]),
      ["squeezed table layouts keep whole words at phone width (never one letter per line)", async () => {
        const layouts = [
          `<table style="width:100%"><tr><td style="width:520px">Main column text that should wrap normally.</td><td>Sidebar notes for the reader</td></tr></table>`,
          `<table width="600"><tr><td width="180">Logo</td><td>Your order has shipped and will arrive on Thursday.</td></tr></table>`,
          `<table width="100%"><tr><td width="95%">Wide</td><td>Receipt number and delivery details</td></tr></table>`,
        ];
        for (const html of layouts) {
          const charsPerLine = await page.evaluate(async source => {
            const frame = document.createElement("iframe");
            frame.style.width = "360px";
            frame.setAttribute("sandbox", "allow-same-origin");
            frame.srcdoc = window.render(source);
            document.body.replaceChildren(frame);
            await new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
            const doc = frame.contentDocument;
            let worst = Infinity;
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const text = node.textContent.trim();
              if (text.length < 4) continue;
              const range = doc.createRange();
              range.selectNodeContents(node);
              const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
              worst = Math.min(worst, text.length / lines);
            }
            return worst;
          }, html);
          assert.ok(charsPerLine >= 4, `${html.slice(0, 60)}… renders ${charsPerLine.toFixed(1)} characters per line`);
        }
      }],
      ["no request ever left the page", async () => {
        assert.deepEqual(leaks, [], "remote images, styles, frames and pings are all blocked");
      }],
    ], page);
    return failed;
  } finally {
    await browser.close();
  }
}
