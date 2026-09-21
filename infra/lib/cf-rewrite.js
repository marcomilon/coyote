// CloudFront Function (viewer-request) for the sites distribution. Runtime: cloudfront-js-2.0.
// The stack replaces the two placeholders at synth time. SITES_HOST = '' means domainless mode.
var SITES_HOST = '__SITES_HOST__';
var APP_URL = '__APP_URL__';

var SLUG = /^[a-z0-9][a-z0-9-]*$/;
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

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (SITES_HOST === '') {
    // Domainless: /{slug}/... and /_preview/{jobId}/... are served as they are.
    if (uri === '/') return redirect(302, APP_URL);
    var parts = uri.split('/'); // ['', first, second, ...]
    var first = parts[1];
    if (first.startsWith('_') && first !== '_preview') return NOT_FOUND; // _uploads, _quarantine, _errors
    // A site root needs its trailing slash so relative asset URLs resolve.
    var rootDepth = first === '_preview' ? 3 : 2;
    if (parts.length === rootDepth && parts[rootDepth - 1] !== '') return redirect(301, uri + '/');
    request.uri = withIndex(uri);
    return request;
  }

  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host === SITES_HOST || host === 'www.' + SITES_HOST) return redirect(302, APP_URL);
  if (!host.endsWith('.' + SITES_HOST)) return NOT_FOUND;

  var label = host.slice(0, host.length - SITES_HOST.length - 1);
  if (label === 'preview') {
    if (uri === '/') return NOT_FOUND;
    request.uri = '/_preview' + withIndex(uri);
    return request;
  }
  if (!SLUG.test(label)) return NOT_FOUND;
  request.uri = '/' + label + withIndex(uri);
  return request;
}
