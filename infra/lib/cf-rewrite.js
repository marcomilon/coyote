// CloudFront Function (viewer-request) for the sites distribution. Runtime: cloudfront-js-2.0.
// The stack replaces the two placeholders at synth time. SITES_HOST = '' means domainless mode.
// Only private drafts are served for now (/_draft/<draftId>/). Published /{slug}/ sites come back with the
// publishing plan.
var SITES_HOST = '__SITES_HOST__';
var APP_URL = '__APP_URL__';

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
  var parts = path.split('/'); // ['', draftId, ...]
  if (!DRAFT_ID.test(parts[1] || '')) return NOT_FOUND;
  // A draft root needs its trailing slash so relative asset URLs resolve.
  if (parts.length === 2) return redirect(301, request.uri + '/');
  request.uri = '/_draft' + withIndex(path);
  return request;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (SITES_HOST === '') {
    // Domainless: /_draft/<draftId>/... is served; everything else is not.
    if (uri === '/') return redirect(302, APP_URL);
    if (uri.indexOf('/_draft/') !== 0) return NOT_FOUND;
    return draft(request, uri.slice('/_draft'.length));
  }

  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host === SITES_HOST || host === 'www.' + SITES_HOST) return redirect(302, APP_URL);
  if (host === 'draft.' + SITES_HOST) return draft(request, uri);
  return NOT_FOUND;
}
