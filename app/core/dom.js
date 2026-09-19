// Small DOM helpers.
//
// Building elements rather than assigning innerHTML: book metadata comes from
// third-party archives, and a title containing markup should render as text,
// not as HTML.

export function el(tag, props = {}, children = []) {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  // `dataset` is read-only, so its keys have to be copied across rather than
  // assigned wholesale.
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...(Array.isArray(children) ? children : [children]));
  return node;
}

/** Minutes as a compact human duration: `2h 45m`. */
export function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
