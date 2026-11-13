// browser-loadgen: real Chromium sessions against the storefront, so Dash0 has many shopper sessions to compare.
// Each session gets a fresh browser context (so a new Dash0 session), signs in as one of the demo users, browses a
// few products, and usually checks out. The Dash0 Web SDK in the page records everything, as for a real shopper.

const { chromium, devices } = require("playwright");

const TARGET = (process.env.TARGET_URL || "http://shop-web.otel-workshop.svc.cluster.local").replace(/\/$/, "");
const PASSWORD = process.env.SHOPPER_PASSWORD || "maker-supply-demo";
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const PAUSE_SECONDS = Number(process.env.PAUSE_SECONDS || 5);

// The same accounts as mysql/10-init-sql.yaml (02-users.sql).
const USERS = ["ada", "bruno", "chiara", "dev", "elif", "finn", "grace", "hana", "ivan", "jules",
  "kemal", "lena", "mateo", "nadia", "oskar", "priya", "quinn", "rosa", "sami", "tomas"].map((n) => `${n}@example.com`);
// A mix of desktop and mobile Chrome. The device profiles also replace the "HeadlessChrome" user agent.
const PROFILES = [devices["Desktop Chrome"], devices["Desktop Chrome"], devices["Pixel 7"], devices["Galaxy S9+"]];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Time a shopper spends looking at a page.
const think = () => sleep(between(800, 3000));

function log(level, message, attrs = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: "browser-loadgen", message, ...attrs }));
}

async function signIn(page, email, password) {
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click("form.login-form button[type=submit]");
}

// Counts the page's requests to the Dash0 endpoint that haven't finished, so the session can wait for them.
function trackTelemetry(page) {
  let inFlight = 0;
  const isTelemetry = (request) => !request.url().startsWith(TARGET);
  page.on("request", (r) => isTelemetry(r) && inFlight++);
  page.on("requestfinished", (r) => isTelemetry(r) && inFlight--);
  page.on("requestfailed", (r) => isTelemetry(r) && inFlight--);
  // The SDK batches for a second before sending; then wait for what it sent, up to 15 s.
  return async () => {
    await sleep(1500);
    for (let waited = 0; inFlight > 0 && waited < 15000; waited += 250) await sleep(250);
  };
}

async function session(browser) {
  const email = pick(USERS);
  const context = await browser.newContext({ ...pick(PROFILES) });
  const page = await context.newPage();
  const telemetrySent = trackTelemetry(page);
  page.on("console", (m) => m.type() === "warning" && log("WARNING", "browser console", { "user.email": email, text: m.text() }));
  const started = Date.now();
  let outcome = "browsed";
  try {
    await page.goto(`${TARGET}/`);
    await page.waitForSelector(".grid .card");
    await think();

    await page.click("#account");
    await page.waitForSelector("form.login-form");
    // About one sign-in in ten starts with a mistyped password.
    if (Math.random() < 0.1) {
      await signIn(page, email, `${PASSWORD}x`);
      await page.waitForSelector("form.login-form .alert");
      await think();
    }
    await signIn(page, email, PASSWORD);
    await page.waitForSelector("#account[href='/logout']", { timeout: 30000 });
    await page.waitForSelector(".grid .card");

    let inCart = 0;
    for (let i = between(1, 3); i > 0; i--) {
      const cards = page.locator(".grid .card");
      await cards.nth(between(0, (await cards.count()) - 1)).click();
      await page.waitForSelector("section.product");
      await think();
      if (Math.random() < 0.7) {
        await page.fill("input.qty", String(between(1, 2)));
        await page.click("section.product button");
        inCart++;
        await think();
      }
      await page.click("a.back");
      await page.waitForSelector(".grid .card");
    }

    if (inCart > 0 && Math.random() < 0.8) {
      await page.click("a.cart-link");
      await page.click("a.button[href='/checkout']");
      for (const [name, value] of [["name", "Demo Shopper"], ["email", email], ["address", "1 Filament Way"],
        ["postcode", "1000"], ["city", "Prague"], ["card", "4242 4242 4242 4242"], ["exp", "12/30"], ["cvc", "123"]]) {
        await page.fill(`input[name=${name}]`, value);
      }
      await page.click("form.checkout-form button[type=submit]");
      // A failed payment (scenario 8) shows an error and keeps the cart.
      await page.waitForSelector("section.confirmation, form.checkout-form .alert", { timeout: 60000 });
      outcome = (await page.locator("section.confirmation").count()) ? "ordered" : "checkout failed";
    } else {
      outcome = inCart ? "abandoned cart" : "browsed";
    }
    await think();
  } catch (e) {
    outcome = "error";
    log("ERROR", "session failed", { "user.email": email, error: e.message.split("\n")[0] });
  } finally {
    // Let the SDK finish sending: Session Replay chunks are too big for keepalive requests, so leaving the page
    // while one is in flight cancels it. Leaving then makes the SDK send its last small batch, with keepalive.
    await telemetrySent();
    await page.goto("about:blank").catch(() => {});
    await sleep(2000);
    await context.close();
  }
  log("INFO", "session finished", { "user.email": email, "session.outcome": outcome, duration_s: (Date.now() - started) / 1000 });
}

async function worker(browser) {
  for (;;) {
    await session(browser);
    await sleep(PAUSE_SECONDS * 1000);
  }
}

(async () => {
  // shop-web is plain HTTP inside the cluster. The Web SDK needs a secure context, so treat the shop's origin as
  // one, as browsers do for http://localhost.
  const browser = await chromium.launch({ args: [`--unsafely-treat-insecure-origin-as-secure=${TARGET}`] });
  log("INFO", "started", { target: TARGET, concurrency: CONCURRENCY });
  process.on("SIGTERM", async () => {
    await browser.close();
    process.exit(0);
  });
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(browser)));
})();
