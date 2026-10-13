import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import App from "./App";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="页面">
      <App />
    </ErrorBoundary>
    <Toaster
      theme="light"
      position="bottom-right"
      toastOptions={{ className: "text-xs" }}
      richColors
    />
  </React.StrictMode>,
);
