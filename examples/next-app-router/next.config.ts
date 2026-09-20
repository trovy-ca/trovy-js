import type { NextConfig } from "next";

const config: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // All the sign-up form needs from a Content Security Policy: one frame
          // host. The package loads no script from anywhere.
          { key: "Content-Security-Policy", value: "frame-src https://js.trovy.ca" },
        ],
      },
    ];
  },
};

export default config;
