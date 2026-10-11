// CloudFront Function (viewer-request) for the sites distribution. Runtime: cloudfront-js-2.0.
// The stack replaces the placeholders at synth time. DOMAIN = '' means domainless mode.
// Two things are served: private drafts (draft.<domain>/<draftId>/, domainless /_draft/<draftId>/), and the landing
// page's example sites (EXAMPLES, from examples.ts, stored under /_examples/<slug>/, at <slug>.<domain>).
// Customer pages are never public here: owners publish only on their own domain.
var DOMAIN = '__DOMAIN__';
var APP_URL = '__APP_URL__';
var EXAMPLES = '__EXAMPLES__'.split(',');

var DRAFT_ID = /^[0-9a-f]{32}$/;
var NOT_FOUND = { statusCode: 404, statusDescription: 'Not Found' };

function redirect(code, location) {
  return {
    statusCode: code,
    statusDescription: code === 301 ? 'Moved Permanently' : 'Found',
    headers: { location: { value: location } },
  };
}

function withIndex(uri) {
  return uri.endsWith('/') ? uri + 'index.html' : uri;
}

// "/<draftId>/rest" → the rewritten request, a redirect that adds the root's trailing slash, or 404.
function draft(request, path) {
  // A draft shows only inside the app's pages (its frame-ancestors names them), never opened from a shared
  // link: the browser marks a top-level load "document". No Sec-Fetch-Dest at all (old browsers) is refused too.
  var dest = request.headers['sec-fetch-dest'];
  if (!dest || dest.value === 'document') return NOT_FOUND;
  var parts = path.split('/'); // ['', draftId, ...]
  if (!DRAFT_ID.test(parts[1] || '')) return NOT_FOUND;
  // A draft root needs its trailing slash so relative asset URLs resolve.
  if (parts.length === 2) return redirect(301, request.uri + '/');
  request.uri = '/_draft' + withIndex(path);
  return request;
}

// An example site, opened like any public page. "rest" is the path after the slug ('' or '/...').
function example(request, slug, rest) {
  if (EXAMPLES.indexOf(slug) < 0) return NOT_FOUND;
  request.uri = '/_examples/' + slug + withIndex(rest || '/');
  return request;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (DOMAIN === '') {
    // Domainless: /_draft/<draftId>/... is served; everything else is not.
    if (uri === '/') return redirect(302, APP_URL);
    if (uri.indexOf('/_draft/') === 0) return draft(request, uri.slice('/_draft'.length));
    var parts = uri.split('/'); // ['', slug, ...]
    if (EXAMPLES.indexOf(parts[1]) < 0) return NOT_FOUND;
    // The root needs its trailing slash so relative asset URLs resolve.
    if (parts.length === 2) return redirect(301, uri + '/');
    return example(request, parts[1], uri.slice(parts[1].length + 1));
  }

  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  // The apex and www are the app distribution's; only *.<domain> reaches this one.
  if (host === 'draft.' + DOMAIN) return draft(request, uri);
  var suffix = '.' + DOMAIN;
  if (host.endsWith(suffix)) return example(request, host.slice(0, -suffix.length), uri);
  return NOT_FOUND;
}
