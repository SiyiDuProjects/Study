(() => {
  "use strict";

  const form = document.getElementById("oauth-consent-form");
  const status = document.getElementById("oauth-consent-status");
  if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement)) {
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
    }
    status.hidden = true;
    status.textContent = "";

    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      const response = await fetch(form.action, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || typeof result.redirectTo !== "string") {
        throw new Error("Authorization request failed");
      }

      const expectedCallback = new URL(String(payload.redirect_uri));
      const callback = new URL(result.redirectTo);
      if (
        callback.origin !== expectedCallback.origin ||
        callback.pathname !== expectedCallback.pathname
      ) {
        throw new Error("Authorization callback did not match the requested redirect URI");
      }

      window.location.assign(callback.href);
    } catch {
      status.textContent = "Authorization failed. Please reload this page and try again.";
      status.hidden = false;
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
      }
    }
  });
})();
