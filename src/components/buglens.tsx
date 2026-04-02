"use client";

import { useEffect } from "react";

/**
 * BugLens widget integration for ShareTab.
 * Loads the BugLens SDK and initializes it with ShareTab-specific config.
 * Only renders in development or when NEXT_PUBLIC_BUGLENS_API_URL is set.
 */
export function BugLensWidget() {
  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_BUGLENS_API_URL;
    const apiKey = process.env.NEXT_PUBLIC_BUGLENS_API_KEY;

    if (!apiUrl || !apiKey) return;

    const script = document.createElement("script");
    script.src = `${apiUrl}/sdk/buglens.iife.js`;
    script.async = true;
    script.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BugLens = (window as any).BugLens;
      if (BugLens) {
        BugLens.init({
          apiEndpoint: `${apiUrl}/api/v1`,
          apiKey,
          position: "bottom-right",
          hotkey: "ctrl+shift+b",
          maskSelectors: [
            'input[type="password"]',
            "[data-sensitive]",
          ],
          metadata: () => ({
            page: window.location.pathname,
            app: "sharetab",
          }),
        });
      }
    };
    document.head.appendChild(script);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BugLens = (window as any).BugLens;
      if (BugLens?.destroy) BugLens.destroy();
      script.remove();
    };
  }, []);

  return null;
}
