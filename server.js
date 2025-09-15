import express from "express";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const CONCURRENT_LIMIT = 3;

// Scrape.do config for Megaup
const SCRAPEDO_TOKENS = [
  "5f14c66712634bb88ba892deeba5a88a64a5bc965af",
  "427b4070e35b4f1082863d76f3da9352e80359162e7",
  "ec01e25abc1c4f7bba671cff8a47367cc0b04432d3d",
  "2626a5fb41e54669809005d73472cccd095e917f969",
];
const SCRAPEDO_URL = "http://api.scrape.do/";

// Helper for Megaup scrape.do
function getRandomToken() {
  return SCRAPEDO_TOKENS[Math.floor(Math.random() * SCRAPEDO_TOKENS.length)];
}

async function scrapeDoRequest(targetUrl, maxAttempts = 5) {
  const triedTokens = new Set();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let token = getRandomToken();
    while (triedTokens.has(token) && triedTokens.size < SCRAPEDO_TOKENS.length) {
      token = getRandomToken();
    }
    triedTokens.add(token);

    const encodedUrl = encodeURIComponent(targetUrl);
    const url = `${SCRAPEDO_URL}?token=${token}&url=${encodedUrl}&render=True`;
    try {
      const r = await fetch(url, { timeout: 60000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      return text;
    } catch (e) {
      if (attempt === maxAttempts) return "";
    }
  }
  return "";
}

// Megaup resolver
async function resolveMegaupLink(megaUrl) {
  try {
    const r = await fetch(megaUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await r.text();
    const m = text.match(/href='(https:\/\/download\.megaup\.net[^']+)'/);
    if (!m) return megaUrl;
    const intermediateLink = m[1];
    const html2 = await scrapeDoRequest(intermediateLink);
    const mFinal = html2.match(/href="(https:\/\/megadl\.boats\/download\/[^"]+)"/);
    return mFinal ? mFinal[1] : intermediateLink;
  } catch (e) {
    return megaUrl;
  }
}

// UsersDrive resolver via Playwright
async function resolveUsersDriveLink(usersUrl, browser) {
  const page = await browser.newPage();
  try {
    await page.goto(usersUrl, { waitUntil: "networkidle", timeout: 120000 });

    // Wait for create download button
    await page.waitForSelector("#downloadbtn", { timeout: 60000 });
    await page.click("#downloadbtn");

    // Wait for final download link
    await page.waitForSelector("a.btn.btn-download", { timeout: 60000 });
    const downloadLink = await page.getAttribute("a.btn.btn-download", "href");
    return downloadLink || usersUrl;
  } catch (e) {
    console.log("UsersDrive resolver error:", e.message);
    return usersUrl;
  } finally {
    await page.close();
  }
}

// Main endpoint
app.get("/extract", async (req, res) => {
  const movieUrl = req.query.url;
  if (!movieUrl) return res.status(400).json({ error: "Missing 'url' query parameter" });

  const results = [];
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(movieUrl, { waitUntil: "networkidle" });

    // Get UsersDrive & Megaup links
    const filteredLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll("tbody tr").forEach(tr => {
        const a = tr.querySelector("a.text-blue-400");
        if (a) {
          const text = a.textContent.trim().toLowerCase();
          if (text.includes("usersdrive") || text.includes("megaup")) {
            links.push({ href: a.href, type: text });
          }
        }
      });
      return links;
    });

    // Process in batches
    for (let i = 0; i < filteredLinks.length; i += CONCURRENT_LIMIT) {
      const batch = filteredLinks.slice(i, i + CONCURRENT_LIMIT);
      const batchResults = await Promise.all(batch.map(async l => {
        if (l.type.includes("usersdrive")) {
          const url = await resolveUsersDriveLink(l.href, browser);
          return { type: "UsersDrive", url };
        } else if (l.type.includes("megaup")) {
          const url = await resolveMegaupLink(l.href);
          return { type: "Megaup", url };
        }
        return null;
      }));
      results.push(...batchResults.filter(Boolean));
    }

    res.json({ movieUrl, results });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Internal server error", details: e.message });
  } finally {
    await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server running on port ${PORT}`);
});
