const form = document.querySelector('#login-form');
const error = document.querySelector('#login-error');
const button = form.querySelector('button');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    let res;
    try {
      res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PiRick': '1' },
        body: JSON.stringify({ username: form.username.value, password: form.password.value }),
      });
    } catch {
      throw new Error("Can't reach PiRick. Check your connection and try again.");
    }
    if (res.ok) {
      location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not sign in. Please try again.');
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    form.password.value = '';
    form.password.focus();
  } finally {
    button.disabled = false;
  }
});
