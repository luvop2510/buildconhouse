// Privacy-preserving, opt-in production monitoring. A build without a Sentry
// DSN stays completely inert; when configured, telemetry contains only route
// templates and numeric timings — never customer data, query strings, request
// bodies, user context, or navigation breadcrumbs.

const DEFAULT_TRACE_SAMPLE_RATE = 0.05;
const DEFAULT_WEB_VITAL_SAMPLE_RATE = 0.1;
const SAFE_ROUTE_SEGMENTS = new Set([
  "admin", "auth", "customer", "catalog", "customers", "dashboard", "followups",
  "login", "notifications", "payments", "purchases", "quotations", "sales-data",
  "settings", "tiles", "walkins", "privacy", "terms", "new", "edit", "index",
  "brands", "orders", "selection", "quotation", "notebook", "today", "executive",
]);

let sentryReady: Promise<typeof import("@sentry/react-native")> | null = null;
let performanceSignalsStarted = false;

function configuredDsn(): string {
  return (process.env.EXPO_PUBLIC_SENTRY_DSN || "").trim();
}

function sampleRate(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function routeTemplate(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length) return "/";
  return `/${segments.map((segment) => SAFE_ROUTE_SEGMENTS.has(segment) ? segment : ":id").join("/")}`;
}

function safeEvent(event: any): any {
  const trace = event.contexts?.trace;
  const metric = event.tags?.metric;
  const isMetric = event.message === "web_vital" && ["dom_content_loaded_ms", "load_ms", "lcp_ms", "cls", "inp_ms", "long_task_ms"].includes(metric);
  // An allowlist is essential: SDK extras, exception messages, source context,
  // span descriptions and tags may contain credentials or customer records.
  return {
    event_id: /^[a-f0-9]{32}$/i.test(event.event_id || "") ? event.event_id : undefined,
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : undefined,
    platform: "javascript",
    level: ["error", "warning", "info", "fatal", "debug"].includes(event.level) ? event.level : "error",
    request: undefined, user: undefined, breadcrumbs: [],
    message: isMetric ? "web_vital" : undefined,
    tags: isMetric ? { metric, route: routeTemplate(event.tags?.route || "/") } : undefined,
    extra: isMetric && Number.isFinite(event.extra?.value) ? { value: event.extra.value } : undefined,
    contexts: trace && /^[a-f0-9]{32}$/i.test(trace.trace_id || "") && /^[a-f0-9]{16}$/i.test(trace.span_id || "")
      ? { trace: { trace_id: trace.trace_id, span_id: trace.span_id } } : undefined,
    exception: event.exception ? { values: event.exception.values?.slice(0, 5).map((value: any) => ({
      type: "Error", value: "Exception details omitted for privacy",
      stacktrace: value.stacktrace ? { frames: value.stacktrace.frames?.slice(-50).map((frame: any) => ({
        filename: typeof frame.filename === "string" ? frame.filename.split(/[?#]/)[0].split("/").pop()?.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) : undefined,
        lineno: Number.isInteger(frame.lineno) ? frame.lineno : undefined,
        colno: Number.isInteger(frame.colno) ? frame.colno : undefined,
      })) } : undefined,
    })) } : undefined,
  };
}

/** Whether this build is configured to emit production monitoring. */
export function isSentryEnabled(): boolean {
  return !!configuredDsn();
}

/** React-caught page errors also need monitoring; the provider/session stays mounted. */
export function captureRuntimeError(error: Error): void {
  if (!isSentryEnabled()) return;
  initSentry();
  void sentryReady?.then((Sentry) => { Sentry.captureException(error); }).catch(() => {
    // Optional diagnostics can never turn a contained page failure into an
    // unhandled rejection. beforeSend strips messages and customer context.
  });
}

/** Call once at app startup. Monitoring must never block the application. */
export function initSentry(): void {
  const dsn = configuredDsn();
  if (!dsn || sentryReady) return;
  const tracesSampleRate = sampleRate(process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, DEFAULT_TRACE_SAMPLE_RATE);
  const initialization = import("@sentry/react-native").then((Sentry) => {
    Sentry.init({
      dsn,
      environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || "production",
      release: process.env.EXPO_PUBLIC_RELEASE || undefined,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracesSampleRate,
      beforeSendTransaction: (event: any) => ({
        ...safeEvent(event),
        type: "transaction",
        transaction: routeTemplate(event.transaction || "/"),
        start_timestamp: Number.isFinite(event.start_timestamp) ? event.start_timestamp : undefined,
        spans: [],
      }),
      beforeSend: safeEvent,
    });
    return Sentry;
  });
  sentryReady = initialization;
  // Startup calls this without awaiting it. Attach a rejection handler so a
  // monitoring SDK/configuration failure cannot become an app-level error.
  void initialization.catch(() => {
    console.warn("[monitoring] Sentry configured but failed to initialize.");
    if (sentryReady === initialization) sentryReady = null;
  });
}

function reportWebMetric(name: string, value: number): void {
  if (!isSentryEnabled() || Math.random() > sampleRate(process.env.EXPO_PUBLIC_WEB_VITAL_SAMPLE_RATE, DEFAULT_WEB_VITAL_SAMPLE_RATE)) return;
  initSentry();
  void sentryReady?.then((Sentry) => {
    Sentry.captureMessage("web_vital", {
      level: "info",
      tags: { metric: name, route: routeTemplate(window.location.pathname) },
      extra: { value: Math.round(value * 100) / 100 },
    });
  }).catch(() => {
    // Monitoring must never affect a route or user interaction.
  });
}

/**
 * Lightweight browser metrics. Development builds keep console diagnostics;
 * configured production builds sample only route templates and numeric values.
 */
export function initPerformanceSignals(): void {
  if (performanceSignalsStarted || typeof window === "undefined") return;
  performanceSignalsStarted = true;
  try {
    const perf = window.performance;
    const emit = (name: string, value: number) => {
      if (__DEV__) console.info("[perf]", name, Math.round(value));
      else reportWebMetric(name, value);
    };
    window.addEventListener("load", () => {
      const navigation = perf.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (navigation) {
        emit("dom_content_loaded_ms", navigation.domContentLoadedEventEnd);
        emit("load_ms", navigation.loadEventEnd);
      }
    }, { once: true });

    const Observer = (window as any).PerformanceObserver;
    if (!Observer) return;
    if (Observer.supportedEntryTypes?.includes("largest-contentful-paint")) {
      const observer = new Observer((list: PerformanceObserverEntryList) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) emit("lcp_ms", last.startTime);
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    }
    if (Observer.supportedEntryTypes?.includes("layout-shift")) {
      let cls = 0;
      const observer = new Observer((list: PerformanceObserverEntryList) => {
        for (const entry of list.getEntries() as any[]) if (!entry.hadRecentInput) cls += entry.value || 0;
        emit("cls", cls);
      });
      observer.observe({ type: "layout-shift", buffered: true });
    }
    if (Observer.supportedEntryTypes?.includes("event")) {
      const observer = new Observer((list: PerformanceObserverEntryList) => {
        for (const entry of list.getEntries()) if (entry.duration >= 40) emit("inp_ms", entry.duration);
      });
      observer.observe({ type: "event", buffered: true, durationThreshold: 40 });
    }
    if (Observer.supportedEntryTypes?.includes("longtask")) {
      const observer = new Observer((list: PerformanceObserverEntryList) => {
        for (const entry of list.getEntries()) if (entry.duration >= 50) emit("long_task_ms", entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    // Performance diagnostics must never affect application startup.
  }
}
