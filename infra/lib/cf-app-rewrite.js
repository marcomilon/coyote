// CloudFront Function (viewer-request) for the app distribution. Runtime: cloudfront-js-2.0.
// Maps clean URLs to the static build: /mi-sitio → /mi-sitio/index.html, /pt/ → /pt/index.html.
// Domain mode: the bare domain (BARE_HOST) redirects to the app's www address (APP_URL), path and query kept.
var BARE_HOST = '__BARE_HOST__';
var APP_URL = '__APP_URL__';

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
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.slice(uri.lastIndexOf('/') + 1).indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }
  return request;
}
