import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
// The design-system stylesheet is global, but its JS barrel is not: importing
// ToastProvider from the barrel would drag DataTable, Modal and ReportToolbar
// into the main chunk on every visit.
import "./components/ui/ui.css";
import { ToastProvider } from "./components/ui/Toast";
import "./index.css";
import App from "./App";

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
