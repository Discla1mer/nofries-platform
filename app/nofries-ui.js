/* No Fries lightweight UI helpers. Safe for static web apps; no dependencies. */
(function () {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
      history.replaceState(null, '', link.getAttribute('href'));
    });
  });

  document.querySelectorAll('.nf-app-nav a').forEach((link) => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.nf-app-nav a').forEach((item) => item.classList.remove('is-active'));
      link.classList.add('is-active');
    });
  });

  const search = document.querySelector('.nf-toolbar input[type="search"]');
  const rows = Array.from(document.querySelectorAll('.nf-table tbody tr'));
  if (search && rows.length) {
    search.addEventListener('input', () => {
      const value = search.value.trim().toLowerCase();
      rows.forEach((row) => {
        row.style.display = row.textContent.toLowerCase().includes(value) ? '' : 'none';
      });
    });
  }
})();
