const form = document.querySelector('#waitlist-form');
const formView = document.querySelector('[data-form-view]');
const successView = document.querySelector('[data-success]');
const alertBox = document.querySelector('[data-form-alert]');
const submitButton = document.querySelector('[data-submit]');
const supportField = document.querySelector('#support');
const count = document.querySelector('[data-count]');
const formStartedAt = Date.now();
let submitting = false;
let idempotencyKey = crypto.randomUUID();
const config = window.INNER_ATELIER_CONFIG;

supportField.addEventListener('input', () => { count.textContent = supportField.value.length.toLocaleString(); });

function setInvalid(name, message) {
  const input = form.elements[name];
  const container = input instanceof RadioNodeList ? document.querySelector('.contact-choice') : input?.closest('.field, .consent-row');
  const error = document.querySelector(`#${name}-error`);
  container?.classList.toggle('invalid', Boolean(message));
  if (input && !(input instanceof RadioNodeList)) input.setAttribute('aria-invalid', String(Boolean(message)));
  if (error && message) error.textContent = message;
}

function validate() {
  const data = new FormData(form);
  const values = Object.fromEntries(data.entries());
  const errors = {};
  const namePattern = /^[\p{L}\p{M}][\p{L}\p{M}'’ .-]{0,59}$/u;
  if (!namePattern.test((values.firstName || '').trim())) errors.firstName = 'Enter your first name.';
  if (!namePattern.test((values.lastName || '').trim())) errors.lastName = 'Enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((values.email || '').trim())) errors.email = 'Enter a valid email address.';
  if ((values.phone || '').replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number.';
  if (!values.state) errors.state = 'Select your state.';
  if (!values.contactMethod) errors.contactMethod = 'Choose a contact method.';
  if (!form.elements.consent.checked) errors.consent = 'Consent is required to join the waitlist.';
  ['firstName','lastName','email','phone','state','contactMethod','consent'].forEach((name) => setInvalid(name, errors[name]));
  return { values, errors };
}

form.addEventListener('input', (event) => {
  const name = event.target.name;
  if (name) setInvalid(name, '');
  alertBox.classList.remove('show');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  const { values, errors } = validate();
  if (Object.keys(errors).length) {
    const first = form.querySelector('.invalid input, .invalid select, .invalid textarea');
    first?.focus();
    return;
  }
  submitting = true;
  submitButton.disabled = true;
  submitButton.innerHTML = 'Sending thoughtfully…';
  alertBox.classList.remove('show');
  try {
    if (!config?.supabaseUrl || !config?.supabasePublishableKey) {
      throw new Error('The waitlist is being connected. Please contact the practice directly for now.');
    }
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/submit-waitlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabasePublishableKey,
        Authorization: `Bearer ${config.supabasePublishableKey}`
      },
      body: JSON.stringify({
        ...values,
        consent: form.elements.consent.checked,
        formStartedAt,
        idempotencyKey
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (result.errors) Object.entries(result.errors).forEach(([name, message]) => setInvalid(name, message));
      throw new Error(result.message || 'We couldn’t submit your request. Please try again.');
    }
    formView.hidden = true;
    successView.classList.add('show');
    successView.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    alertBox.textContent = error.message;
    alertBox.classList.add('show');
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    submitting = false;
    submitButton.disabled = false;
    submitButton.innerHTML = 'Join the waitlist <span>↗</span>';
    idempotencyKey = crypto.randomUUID();
  }
});
