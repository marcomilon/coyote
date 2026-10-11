// CloudFront Function (viewer-request) for the app distribution. Runtime: cloudfront-js-2.0.
// Maps clean URLs to the static build: /mi-pagina-web → /mi-pagina-web/index.html, /pt/ → /pt/index.html.
// Domain mode: the bare domain (BARE_HOST) redirects to the app's www address (APP_URL), path and query kept.
// Visitors from a voseo country (VOSEO, from i18n.ts) get the Spanish pages written with vos, built under /vos/,
// at the usual URLs: /crear → /vos/crear/index.html. The rewritten URI is the cache key, so each version caches apart.
// The country is the one chosen in the home page's picker (the `country` cookie), else the one CloudFront sees.
var BARE_HOST = '__BARE_HOST__';
var APP_URL = '__APP_URL__';
var VOSEO = '__VOSEO__'.split(',');

// A Spanish page (not Portuguese, not a file, not already a vos page) for a visitor in a voseo country.
function wantsVos(request, uri) {
  var chosen = request.cookies && request.cookies.country;
  var seen = request.headers['cloudfront-viewer-country'];
  var country = chosen && /^[A-Z]{2}$/.test(chosen.value) ? chosen.value : seen ? seen.value : '';
  if (VOSEO.indexOf(country) < 0) return false;
  if (uri === '/pt' || uri.indexOf('/pt/') === 0 || uri === '/vos' || uri.indexOf('/vos/') === 0) return false;
  return uri.slice(uri.lastIndexOf('/') + 1).indexOf('.') === -1;
}

function query(qs) {
  var parts = [];
  for (var key in qs) {
    var entry = qs[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) parts.push(key + (values[i].value === '' ? '' : '=' + values[i].value));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (BARE_HOST && host === BARE_HOST) {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: APP_URL + uri + query(request.querystring || {}) } } };
  }
  if (wantsVos(request, uri)) uri = '/vos' + uri;
  request.uri = uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.slice(uri.lastIndexOf('/') + 1).indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }
  return request;
}
