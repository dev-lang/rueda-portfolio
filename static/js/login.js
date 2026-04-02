'use strict';

(function () {
  const form = document.getElementById('login-form');
  const btn  = document.getElementById('login-btn');
  const err  = document.getElementById('login-error');

  function showError(msg) {
    err.textContent = msg;
    err.classList.add('visible');
  }

  function hideError() {
    err.classList.remove('visible');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    btn.disabled = true;
    btn.textContent = 'Verificando...';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      showError('Completá usuario y contraseña.');
      btn.disabled = false;
      btn.textContent = 'Iniciar sesión';
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.detail || 'Error al iniciar sesión. Verificá tus credenciales.');
        btn.disabled = false;
        btn.textContent = 'Iniciar sesión';
      }
    } catch {
      showError('Error de red. Verificá la conexión al servidor.');
      btn.disabled = false;
      btn.textContent = 'Iniciar sesión';
    }
  });
})();
