// Maker Supply storefront: a small client-side-routed shop. All data comes from shop-php via /api.
// Route changes use the History API, which the Dash0 Web SDK records as page views.

const app = document.getElementById("app");
const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const money = (cents) => euro.format(cents / 100);

// ---- cart (localStorage, guarded: storage can be unavailable) ----
const CART_KEY = "maker-supply-cart";
function readCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}
function writeCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    /* cart lives for this page only */
  }
  updateCartCount(cart);
}
function updateCartCount(cart = readCart()) {
  document.getElementById("cart-count").textContent = cart.reduce((n, l) => n + l.qty, 0);
}
function addToCart(product, qty) {
  const cart = readCart();
  const line = cart.find((l) => l.id === product.id);
  if (line) line.qty = Math.min(line.qty + qty, 10);
  else cart.push({ id: product.id, name: product.name, price_cents: product.price_cents, qty });
  writeCart(cart);
}

// ---- helpers ----
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}
const link = (href, attrs, ...children) => h("a", { href, "data-link": true, ...attrs }, ...children);

// A coloured tile instead of a product photo: the colour named in the product, else one derived from its id.
const NAMED_COLOURS = { orange: [25, "80%"], black: [220, "8%"], translucent: [195, "35%"], red: [5, "70%"], blue: [215, "65%"] };
function swatch(product, size = "") {
  const named = Object.keys(NAMED_COLOURS).find((c) => product.name.toLowerCase().includes(c));
  const [hue, sat] = named ? NAMED_COLOURS[named] : [(product.id * 47) % 360, "55%"];
  const el = h("div", { class: `swatch ${size}`, "aria-hidden": "true" }, product.name.split(/[ ,]+/)[0]);
  // CSSOM rather than a style attribute: the CSP (style-src 'self') blocks inline style attributes.
  el.style.setProperty("--hue", hue);
  el.style.setProperty("--sat", sat);
  return el;
}

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  return body;
}

function render(title, ...nodes) {
  document.title = title ? `${title} · Maker Supply` : "Maker Supply";
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}
const loading = () => app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
const errorBox = (message) => h("div", { class: "alert" }, message);

// ---- pages ----
async function home() {
  loading();
  try {
    const { products } = await api("/products");
    render(
      "",
      h("section", { class: "hero" },
        h("h1", {}, "Everything for your next print"),
        h("p", { class: "muted" }, "Filament, nozzles and build plates, shipped across Europe.")),
      h("div", { class: "grid" }, products.map((p) =>
        link(`/product/${p.id}`, { class: "card" },
          swatch(p),
          h("div", { class: "card-body" },
            h("div", { class: "card-name" }, p.name),
            h("div", { class: "price" }, money(p.price_cents)),
            p.stock < 30 ? h("div", { class: "low-stock" }, `Only ${p.stock} left`) : null)))),
    );
  } catch (e) {
    render("Error", errorBox(`Couldn't load products: ${e.message}`));
  }
}

async function product(id) {
  loading();
  let data;
  try {
    data = await api(`/products/${id}`);
  } catch (e) {
    return render("Not found", errorBox(e.status === 404 ? "That product doesn't exist." : `Couldn't load product: ${e.message}`));
  }
  const p = data.product;
  const qty = h("input", { type: "number", min: "1", max: "10", value: "1", class: "qty", "aria-label": "Quantity" });
  const added = h("span", { class: "added muted" });
  render(
    p.name,
    link("/", { class: "back" }, "← All products"),
    h("section", { class: "product" },
      swatch(p, "large"),
      h("div", {},
        h("h1", {}, p.name),
        h("div", { class: "price big" }, money(p.price_cents)),
        h("p", { class: "muted" }, `${p.weight_g} g · ${p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}`),
        h("div", { class: "buy" },
          qty,
          h("button", {
            onclick: () => {
              addToCart(p, Math.max(1, Math.min(10, parseInt(qty.value, 10) || 1)));
              added.textContent = "Added to cart";
            },
          }, "Add to cart"),
          added))),
    data.recommendations.length
      ? h("section", {},
          h("h2", {}, "You might also like"),
          h("div", { class: "grid small" }, data.recommendations.map((r) =>
            link(`/product/${r.id}`, { class: "card" },
              swatch(r),
              h("div", { class: "card-body" }, h("div", { class: "card-name" }, r.name), h("div", { class: "price" }, money(r.price_cents)))))))
      : null,
  );
}

function cart() {
  const lines = readCart();
  if (!lines.length) {
    return render("Cart", h("h1", {}, "Your cart"), h("p", { class: "muted" }, "Your cart is empty. ", link("/", {}, "Keep shopping")));
  }
  const setQty = (id, qty) => {
    writeCart(readCart().map((l) => (l.id === id ? { ...l, qty } : l)).filter((l) => l.qty > 0));
    cart();
  };
  const subtotal = lines.reduce((s, l) => s + l.price_cents * l.qty, 0);
  render(
    "Cart",
    h("h1", {}, "Your cart"),
    h("div", { class: "lines" }, lines.map((l) =>
      h("div", { class: "line" },
        swatch(l, "tiny"),
        link(`/product/${l.id}`, { class: "line-name" }, l.name),
        h("div", { class: "stepper" },
          h("button", { class: "ghost", "aria-label": "Fewer", onclick: () => setQty(l.id, l.qty - 1) }, "−"),
          h("span", {}, l.qty),
          h("button", { class: "ghost", "aria-label": "More", onclick: () => setQty(l.id, Math.min(l.qty + 1, 10)) }, "+")),
        h("div", { class: "price" }, money(l.price_cents * l.qty))))),
    h("div", { class: "summary" },
      h("div", {}, "Subtotal ", h("strong", {}, money(subtotal))),
      h("p", { class: "muted" }, "Shipping is calculated at checkout."),
      link("/checkout", { class: "button" }, "Checkout")),
  );
}

function checkout() {
  const lines = readCart();
  if (!lines.length) return navigate("/cart", true);
  const message = h("div");
  const submit = h("button", { type: "submit" }, "Place order");
  const field = (label, attrs) => h("label", {}, label, h("input", { required: true, ...attrs }));
  // All inputs are masked in Session Replay (maskAllInputs is on by default).
  const form = h("form", {
    class: "checkout-form",
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = "Placing order…";
      message.replaceChildren();
      try {
        const order = await api("/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: readCart().map(({ id, qty }) => ({ id, qty })) }),
        });
        try {
          sessionStorage.setItem(`order-${order.order_id}`, JSON.stringify(order));
        } catch {
          /* confirmation page falls back to the order id only */
        }
        writeCart([]);
        navigate(`/order/${order.order_id}`);
      } catch (e) {
        message.replaceChildren(errorBox(e.status === 409 ? e.message : `We couldn't place your order: ${e.message}`));
        submit.disabled = false;
        submit.textContent = "Place order";
      }
    },
  },
    h("fieldset", {},
      h("legend", {}, "Shipping"),
      field("Full name", { name: "name", autocomplete: "name" }),
      field("Email", { name: "email", type: "email", autocomplete: "email" }),
      field("Address", { name: "address", autocomplete: "street-address" }),
      h("div", { class: "row" },
        field("Postcode", { name: "postcode", autocomplete: "postal-code" }),
        field("City", { name: "city", autocomplete: "address-level2" }))),
    h("fieldset", {},
      h("legend", {}, "Payment"),
      field("Card number", { name: "card", inputmode: "numeric", autocomplete: "cc-number", placeholder: "4242 4242 4242 4242" }),
      h("div", { class: "row" },
        field("Expiry", { name: "exp", autocomplete: "cc-exp", placeholder: "MM/YY" }),
        field("CVC", { name: "cvc", inputmode: "numeric", autocomplete: "cc-csc" }))),
    message,
    submit,
  );
  const subtotal = lines.reduce((s, l) => s + l.price_cents * l.qty, 0);
  render(
    "Checkout",
    h("h1", {}, "Checkout"),
    h("div", { class: "checkout" },
      form,
      h("aside", { class: "summary" },
        h("h2", {}, "Order summary"),
        lines.map((l) => h("div", { class: "summary-line" }, h("span", {}, `${l.qty} × ${l.name}`), h("span", {}, money(l.price_cents * l.qty)))),
        h("div", { class: "summary-line total" }, h("span", {}, "Subtotal"), h("span", {}, money(subtotal))))),
  );
}

function order(id) {
  let o = null;
  try {
    o = JSON.parse(sessionStorage.getItem(`order-${id}`));
  } catch {
    /* no stored details */
  }
  render(
    "Order confirmed",
    h("section", { class: "confirmation" },
      h("h1", {}, "Thanks for your order!"),
      h("p", {}, "Order ", h("strong", {}, id), " is confirmed."),
      o ? h("div", { class: "summary" },
            o.lines.map((l) => h("div", { class: "summary-line" }, h("span", {}, `${l.qty} × ${l.name}`), h("span", {}, money(l.price_cents * l.qty)))),
            h("div", { class: "summary-line" }, h("span", {}, "Shipping"), h("span", {}, money(o.shipping_cents))),
            h("div", { class: "summary-line total" }, h("span", {}, "Total"), h("span", {}, money(o.total_cents))))
        : null,
      link("/", { class: "button" }, "Continue shopping")),
  );
}

// Workshop controls, kept off the shopping pages.
function lab() {
  const output = h("pre", { class: "output" }, "Nothing yet.");
  const call = async (label, path, options) => {
    output.textContent = `${label}…`;
    const started = performance.now();
    try {
      const response = await fetch(`/api${path}`, options);
      output.textContent = `${label} → HTTP ${response.status} in ${Math.round(performance.now() - started)} ms\n\n${await response.text()}`;
    } catch (e) {
      output.textContent = `${label} failed: ${e}`;
    }
  };
  render(
    "Workshop lab",
    h("h1", {}, "Workshop lab"),
    h("p", { class: "muted" }, "Buttons for the workshop scenarios. Each request is traced from the browser through the backend."),
    h("div", { class: "lab-buttons" },
      h("button", { onclick: () => call("Random checkout", "/checkout") }, "Random checkout (GET /api/checkout)"),
      h("button", { onclick: () => call("Slow query", "/slow") }, "Slow query (GET /api/slow)"),
      h("button", {
        class: "danger",
        onclick: () => {
          // Uncaught on purpose: the Dash0 Web SDK reports it as an error.
          throw new Error("Demo error: shipping estimate widget failed to render");
        },
      }, "Throw a JavaScript error")),
    output,
  );
}

// ---- router ----
const routes = [
  [/^\/$/, home],
  [/^\/product\/(\d+)$/, product],
  [/^\/cart$/, cart],
  [/^\/checkout$/, checkout],
  [/^\/order\/([\w-]+)$/, order],
  [/^\/lab$/, lab],
];

function route() {
  for (const [pattern, page] of routes) {
    const match = location.pathname.match(pattern);
    if (match) return page(...match.slice(1));
  }
  render("Not found", h("h1", {}, "Page not found"), link("/", {}, "Back to the shop"));
}

function navigate(path, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", path);
  route();
}

document.addEventListener("click", (event) => {
  const a = event.target.closest("a[data-link]");
  if (!a || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  if (a.getAttribute("href") !== location.pathname) navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", route);

updateCartCount();
route();
