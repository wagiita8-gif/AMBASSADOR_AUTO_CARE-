
(() => {
  'use strict';

  const API_BASE = 'https://ambassador-auto-care.onrender.com';
  const SHOP_ID = 'fe94ff4e-e3a8-4fb4-88a1-3a1fc0eef824';
  const STORAGE_KEY = 'ambassadors_pos_auth_v1';

  let currentSession = null;
  let busy = false;

  const style = document.createElement('style');

  style.textContent = `
    body.auth-locked .app,
    body.auth-locked #mobileNav,
    body.auth-locked #themeToggle {
      display: none !important;
    }

    #authScreen {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: var(--bg, #f7faf8);
      color: var(--ink, #17211b);
      font-family: Inter, system-ui, sans-serif;
    }

    #authScreen[hidden] {
      display: none !important;
    }

    .auth-card {
      width: min(420px, 100%);
      background: var(--white, #fff);
      border: 1px solid var(--line, #e8eee9);
      border-radius: 18px;
      padding: 26px;
      box-shadow: 0 15px 50px #00000010;
    }

    .auth-mark {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: #16a34a;
      color: white;
      display: grid;
      place-items: center;
      font-weight: 900;
      font-size: 21px;
      margin-bottom: 18px;
    }

    .auth-card h1 {
      font-size: 23px;
      margin: 0 0 7px;
    }

    .auth-card p {
      color: var(--muted, #718078);
      font-size: 12px;
      line-height: 1.6;
    }

    .auth-card label {
      display: grid;
      gap: 6px;
      margin-top: 15px;
      font-size: 11px;
      font-weight: 750;
    }

    .auth-card input {
      width: 100%;
      padding: 12px;
      border: 1px solid var(--line, #e8eee9);
      border-radius: 9px;
      background: var(--bg, #f7faf8);
      color: var(--ink, #17211b);
      outline-color: #16a34a;
    }

    .auth-submit {
      width: 100%;
      margin-top: 20px;
      padding: 12px;
      border: 0;
      border-radius: 9px;
      background: #16a34a;
      color: white;
      font-weight: 800;
      cursor: pointer;
    }

    .auth-submit:disabled {
      opacity: .6;
      cursor: wait;
    }

    #authMessage {
      min-height: 18px;
      color: #dc2626;
      font-size: 11px;
      margin-top: 12px;
    }

    .auth-security {
      border-top: 1px solid var(--line, #e8eee9);
      padding-top: 13px;
      margin-top: 20px;
      font-size: 10px !important;
    }

    #authLogout {
      border: 1px solid var(--line);
      background: var(--white);
      color: var(--ink);
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 11px;
      font-weight: 750;
      cursor: pointer;
      margin-left: 12px;
    }
  `;

  document.head.appendChild(style);

  document.body.classList.add('auth-locked');

  const screen = document.createElement('section');

  screen.id = 'authScreen';

  screen.innerHTML = `
    <div class="auth-card">
      <div class="auth-mark">A</div>

      <div class="eyebrow">AMBASSADORS AUTO CARE</div>

      <h1>Welcome back</h1>

      <p>
        Sign in using your authorized shop account.
      </p>

      <form id="authForm">
        <label>
          Email address
          <input
            id="authEmail"
            type="email"
            autocomplete="username"
            required
            maxlength="255"
            placeholder="you@example.com"
          >
        </label>

        <label>
          Password
          <input
            id="authPassword"
            type="password"
            autocomplete="current-password"
            required
            placeholder="Your password"
          >
        </label>

        <button
          class="auth-submit"
          id="authSubmit"
          type="submit"
        >
          Sign in
        </button>

        <div
          id="authMessage"
          role="alert"
          aria-live="polite"
        ></div>
      </form>

      <p class="auth-security">
        Protected shop access. Your password is never saved
        in this browser.
      </p>
    </div>
  `;

  document.body.appendChild(screen);

  const form = document.getElementById('authForm');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const submitButton = document.getElementById('authSubmit');
  const message = document.getElementById('authMessage');

  function readStoredSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function clearStoredSession() {
    localStorage.removeItem(STORAGE_KEY);
    currentSession = null;
  }

  function setMessage(text) {
    message.textContent = text || '';
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? 'Please wait...' : 'Sign in';
  }

  async function verifyToken(token) {
    const response = await fetch(
      `${API_BASE}/api/auth/session`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || 'Your session could not be verified.'
      );
    }

    const shop = Array.isArray(data.shops)
      ? data.shops.find(item => item.shop_id === SHOP_ID)
      : null;

    if (!shop) {
      throw new Error(
        'This account does not belong to this shop.'
      );
    }

    return {
      token,
      user: data.user,
      shopId: shop.shop_id,
      shopName: shop.shop_name,
      role: shop.role
    };
  }

  function unlock(session) {
    currentSession = session;

    document.body.classList.remove('auth-locked');
    screen.hidden = true;

    const header = document.querySelector('.top');

    if (header && !document.getElementById('authLogout')) {
      const button = document.createElement('button');

      button.id = 'authLogout';
      button.type = 'button';
      button.textContent = 'Sign out';

      button.addEventListener('click', logout);

      header.appendChild(button);
    }

    const indicator = document.getElementById('connection');

    if (indicator) {
      indicator.textContent = '● AUTHENTICATED';
    }
  }

  function lock(messageText = '') {
    document.body.classList.add('auth-locked');
    screen.hidden = false;

    setMessage(messageText);

    const button = document.getElementById('authLogout');

    if (button) {
      button.remove();
    }
  }

  function logout() {
    clearStoredSession();
    passwordInput.value = '';
    lock('You have signed out.');
  }

  async function login(email, password) {
    const response = await fetch(
      `${API_BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ email, password })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.token) {
      throw new Error(
        data.error || 'Login failed. Check your details.'
      );
    }

    const session = await verifyToken(data.token);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: session.token,
        user: session.user,
        shopId: session.shopId,
        shopName: session.shopName,
        role: session.role
      })
    );

    return session;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();

    if (busy) return;

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      setMessage('Enter your email and password.');
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const session = await login(email, password);

      passwordInput.value = '';

      unlock(session);

    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  });

  async function restoreSession() {
    const saved = readStoredSession();

    if (!saved || typeof saved.token !== 'string') {
      lock();
      return;
    }

    setBusy(true);

    try {
      const session = await verifyToken(saved.token);
      unlock(session);

    } catch (error) {
      clearStoredSession();
      lock('Your session expired or is no longer valid. Sign in again.');
    } finally {
      setBusy(false);
    }
  }

  window.POS_AUTH = {
    get token() {
      return currentSession?.token || null;
    },

    get user() {
      return currentSession?.user || null;
    },

    get shopId() {
      return currentSession?.shopId || null;
    },

    get role() {
      return currentSession?.role || null;
    },

    get authenticated() {
      return Boolean(currentSession?.token);
    },

    logout
  };

  restoreSession();
})();
