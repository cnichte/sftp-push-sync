// packages/gui/src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "@gfazioli/mantine-window/styles.css";
import "./i18n.js";
import App from "./App.jsx";

// Electron's default behaviour for a dropped file is to navigate the window
// to it (like a normal Chromium tab). Block that globally so our own drop
// zone in App.jsx is what handles the drop instead of the window navigating
// away or silently ignoring it.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </React.StrictMode>
);
