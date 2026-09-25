const menuButton = document.querySelector('[data-menu-toggle]');
const nav = document.querySelector('[data-nav]');
const header = document.querySelector('[data-header]');

menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!open));
  menuButton.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
  nav.classList.toggle('open', !open);
  document.body.classList.toggle('menu-open', !open);
});

nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  menuButton.setAttribute('aria-expanded', 'false');
  nav.classList.remove('open');
  document.body.classList.remove('menu-open');
}));

const sectionLinks = nav
  ? [...nav.querySelectorAll('a[href^="#"]')]
      .map((link) => ({ link, section: document.querySelector(link.hash) }))
      .filter(({ section }) => section)
  : [];

let scrollFrame;
const updateActiveSection = () => {
  scrollFrame = undefined;
  if (!sectionLinks.length) return;
  const marker = window.scrollY + (header?.offsetHeight || 0) + window.innerHeight * 0.22;
  let current = sectionLinks[0];
  sectionLinks.forEach((entry) => {
    if (entry.section.offsetTop <= marker) current = entry;
  });
  sectionLinks.forEach(({ link }) => link.classList.toggle('active', link === current.link));
};

const scheduleActiveSectionUpdate = () => {
  if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updateActiveSection);
};

updateActiveSection();
window.addEventListener('scroll', scheduleActiveSectionUpdate, { passive: true });
window.addEventListener('resize', scheduleActiveSectionUpdate);

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link || !document.body.classList.contains('site-page') || event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank' || link.hasAttribute('download')) return;
  const destination = new URL(link.href, window.location.href);
  if (destination.origin !== window.location.origin || !['http:', 'https:'].includes(destination.protocol)) return;
  const current = new URL(window.location.href);
  if (destination.pathname === current.pathname && destination.search === current.search) return;
  event.preventDefault();
  document.body.classList.add('page-leaving');
  const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360;
  window.setTimeout(() => { window.location.href = destination.href; }, delay);
});

document.querySelectorAll('[data-accordion] .faq-item button').forEach((button) => {
  button.addEventListener('click', () => {
    const item = button.closest('.faq-item');
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach((other) => {
      other.classList.remove('open');
      other.querySelector('button').setAttribute('aria-expanded', 'false');
      other.querySelector('button i').textContent = '+';
    });
    if (!wasOpen) {
      item.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      button.querySelector('i').textContent = '−';
    }
  });
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

window.addEventListener('scroll', () => header?.classList.toggle('scrolled', window.scrollY > 24), { passive: true });
document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
