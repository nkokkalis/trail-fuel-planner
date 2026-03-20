import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "https://65ea9a4dff26a84f98c2a5672f652b38@o4511076874584064.ingest.de.sentry.io/4511076877598800",
  environment: import.meta.env.MODE,

  sendDefaultPii: true,

  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,  // fuel planner has no PII input fields
      blockAllMedia: false,
    }),
  ],

  // Tracing — 100% in dev, lower this to 0.1–0.2 in production if volume grows
  tracesSampleRate: 1.0,
  tracePropagationTargets: [
    "localhost",
    /^https:\/\/api\.open-meteo\.com/,
    /^https:\/\/nominatim\.openstreetmap\.org/,
  ],

  // Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  enableLogs: true,
});
