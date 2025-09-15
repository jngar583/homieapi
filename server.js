import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const CONCURRENT_LIMIT = 3;

// Endpoint to extract real URLs from a movie page
app.get("/extract", async (req, res) => {
  const movieUrl = req.query.url;
  if (!movieUrl) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(movieUrl, { waitUntil: "networkidle" });

    // Get all UsersDrive & Megaup links
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

    console.log(`Found ${filteredLinks.length} UsersDrive/Megaup links`);

    // Extract real URL from AdsFly
    async function extractRealUrl(adsLink) {
      const adPage = await browser.newPage();
      let finalUrl = null;

      // Listen for AdsFly API response
      adPage.on("response", async response => {
        if (response.url().includes("/get-real-url") && response.request().method() === "POST") {
          try {
            const data = await response.json();
            finalUrl = data.url;
          } catch (err) {
            console.log("Failed parsing JSON for:", adsLink);
          }
        }
      });

      try {
        await adPage.goto(adsLink, { waitUntil: "networkidle", timeout: 60000 });
        await adPage.waitForTimeout(5000);

        // Click 'Create Download Link' button if exists
        const btn = await adPage.$("button.bg-red-600");
        if (btn) {
          await btn.click();
          await adPage.waitForTimeout(3000);
        }
      } catch (err) {
        console.log("Error fetching real URL for", adsLink, err.message);
      } finally {
        await adPage.close();
      }

      return finalUrl;
    }

    // Process links in batches
    const results = [];
    for (let i = 0; i < filteredLinks.length; i += CONCURRENT_LIMIT) {
      const batch = filteredLinks.slice(i, i + CONCURRENT_LIMIT);
      const batchResults = await Promise.all(
        batch.map(l => extractRealUrl(l.href).then(url => ({ type: l.type, url })))
      );
      results.push(...batchResults);
    }

    await browser.close();

    // Return JSON
    res.json({ movieUrl, results });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server running on port ${PORT}`);
});
