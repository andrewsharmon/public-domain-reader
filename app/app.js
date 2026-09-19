// Routing.
//
// Hash routes rather than a server-side router or a framework: the reader has
// to keep working when these files are served from anywhere, and a hash never
// hits the network. Each view owns its own DOM and cleans up after itself.

import * as library from './library/view.js';
import * as discover from './discover/view.js';
import * as reader from './reader/view.js';

const ROUTES = [
  { match: /^#\/read\/(.+)$/, view: reader, name: 'read' },
  { match: /^#\/discover/, view: discover, name: 'discover' },
  { match: /.*/, view: library, name: 'library' },
];

const root = document.querySelector('#view');
let current = null;

async function render() {
  const hash = location.hash || '#/library';
  const route = ROUTES.find((r) => r.match.test(hash));
  const params = hash.match(route.match)?.slice(1).map(decodeURIComponent) ?? [];

  current?.unmount?.();
  root.replaceChildren();
  current = route.view;

  // The reader hides the site chrome: a book should fill the screen.
  document.body.classList.toggle('reading', route.name === 'read');
  for (const link of document.querySelectorAll('nav a')) {
    link.classList.toggle('active', link.dataset.route === route.name);
  }

  try {
    await route.view.mount(root, ...params);
  } catch (err) {
    root.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'status',
      textContent: `Could not open this view: ${err.message}`,
    }));
  }
}

addEventListener('hashchange', render);
render();
