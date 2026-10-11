// CloudFront Function (viewer-request) for /geo on the app distribution. Runtime: cloudfront-js-2.0.
// Answers with the visitor's country from CloudFront (ISO code from their IP), so the app can preselect it:
// {"country":"MX"}, or {"country":null} when CloudFront doesn't know. Never reaches the origin.
// The header is only there because the /geo behavior's origin request policy lists CloudFront-Viewer-Country.
function handler(event) {
  var header = event.request.headers['cloudfront-viewer-country'];
  var country = header && /^[A-Z]{2}$/.test(header.value) ? header.value : null;
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: 'private, no-store' },
    },
    body: JSON.stringify({ country: country }),
  };
}
