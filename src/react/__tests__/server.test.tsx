// @vitest-environment node

// A real server: no window, no document. The jsdom tests cannot show that the
// component leaves them alone, because under jsdom they are always there.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

const PK = `trv_pk_live_${"a".repeat(32)}`;

describe("on a server", () => {
  it("has no DOM to lean on", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("imports, which is all a Server Component that renders it does first", async () => {
    await expect(import("../index.js")).resolves.toHaveProperty("TrovySignup");
  });

  it("renders an empty box: no iframe, and no key in the markup", async () => {
    const { TrovySignup } = await import("../index.js");

    const html = renderToString(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" className="card" />);

    expect(html).toBe('<div class="card" data-trovy-state="loading"><div></div></div>');
  });

  it("renders the same box for props that are wrong, and says nothing until the browser does", async () => {
    const { TrovySignup } = await import("../index.js");

    const html = renderToString(<TrovySignup publishableKey="nope" onSuccess={() => {}} />);

    expect(html).toBe('<div data-trovy-state="loading"><div></div></div>');
  });
});
