import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { InstanceProvider } from "./instance";
import { installMailFetchCache } from "./mailCache";
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
    <InstanceProvider><AuthGate><App /></AuthGate></InstanceProvider>
  </StrictMode>,
);
