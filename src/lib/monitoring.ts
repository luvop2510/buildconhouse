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

function scrubText(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/\?.*$/, "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[redacted-id]");
}

/** Whether this build is configured to emit production monitoring. */
export function isSentryEnabled(): boolean {
  return !!configuredDsn();
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
        ...event,
        transaction: routeTemplate(event.transaction || "/"),
        request: undefined,
        user: undefined,
        breadcrumbs: [],
      }),
      beforeSend: (event: any) => ({
        ...event,
        request: undefined,
        user: undefined,
        breadcrumbs: [],
        exception: event.exception ? {
          ...event.exception,
          values: event.exception.values?.map((value: any) => ({
            ...value,
            value: scrubText(value.value),
            stacktrace: value.stacktrace ? {
              ...value.stacktrace,
              frames: value.stacktrace.frames?.map((frame: any) => ({
                ...frame,
                filename: scrubText(frame.filename),
              })),
            } : undefined,
          })),
        } : undefined,
      }),
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
