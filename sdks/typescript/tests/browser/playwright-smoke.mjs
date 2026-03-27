import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { chromium } from "playwright";
import { createServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sdkRoot = path.resolve(__dirname, "..", "..");

let browser;
let page;
let viteServer;

try {
  viteServer = await createServer({
    root: sdkRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: false,
    },
  });
  await viteServer.listen();
  const localUrl = viteServer.resolvedUrls?.local?.[0];
  if (!localUrl) {
    throw new Error("Vite server failed to provide local URL");
  }

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error);
  });

  await page.goto(`${localUrl}tests/browser/fixtures/smoke.html`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => {
    const state = document.getElementById("status")?.dataset.status;
    return state === "ok" || state === "error";
  });

  const status = await page.$eval("#status", (el) => ({
    state: el.dataset.status,
    text: el.textContent ?? "",
  }));

  if (status.state !== "ok") {
    throw new Error(`Browser smoke status=${status.state}: ${status.text}`);
  }
  if (pageErrors.length > 0) {
    throw pageErrors[0];
  }
} catch (error) {
  console.error("Playwright browser smoke test failed");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (page) await page.close();
  if (browser) await browser.close();
  if (viteServer) await viteServer.close();
}

if (!process.exitCode) {
  console.log("Playwright browser smoke test passed");
}
