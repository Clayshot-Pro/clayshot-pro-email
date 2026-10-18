import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { installMailFetchCache } from "./mailCache";
import "./theme/themes/ltm-dark.css";
import "./theme/themes/light.css";
import "./theme/themes/ltm-ember.css";
import "./theme/themes/graphite.css";
import "./theme/themes/high-contrast.css";
import "./theme/tokens.css";
import "./styles.css";
import "./dark.css";
import "./ui-overrides.css";
import "./mobile-accounts.css";
import "./email-html.css";
import "./device-login.css";

installMailFetchCache();
const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <AuthGate><App /></AuthGate>
  </StrictMode>,
);
