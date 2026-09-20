// How this project identifies itself to the archives.
//
// Wikimedia's User-Agent policy requires a descriptive agent with a way to
// make contact, and explicitly allows requests without one to be refused.
// The other archives do not demand it, but every one of them is volunteer-run
// and an unidentified client is an unaccountable one.
//
// Set PDR_CONTACT to your own repository or email before running this against
// the archives at any volume, so that if this tool misbehaves someone can tell
// you rather than simply blocking it.

const VERSION = '0.1.0';
const CONTACT = process.env.PDR_CONTACT
  ?? 'https://github.com/OWNER/public-domain-reader';

export const USER_AGENT = `PublicDomainReader/${VERSION} (+${CONTACT})`;

/** fetch(), identified. Use this for every outbound request to an archive. */
export function fetchIdentified(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { 'user-agent': USER_AGENT, ...(options.headers ?? {}) },
  });
}
