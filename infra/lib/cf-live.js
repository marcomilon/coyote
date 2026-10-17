// CloudFront Function (viewer-request) for the live distribution: owners' published sites on their own domains.
// Runtime: cloudfront-js-2.0. Each domain is a distribution tenant whose origin path is /_live/<slug> (hosting.ts),
// so there is nothing to route here; www.<domain> only redirects to the bare domain, keeping the path.
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host.indexOf('www.') === 0) {
    var query = Object.keys(request.querystring)
      .map(function (k) { return k + '=' + request.querystring[k].value; })
      .join('&');
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://' + host.slice(4) + request.uri + (query ? '?' + query : '') } },
    };
  }
  return request;
}
