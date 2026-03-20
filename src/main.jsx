import "./instrument";  // Sentry must init before anything else

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>Something went wrong — please reload the page.</p>} showDialog>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>
);
