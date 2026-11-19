// Usage: node design-inspiration/capture.mjs <shardIndex> <shardCount> [slug]
// Takes full-page desktop (1440w) and mobile (390w) screenshots of each template's public preview.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
const require = createRequire(
  "e:/Courses/Web Development/Indepth Solution/Orbyt/e2e/package.json",
);
const { chromium } = require("@playwright/test");
const [shard = "0", count = "1", only] = process.argv.slice(2);
const all = JSON.parse(
  readFileSync("design-inspiration/manifest.json", "utf8"),
);
const mine = only
  ? all.filter((t) => t.slug === only)
  : all.filter((_, i) => i % Number(count) === Number(shard));
const MAX_H = 15000; // chromium caps a screenshot at 16384px
const b = await chromium.launch();
for (const t of mine) {
  const dir = `design-inspiration/shots/${t.slug}`;
  mkdirSync(dir, { recursive: true });
  for (const [name, w, h, mobile] of [
    ["desktop", 1440, 900, false],
    ["mobile", 390, 844, true],
  ]) {
    if (existsSync(`${dir}/${name}.png`)) continue;
    const ctx = await b.newContext({
      viewport: { width: w, height: h },
      isMobile: mobile,
      hasTouch: mobile,
      deviceScaleFactor: 1,
    });
    const p = await ctx.newPage();
    try {
      await p.goto(t.preview, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await p.waitForTimeout(3500);
      // scroll down in steps so lazy content and appear-animations fire, then return to the top
      const total = await p.evaluate(
        () => document.documentElement.scrollHeight,
      );
      for (let y = 0; y < Math.min(total, MAX_H); y += 600) {
        await p.evaluate((v) => window.scrollTo(0, v), y);
        await p.waitForTimeout(250);
      }
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(800);
      const height = Math.min(
        await p.evaluate(() => document.documentElement.scrollHeight),
        MAX_H,
      );
      await p.screenshot({
        path: `${dir}/${name}.png`,
        clip: { x: 0, y: 0, width: w, height },
        fullPage: true,
      });
      console.log("ok", t.slug, name, height);
    } catch (e) {
      console.log("FAIL", t.slug, name, e.message.slice(0, 80));
    }
    await ctx.close();
  }
}
await b.close();
