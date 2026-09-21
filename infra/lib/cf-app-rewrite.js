// CloudFront Function (viewer-request) for the app distribution. Runtime: cloudfront-js-2.0.
// Maps clean URLs to the static build: /mi-sitio → /mi-sitio/index.html, /pt/ → /pt/index.html.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.slice(uri.lastIndexOf('/') + 1).indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }
  return request;
}
