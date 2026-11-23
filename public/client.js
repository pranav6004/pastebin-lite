const form = document.querySelector("#compose");

if (form) {
  const content = document.querySelector("#content");
  const count = document.querySelector("#character-count");
  const publish = document.querySelector("#publish");
  const status = document.querySelector("#form-status");
  const result = document.querySelector("#share-result");
  const shareUrl = document.querySelector("#share-url");
  const openPaste = document.querySelector("#open-paste");
  const number = new Intl.NumberFormat();

  content.addEventListener("input", () => {
    content.setCustomValidity("");
    const length = [...content.value].length;
    count.textContent = `${number.format(length)} ${length === 1 ? "character" : "characters"}`;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!content.value.trim()) {
      content.setCustomValidity("Enter some text to share.");
      content.reportValidity();
      return;
    }

    const data = { content: content.value };
    for (const name of ["ttl_seconds", "max_views"]) {
      const input = form.elements.namedItem(name);
      if (input.value !== "") data[name] = input.valueAsNumber;
    }

    result.hidden = true;
    result.querySelector("[data-copy-status]").textContent = "";
    publish.disabled = true;
    publish.textContent = "Creating paste…";
    status.textContent = "";
    try {
      const response = await fetch("/api/pastes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await response.json();
      if (!response.ok) {
        status.textContent = body.error ?? "Could not create the paste. Try again.";
        return;
      }

      shareUrl.value = body.url;
      openPaste.href = `/p/${body.id}`;
      result.hidden = false;
      shareUrl.focus();
      shareUrl.select();
      status.textContent = "Paste created.";
    } catch {
      status.textContent = "Could not create the paste. Check your connection and try again.";
    } finally {
      publish.disabled = false;
      publish.innerHTML = 'Create paste <span aria-hidden="true">→</span>';
    }
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  const source = document.getElementById(button.dataset.copy);
  const status = button.closest("section").querySelector("[data-copy-status]");

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(source.value ?? source.textContent);
      status.textContent = "Copied.";
    } catch {
      if (source instanceof HTMLInputElement) {
        source.focus();
        source.select();
      } else {
        getSelection().selectAllChildren(source);
      }
      status.textContent = "Selected. Use your device’s copy command.";
    }
  });
}

for (const time of document.querySelectorAll("time")) {
  time.textContent = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(time.dateTime));
}
