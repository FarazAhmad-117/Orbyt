// Builds manifest.json: template slug, marketplace URL and live preview URL, from the SaaS / AI / Software categories.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(
  "e:/Courses/Web Development/Indepth Solution/Orbyt/e2e/package.json",
);
const { chromium } = require("@playwright/test");
const PER_CATEGORY = 24;
const b = await chromium.launch();
const p = await (
  await b.newContext({ viewport: { width: 1440, height: 900 } })
).newPage();
const seen = new Map();
for (const cat of ["saas", "ai", "software"]) {
  await p.goto(
    `https://www.framer.com/marketplace/templates/categories/${cat}/`,
    { waitUntil: "domcontentloaded", timeout: 60000 },
  );
  await p.waitForTimeout(3000);
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, 3000);
    await p.waitForTimeout(700);
  }
  const links = await p.$$eval('a[href*="/marketplace/templates/"]', (as) =>
    [...new Set(as.map((a) => a.href))].filter(
      (h) =>
        !h.includes("/categories/") &&
        !h.includes("/tags/") &&
        !/templates\/?$/.test(h),
    ),
  );
  for (const l of links.slice(0, PER_CATEGORY))
    if (!seen.has(l)) seen.set(l, cat);
}
const out = [];
for (const [url, category] of seen) {
  try {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(1500);
    const preview = await p.$$eval(
      "a",
      (as) =>
        as
          .map((a) => a.href)
          .find((h) =>
            /^https:\/\/[^/]+\.framer\.(website|media|app)\/?/.test(h),
          ) ?? null,
    );
    const slug = url.split("/").filter(Boolean).pop();
    if (preview) out.push({ slug, category, marketplace: url, preview });
  } catch (e) {
    console.log("skip", url, e.message.slice(0, 60));
  }
}
writeFileSync("design-inspiration/manifest.json", JSON.stringify(out, null, 2));
console.log("manifest entries:", out.length);
await b.close();
