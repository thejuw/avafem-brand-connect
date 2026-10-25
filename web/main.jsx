import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileCheck2,
  FlaskConical,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  Menu,
  Package,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Truck,
  WalletCards,
  X,
  Zap,
  AlertCircle,
} from "lucide-react";
import "./styles.css";
import { displayLabel } from "./lib/display-label.mjs";
import { resolveAccessRoute } from "./lib/access-route.mjs";
import { pendingHandoffLink } from "./lib/handoff-link.mjs";
import { connectorSummary } from "./lib/connector-summary.mjs";
import { normalizeHandoffBag } from './lib/handoff-bag.mjs';
import { clearStripeSecretForm, configureStripeTestCredentials, isLoopbackHost } from './lib/stripe-test-entry.mjs';
import TestCheckoutPanel from './TestCheckoutPanel.jsx';
import UnifiedCheckoutPanel from './UnifiedCheckoutPanel.jsx';
import PlatformPanel from './PlatformPanel.jsx';
import BrandOnboarding from './BrandOnboarding.jsx';
import BrandPortal from './BrandPortal.jsx';
import {createScopeFence} from './lib/scope-fence.mjs';
import { resolveUnifiedCheckoutReturn } from './lib/unified-checkout.mjs';

const CommercePanel=React.lazy(()=>import('./CommercePanel.jsx'));

const NAV = [
  ["overview", "Overview", LayoutDashboard],
  ["brands", "Brands", Store],
  ["catalog", "Catalog", Package],
  ["orders", "Orders & bags", ShoppingBag],
  ["finance", "Finance", WalletCards],
  ["commerce", "Commerce controls", Zap],
  ["connections", "Connections", Plug],
  ["events", "Events & jobs", Activity],
  ["platform", "Backend & CRM", ShieldCheck],
];
const emptyData = {
  dashboard: {},
  brands: [],
  products: [],
  bags: [],
  refunds: [],
  finance: {},
  events: [],
  connections: {},
};
const list = (value) =>
  Array.isArray(value)
    ? value
    : value?.items || value?.rows || value?.events || [];
const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(cents || 0) / 100,
  );
const label = (value) =>
  String(value || "pending")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
const shortDate = (value) =>
  value && Number.isFinite(new Date(value).getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
      }).format(new Date(value))
    : "—";
const longDate = (value) =>
  value && Number.isFinite(new Date(value).getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
const titleOf = (item) => displayLabel(item, "Untitled");
const brandName = (id, brands) =>
  titleOf(brands.find((brand) => brand.id === id) || { name: id || "Avafem" });
const amountOf = (bag) =>
  bag?.totalCents ??
  bag?.shopperTotalCents ??
  bag?.total ??
  bag?.amountCents ??
  Number(bag?.subtotalCents || 0) +
    Number(bag?.shippingCents || 0) +
    Number(bag?.taxCents || 0);
const bagRef = (bag) =>
  bag?.orderRef || bag?.orderReference || bag?.reference || bag?.id || "Bag";
const productPrice = (product) =>
  product?.priceCents ??
  product?.variants?.[0]?.price?.amount ??
  product?.price?.amount ??
  product?.unitPriceCents ??
  0;
const productQty = (product) =>
  product?.inventoryQty ??
  product?.inventory?.qty ??
  product?.variants?.[0]?.inventory?.qty ??
  product?.quantity ??
  0;
const cls = (...values) => values.filter(Boolean).join(" ");

function Badge({ status, children }) {
  const text = String(status || "pending").toLowerCase();
  const tone =
    /approved|ready|live|connected|delivered|released|completed|issued|healthy|paid|succeeded|processed|active/.test(
      text,
    ) && !/disconnected|unpaid|inactive/.test(text)
      ? "green"
      : /reject|fail|error|dead|disconnect|cancel/.test(text)
        ? "red"
        : /review|pending|await|hold|scheduled|draft|unconfigured|not_configured/.test(
              text,
            )
          ? "amber"
          : "purple";
  return (
    <span className={`badge ${tone}`}>
      <span className="badge-dot" />
      {children || label(status)}
    </span>
  );
}
function Button({
  children,
  icon: Icon,
  kind = "secondary",
  small,
  loading,
  className,
  ...props
}) {
  return (
    <button
      className={cls("button", kind, small && "small", className)}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? (
        <LoaderCircle className="spin" size={15} />
      ) : Icon ? (
        <Icon size={15} />
      ) : null}
      {children}
    </button>
  );
}
function Empty({
  icon: Icon = Package,
  title = "Nothing here yet",
  text,
  action,
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
function SectionTitle({ eyebrow, title, subtitle, children }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
function CardHeading({ title, subtitle, action }) {
  return (
    <div className="card-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
function Avatar({ name = "A", size = "", index = 0 }) {
  return (
    <span className={cls("avatar", size, `avatar-${index % 4}`)}>
      {String(name).slice(0, 1).toUpperCase()}
    </span>
  );
}
function Metric({ icon: Icon, title, value, note, tone = "" }) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-top">
        <span>{title}</span>
        <Icon size={17} />
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-note">{note}</div>
    </div>
  );
}

function App() {
  const [checkoutReturn] = useState(() => resolveUnifiedCheckoutReturn(window.location));
  const [session, setSession] = useState(null);
  const [data, setData] = useState(emptyData);
  const [page, setPage] = useState(checkoutReturn ? "connections" : "overview");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [modal, setModal] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [connectionResult, setConnectionResult] = useState(null);
  const [refreshAt, setRefreshAt] = useState(null);
  const [formError, setFormError] = useState("");
  const [apiCredentials, setApiCredentials] = useState([]);
  const [credentialResult, setCredentialResult] = useState(null);
  const modalFormRef = useRef(null);
  const toastTimer = useRef(null);
  const csrf = useRef("");
  const activeBrandRef = useRef(null);
  const scopeFence=useRef(createScopeFence());
  const localStripeOwner = session?.owner === true && session?.role === 'admin' && !session?.brandId;
  const localStripeAllowed = localStripeOwner && isLoopbackHost(window.location.hostname);
  useEffect(() => {
    if (checkoutReturn) window.history.replaceState(null, '', checkoutReturn.cleanPath);
  }, [checkoutReturn]);
  function closeModal() {
    if (modal?.type === 'stripeCredentials') clearStripeSecretForm(modalFormRef.current);
    setFormError('');
    setModal(null);
  }

  const notify = (message, tone = "success") => {
    clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  };
  async function request(path, options = {}) {
    const method = options.method || "GET";
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET"
          ? {
              "x-csrf-token": csrf.current,
              "Idempotency-Key": crypto.randomUUID(),
            }
          : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        payload.error?.message ||
          payload.error ||
          payload.message ||
          `Request failed (${response.status})`,
      );
    return payload.data ?? payload;
  }
  const refresh = useCallback(async () => {
    const stamp=scopeFence.current.begin();
    const paths = {
      dashboard: "/api/dashboard",
      brands: "/api/brands",
      products: "/api/products",
      bags: "/api/bags",
      refunds: "/api/refunds",
      finance: "/api/finance",
      events: "/api/events",
      connections: "/api/connections",
    };
    if (activeBrandRef.current) delete paths.connections;
    const result = await Promise.allSettled(
      Object.entries(paths).map(async ([key, path]) => [
        key,
        await request(path),
      ]),
    );
    if(!scopeFence.current.current(stamp))return;
    const next = {};
    const failures = [];
    for (const item of result) {
      if (item.status === "fulfilled") {
        const [key, value] = item.value;
        if (key === "events") {
          next.jobs = list(value.jobs);
          next.inbox = list(value.inbox);
        }
        next[key] = [
          "brands",
          "products",
          "bags",
          "refunds",
          "events",
        ].includes(key)
          ? list(value)
          : value;
      } else failures.push(item.reason.message);
    }
    setData({ ...emptyData, ...next });
    setRefreshAt(new Date().toISOString());
    setError(failures.length ? [...new Set(failures)].join(" · ") : "");
    setLoading(false);
  }, []);
  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const nextSession = await request("/api/session");
        if (!current) return;
        csrf.current = nextSession.csrfToken;
        activeBrandRef.current = nextSession.brandId;
        scopeFence.current.change(nextSession.brandId || 'owner');
        setSession(nextSession);
        await refresh();
      } catch (err) {
        if (current) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();
    return () => {
      current = false;
      scopeFence.current.invalidate();
      clearTimeout(toastTimer.current);
    };
  }, [refresh]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    setQuery("");
    setFilter("all");
    setMobileNav(false);
    setDrawer(null);
  }, [page]);
  useEffect(() => {
    if (!modal && !drawer) return;
    const previousFocus = document.activeElement;
    setFormError("");
    const panel = document.querySelector(modal ? ".modal" : ".drawer");
    panel?.querySelector("input, textarea, select, button")?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        closeModal();
        setDrawer(null);
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...(panel?.querySelectorAll(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || []),
      ];
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [modal, drawer]);
  useEffect(() => {
    let current=true;const stamp=scopeFence.current.capture();
    setCredentialResult(null);
    setApiCredentials([]);
    if (modal?.type === "credentials")
      request(`/api/brands/${modal.item.id}/credentials`)
        .then((value) => {if(current && scopeFence.current.sameScope(stamp))setApiCredentials(list(value));})
        .catch((err) => {if(current && scopeFence.current.sameScope(stamp))notify(err.message, "error");});
    return()=>{current=false;};
  }, [modal]);

  async function action(path, body, message, method = "POST") {
    if (busy) return null;
    setBusy(path);
    try {
      const result = await request(path, { method, body: body || {} });
      await refresh();
      if (message) notify(message);
      return result ?? true;
    } catch (err) {
      notify(err.message, "error");
      return null;
    } finally {
      setBusy("");
    }
  }
  async function switchBrand(brandId) {
    scopeFence.current.invalidate();setData(emptyData);setLoading(true);setRefreshAt(null);setError('');
    closeModal();setDrawer(null);setCredentialResult(null);setApiCredentials([]);setConnectionResult(null);setToast(null);
    setBusy("workspace");
    try {
      const next = await request("/api/session/brand", {
        method: "POST",
        body: { brandId: brandId || null },
      });
      csrf.current = next.csrfToken || csrf.current;
      activeBrandRef.current = next.brandId;
      scopeFence.current.change(next.brandId || 'owner');
      setSession(next);
      setDrawer(null);
      setPage("overview");
      await refresh();
      notify(
        brandId
          ? `Opened ${brandName(brandId, data.brands)} workspace`
          : "Opened Avafem operations",
      );
    } catch (err) {
      notify(err.message, "error");
      await refresh();
    } finally {
      setBusy("");
    }
  }
  const owner = session?.owner===true && !session?.brandId;
  const selectedBrand = data.brands.find((b) => b.id === session?.brandId);
  const navigate = (next, nextFilter) => {
    setPage(next);
    if (nextFilter) setTimeout(() => setFilter(nextFilter), 0);
  };
  const searchMatch = (item) =>
    !query || JSON.stringify(item).toLowerCase().includes(query.toLowerCase());
  const openBags = data.bags.filter(
    (b) => !["delivered", "cancelled", "refunded"].includes(b.status),
  );
  const reviewProducts = data.products.filter((p) =>
    ["in_review", "pending_review", "draft", "rejected"].includes(p.status),
  );
  const awaitingBags = data.bags.filter((b) =>
    ["awaiting_shipment", "created", "pushed", "push_failed", "paid"].includes(
      b.status,
    ),
  );
  const shippedBags = data.bags.filter((b) =>
    ["shipped", "partially_shipped", "in_transit"].includes(b.status),
  );
  const deliveredBags = data.bags.filter((b) => b.status === "delivered");
  const finance = data.finance || {};
  const transfers = list(finance.transfers);
  const credits = list(finance.credits);
  const ledger = list(finance.ledger);
  const totalHeld = transfers
    .filter((t) => ["scheduled", "held", "pending"].includes(t.status))
    .reduce((sum, t) => sum + Number(t.amountCents || t.amount || 0), 0);
  const totalCredits = credits
    .filter((c) => c.status !== "voided")
    .reduce((sum, c) => sum + Number(c.amountCents || c.amount || 0), 0);
  const catalogStatuses = ["all", "draft", "in_review", "approved", "rejected"];
  const filteredProducts = data.products.filter(
    (p) => searchMatch(p) && (filter === "all" || p.status === filter),
  );
  const filteredBags = data.bags.filter(
    (b) =>
      searchMatch(b) &&
      (filter === "all" ||
        b.status === filter ||
        (filter === "awaiting_shipment" && awaitingBags.includes(b))),
  );
  const filteredBrands = data.brands.filter(searchMatch);
  const filteredEvents = data.events.filter(
    (e) => searchMatch(e) && (filter === "all" || e.status === filter),
  );
  const displayBrandList = useRef([]);
  if (owner && data.brands.length) displayBrandList.current = data.brands;
  const brandList = displayBrandList.current.length
    ? displayBrandList.current
    : data.brands;

  function createTestBag() {
    if (!owner) {
      notify(
        "Create sandbox orders from the Avafem operations workspace.",
        "error",
      );
      return;
    }
    action(
      "/api/sandbox/orders",
      session?.brandId ? { brandId: session.brandId } : {},
      "Synthetic test bag created. No payment was charged.",
    );
  }
  function SearchBox({ placeholder }) {
    return (
      <div className="search-box">
        <Search size={16} />
        <input
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button aria-label="Clear search" onClick={() => setQuery("")}>
            <X size={14} />
          </button>
        )}
      </div>
    );
  }
  function ProductTable({ items = filteredProducts, compact = false }) {
    return items.length ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              {!compact && <th>Brand</th>}
              <th>Price</th>
              <th>Inventory</th>
              <th>Review status</th>
              <th className="arrow-col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((product, index) => (
              <tr
                key={product.id || product.sku}
                onClick={() => setDrawer({ type: "product", id: product.id })}
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  setDrawer({ type: "product", id: product.id })
                }
              >
                <td>
                  <div className="cell-identity">
                    <span className={`product-art art-${index % 4}`}>
                      <Leaf size={21} />
                    </span>
                    <div>
                      <strong>{titleOf(product)}</strong>
                      <small>{product.sku || product.category}</small>
                    </div>
                  </div>
                </td>
                {!compact && <td>{brandName(product.brandId, data.brands)}</td>}
                <td className="number">{money(productPrice(product))}</td>
                <td>
                  <span className={productQty(product) <= 0 ? "muted" : ""}>
                    {productQty(product)} <span className="muted">units</span>
                  </span>
                </td>
                <td>
                  <Badge status={product.status} />
                </td>
                <td>
                  <ChevronRight size={15} className="muted" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        title="Your catalog starts here"
        text="Add a product to validate its details and send it for review."
        action={
          <Button
            small
            icon={Plus}
            onClick={() => setModal({ type: "product" })}
          >
            Add product
          </Button>
        }
      />
    );
  }
  function BagTable({ items = filteredBags, compact = false }) {
    return items.length ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Bag / order</th>
              <th>Brand</th>
              {!compact && <th>Created</th>}
              <th>Total</th>
              <th>Status</th>
              <th className="arrow-col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((bag) => (
              <tr
                key={bag.id}
                onClick={() => setDrawer({ type: "bag", id: bag.id })}
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter" && setDrawer({ type: "bag", id: bag.id })
                }
              >
                <td>
                  <strong className="table-reference">{bagRef(bag)}</strong>
                  <small className="below">
                    {list(bag.items).reduce(
                      (sum, item) =>
                        sum + Number(item.qty || item.quantity || 1),
                      0,
                    )}{" "}
                    items · {bag.id?.slice(-10)}
                  </small>
                </td>
                <td>{brandName(bag.brandId, data.brands)}</td>
                {!compact && (
                  <td className="muted">{shortDate(bag.createdAt)}</td>
                )}
                <td className="number">{money(amountOf(bag))}</td>
                <td>
                  <Badge status={bag.status} />
                </td>
                <td>
                  <ChevronRight size={15} className="muted" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        icon={ShoppingBag}
        title="No bags in this view"
        text="Create a synthetic order to walk through the fulfillment workflow."
        action={
          owner && (
            <Button small icon={Plus} onClick={createTestBag} loading={!!busy}>
              Create test bag
            </Button>
          )
        }
      />
    );
  }

  function Overview() {
    const flows = [
      {
        label: "Awaiting shipment",
        amount: awaitingBags.length,
        icon: Package,
        color: "peach",
        filter: "awaiting_shipment",
      },
      {
        label: "On their way",
        amount: shippedBags.length,
        icon: Truck,
        color: "lilac",
        filter: "shipped",
      },
      {
        label: "Delivered",
        amount: deliveredBags.length,
        icon: CheckCircle2,
        color: "mint",
        filter: "delivered",
      },
    ];
    const alerts = [
      reviewProducts.length && {
        icon: FileCheck2,
        title: `${reviewProducts.length} product${reviewProducts.length === 1 ? "" : "s"} need a closer look`,
        description: "Complete validation and review product claims.",
        action: () => navigate("catalog"),
        color: "peach",
      },
      data.refunds.filter((r) =>
        ["pending", "proposed", "pending_approval", "requested"].includes(
          r.status,
        ),
      ).length && {
        icon: WalletCards,
        title: "Refund proposals awaiting review",
        description: "Check the allocation before approving a refund.",
        action: () => navigate("finance"),
        color: "lilac",
      },
      owner &&
        !data.connections.stripe?.configured && {
          icon: Plug,
          title: "Stripe test credentials needed",
          description: "Connect test mode to validate real Stripe transfers.",
          action: () => navigate("connections"),
          color: "lilac",
        },
    ].filter(Boolean);
    return (
      <>
        <SectionTitle
          eyebrow={
            owner ? "YOUR OPERATIONS, AT A GLANCE" : "YOUR BRAND WORKSPACE"
          }
          title={
            owner
              ? "Good things, connected."
              : `${titleOf(selectedBrand)} workspace`
          }
          subtitle="A little clarity for every part of your brand network."
        >
          {owner && (
            <Button
              icon={Plus}
              kind="primary"
              onClick={createTestBag}
              loading={!!busy}
            >
              Create test bag
            </Button>
          )}
        </SectionTitle>
        <div className="metrics-grid">
          <Metric
            icon={ShoppingBag}
            title="Open bags"
            value={openBags.length}
            note={`${awaitingBags.length} awaiting shipment`}
          />
          <Metric
            icon={Store}
            title="Connected brands"
            value={data.brands.length}
            note={`${data.brands.filter((b) => ["live", "ready", "approved", "active"].includes(b.status)).length} ready in sandbox`}
          />
          <Metric
            icon={FileCheck2}
            title="Catalog review"
            value={reviewProducts.length}
            note={`${data.products.length} products in your catalog`}
            tone="soft-peach"
          />
          <Metric
            icon={WalletCards}
            title="Transfers on hold"
            value={money(totalHeld)}
            note="Sandbox · release after the return window"
          />
        </div>
        <div className="overview-grid">
          <section className="card flow-card">
            <CardHeading
              title="Every bag has a next step"
              subtitle="Your current fulfillment pipeline"
              action={
                <button
                  className="text-button"
                  onClick={() => navigate("orders")}
                >
                  View bags <ArrowUpRight size={14} />
                </button>
              }
            />
            <div className="flow-stages">
              {flows.map(
                (
                  { label: text, amount, icon: Icon, color, filter: status },
                  index,
                ) => (
                  <React.Fragment key={text}>
                    <button
                      className="flow-stage"
                      onClick={() => navigate("orders", status)}
                    >
                      <span className={`square-icon ${color}`}>
                        <Icon size={20} />
                      </span>
                      <strong>{amount}</strong>
                      <span>{text}</span>
                    </button>
                    {index < 2 && (
                      <ChevronRight size={18} className="flow-arrow" />
                    )}
                  </React.Fragment>
                ),
              )}
            </div>
            <div className="pipeline-track">
              {flows.map((flow) => (
                <span
                  key={flow.label}
                  className={flow.color}
                  style={{ flex: Math.max(flow.amount, 0.35) }}
                />
              ))}
            </div>
            <div className="subtle-note">
              <ShieldCheck size={14} />
              <span>
                Each bag belongs to one brand. Shopper health data stays
                private.
              </span>
            </div>
          </section>
          <section className="card attention-card">
            <CardHeading
              title="A little attention"
              subtitle="The things that move your network forward"
            />
            <div className="attention-list">
              {alerts.length ? (
                alerts.map((alert) => (
                  <button
                    className="attention-item"
                    key={alert.title}
                    onClick={alert.action}
                  >
                    <span className={`square-icon ${alert.color}`}>
                      <alert.icon size={17} />
                    </span>
                    <span>
                      <strong>{alert.title}</strong>
                      <small>{alert.description}</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))
              ) : (
                <div className="all-clear">
                  <CheckCircle2 size={26} />
                  <strong>You're all caught up.</strong>
                  <p>No reviews or connection issues need attention.</p>
                </div>
              )}
            </div>
          </section>
          <section className="card recent-card">
            <CardHeading
              title="Recent bags"
              subtitle="From checkout to a happy doorstep"
              action={
                <button
                  className="text-button"
                  onClick={() => navigate("orders")}
                >
                  All bags <ArrowUpRight size={14} />
                </button>
              }
            />
            <BagTable items={data.bags.slice(0, 5)} compact />
          </section>
          <section className="card brands-mini">
            <CardHeading
              title="Your brand circle"
              subtitle="Connected through one shared core"
              action={
                <button
                  className="icon-button"
                  aria-label="View brands"
                  onClick={() => navigate("brands")}
                >
                  <ArrowUpRight size={17} />
                </button>
              }
            />
            <div className="brand-mini-list">
              {data.brands.slice(0, 4).map((brand, index) => (
                <button
                  key={brand.id}
                  onClick={() => setDrawer({ type: "brand", id: brand.id })}
                >
                  <Avatar name={titleOf(brand)} index={index} />
                  <span>
                    <strong>{titleOf(brand)}</strong>
                    <small>
                      {label(brand.connectionTier || brand.tier || "dashboard")}{" "}
                      connection
                    </small>
                  </span>
                  <Badge status={brand.status} />
                </button>
              ))}
              {!data.brands.length && (
                <Empty
                  icon={Store}
                  title="Welcome to your brand circle"
                  text="Add your first brand to get started."
                />
              )}
            </div>
            <button
              className="brand-footer"
              onClick={() =>
                owner ? setModal({ type: "brand" }) : navigate("catalog")
              }
            >
              <Plus size={15} />
              {owner ? "Add a brand" : "View your catalog"}
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      </>
    );
  }
  function Brands() {
    return (
      <>
        <SectionTitle
          eyebrow="YOUR PARTNERS, ONE PLACE"
          title="Your brand circle"
          subtitle="Onboard thoughtfully. Keep every brand ready for what’s next."
        >
          {owner && (
            <Button
              kind="primary"
              icon={Plus}
              onClick={() => setModal({ type: "brand" })}
            >
              Add brand
            </Button>
          )}
        </SectionTitle>
        <div className="card">
          <div className="table-toolbar">
            <div>
              <strong>{data.brands.length} brands</strong>
              <span className="muted toolbar-description">
                All connection tiers
              </span>
            </div>
            {SearchBox({ placeholder: "Search brands…" })}
          </div>
          {filteredBrands.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Connection</th>
                    <th>Catalog</th>
                    <th>Commission</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredBrands.map((brand, index) => (
                    <tr
                      key={brand.id}
                      onClick={() => setDrawer({ type: "brand", id: brand.id })}
                      tabIndex={0}
                      onKeyDown={(e) =>
                        e.key === "Enter" &&
                        setDrawer({ type: "brand", id: brand.id })
                      }
                    >
                      <td>
                        <div className="cell-identity">
                          <Avatar name={titleOf(brand)} index={index} />
                          <span>
                            <strong>{titleOf(brand)}</strong>
                            <small>
                              {brand.supportEmail || brand.email || brand.id}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        {label(
                          brand.connectionTier || brand.tier || "dashboard",
                        )}
                      </td>
                      <td>
                        {
                          data.products.filter((p) => p.brandId === brand.id)
                            .length
                        }{" "}
                        products
                      </td>
                      <td>
                        {brand.commissionBps != null
                          ? `${brand.commissionBps / 100}%`
                          : brand.commissionRate != null
                            ? `${Number(brand.commissionRate) <= 1 ? Number(brand.commissionRate) * 100 : brand.commissionRate}%`
                            : "—"}
                      </td>
                      <td>
                        <Badge status={brand.status} />
                      </td>
                      <td>
                        <ChevronRight size={15} className="muted" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={Store}
              title={query ? "No matching brands" : "Meet your first brand"}
              text={
                query
                  ? "Try another search."
                  : "Create a brand profile to start the onboarding checklist."
              }
            />
          )}
        </div>
        <div className="info-strip">
          <ShieldCheck size={18} />
          <p>
            Go-live checks bring agreements, catalog review, fulfillment setup,
            and payment readiness together. Every brand starts in sandbox.
          </p>
        </div>
      </>
    );
  }
  function Catalog() {
    return (
      <>
        <SectionTitle
          eyebrow="CURATED WITH CARE"
          title="Catalog & review"
          subtitle="The right details, the right evidence, and a human eye on every claim."
        >
          <Button
            icon={Plus}
            kind="primary"
            onClick={() => setModal({ type: "product" })}
          >
            Add product
          </Button>
        </SectionTitle>
        <div className="card">
          <div className="table-toolbar">
            <div className="tabs">
              {catalogStatuses.map((status) => (
                <button
                  className={filter === status ? "active" : ""}
                  key={status}
                  onClick={() => setFilter(status)}
                >
                  {status === "all" ? "All products" : label(status)}
                  <span>
                    {status === "all"
                      ? data.products.length
                      : data.products.filter((p) => p.status === status).length}
                  </span>
                </button>
              ))}
            </div>
            {SearchBox({ placeholder: "Find a product…" })}
          </div>
          <ProductTable />
        </div>
        <div className="info-strip">
          <FileCheck2 size={18} />
          <p>
            Health and efficacy claims require review. Editing claim text sends
            an approved product back through review; price and inventory updates
            keep approval.
          </p>
        </div>
      </>
    );
  }
  function Orders() {
    return (
      <>
        <SectionTitle
          eyebrow="FROM YOUR BRANDS TO THEIR DOOR"
          title="Orders & bags"
          subtitle="One checkout. A separate fulfillment bag for each brand."
        >
          {owner && (
            <Button
              icon={Plus}
              kind="primary"
              onClick={createTestBag}
              loading={!!busy}
            >
              Create test bag
            </Button>
          )}
        </SectionTitle>
        <div className="inline-banner">
          <FlaskConical size={17} />
          <div>
            <strong>Synthetic orders only</strong>
            <span>
              No real charges or shipping requests. Test addresses are clearly
              labeled.
            </span>
          </div>
        </div>
        <div className="card">
          <div className="table-toolbar">
            <div className="tabs">
              {["all", "awaiting_shipment", "shipped", "delivered"].map(
                (status) => (
                  <button
                    className={filter === status ? "active" : ""}
                    key={status}
                    onClick={() => setFilter(status)}
                  >
                    {status === "all" ? "All bags" : label(status)}
                  </button>
                ),
              )}
            </div>
            {SearchBox({ placeholder: "Find a bag or order…" })}
          </div>
          <BagTable />
        </div>
      </>
    );
  }
  function Finance() {
    const fs = finance.summary || {};
    return (
      <>
        <SectionTitle
          eyebrow="EVERY CENT, ACCOUNTED FOR"
          title="Finance"
          subtitle="A clear trail from shopper payment to brand transfer and Beauty Bank credit."
        >
          <span className="context-pill">
            <FlaskConical size={14} />
            Sandbox ledger
          </span>
        </SectionTitle>
        <div className="metrics-grid">
          <Metric
            icon={WalletCards}
            title="Held transfers"
            value={money(fs.heldCents ?? totalHeld)}
            note="Held through the configured return window"
          />
          <Metric
            icon={CheckCircle2}
            title="Released transfers"
            value={money(
              fs.releasedCents ??
                transfers
                  .filter((t) =>
                    ["paid", "released", "completed", "created"].includes(
                      t.status,
                    ),
                  )
                  .reduce(
                    (sum, t) => sum + Number(t.amountCents || t.amount || 0),
                    0,
                  ),
            )}
            note="Sandbox allocations only"
          />
          <Metric
            icon={Leaf}
            title="Beauty Bank credits"
            value={money(fs.creditsCents ?? totalCredits)}
            note={`${credits.filter((c) => c.status === "pending").length} credit allocations pending`}
            tone="soft-peach"
          />
          <Metric
            icon={ShieldCheck}
            title="Ledger balance"
            value={money(
              fs.imbalanceCents ??
                ledger.reduce(
                  (sum, l) =>
                    sum +
                    Number(l.debitCents || 0) -
                    Number(l.creditCents || 0),
                  0,
                ),
            )}
            note="Debits minus credits · expected $0.00"
          />
        </div>
        <div className="card">
          <CardHeading
            title="Brand transfers"
            subtitle="Held until the release window closes"
          />
          {transfers.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Transfer</th>
                    <th>Brand</th>
                    <th>Amount</th>
                    <th>Release eligible</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.id?.slice(-16)}</strong>
                        <small className="below">{t.bagId}</small>
                      </td>
                      <td>{brandName(t.brandId, data.brands)}</td>
                      <td className="number">
                        {money(t.amountCents || t.amount)}
                      </td>
                      <td className="muted">
                        {shortDate(
                          t.dueAt ||
                            t.releaseAt ||
                            t.eligibleAt ||
                            t.scheduledAt,
                        )}
                      </td>
                      <td>
                        <Badge status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={WalletCards}
              title="Transfers follow your first bag"
              text="Create a sandbox order to see its transfer allocation."
            />
          )}
        </div>
        <div className="finance-columns">
          <section className="card">
            <CardHeading
              title="Refund proposals"
              subtitle="Human approval before any refund is issued"
            />
            {data.refunds.length ? (
              <div className="proposal-list">
                {data.refunds.map((refund) => (
                  <div className="proposal" key={refund.id}>
                    <div>
                      <strong>
                        {money(refund.amountCents || refund.amount)}
                      </strong>
                      <Badge status={refund.status} />
                    </div>
                    <p>{refund.reason || "Refund requested"}</p>
                    <small>{refund.bagId}</small>
                    {owner &&
                      [
                        "pending",
                        "pending_approval",
                        "proposed",
                        "requested",
                      ].includes(refund.status) && (
                        <Button
                          small
                          onClick={() =>
                            setModal({ type: "approveRefund", item: refund })
                          }
                          icon={Check}
                        >
                          Review & approve
                        </Button>
                      )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                icon={CheckCircle2}
                title="No refund proposals"
                text="Requests from a bag will appear here for review."
              />
            )}
          </section>
          <section className="card">
            <CardHeading
              title="Beauty Bank"
              subtitle="Credits are tied to each bag’s lifecycle"
            />
            {credits.length ? (
              <div className="credit-list">
                {credits.map((credit) => (
                  <div key={credit.id}>
                    <span className="square-icon peach">
                      <Leaf size={16} />
                    </span>
                    <span>
                      <strong>
                        {money(credit.amountCents || credit.amount)}
                      </strong>
                      <small>{credit.bagId}</small>
                    </span>
                    <Badge status={credit.status} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                icon={Leaf}
                title="Room for a little reward"
                text="Credit allocations appear when test bags are created."
              />
            )}
          </section>
        </div>
        <section className="card">
          <CardHeading
            title="Double-entry ledger"
            subtitle="An immutable accounting trail for every allocation"
          />
          {ledger.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Entry / account</th>
                    <th>Reference</th>
                    <th>Debit</th>
                    <th>Credit</th>
                    <th>Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.slice(0, 30).map((entry, index) => (
                    <tr key={entry.id || index}>
                      <td>
                        <strong>
                          {label(
                            entry.account || entry.accountName || entry.type,
                          )}
                        </strong>
                        <small className="below">
                          {entry.description || entry.id?.slice(-12)}
                        </small>
                      </td>
                      <td className="muted">
                        {entry.bagId ||
                          entry.reference ||
                          entry.transactionId?.slice(-12) ||
                          "—"}
                      </td>
                      <td className="number">{money(entry.debitCents)}</td>
                      <td className="number">{money(entry.creditCents)}</td>
                      <td className="muted">{longDate(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={WalletCards}
              title="Your ledger is ready"
              text="Sandbox order events create balanced accounting entries."
            />
          )}
        </section>
      </>
    );
  }
  function Connections() {
    const shop = data.connections.shopify || {};
    const stripe = data.connections.stripe || {};
    const shopLabel = displayLabel(
      shop.shop,
      displayLabel(shop.store, "No store configured"),
    );
    const appLabel = displayLabel(
      shop.app,
      displayLabel(shop.appName, "Avafem Test Connector"),
    );
    const resultSummary = connectionResult
      ? connectorSummary(connectionResult)
      : null;
    return (
      <>
        <SectionTitle
          eyebrow="ONE CORE, MANY WAYS TO CONNECT"
          title="Connections"
          subtitle="Keep each brand’s catalog and fulfillment in step with Avafem."
        >
          <Button
            icon={RefreshCw}
            onClick={async () => {
              setLoading(true);
              await refresh();
            }}
            loading={loading}
          >
            Refresh status
          </Button>
        </SectionTitle>
        <div className="connection-grid">
          <section className="card connection-card">
            <div className="connection-logo shopify-logo">
              <ShoppingBag size={28} />
            </div>
            <div className="connection-title">
              <h2>Shopify</h2>
              <Badge
                status={
                  shop.connected || shop.verified
                    ? "connected"
                    : shop.configured
                      ? "configured"
                      : "not_configured"
                }
              />
            </div>
            <p>
              Catalog reads and order fulfillment through your installed custom
              app.
            </p>
            <div className="connection-details">
              <div>
                <span>Store</span>
                <strong>{shopLabel}</strong>
              </div>
              <div>
                <span>App</span>
                <strong>{appLabel}</strong>
              </div>
              <div>
                <span>Last checked</span>
                <strong>{longDate(shop.lastCheckedAt)}</strong>
              </div>
            </div>
            <div className="connection-actions">
              <Button
                icon={ShieldCheck}
                small
                onClick={async () => {
                  const result = await action(
                    "/api/connections/shopify/preflight",
                    {},
                    "Shopify read-only preflight completed.",
                  );
                  if (result) setConnectionResult(result);
                }}
                loading={busy.includes("preflight")}
              >
                Run preflight
              </Button>
              <Button
                icon={ArrowDownToLine}
                small
                kind="primary"
                onClick={async () => {
                  const result = await action(
                    "/api/connections/shopify/import",
                    {},
                    "Shopify catalog imported for local review.",
                  );
                  if (result) setConnectionResult(result);
                }}
                loading={busy.includes("/import")}
              >
                Import catalog
              </Button>
            </div>
            <div className="subtle-note">
              <ShieldCheck size={13} />
              Both actions read Shopify; no store orders are created.
            </div>
          </section>
          <section className="card connection-card">
            <div className="connection-logo stripe-logo">s</div>
            <div className="connection-title">
              <h2>Stripe Connect</h2>
              <Badge
                status={stripe.verified ? 'connected' : stripe.configured ? "configured" : "not_configured"}
              >{stripe.verified ? 'Test account verified' : stripe.configured ? 'Configured' : 'Not configured'}</Badge>
            </div>
            <p>
              Separate charges and transfers, Express onboarding, and payment
              events.
            </p>
            <div className="connection-details">
              <div>
                <span>Mode</span>
                <strong>{stripe.mode === "live" ? "Live" : "Test mode"}</strong>
              </div>
              <div>
                <span>Credentials</span>
                <strong>
                  {stripe.verified ? 'Account access verified' : stripe.configured
                    ? "Configured; verification pending"
                    : "Not configured"}
                </strong>
              </div>
              <div>
                <span>Transfers</span>
                <strong>
                  {stripe.configured
                    ? "Separate transfer test not run"
                    : "Local ledger simulation only"}
                </strong>
              </div>
              {stripe.accountId && <div><span>Verified account</span><strong>{displayLabel(stripe.accountId)}</strong></div>}
              {stripe.configured && <div><span>Webhook signing</span><strong>{stripe.webhookConfigured ? 'Configured' : 'Signing secret still needed'}</strong></div>}
            </div>
            <div className="setup-note">
              <AlertCircle size={17} />
              <span>
                {stripe.verified ? 'Stripe test account access is verified. Credential verification did not create a payment or complete checkout acceptance.' : stripe.configured ? 'Credentials are configured; verify the test account before exercising provider workflows.' : stripe.reason || "Stripe test credentials are required before payment and transfer API verification."}
              </span>
            </div>
            {localStripeOwner && <div className="connection-actions stripe-entry-action"><Button icon={ShieldCheck} kind="primary" disabled={!localStripeAllowed} onClick={() => localStripeAllowed && setModal({type:'stripeCredentials'})}>Configure test credentials</Button></div>}
            <button
              className="text-button"
              onClick={() => setModal({ type: "stripe" })}
            >
              View setup requirements <ArrowUpRight size={14} />
            </button>
          </section>
        </div>
        {localStripeOwner && <UnifiedCheckoutPanel request={request} enabled={localStripeAllowed} checkoutReturn={checkoutReturn} />}
        {localStripeOwner && <TestCheckoutPanel request={request} enabled={localStripeAllowed} stripeVerified={stripe.verified===true} />}
        {connectionResult && (
          <section className="card preflight-result">
            <CardHeading
              title={resultSummary.title}
              action={
                <button
                  className="icon-button"
                  aria-label="Dismiss connector result"
                  onClick={() => setConnectionResult(null)}
                >
                  <X size={16} />
                </button>
              }
            />
            <div className="connector-summary">
              {resultSummary.kind === "import" ? (
                <>
                  <div className="connector-result-metrics">
                    <div>
                      <strong>{resultSummary.imported}</strong>
                      <span>Products imported</span>
                    </div>
                    <div>
                      <strong>{resultSummary.issues}</strong>
                      <span>Import issues</span>
                    </div>
                    <div>
                      <strong>{resultSummary.drafts}</strong>
                      <span>Sandbox drafts</span>
                    </div>
                  </div>
                  <p>
                    {resultSummary.drafts
                      ? "Draft products need required catalog details and human review before listing. Existing stock values are preserved conservatively."
                      : "Imported catalog records are available in Catalog & review."}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => navigate("catalog")}
                  >
                    Review catalog <ArrowUpRight size={14} />
                  </button>
                </>
              ) : (
                <>
                  <div className="connector-verification">
                    <span
                      className={`square-icon ${resultSummary.verified ? "mint" : "peach"}`}
                    >
                      {resultSummary.verified ? (
                        <CheckCircle2 size={20} />
                      ) : (
                        <AlertCircle size={20} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {resultSummary.verified
                          ? "Store access verified"
                          : "Store access checked"}
                      </strong>
                      <p>
                        {resultSummary.shop} · {resultSummary.app}
                      </p>
                    </div>
                    <Badge
                      status={
                        resultSummary.verified ? "verified" : "review_required"
                      }
                    />
                  </div>
                  <p>
                    Missing scopes:{" "}
                    {resultSummary.missingScopes.length
                      ? resultSummary.missingScopes.join(", ")
                      : "None"}
                  </p>
                </>
              )}
            </div>
            <details className="technical-details" key={resultSummary.kind}>
              <summary>Technical details</summary>
              <pre>{JSON.stringify(connectionResult, null, 2)}</pre>
            </details>
          </section>
        )}
        <section className="card">
          <CardHeading
            title="Built on one shared contract"
            subtitle="Each connection uses the same brand, product, bag, and event models."
          />
          <div className="tier-grid">
            {[
              {
                icon: Store,
                name: "Dashboard",
                tag: "Available",
                text: "Manage products and enter tracking in this workspace.",
              },
              {
                icon: Zap,
                name: "Direct API",
                tag: "Local sandbox",
                text: "Scoped catalog and fulfillment endpoints with idempotency.",
              },
              {
                icon: Plug,
                name: "MCP",
                tag: "Local sandbox",
                text: "Agent tools use the same permissions and business rules.",
              },
            ].map((tier) => (
              <div key={tier.name}>
                <span className="square-icon lilac">
                  <tier.icon size={18} />
                </span>
                <h3>{tier.name}</h3>
                <span className="tiny-tag">{tier.tag}</span>
                <p>{tier.text}</p>
              </div>
            ))}
          </div>
        </section>
      </>
    );
  }
  function Events() {
    return (
      <>
        <SectionTitle
          eyebrow="A RELIABLE TRAIL, EVERY STEP"
          title="Events & jobs"
          subtitle="Domain changes, outbox delivery, and retries in one place."
        >
          {owner && (
            <Button
              icon={RefreshCw}
              kind="primary"
              onClick={() =>
                action("/api/jobs/run", {}, "Due sandbox jobs processed.")
              }
              loading={!!busy}
            >
              Run due jobs
            </Button>
          )}
        </SectionTitle>
        <div className="info-strip top-info">
          <Activity size={18} />
          <p>
            Events are written with domain changes. Replays retry delivery
            without repeating the original business action.
          </p>
        </div>
        <div className="card">
          <div className="table-toolbar">
            <div className="tabs">
              {["all", "pending", "delivered", "failed"].map((status) => (
                <button
                  key={status}
                  className={filter === status ? "active" : ""}
                  onClick={() => setFilter(status)}
                >
                  {status === "all" ? "All events" : label(status)}
                </button>
              ))}
            </div>
            {SearchBox({ placeholder: "Search events…" })}
          </div>
          {filteredEvents.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Recorded</th>
                    <th>Attempts</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <button
                          className="event-name"
                          onClick={() =>
                            setDrawer({ type: "event", id: event.id })
                          }
                        >
                          {event.type || event.eventType || event.name}
                          <ArrowUpRight size={12} />
                        </button>
                        <small className="below">{event.id?.slice(-18)}</small>
                      </td>
                      <td className="muted">{longDate(event.createdAt)}</td>
                      <td>{event.attempts || event.attemptCount || 0}</td>
                      <td>
                        <Badge status={event.status} />
                      </td>
                      <td>
                        {owner && (
                          <Button
                            small
                            icon={RefreshCw}
                            onClick={() =>
                              action(
                                `/api/events/${event.id}/replay`,
                                {},
                                "Event queued for replay.",
                              )
                            }
                            loading={busy.includes(event.id)}
                          >
                            Replay
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={Activity}
              title="No events in this view"
              text="Actions on brands, products, and bags will appear here."
            />
          )}
        </div>
        <section className="card jobs-card">
          <CardHeading
            title="Scheduled jobs"
            subtitle="Transfers stay scheduled until the delivery window closes."
          />
          {list(data.jobs).length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Bag</th>
                    <th>Due</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list(data.jobs).map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>{label(job.kind || job.type)}</strong>
                        <small className="below">{job.id?.slice(-16)}</small>
                      </td>
                      <td className="muted">{job.bagId?.slice(-18) || "—"}</td>
                      <td>{longDate(job.dueAt || job.availableAt)}</td>
                      <td>
                        <Badge status={job.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={Clock3}
              title="No scheduled jobs"
              text="Recording a delivery schedules its sandbox release window."
            />
          )}
        </section>
        {list(data.inbox).length > 0 && (
          <section className="card jobs-card">
            <CardHeading
              title="Dashboard dispatch inbox"
              subtitle="Local fallback handoffs; no email provider is connected."
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dispatch</th>
                    <th>Bag</th>
                    <th>Created</th>
                    <th>Status / link expiry</th>
                    <th>View</th>
                  </tr>
                </thead>
                <tbody>
                  {list(data.inbox)
                    .slice(0, 20)
                    .map((message) => {
                      const handoffPath = pendingHandoffLink(message);
                      return (
                        <tr key={message.id}>
                          <td>
                            <strong>{message.subject}</strong>
                            <small className="below">Sandbox inbox</small>
                          </td>
                          <td className="muted">
                            {message.bag_id?.slice(-16) ||
                              message.bagId?.slice(-16)}
                          </td>
                          <td>
                            {longDate(message.created_at || message.createdAt)}
                          </td>
                          <td>
                            <Badge status={message.status || "pending"} />
                            {message.body?.handoffExpiresAt && (
                              <small className="below">
                                Expires{" "}
                                {longDate(message.body.handoffExpiresAt)}
                              </small>
                            )}
                          </td>
                          <td>
                            <div className="dispatch-actions">
                              {handoffPath && (
                                <a
                                  className="button small"
                                  href={handoffPath}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open shipping handoff{" "}
                                  <ArrowUpRight size={13} />
                                </a>
                              )}
                              <Button
                                small
                                icon={ArrowUpRight}
                                onClick={() => {
                                  const id = message.bag_id || message.bagId;
                                  if (data.bags.some((b) => b.id === id))
                                    setDrawer({ type: "bag", id });
                                  else
                                    notify(
                                      "This dispatch bag is not available in the current workspace.",
                                      "error",
                                    );
                                }}
                              >
                                Open bag
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </>
    );
  }

  const drawerItem =
    drawer &&
    (drawer.type === "brand"
      ? data.brands
      : drawer.type === "product"
        ? data.products
        : drawer.type === "bag"
          ? data.bags
          : data.events
    ).find((item) => item.id === drawer.id);
  function DetailDrawer() {
    const item = drawerItem;
    if (!item) return null;
    const shipTo = item.shipTo || item.ship_to || item.shippingAddress || {};
    const shipments = list(item.shipments);
    const evidence = item.evidence || {};
    const issues = list(item.validationIssues || item.issues);
    const readiness = item.onboardingRequirements
      ? [
          "Signed brand agreement",
          "Sandbox Express onboarding",
          "Ship-from address",
          "Shipping table",
          "Support contact",
          "At least one approved product",
          "Passing sandbox order",
          "Healthy connection",
        ].map((name) => ({
          name,
          passed: !item.onboardingRequirements.includes(name),
        }))
      : item.readiness || item.goLiveChecklist || item.gates;
    return (
      <div className="overlay drawer-overlay" onClick={() => setDrawer(null)}>
        <aside
          className="drawer"
          aria-label={`${drawer.type} details`}
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="drawer-heading">
            <div>
              <span className="eyebrow">
                {drawer.type === "bag"
                  ? "FULFILLMENT BAG"
                  : drawer.type.toUpperCase()}
              </span>
              <h2>
                {drawer.type === "bag"
                  ? bagRef(item)
                  : drawer.type === "event"
                    ? item.type || item.eventType
                    : titleOf(item)}
              </h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close details"
              onClick={() => setDrawer(null)}
            >
              <X size={20} />
            </button>
          </div>
          <div className="drawer-body">
            <div className="detail-status">
              <Badge status={item.status} />
              <span className="tiny-tag">Sandbox</span>
            </div>
            {drawer.type === "brand" && (
              <>
                <div className="detail-intro">
                  <Avatar name={titleOf(item)} size="large" />
                  <p>
                    {item.description ||
                      "A thoughtful addition to the Avafem brand circle."}
                  </p>
                </div>
                <DetailList
                  rows={[
                    [
                      "Connection",
                      label(item.connectionTier || item.tier || "dashboard"),
                    ],
                    ["Support contact", item.supportEmail || item.email],
                    ["Return window", `${item.returnWindowDays ?? 30} days`],
                    [
                      "Commission",
                      item.commissionBps != null
                        ? `${item.commissionBps / 100}%`
                        : "Not set",
                    ],
                    ["Brand ID", item.id],
                  ]}
                />
                <h3 className="detail-label">Go-live readiness</h3>
                {readiness ? (
                  <div className="checklist">
                    {(Array.isArray(readiness)
                      ? readiness
                      : Object.entries(readiness).map(([name, value]) => ({
                          name,
                          passed: value === true || value?.passed,
                          ...(typeof value === "object" ? value : {}),
                        }))
                    ).map((gate, index) => (
                      <div key={gate.name || gate.key || index}>
                        <span
                          className={
                            gate.passed || gate.complete || gate.ready
                              ? "check-circle ready"
                              : "check-circle"
                          }
                        >
                          {gate.passed || gate.complete || gate.ready ? (
                            <Check size={12} />
                          ) : (
                            <Clock3 size={12} />
                          )}
                        </span>
                        <span>
                          {gate.label ||
                            label(gate.name || gate.key || "Readiness check")}
                          {gate.reason && <small>{gate.reason}</small>}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="setup-note">
                    <ShieldCheck size={18} />
                    <span>
                      Catalog approval, agreement, shipping setup, and payment
                      readiness are checked by the server before go-live.
                    </span>
                  </div>
                )}
                <div className="drawer-actions">
                  <Button
                    icon={Package}
                    onClick={() => {
                      navigate("catalog");
                      setDrawer(null);
                    }}
                  >
                    View catalog
                  </Button>
                  {owner && (
                    <Button
                      icon={Plug}
                      onClick={() => setModal({ type: "credentials", item })}
                    >
                      API access
                    </Button>
                  )}
                  {owner && (
                    <Button
                      kind="primary"
                      onClick={() => setModal({ type: "editBrand", item })}
                    >
                      Edit brand
                    </Button>
                  )}
                </div>
              </>
            )}
            {drawer.type === "product" && (
              <>
                <div className="product-preview">
                  <span className="product-preview-art">
                    <Leaf size={44} />
                  </span>
                  <div>
                    <h3>{titleOf(item)}</h3>
                    <p>{item.sku}</p>
                    <strong>{money(productPrice(item))}</strong>
                  </div>
                </div>
                <p className="detail-description">
                  {item.description || "No description supplied."}
                </p>
                <DetailList
                  rows={[
                    ["Brand", brandName(item.brandId, data.brands)],
                    ["Category", item.category],
                    ["Inventory", `${productQty(item)} units`],
                    ["Tax code", item.taxCode || item.tax_code],
                    [
                      "Shipping profile",
                      item.shippingProfile || item.shipping_profile,
                    ],
                  ]}
                />
                {issues.length > 0 && (
                  <div className="validation-box">
                    <h3>Validation needs attention</h3>
                    {issues.map((issue, index) => (
                      <p key={index}>
                        <AlertCircle size={14} />
                        {typeof issue === "string"
                          ? issue
                          : issue.message || issue.code}
                      </p>
                    ))}
                  </div>
                )}
                <h3 className="detail-label">Ingredients & evidence</h3>
                <p className="detail-description">
                  {(
                    evidence.ingredientsInci ||
                    evidence.ingredients_inci ||
                    item.ingredients ||
                    []
                  ).join?.(", ") || "No ingredient evidence supplied."}
                </p>
                <h3 className="detail-label">Product claims</h3>
                {list(evidence.claims || item.claims).length ? (
                  list(evidence.claims || item.claims).map((claim, index) => (
                    <div className="claim" key={index}>
                      <p>{typeof claim === "string" ? claim : claim.text}</p>
                      <span className="tiny-tag">
                        {label(claim.type || "Review required")}
                      </span>
                      {(claim.sourceUrl || claim.source_url) && (
                        <SafeLink href={claim.sourceUrl || claim.source_url}>
                          View evidence <ExternalLink size={12} />
                        </SafeLink>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="muted">No claims submitted.</p>
                )}
                <div className="drawer-actions">
                  <Button onClick={() => setModal({ type: "product", item })}>
                    Edit product
                  </Button>
                  {owner && item.status !== "approved" && (
                    <>
                      <Button
                        kind="danger"
                        onClick={() =>
                          setModal({ type: "rejectProduct", item })
                        }
                      >
                        Reject
                      </Button>
                      <Button
                        icon={Check}
                        kind="primary"
                        onClick={() =>
                          action(
                            `/api/products/${item.id}/review`,
                            { decision: "approved", status: "approved" },
                            "Product approved.",
                          )
                        }
                        loading={!!busy}
                      >
                        Approve
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
            {drawer.type === "bag" && (
              <>
                <div className="inline-banner compact">
                  <FlaskConical size={17} />
                  <div>
                    <strong>Synthetic shipping details</strong>
                    <span>This bag is for local testing. Do not ship.</span>
                  </div>
                </div>
                <DetailList
                  rows={[
                    ["Brand", brandName(item.brandId, data.brands)],
                    ["Created", longDate(item.createdAt)],
                    ["Shopper total", money(amountOf(item))],
                    ["Ship by", shortDate(item.shipBy)],
                    ["Bag ID", item.id],
                  ]}
                />
                <h3 className="detail-label">Items in this bag</h3>
                <div className="bag-items">
                  {list(item.items).map((line, index) => (
                    <div key={line.sku || index}>
                      <span className="product-art art-1">
                        <Leaf size={18} />
                      </span>
                      <span>
                        <strong>{line.title || line.sku}</strong>
                        <small>
                          {line.qty || line.quantity || 1} ×{" "}
                          {money(
                            line.unitPriceCents ||
                              line.unitPrice ||
                              line.unit_price,
                          )}
                        </small>
                      </span>
                      <strong>
                        {money(
                          Number(
                            line.unitPriceCents ||
                              line.unitPrice ||
                              line.unit_price ||
                              0,
                          ) * Number(line.qty || line.quantity || 1),
                        )}
                      </strong>
                    </div>
                  ))}
                </div>
                <h3 className="detail-label">
                  Ship to · minimum necessary data
                </h3>
                <address className="shipping-address">
                  {shipTo.name ||
                    [shipTo.firstName, shipTo.lastName]
                      .filter(Boolean)
                      .join(" ") ||
                    "Synthetic recipient"}
                  <br />
                  {shipTo.line1 || shipTo.address1 || "Address not available"}
                  {(shipTo.line2 || shipTo.address2) && (
                    <>
                      <br />
                      {shipTo.line2 || shipTo.address2}
                    </>
                  )}
                  <br />
                  {[
                    shipTo.city,
                    shipTo.region || shipTo.province,
                    shipTo.postal || shipTo.zip || shipTo.postalCode,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  <br />
                  {shipTo.country || shipTo.countryCode}
                </address>
                <h3 className="detail-label">Fulfillment timeline</h3>
                <div className="timeline">
                  <TimelineStep
                    done
                    title="Bag created"
                    text={longDate(item.createdAt)}
                  />
                  <TimelineStep
                    done={
                      shipments.length > 0 ||
                      !!item.shippedAt ||
                      ["shipped", "delivered"].includes(item.status)
                    }
                    title="Shipped"
                    text={
                      shipments.length
                        ? shipments
                            .map(
                              (s) =>
                                `${label(s.carrier)} · ${s.trackingNumber || s.tracking_number}`,
                            )
                            .join(" / ")
                        : item.trackingNumber || "Tracking not recorded yet"
                    }
                  />
                  <TimelineStep
                    done={!!item.deliveredAt || item.status === "delivered"}
                    title="Delivered"
                    text={
                      item.deliveredAt
                        ? longDate(item.deliveredAt)
                        : "Awaiting delivery confirmation"
                    }
                  />
                  <TimelineStep
                    done={["paid", "released"].includes(item.transfer?.status)}
                    title="Transfer & credit release"
                    text={
                      ["paid", "released"].includes(item.transfer?.status)
                        ? `Released in sandbox ${longDate(item.transfer.paidAt)}`
                        : item.payoutDueAt
                          ? `Eligible ${shortDate(item.payoutDueAt)}`
                          : "After return window"
                    }
                  />
                </div>
                <div className="drawer-actions">
                  {[
                    "awaiting_shipment",
                    "created",
                    "pushed",
                    "push_failed",
                    "partially_shipped",
                  ].includes(item.status) && (
                    <Button
                      kind="primary"
                      icon={Truck}
                      onClick={() => setModal({ type: "shipment", item })}
                    >
                      Enter tracking
                    </Button>
                  )}
                  {owner &&
                    ["shipped", "partially_shipped", "in_transit"].includes(
                      item.status,
                    ) && (
                      <Button
                        icon={CheckCircle2}
                        onClick={() =>
                          action(
                            `/api/bags/${item.id}/delivery`,
                            { source: "sandbox" },
                            "Sandbox delivery recorded. Release window has started.",
                          )
                        }
                        loading={!!busy}
                      >
                        Simulate delivery
                      </Button>
                    )}
                  {item.status !== "refunded" && (
                    <Button onClick={() => setModal({ type: "refund", item })}>
                      Request refund
                    </Button>
                  )}
                </div>
              </>
            )}
            {drawer.type === "event" && (
              <>
                <DetailList
                  rows={[
                    ["Event ID", item.id],
                    ["Recorded", longDate(item.createdAt)],
                    ["Attempts", item.attempts || 0],
                    ["Next attempt", longDate(item.nextAttemptAt)],
                    ["Last error", item.lastError || "None"],
                  ]}
                />
                <h3 className="detail-label">Payload</h3>
                <pre className="event-payload">
                  {JSON.stringify(item.payload || item.data || {}, null, 2)}
                </pre>
                {owner && (
                  <Button
                    icon={RefreshCw}
                    onClick={() =>
                      action(
                        `/api/events/${item.id}/replay`,
                        {},
                        "Event queued for replay.",
                      )
                    }
                    loading={!!busy}
                  >
                    Replay delivery
                  </Button>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    );
  }

  function FormModal() {
    const item = modal.item || {};
    const title = {
      brand: "Welcome a new brand",
      editBrand: "Brand settings",
      product: item.id ? "Edit product" : "Add a product",
      shipment: "Record a shipment",
      refund: "Request a refund",
      approveRefund: "Approve refund proposal",
      rejectProduct: "Send product back for edits",
      stripe: "Stripe test setup",
      credentials: "Brand API access",
      stripeCredentials: "Configure Stripe test credentials",
    }[modal.type];
    async function reloadCredentials() {
      try {
        setApiCredentials(
          list(await request(`/api/brands/${item.id}/credentials`)),
        );
      } catch (err) {
        notify(err.message, "error");
      }
    }
    async function submit(e) {
      e.preventDefault();
      setFormError("");
      if (modal.type === 'stripeCredentials') {
        if (busy) return;
        const form = e.currentTarget;
        setBusy('stripe-test-credentials');
        try {
          await configureStripeTestCredentials({form,csrfToken:csrf.current,hostname:window.location.hostname,isOwner:localStripeOwner});
          closeModal();
          await refresh();
          notify('Stripe test credentials verified. No charge was created.');
        } catch (err) { setFormError(err.message); }
        finally { setBusy(''); }
        return;
      }
      const formData = new FormData(e.target);
      const values = Object.fromEntries(formData);
      let result;
      if (modal.type === "credentials") {
        result = await action(
          `/api/brands/${item.id}/credentials`,
          {
            kind: values.kind,
            label: values.label,
            scopes: formData.getAll("scopes"),
          },
          "Sandbox credential created. Save the secret before closing.",
        );
        if (result) {
          setCredentialResult(result);
          await reloadCredentials();
        }
      } else if (modal.type === "brand" || modal.type === "editBrand") {
        const payload = {
          name: values.name,
          supportEmail: values.supportEmail,
          connectionTier: values.connectionTier,
          commissionBps: Math.round(Number(values.commission) * 100),
          returnWindowDays: Number(values.returnWindowDays),
          shippingTable: [
            {
              country: "US",
              priceCents: Math.round(Number(values.shipping) * 100),
            },
          ],
          shipFromAddress: {
            name: values.name,
            line1: values.address,
            city: values.city,
            region: values.region,
            postal: values.postal,
            country: "US",
          },
          agreementSigned: values.agreementSigned === "on",
          ...(values.status ? { status: values.status } : {}),
          ...(values.sandboxExpress === "on"
            ? {
                stripeAccountId:
                  item.stripeAccountId ||
                  `acct_sandbox_${values.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
                chargesEnabled: true,
                payoutsEnabled: true,
              }
            : { chargesEnabled: false, payoutsEnabled: false }),
          connectionHealthy: values.connectionHealthy === "on",
          testOrderPassed: values.testOrderPassed === "on",
        };
        result = await action(
          modal.type === "brand" ? "/api/brands" : `/api/brands/${item.id}`,
          payload,
          modal.type === "brand"
            ? "Brand profile created. Complete the readiness checklist to go live."
            : "Brand settings saved.",
          modal.type === "brand" ? "POST" : "PATCH",
        );
      } else if (modal.type === "product") {
        const brandId = session?.brandId || values.brandId || item.brandId;
        if (!brandId) {
          setFormError("Select a brand for this product.");
          return;
        }
        const price = Math.round(Number(values.price) * 100),
          qty = Number(values.quantity);
        const payload = {
          sku: values.sku,
          title: values.title,
          description: values.description,
          category: values.category,
          priceCents: price,
          inventoryQty: qty,
          images: [values.image, ...(item.images || []).slice(1)].filter(
            Boolean,
          ),
          taxCode: values.taxCode,
          shippingProfile: "standard",
          status: "in_review",
          variants: (item.variants || []).map((variant) =>
            variant.sku === values.sku
              ? {
                  ...variant,
                  price: { ...variant.price, amount: price },
                  inventory: { ...variant.inventory, qty },
                }
              : variant,
          ),
          evidence: {
            ...item.evidence,
            ingredients_inci: values.ingredients
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            certifications: item.evidence?.certifications || [],
            claims: values.claim
              ? [
                  {
                    text: values.claim,
                    source_url: values.source,
                    type: item.evidence?.claims?.[0]?.type || "health",
                  },
                  ...(item.evidence?.claims || []).slice(1),
                ]
              : (item.evidence?.claims || []).slice(1),
            contraindications: item.evidence?.contraindications || "",
          },
        };
        result = await action(
          `/api/brands/${brandId}/products/${encodeURIComponent(values.sku)}`,
          payload,
          "Product saved and validation updated.",
          "PUT",
        );
      } else if (modal.type === "shipment")
        result = await action(
          `/api/bags/${item.id}/shipments`,
          {
            carrier: values.carrier,
            trackingNumber: values.trackingNumber,
            trackingUrl: values.trackingUrl || null,
          },
          "Shipment recorded for this sandbox bag.",
        );
      else if (modal.type === "refund")
        result = await action(
          `/api/bags/${item.id}/refunds`,
          {
            reason: values.reason,
            ...(values.amount
              ? { amountCents: Math.round(Number(values.amount) * 100) }
              : {}),
          },
          "Refund proposal created for human review.",
        );
      else if (modal.type === "approveRefund")
        result = await action(
          `/api/refunds/${item.id}/approve`,
          {},
          "Sandbox refund approved and ledger updated.",
        );
      else if (modal.type === "rejectProduct")
        result = await action(
          `/api/products/${item.id}/review`,
          {
            decision: "rejected",
            status: "rejected",
            note: values.reason,
            reason: values.reason,
          },
          "Product returned with feedback.",
        );
      if (result && modal.type !== "credentials") setModal(null);
    }
    return (
      <div className="overlay modal-overlay" onClick={closeModal}>
        <section
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-heading">
            <div>
              <span className="eyebrow">BRAND CONNECT · SANDBOX</span>
              <h2 id="modal-title">{title}</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close dialog"
              onClick={closeModal}
            >
              <X size={19} />
            </button>
          </div>
          {modal.type === "stripe" ? (
            <div className="modal-body">
              <p>
                Use Configure test credentials in this local operations workspace to paste a Stripe test secret key into a masked field. Verification reads account access and creates no charge.
              </p>
              <p className="muted">
                The local entry stores credentials only in server process memory, cleared on restart. Credentials are not saved to project files, the database, browser storage, or logs. Payment and transfer workflows still require separate testing.
              </p>
              <Button onClick={() => setModal(null)}>Got it</Button>
            </div>
          ) : (
            <form ref={modalFormRef} onSubmit={submit}>
              <div className="modal-body form-fields">
                {modal.type === 'stripeCredentials' && localStripeAllowed && <>
                  <p>Paste your Stripe test credentials into these masked fields. The local server verifies account access without creating a charge.</p>
                  <Field label="Stripe test secret key" name="stripeTestSecretKey" type="password" placeholder="sk_test_…" autoComplete="off" spellCheck={false} required />
                  <Field label="Webhook signing secret (optional)" name="stripeWebhookSigningSecret" type="password" placeholder="whsec_…" autoComplete="off" spellCheck={false} />
                  <div className="setup-note"><ShieldCheck size={17} /><span>Stored only in server process memory; cleared on restart. Not saved to project files, the database, browser storage, or logs. The fields clear when saved or closed.</span></div>
                </>}
                {modal.type === "credentials" && (
                  <>
                    <p>
                      Credentials are scoped to {titleOf(item)} and work only in
                      this local sandbox. OAuth tokens expire after one hour.
                    </p>
                    {apiCredentials.length > 0 && (
                      <div className="credential-list">
                        {apiCredentials.map((credential) => (
                          <div key={credential.id}>
                            <span>
                              <strong>{credential.label}</strong>
                              <small>
                                {label(credential.kind)} · {credential.id}
                              </small>
                            </span>
                            <Badge
                              status={credential.active ? "active" : "revoked"}
                            />
                            {credential.active && (
                              <Button
                                small
                                kind="danger"
                                type="button"
                                onClick={async () => {
                                  const revoked = await action(
                                    `/api/brands/${item.id}/credentials/${credential.id}`,
                                    {},
                                    "Sandbox credential revoked.",
                                    "DELETE",
                                  );
                                  if (revoked) await reloadCredentials();
                                }}
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {credentialResult ? (
                      <div className="credential-result">
                        <h3>Save this secret now</h3>
                        <p>
                          It will not be shown again after closing this dialog.
                        </p>
                        {credentialResult.clientId && (
                          <Field
                            label="OAuth client ID"
                            readOnly
                            value={credentialResult.clientId}
                          />
                        )}
                        <div className="secret-copy">
                          <Field
                            label={
                              credentialResult.apiKey
                                ? "Sandbox API key"
                                : "OAuth client secret"
                            }
                            type="password"
                            readOnly
                            value={
                              credentialResult.apiKey ||
                              credentialResult.clientSecret
                            }
                          />
                          <Button
                            type="button"
                            icon={Copy}
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(
                                  credentialResult.apiKey ||
                                    credentialResult.clientSecret,
                                );
                                notify("Secret copied to clipboard.");
                              } catch {
                                notify(
                                  "Clipboard unavailable. Select and copy the secret from the field.",
                                  "error",
                                );
                              }
                            }}
                          >
                            Copy
                          </Button>
                        </div>
                        <p className="muted">
                          Token endpoint: <code>/oauth/token</code> · API:{" "}
                          <code>/v1</code> · MCP: <code>/mcp</code>
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="form-grid">
                          <Field
                            label="Credential label"
                            name="label"
                            placeholder="Brand warehouse integration"
                            required
                          />
                          <Field
                            label="Credential type"
                            name="kind"
                            as="select"
                            defaultValue="oauth_client"
                          >
                            <option value="oauth_client">OAuth client</option>
                            <option value="api_key">
                              Static sandbox API key
                            </option>
                          </Field>
                        </div>
                        <p className="form-section-label">
                          Choose access scopes
                        </p>
                        <div className="scope-options">
                          {[
                            "catalog:read",
                            "catalog:write",
                            "orders:read",
                            "orders:fulfill",
                            "payouts:read",
                            "refunds:write",
                          ].map((scope) => (
                            <label className="checkbox-field" key={scope}>
                              <input
                                type="checkbox"
                                name="scopes"
                                value={scope}
                                defaultChecked={[
                                  "catalog:read",
                                  "orders:read",
                                  "payouts:read",
                                ].includes(scope)}
                              />
                              <span>{scope}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
                {["brand", "editBrand"].includes(modal.type) && (
                  <>
                    <Field
                      label="Brand name"
                      name="name"
                      required
                      defaultValue={item.name}
                      placeholder="Brand name"
                    />
                    <div className="form-grid">
                      <Field
                        label="Support email"
                        name="supportEmail"
                        type="email"
                        required
                        defaultValue={item.supportEmail || item.email}
                        placeholder="hello@brand.example"
                      />
                      <Field
                        label="Connection tier"
                        name="connectionTier"
                        as="select"
                        defaultValue={item.connectionTier || "dashboard"}
                      >
                        <option value="dashboard">Dashboard / manual</option>
                        <option value="shopify">Shopify</option>
                        <option value="api">Direct API</option>
                      </Field>
                    </div>
                    <div className="form-grid three">
                      <Field
                        label="Commission (%)"
                        name="commission"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        defaultValue={(item.commissionBps ?? 1500) / 100}
                        required
                      />
                      <Field
                        label="Returns (days)"
                        name="returnWindowDays"
                        type="number"
                        min="0"
                        max="365"
                        defaultValue={item.returnWindowDays ?? 30}
                        required
                      />
                      <Field
                        label="Shipping ($)"
                        name="shipping"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={
                          (item.shippingTable?.[0]?.priceCents ??
                            item.shippingCents ??
                            599) / 100
                        }
                        required
                      />
                    </div>
                    <p className="form-section-label">
                      Ship-from address · synthetic test data only
                    </p>
                    <Field
                      label="Street address"
                      name="address"
                      placeholder="100 Test Avenue"
                      defaultValue={item.shipFromAddress?.line1}
                      required
                    />
                    <div className="form-grid three">
                      <Field
                        label="City"
                        name="city"
                        placeholder="Austin"
                        defaultValue={item.shipFromAddress?.city}
                        required
                      />
                      <Field
                        label="State"
                        name="region"
                        placeholder="TX"
                        maxLength="2"
                        defaultValue={item.shipFromAddress?.region}
                        required
                      />
                      <Field
                        label="ZIP"
                        name="postal"
                        placeholder="78701"
                        defaultValue={item.shipFromAddress?.postal}
                        required
                      />
                    </div>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        name="agreementSigned"
                        defaultChecked={item.agreementSigned}
                      />
                      <span>Agreement recorded for this sandbox brand</span>
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        name="sandboxExpress"
                        defaultChecked={
                          item.chargesEnabled && item.payoutsEnabled
                        }
                      />
                      <span>
                        Enable simulated Express readiness · no Stripe account
                        is created
                      </span>
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        name="connectionHealthy"
                        defaultChecked={item.connectionHealthy ?? true}
                      />
                      <span>Connection checked for this sandbox brand</span>
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        name="testOrderPassed"
                        defaultChecked={item.testOrderPassed}
                      />
                      <span>
                        Passing sandbox test order verified by operations
                      </span>
                    </label>
                    {item.id && (
                      <Field
                        label="Brand status"
                        name="status"
                        as="select"
                        defaultValue={item.status}
                      >
                        <option value="onboarding">Onboarding</option>
                        <option value="ready">Ready in sandbox</option>
                        <option value="live">
                          Listings enabled in sandbox
                        </option>
                        <option value="paused">Paused</option>
                        <option value="disconnected">Disconnected</option>
                        <option value="invited">Invited</option>
                      </Field>
                    )}
                  </>
                )}
                {modal.type === "product" && (
                  <>
                    {!session?.brandId && (
                      <Field
                        label="Brand"
                        name="brandId"
                        as="select"
                        required
                        defaultValue={item.brandId || ""}
                      >
                        <option value="" disabled>
                          Select a brand
                        </option>
                        {data.brands.map((b) => (
                          <option value={b.id} key={b.id}>
                            {titleOf(b)}
                          </option>
                        ))}
                      </Field>
                    )}
                    <div className="form-grid">
                      <Field
                        label="Product title"
                        name="title"
                        required
                        defaultValue={item.title}
                        placeholder="Daily care essentials"
                      />
                      <Field
                        label="SKU"
                        name="sku"
                        required
                        defaultValue={item.sku}
                        placeholder="BRD-DAILY-01"
                        readOnly={!!item.id}
                      />
                    </div>
                    <Field
                      label="Description"
                      name="description"
                      as="textarea"
                      required
                      defaultValue={item.description}
                      rows="3"
                      placeholder="A clear, factual product description."
                    />
                    <div className="form-grid three">
                      <Field
                        label="Category"
                        name="category"
                        defaultValue={item.category || "period-care"}
                        required
                      />
                      <Field
                        label="Price ($)"
                        name="price"
                        type="number"
                        min="0.01"
                        step="0.01"
                        defaultValue={item.id ? productPrice(item) / 100 : ""}
                        required
                      />
                      <Field
                        label="Inventory"
                        name="quantity"
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={item.id ? productQty(item) : 0}
                        required
                      />
                    </div>
                    <Field
                      label="Product image URL (HTTPS)"
                      name="image"
                      type="url"
                      required
                      defaultValue={item.images?.[0]}
                      placeholder="https://your-brand.example/product.jpg"
                    />
                    <Field
                      label="Tax code"
                      name="taxCode"
                      defaultValue={item.taxCode || item.tax_code || ""}
                      placeholder="txcd_…"
                      required
                    />
                    <Field
                      label="Ingredients / materials · comma separated"
                      name="ingredients"
                      required
                      defaultValue={(
                        item.evidence?.ingredientsInci ||
                        item.evidence?.ingredients_inci ||
                        []
                      ).join(", ")}
                      placeholder="Organic cotton, …"
                    />
                    <Field
                      label="Health or efficacy claim (optional)"
                      name="claim"
                      as="textarea"
                      rows="2"
                      defaultValue={item.evidence?.claims?.[0]?.text}
                      placeholder="Claims are sent for human review."
                    />
                    <Field
                      label="Claim evidence URL (if applicable)"
                      name="source"
                      type="url"
                      defaultValue={
                        item.evidence?.claims?.[0]?.sourceUrl ||
                        item.evidence?.claims?.[0]?.source_url
                      }
                      placeholder="https://…"
                    />
                    <div className="setup-note">
                      <FileCheck2 size={16} />
                      <span>
                        Required data is validated on save. Human approval is
                        required before listings can go live.
                      </span>
                    </div>
                  </>
                )}
                {modal.type === "shipment" && (
                  <>
                    <div className="inline-banner compact">
                      <FlaskConical size={17} />
                      <div>
                        <strong>Sandbox shipment</strong>
                        <span>
                          Enter synthetic tracking. No carrier shipment is
                          purchased.
                        </span>
                      </div>
                    </div>
                    <Field label="Carrier" name="carrier" as="select" required>
                      <option value="usps">USPS</option>
                      <option value="ups">UPS</option>
                      <option value="fedex">FedEx</option>
                      <option value="other">Other</option>
                    </Field>
                    <Field
                      label="Tracking number"
                      name="trackingNumber"
                      defaultValue={`TEST-${item.id?.slice(-8).toUpperCase()}`}
                      required
                    />
                    <Field
                      label="Tracking URL (optional)"
                      name="trackingUrl"
                      type="url"
                      placeholder="https://…"
                    />
                    <p className="muted">
                      All remaining bag items will be included in this shipment.
                    </p>
                  </>
                )}
                {modal.type === "refund" && (
                  <>
                    <p>
                      Send a proposal to Avafem operations. Approval updates the
                      sandbox ledger, transfer allocation, and related credits.
                    </p>
                    <Field
                      label="Reason"
                      name="reason"
                      as="textarea"
                      rows="3"
                      required
                      placeholder="Explain why this refund is requested."
                    />
                    <Field
                      label="Full bag refund ($)"
                      name="amount"
                      type="number"
                      min="0.01"
                      max={amountOf(item) / 100}
                      step="0.01"
                      defaultValue={amountOf(item) / 100}
                      required
                      readOnly
                    />
                    <p className="muted">
                      The sandbox currently supports full bag refunds. Shopper
                      total: {money(amountOf(item))}. Brand transfers and
                      shopper refunds are accounted for separately.
                    </p>
                  </>
                )}
                {modal.type === "approveRefund" && (
                  <>
                    <div className="approval-amount">
                      {money(item.amountCents || item.amount)}
                    </div>
                    <p>{item.reason}</p>
                    <DetailList
                      rows={[
                        ["Proposal", item.id],
                        ["Bag", item.bagId],
                      ]}
                    />
                    <div className="setup-note">
                      <FlaskConical size={17} />
                      <span>
                        This records a sandbox refund. No real funds move.
                      </span>
                    </div>
                  </>
                )}
                {modal.type === "rejectProduct" && (
                  <>
                    <p>Leave a clear note so the brand knows what to change.</p>
                    <Field
                      label="Review feedback"
                      name="reason"
                      as="textarea"
                      rows="4"
                      required
                      placeholder="What needs to be corrected or substantiated?"
                    />
                  </>
                )}
                {formError && (
                  <p className="form-error" role="alert">
                    {formError}
                  </p>
                )}
              </div>
              <div className="modal-footer">
                <Button type="button" onClick={closeModal}>
                  Cancel
                </Button>
                {credentialResult && modal.type === "credentials" ? (
                  <Button
                    type="button"
                    kind="primary"
                    onClick={() => setModal(null)}
                  >
                    Done
                  </Button>
                ) : (
                  <Button type="submit" kind="primary" loading={!!busy} disabled={modal.type === 'stripeCredentials' && !localStripeAllowed}>
                    {modal.type === 'stripeCredentials' ? 'Verify & keep for this session' : modal.type === "approveRefund"
                      ? "Approve sandbox refund"
                      : modal.type === "shipment"
                        ? "Save tracking"
                        : modal.type === "refund"
                          ? "Create proposal"
                          : modal.type === "rejectProduct"
                            ? "Send feedback"
                            : modal.type === "product"
                              ? "Save product"
                              : modal.type === "credentials"
                                ? "Generate sandbox credential"
                                : "Save brand"}
                  </Button>
                )}
              </div>
            </form>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className={cls("sidebar", mobileNav && "is-open")}>
        <a
          className="wordmark"
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span className="brand-mark">
            <Leaf size={22} strokeWidth={1.6} />
          </span>
          avafem<span className="wordmark-dot">®</span>
        </a>
        <div className="workspace-label">BRAND CONNECT</div>
        <nav aria-label="Main navigation">
          {NAV.filter(([id]) => owner || !["connections","commerce"].includes(id)).map(
            ([id, name, Icon]) => (
              <button
                className={cls("nav-item", page === id && "active")}
                key={id}
                onClick={() => navigate(id)}
              >
                <Icon size={18} />
                <span>{name}</span>
                {id === "catalog" && reviewProducts.length > 0 && (
                  <span className="nav-count">{reviewProducts.length}</span>
                )}
                {page === id && <span className="nav-active-dot" />}
              </button>
            ),
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sandbox-sidebar">
            <span className="square-icon">
              <FlaskConical size={17} />
            </span>
            <strong>A safe place to build</strong>
            <p>
              Your local sandbox.
              <br />
              No real charges or payouts.
            </p>
            <button onClick={() => navigate(owner ? "connections" : "events")}>
              {owner ? "Check connections" : "View your events"}{" "}
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="workspace-switch">
            <Avatar name={selectedBrand ? titleOf(selectedBrand) : "Avafem"} />
            <div>
              <label htmlFor="workspace-select">
                {selectedBrand ? "Brand workspace" : "Avafem operations"}
              </label>
              <select
                id="workspace-select"
                value={session?.brandId || ""}
                onChange={(e) => switchBrand(e.target.value)}
                disabled={!!busy || !session || !session.owner}
              >
                <option value="">Owner / admin</option>
                {brandList.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {titleOf(brand)}
                  </option>
                ))}
              </select>
            </div>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-location">
            <button
              className="icon-button mobile-menu"
              aria-label="Toggle navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={20} />
            </button>
            <span>Brand Connect</span>
            <ChevronRight size={13} />
            <strong>{NAV.find((n) => n[0] === page)?.[1]}</strong>
          </div>
          <div className="topbar-right">
            <span className="sandbox-tag">
              <span />
              Local sandbox
            </span>
            <span className="topbar-divider" />
            <Avatar name={owner ? "A" : titleOf(selectedBrand)} size="small" />
          </div>
        </header>
        <main>
          <div className="environment-line">
            <span>
              <FlaskConical size={13} />
              Development workspace · synthetic shopper data · no real funds
            </span>
            <span className="sync-label">
              <span className={loading ? "sync-dot syncing" : "sync-dot"} />
              {loading
                ? "Syncing…"
                : refreshAt
                  ? `Updated ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(refreshAt))}`
                  : "Offline"}
            </span>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <Button
                small
                onClick={async () => {
                  setLoading(true);
                  await refresh();
                }}
              >
                Retry
              </Button>
            </div>
          )}
          {loading && !refreshAt ? (
            <div className="loading-screen">
              <LoaderCircle size={28} className="spin" />
              <h2>Bringing your workspace together</h2>
              <p>Loading brands, bags, and connection health…</p>
            </div>
          ) : (
            <WorkspaceErrorBoundary
              key={page}
              onRecover={async () => {
                await refresh();
                navigate("overview");
              }}
            >
              {page === "overview" && Overview()}
              {page === "brands" && Brands()}
              {page === "catalog" && Catalog()}
              {page === "orders" && Orders()}
              {page === "finance" && Finance()}
              {page === "commerce" && owner && <React.Suspense fallback={<div className="loading-screen" role="status"><LoaderCircle className="spin" size={26}/><h2>Opening commerce controls</h2><p>Loading the local admin interface…</p></div>}><CommercePanel key={`${session?.brandId || 'owner'}:${session?.role || ''}`} request={request} owner={owner} session={session}/></React.Suspense>}
              {page === "connections" && Connections()}
              {page === "events" && Events()}
              {page === "platform" && <PlatformPanel key={`${session?.brandId || 'owner'}:${session?.role || ''}`} request={request} owner={owner} session={session} />}
            </WorkspaceErrorBoundary>
          )}
          <footer className="main-footer">
            <span>Thoughtful connections. Better care.</span>
            <span>
              Avafem Brand Connect <span className="footer-dot">·</span> Local
              sandbox
            </span>
          </footer>
        </main>
      </div>
      {drawer && <DetailDrawer />}
      {modal && FormModal()}
      {toast && (
        <div
          className={cls("toast", toast.tone === "error" && "toast-error")}
          role="status"
          aria-live="polite"
        >
          {toast.tone === "error" ? (
            <AlertCircle size={19} />
          ) : (
            <CheckCircle2 size={19} />
          )}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label: text, as = "input", children, className, ...props }) {
  const Tag = as;
  return (
    <label className={cls("field", className)}>
      <span>{text}</span>
      <Tag {...props}>{children}</Tag>
    </label>
  );
}
function DetailList({ rows }) {
  return (
    <dl className="detail-list">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{displayLabel(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
function TimelineStep({ done, title, text }) {
  return (
    <div className={cls("timeline-step", done && "done")}>
      <span>{done ? <Check size={11} /> : <span />}</span>
      <div>
        <strong>{title}</strong>
        <small>{text}</small>
      </div>
    </div>
  );
}
function SafeLink({ href, children }) {
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return (
      <a href={url.href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  } catch {
    return null;
  }
}

class WorkspaceErrorBoundary extends React.Component {
  state = { hasError: false, recovering: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  recover = async () => {
    this.setState({ recovering: true });
    try {
      await this.props.onRecover?.();
    } finally {
      this.setState({ hasError: false, recovering: false });
    }
  };
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <section className="render-error card" role="alert">
        <span className="empty-icon">
          <AlertCircle size={26} />
        </span>
        <h2>This view needs a refresh</h2>
        <p>
          A connection returned an unexpected value. Your saved records are
          still available. Reload the workspace to continue.
        </p>
        <Button
          icon={RefreshCw}
          kind="primary"
          onClick={this.recover}
          loading={this.state.recovering}
        >
          Recover workspace
        </Button>
      </section>
    );
  }
}

async function accessRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body
      ? {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        }
      : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(
        displayLabel(
          payload.error?.message || payload.message,
          `This link could not be opened (${response.status}).`,
        ),
      ),
      { status: response.status },
    );
  return payload.data ?? payload;
}

/** Capability links are deliberately mounted without the operations session bootstrap. */
function AccessPage({ kind, token }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const handoff = kind === "handoff";
  const endpoint = `/api/${handoff ? "handoffs" : "invites"}/${encodeURIComponent(token)}`;
  useEffect(() => {
    document.title = handoff
      ? "Ship this bag · Avafem"
      : "Welcome to Avafem Brand Connect";
    const controller = new AbortController();
    setLoading(true);
    setError("");
    accessRequest(endpoint, { signal: controller.signal })
      .then((value) => {
        setPayload(value);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [endpoint, handoff]);
  async function submit(event) {
    event.preventDefault();
    if (submitting || submitted || (!handoff && !accepted)) return;
    setSubmitting(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.target));
    try {
      await accessRequest(`${endpoint}/${handoff ? "shipments" : "accept"}`, {
        method: "POST",
        body: handoff
          ? {
              carrier: values.carrier,
              trackingNumber: values.trackingNumber,
              trackingUrl: values.trackingUrl || undefined,
            }
          : { acceptedSandboxTerms: true },
      });
      setSubmitted(true);
      if (!handoff) window.location.assign("/");
    } catch (err) {
      setError(err.message);
      if ([401, 403, 404, 410].includes(err.status)) setPayload(null);
    } finally {
      setSubmitting(false);
    }
  }
  const bag = normalizeHandoffBag(payload?.bag);
  const shipTo = bag.shipTo || {};
  return (
    <div className="access-shell">
      <header className="access-header">
        <div className="wordmark">
          <span className="brand-mark">
            <Leaf size={23} strokeWidth={1.6} />
          </span>
          avafem<span className="wordmark-dot">®</span>
        </div>
        <span className="sandbox-tag">
          <span />
          Sandbox access link
        </span>
      </header>
      <main className="access-main">
        {loading ? (
          <div className="loading-screen">
            <LoaderCircle className="spin" size={27} />
            <h2>Opening your secure link</h2>
            <p>
              Loading your {handoff ? "fulfillment bag" : "brand invitation"}…
            </p>
          </div>
        ) : !payload ? (
          <section className="card access-card access-unavailable" role="alert">
            <span className="empty-icon">
              <Clock3 size={26} />
            </span>
            <h1>This link isn’t available</h1>
            <p>
              {error ||
                "The link has expired, has already been used, or is invalid."}
            </p>
            <small>
              Ask Avafem operations for a fresh{" "}
              {handoff ? "fulfillment" : "invitation"} link.
            </small>
          </section>
        ) : submitted ? (
          <section
            className="card access-card access-unavailable"
            role="status"
          >
            <span className="empty-icon">
              <CheckCircle2 size={27} />
            </span>
            <h1>
              {handoff ? "Tracking recorded." : "You’re ready to connect."}
            </h1>
            <p>
              {handoff
                ? "This sandbox bag now has tracking. You can close this page."
                : "Opening your brand workspace…"}
            </p>
            <span className="tiny-tag">
              {handoff ? "This link has been used" : "Sandbox terms accepted"}
            </span>
          </section>
        ) : (
          <>
            <SectionTitle
              eyebrow={
                handoff
                  ? "A LITTLE CARE, ON ITS WAY"
                  : "WELCOME TO YOUR BRAND CIRCLE"
              }
              title={
                handoff
                  ? "Ship this bag"
                  : `Welcome, ${displayLabel(payload.brand, "brand partner")}.`
              }
              subtitle={
                handoff
                  ? "Everything you need to fulfill this one bag."
                  : "Accept the sandbox draft terms to open your brand workspace."
              }
            />
            <div className="inline-banner">
              <FlaskConical size={17} />
              <div>
                <strong>
                  {handoff
                    ? "Synthetic bag · do not ship"
                    : "Sandbox invitation"}
                </strong>
                <span>
                  {handoff
                    ? "Use synthetic tracking to test the workflow. No actual shipment is requested."
                    : "This invitation opens a local test workspace. No live charges or payouts."}
                </span>
              </div>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <AlertCircle size={17} />
                <span>{error}</span>
              </div>
            )}
            <section className="card access-card">
              {handoff ? (
                <>
                  <CardHeading
                    title={bagRef(bag)}
                    subtitle={displayLabel(bag.brandName, "Brand fulfillment")}
                    action={bag.status ? <Badge status={bag.status} /> : undefined}
                  />
                  <div className="access-card-body">
                    <h3 className="detail-label">Items in this bag</h3>
                    <div className="bag-items">
                      {list(bag.items).map((item, index) => (
                        <div key={item.sku || index}>
                          <span className="product-art art-1">
                            <Leaf size={18} />
                          </span>
                          <span>
                            <strong>
                              {displayLabel(item.title || item.sku)}
                            </strong>
                            <small>{displayLabel(item.sku)}</small>
                          </span>
                          <strong>
                            Qty {displayLabel(item.qty)}
                          </strong>
                        </div>
                      ))}
                    </div>
                    <h3 className="detail-label">
                      Ship-to details · synthetic test recipient
                    </h3>
                    <address className="shipping-address">
                      {displayLabel(shipTo.name)}
                      <br />
                      {displayLabel(shipTo.line1)}
                      {shipTo.line2 && (
                        <>
                          <br />
                          {displayLabel(shipTo.line2)}
                        </>
                      )}
                      <br />
                      {[shipTo.city, shipTo.region, shipTo.postal]
                        .filter((value) => typeof value === "string")
                        .join(", ")}
                      <br />
                      {displayLabel(shipTo.country)}
                    </address>
                    <h3 className="detail-label">Add tracking</h3>
                    <form onSubmit={submit} className="form-fields">
                      <div className="form-grid">
                        <Field
                          label="Carrier"
                          name="carrier"
                          as="select"
                          required
                        >
                          <option value="usps">USPS</option>
                          <option value="ups">UPS</option>
                          <option value="fedex">FedEx</option>
                          <option value="other">Other</option>
                        </Field>
                        <Field
                          label="Tracking number"
                          name="trackingNumber"
                          required
                          placeholder="SANDBOX-TRACK-001"
                        />
                      </div>
                      <Field
                        label="Tracking URL (optional)"
                        name="trackingUrl"
                        type="url"
                        placeholder="https://…"
                      />
                      <Button
                        kind="primary"
                        icon={Truck}
                        type="submit"
                        loading={submitting}
                      >
                        Save sandbox tracking
                      </Button>
                    </form>
                  </div>
                </>
              ) : (
                <div className="access-card-body">
                  <span className="square-icon lilac">
                    <Store size={22} />
                  </span>
                  <h2>Your next chapter, connected.</h2>
                  <p className="access-intro">
                    Your brand workspace brings catalog details, fulfillment
                    bags, and payout reporting into one place. This invitation
                    accepts the sandbox draft terms for a test account.
                  </p>
                  <form onSubmit={submit} className="form-fields">
                    <label className="checkbox-field access-terms">
                      <input
                        type="checkbox"
                        checked={accepted}
                        onChange={(event) => setAccepted(event.target.checked)}
                        required
                      />
                      <span>Accept sandbox draft terms for this test</span>
                    </label>
                    <Button
                      kind="primary"
                      type="submit"
                      icon={ArrowRight}
                      loading={submitting}
                      disabled={!accepted}
                    >
                      Accept & open workspace
                    </Button>
                  </form>
                </div>
              )}
            </section>
            <p className="access-expiry">
              <Clock3 size={12} />
              This link expires {longDate(payload.expiresAt)}.
            </p>
          </>
        )}
        <footer className="main-footer">
          <span>Thoughtful connections. Better care.</span>
          <span>Avafem Brand Connect · Sandbox</span>
        </footer>
      </main>
    </div>
  );
}

const accessRoute = resolveAccessRoute(window.location.pathname);
// The brand portal owns its own session; it never bootstraps the owner workspace.
const brandPortalRoute = /^\/brand(\/|$)/.test(window.location.pathname);
createRoot(document.getElementById("root")).render(
  <WorkspaceErrorBoundary onRecover={() => window.location.reload()}>
    {brandPortalRoute ? <BrandPortal /> : accessRoute ? (
      accessRoute.kind==='invite' ? <BrandOnboarding token={accessRoute.token}/> : <AccessPage kind={accessRoute.kind} token={accessRoute.token} />
    ) : (
      <App />
    )}
  </WorkspaceErrorBoundary>,
);
