// Inquiry form: no data leaves this site. When the form carries a confirmed
// address in data-inquiry-email, submitting opens a pre-filled email in the
// visitor's own mail app. Until then the button stays disabled.
(() => {
  const form = document.getElementById("inquiry");
  if (!form) return;
  const address = (form.dataset.inquiryEmail || "").trim();
  const submit = document.getElementById("inquiry-submit");
  const status = document.getElementById("inquiry-status");
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(address)) return;
  submit.disabled = false;
  status.textContent = "Submitting opens a pre-filled email in your mail app. Nothing is sent from this site.";

  const labelFor = (name) => {
    const field = form.elements[name];
    const node = field && (field.length ? field[0] : field);
    const set = node && node.closest("fieldset");
    if (set) return set.querySelector("legend").textContent.trim();
    const label = node && form.querySelector(`label[for="${node.id}"]`);
    return label ? label.textContent.replace("(optional)", "").trim() : name;
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const location = form.elements.location.value.trim();
    for (const field of [form.elements.name, form.elements.email, form.elements.location]) {
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
    }
    if (!name || !email || !form.elements.email.checkValidity() || !location) {
      const invalid = !name ? form.elements.name : !email || !form.elements.email.checkValidity() ? form.elements.email : form.elements.location;
      invalid.setAttribute("aria-invalid", "true");
      invalid.setAttribute("aria-describedby", "inquiry-status");
      status.textContent = "Please add your name, a valid email address and the project location.";
      invalid.focus();
      return;
    }
    const data = new FormData(form);
    const lines = [];
    const seen = new Set();
    for (const key of data.keys()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const value = data.getAll(key).map((item) => String(item).trim()).filter(Boolean).join(", ");
      if (value) lines.push(`${labelFor(key)}\n${value}\n`);
    }
    const subject = `Project inquiry from ${name}`;
    const href = `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
    status.textContent = "Opening your mail app…";
    window.location.href = href;
  });
})();
