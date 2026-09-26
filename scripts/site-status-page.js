// Bundled from the pinned shared browser export by build-site-status-page.ts.
import { attachStatusPage } from "@hraness/design-kit/browser";

const enhance = () => {
  const root = document.querySelector(".hraness-status-page");
  if (root) attachStatusPage(root);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhance, { once: true });
else enhance();
