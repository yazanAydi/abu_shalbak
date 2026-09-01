import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import "./utils/disableNumberInputSpin";
import "./utils/forceLatinDigits";
// The design-system stylesheet is global, but its JS barrel is not: importing
// ToastProvider from the barrel would drag DataTable, Modal and ReportToolbar
// into the main chunk on every visit.
import "./components/ui/ui.css";
import App from "./App";
import { ToastProvider } from "./components/ui/Toast";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <BrowserRouter basename={process.env.PUBLIC_URL}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);

if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = process.env.PUBLIC_URL || "";
    navigator.serviceWorker.register(`${base}/sw.js`).catch(() => {});
  });
}
