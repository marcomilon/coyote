import { generate, parse, walk, type CssNode } from 'css-tree';
import { selectAll } from 'css-select';
import render from 'dom-serializer';
import { parseDocument } from 'htmlparser2';
import { Text, type AnyNode, type Document, type Element } from 'domhandler';
import {
  DISPLAY_FOR_URL,
  isImagePlaceholder,
  isTextPlaceholder,
  isUrlPlaceholder,
  MAP_SLOT,
  NEEDS_ATTRIBUTE,
  PLACEHOLDER,
  wholePlaceholder,
} from './placeholders';
import { FONT_ORIGINS, fromOrigins, isHttpsUrl, SCRIPT_ORIGINS, STYLE_ORIGINS } from './cdn';

/**
 * The model writes the whole page. It is kept only if it fits the allowlist: the document is parsed,
 * everything outside the allowlist is a violation, unknown harmless attributes are dropped, and the result
 * is serialized again from the tree (never the raw input). Violations are written for the model, which gets
 * one retry with them as feedback. Scripts (inline, or from the CDNs in cdn.ts) and https: images are allowed;
 * the checks here cover the markup, the CSS, and the text in the HTML, not what a script does at run time.
 */

export interface PageText {
  /** `<title>`. */
  title: string;
  /** Text of every `h1`. */
  h1: string[];
  /** Everything a visitor can read: text nodes, alt/title/aria-label, SVG text, CSS `content`. */
  texts: string[];
}

export interface SanitizeResult {
  /** The rebuilt document. Only meaningful when there are no violations. */
  html: string;
  /** Safety or contract problems. Any one rejects the page. */
  violations: string[];
  /** Quality problems (web-interface-guidelines). Worth one regeneration, never a rejection. */
  lint: string[];
  text: PageText;
}

const MAX_HTML = 200_000;
const MAX_CSS = 80_000;
const MAX_DATA_URI = 20_000;

const HTML_TAGS = new Set([
  'html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script',
  'header', 'footer', 'main', 'section', 'article', 'aside', 'nav', 'div', 'span', 'p', 'br', 'hr', 'wbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption', 'picture',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'blockquote', 'q', 'cite',
  'time', 'address', 'abbr', 'sup', 'sub', 'data', 'details', 'summary',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
]);

/** Inline SVG: shapes, text, gradients, patterns, filters. No foreignObject, a, use, image, or animation. */
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'title', 'desc',
  'filter', 'feturbulence', 'fecolormatrix', 'fegaussianblur', 'feblend', 'fecomposite', 'feoffset', 'femerge',
  'femergenode', 'feflood', 'fedisplacementmap', 'fedropshadow', 'fecomponenttransfer', 'fefunca', 'fefuncr',
  'fefuncg', 'fefuncb', 'femorphology',
]);

const GLOBAL_ATTRS = new Set(['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'translate', NEEDS_ATTRIBUTE]);

const TAG_ATTRS: Record<string, Set<string>> = {
  html: new Set(['lang']),
  meta: new Set(['charset', 'name', 'content']),
  link: new Set(['rel', 'href', 'crossorigin']),
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'fetchpriority']),
  script: new Set(['src', 'type', 'defer', 'async', 'crossorigin', 'integrity', 'referrerpolicy', 'nomodule']),
  time: new Set(['datetime']),
  data: new Set(['value']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'reversed', 'type']),
  details: new Set(['open', 'name']),
  div: new Set([MAP_SLOT.attribute]),
};

const SVG_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'preserveaspectratio', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
  'rx', 'ry', 'fx', 'fy', 'd', 'points', 'pathlength', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'stroke-opacity', 'opacity', 'clip-path', 'clip-rule', 'mask', 'filter', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'patternunits', 'patterncontentunits', 'patterntransform',
  'clippathunits', 'maskunits', 'maskcontentunits', 'filterunits', 'primitiveunits', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'textlength', 'lengthadjust',
  'dx', 'dy', 'startoffset', 'basefrequency', 'numoctaves', 'seed', 'stitchtiles', 'type', 'values', 'in', 'in2',
  'result', 'stddeviation', 'mode', 'operator', 'k1', 'k2', 'k3', 'k4', 'scale', 'xchannelselector',
  'ychannelselector', 'flood-color', 'flood-opacity', 'color-interpolation-filters', 'tablevalues', 'slope',
  'intercept', 'amplitude', 'exponent', 'radius', 'focusable', 'vector-effect', 'paint-order', 'shape-rendering',
  'xml:space', 'href', 'xlink:href', 'xmlns:xlink', 'color',
]);

/** Attributes that must never survive, whatever the tag. Anything else unknown is dropped quietly. Event handlers (`on*`) are allowed along with scripts. */
const DANGEROUS_ATTR = /^(formaction$|action$|srcdoc$|background$|poster$|ping$|download$|http-equiv$|xlink:(?!href$)|xml:base$|is$)/;
const EVENT_HANDLER = /^on[a-z]+$/;

/** `url` as a function (an escaped name) would skip the URL check; the rest load or run things CSS never needs. */
const FORBIDDEN_FUNCTIONS = new Set(['expression', 'element', 'paint', 'src', 'url']);
const FORBIDDEN_PROPERTIES = new Set(['behavior', '-ms-behavior', '-moz-binding']);
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'container', 'layer']);


// ---------------------------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------------------------

interface CssFacts {
  contents: string[];
  /** Selectors of rules that hide what they match, with the reason. */
  hiding: { selector: string; why: string }[];
  motion: boolean;
  reducedMotion: boolean;
  outlineRemoved: boolean;
  focusVisible: boolean;
  transitionAll: boolean;
}

const emptyFacts = (): CssFacts => ({ contents: [], hiding: [], motion: false, reducedMotion: false, outlineRemoved: false, focusVisible: false, transitionAll: false });

/** A `data:image/svg+xml` URL: decoded and kept only when it is a plain drawing (no text, links, or scripts). */
function dataSvgProblem(url: string): string | undefined {
  if (url.length > MAX_DATA_URI) return 'a data: image is too large (max 20 KB)';
  const match = /^data:image\/svg\+xml(;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(url.trim());
  if (!match) return `only data:image/svg+xml data URLs are allowed (${url.slice(0, 40)})`;
  let svg: string;
  try {
    svg = match[2] ? Buffer.from(match[3]!, 'base64').toString('utf8') : decodeURIComponent(match[3]!);
  } catch {
    return 'a data: SVG could not be decoded';
  }
  if (/<\s*(script|foreignobject|text|image|use|a|style|iframe)\b|\bhref\s*=|\bon\w+\s*=|javascript:|url\s*\(\s*['"]?(?!#)/i.test(svg)) {
    return 'a data: SVG may only draw shapes and filters (no text, links, scripts, styles, or external references)';
  }
  return undefined;
}

const px = (value: string): number | undefined => {
  const m = /^(-?\d*\.?\d+)(px|em|rem|vw|vh|%)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'em' || m[2] === 'rem' ? n * 16 : m[2] === 'vw' || m[2] === 'vh' ? n * 10 : n;
};

/** Why a set of declarations hides its element's text from sight, or undefined. */
function hidingReason(decls: Map<string, string>): string | undefined {
  const get = (name: string) => decls.get(name)?.toLowerCase().replace(/\s*!important$/, '').trim();
  if (get('display') === 'none') return 'display: none';
  if (/^(hidden|collapse)$/.test(get('visibility') ?? '')) return 'visibility: hidden';
  const opacity = get('opacity');
  if (opacity !== undefined && Number(opacity) < 0.05 && !decls.has('animation') && !decls.has('animation-name')) return 'opacity: 0';
  const size = get('font-size');
  if (size !== undefined && (px(size) ?? 99) < 4) return 'font-size near 0';
  const clipText = /text/.test(get('background-clip') ?? get('-webkit-background-clip') ?? '');
  if (!clipText && (get('color') === 'transparent' || get('-webkit-text-fill-color') === 'transparent')) return 'transparent text';
  const indent = get('text-indent');
  if (indent !== undefined && (px(indent) ?? 0) <= -200) return 'text-indent off-screen';
  for (const side of ['left', 'top', 'right', 'margin-left', 'margin-top', 'inset']) {
    const value = get(side);
    if (value !== undefined && (px(value.split(/\s+/)[0] ?? '') ?? 0) <= -500) return `${side} off-screen`;
  }
  if (/rect\(\s*0/.test(get('clip') ?? '')) return 'clip: rect(0…)';
  const clipPath = get('clip-path') ?? '';
  if (/inset\(\s*(50|[5-9]\d|100)%|circle\(\s*0/.test(clipPath)) return 'clip-path hides everything';
  if (/scale\(\s*0(\.0\d*)?\s*[,)]|scale\(\s*0\s*\)/.test(get('transform') ?? '') || get('scale') === '0') return 'scale(0)';
  if (get('max-height') === '0' || get('height') === '0' || get('height') === '0px' || get('max-height') === '0px') {
    if (/hidden|clip/.test(get('overflow') ?? '')) return 'height: 0 with overflow hidden';
  }
  return undefined;
}

/**
 * A width breakpoint a real screen falls on either side of (320–2000 px). Hiding something inside one is
 * responsive design (a sticky phone bar hidden on desktop): the text is still visible at other widths.
 */
function isResponsiveBreakpoint(prelude: string): boolean {
  const bounds = [...prelude.matchAll(/\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)\)/g)];
  return bounds.length > 0 && bounds.every((m) => {
    const px = Number(m[1]) * (m[2] === 'px' ? 1 : 16);
    return px >= 320 && px <= 2000;
  });
}

function checkUrl(url: string, where: string, violations: string[]): void {
  if (isImagePlaceholder(wholePlaceholder(url)) || isHttpsUrl(url)) return;
  if (/^data:/i.test(url.trim())) {
    const problem = dataSvgProblem(url);
    if (problem) violations.push(`${where}: ${problem}`);
    return;
  }
  violations.push(`${where}: url(${url.slice(0, 60)}) is not allowed. Use {{hero}}, {{photo:N}}, {{logo}}, an https: URL, or a data:image/svg+xml URL`);
}

/** Checks one stylesheet (`<style>`) or declaration list (`style=""`). Returns the re-serialized CSS. */
function sanitizeCss(css: string, context: 'stylesheet' | 'declarationList', where: string, violations: string[], facts: CssFacts): string {
  const errors: string[] = [];
  const ast = parse(css, { context, positions: false, parseValue: true, onParseError: (error) => errors.push(error.message) });
  if (errors.length > 0) violations.push(`${where}: CSS parse error: ${errors[0]}`);

  walk(ast, function (this: { atrule: { name: string; prelude: CssNode | null } | null }, node: CssNode) {
    switch (node.type) {
      case 'Atrule': {
        const name = node.name.toLowerCase();
        if (!ALLOWED_AT_RULES.has(name)) violations.push(`${where}: @${node.name} is not allowed`);
        if (name === 'media' && node.prelude && /prefers-reduced-motion/.test(generate(node.prelude))) facts.reducedMotion = true;
        break;
      }
      case 'Rule': {
        if (this.atrule && /keyframes$/i.test(this.atrule.name)) break;
        if (node.prelude.type !== 'SelectorList') {
          violations.push(`${where}: unparsable selector`);
          break;
        }
        const selector = generate(node.prelude);
        if (/:focus-visible/.test(selector)) facts.focusVisible = true;
        const decls = new Map<string, string>();
        node.block.children.forEach((child) => {
          if (child.type === 'Declaration') decls.set(child.property.toLowerCase(), generate(child.value));
        });
        const why = hidingReason(decls);
        const responsive = this.atrule?.name.toLowerCase() === 'media' && this.atrule.prelude !== null && isResponsiveBreakpoint(generate(this.atrule.prelude));
        if (why && !responsive) facts.hiding.push({ selector, why });
        break;
      }
      case 'Declaration': {
        const property = node.property.toLowerCase();
        const value = generate(node.value).toLowerCase();
        if (FORBIDDEN_PROPERTIES.has(property)) violations.push(`${where}: property ${node.property} is not allowed`);
        if (/^(-webkit-)?(animation|transition)(-name|-duration)?$/.test(property) && !/^(none|0s?)$/.test(value)) facts.motion = true;
        if ((property === 'transition' && /(^|,|\s)all(\s|,|$)/.test(value)) || (property === 'transition-property' && /\ball\b/.test(value))) facts.transitionAll = true;
        if (/^outline(-style)?$/.test(property) && /^(none|0(px)?)$/.test(value)) facts.outlineRemoved = true;
        if (property === 'content') {
          walk(node.value, (inner: CssNode) => {
            if (inner.type === 'String') facts.contents.push(inner.value);
          });
        }
        break;
      }
      case 'Url':
        checkUrl(node.value, where, violations);
        break;
      case 'Function':
        if (FORBIDDEN_FUNCTIONS.has(node.name.toLowerCase())) violations.push(`${where}: ${node.name}() is not allowed`);
        break;
    }
  });

  const out = generate(ast);
  // Embedded in <style> or an attribute: no markup, ever.
  if (out.includes('<')) violations.push(`${where}: "<" is not allowed in CSS (write ‹ or use an SVG)`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------

const isElement = (node: AnyNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

function textOf(node: AnyNode): string {
  if (node.type === 'text') return (node as Text).data;
  if (isElement(node) && node.name !== 'script' && node.name !== 'style') return node.children.map(textOf).join(' ');
  return '';
}

/** `{{instagram_url}}` written as text → `{{instagram_display}}`. */
const displayUrls = (text: string) =>
  text.replace(PLACEHOLDER, (match, name: string) => (isUrlPlaceholder(name) ? `{{${DISPLAY_FOR_URL[name]}}}` : match));

const stripPlaceholders = (text: string) => text.replace(PLACEHOLDER, ' ').replace(/\s+/g, ' ').trim();

function checkTextPlaceholders(text: string, where: string, violations: string[]): void {
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!isTextPlaceholder(match[1] ?? '')) violations.push(`${where}: {{${match[1]}}} is not allowed in text`);
  }
}

export function sanitizePage(input: string): SanitizeResult {
  const violations: string[] = [];
  const lint: string[] = [];
  const text: PageText = { title: '', h1: [], texts: [] };
  const facts = emptyFacts();

  if (input.length > MAX_HTML) return { html: '', violations: [`the page is too long (${input.length} characters, max ${MAX_HTML})`], lint, text };

  const dom: Document = parseDocument(input, { recognizeSelfClosing: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  let cssLength = 0;
  let maps = 0;
  let whatsappLinks = 0;
  const styled: { el: Element; why: string }[] = [];

  const visit = (node: AnyNode, inSvg: boolean): boolean => {
    if (node.type === 'comment' || node.type === 'directive' || node.type === 'cdata') return false;
    if (node.type === 'text') {
      (node as Text).data = displayUrls((node as Text).data);
      checkTextPlaceholders((node as Text).data, 'text', violations);
      return true;
    }
    if (!isElement(node)) return false;
    const el = node;
    const tag = el.name.toLowerCase();
    const svg = inSvg || tag === 'svg';
    const where = `<${tag}>`;

    if (!(svg ? SVG_TAGS.has(tag) : HTML_TAGS.has(tag))) {
      violations.push(`${where} is not allowed${svg ? ' inside SVG' : ''}`);
      return false;
    }

    if (el.attribs.hidden !== undefined) violations.push(`${where}[hidden]: hidden text is not allowed`);
    for (const [name, value] of Object.entries(el.attribs)) {
      const allowed = GLOBAL_ATTRS.has(name) || name.startsWith('aria-') || (svg ? SVG_ATTRS.has(name) : TAG_ATTRS[tag]?.has(name));
      if (EVENT_HANDLER.test(name)) continue; // allowed with scripts
      if (DANGEROUS_ATTR.test(name)) {
        violations.push(`${where}[${name}] is not allowed`);
        delete el.attribs[name];
        continue;
      } else if (!allowed) {
        delete el.attribs[name]; // harmless but unknown: dropped
        continue;
      }
      if (name === 'style') {
        cssLength += value.length;
        el.attribs.style = sanitizeCss(value, 'declarationList', `${where}[style]`, violations, facts);
        const decls = new Map<string, string>();
        for (const part of el.attribs.style.split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0) decls.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1));
        }
        const why = hidingReason(decls);
        if (why) styled.push({ el, why });
      } else if (name === NEEDS_ATTRIBUTE) {
        const names = value.trim().split(/\s+/);
        if (!names.every((n) => isUrlPlaceholder(n) || isTextPlaceholder(n) || isImagePlaceholder(n) || n === 'map')) {
          violations.push(`${where}[${NEEDS_ATTRIBUTE}="${value.slice(0, 60)}"]: list placeholder names without braces, e.g. "phone_url email_url"`);
        }
      } else if (name !== 'href' && name !== 'src' && name !== 'xlink:href') {
        if (name === 'alt' || name === 'title' || name === 'aria-label') el.attribs[name] = displayUrls(value);
        for (const match of el.attribs[name]!.matchAll(PLACEHOLDER)) {
          if (!(name === 'alt' || name === 'title' || name === 'aria-label') || !isTextPlaceholder(match[1] ?? '')) violations.push(`${where}[${name}]: {{${match[1]}}} is not allowed here`);
        }
        if (svg && /url\(/i.test(value) && !/^url\(#[\w-]+\)$/.test(value.trim())) violations.push(`${where}[${name}]: only url(#id) references are allowed in SVG`);
      }
    }

    // URLs: only placeholders, #anchors, fonts, and plain SVG data.
    if (svg && (el.attribs.href !== undefined || el.attribs['xlink:href'] !== undefined)) {
      const ref = el.attribs.href ?? el.attribs['xlink:href'] ?? '';
      if (!/^#[\w-]+$/.test(ref.trim())) violations.push(`${where}: SVG references must be #id`);
    }
    if (tag === 'a') {
      const href = el.attribs.href?.trim();
      if (href !== undefined && !/^#[\w-]*$/.test(href) && !isUrlPlaceholder(wholePlaceholder(href))) {
        violations.push(`<a href="${href.slice(0, 60)}">: links may only be #anchors or one of {{whatsapp_url}}, {{phone_url}}, {{email_url}}, {{maps_url}}, {{instagram_url}}, {{facebook_url}}`);
      }
      if (wholePlaceholder(href ?? '') === 'whatsapp_url') whatsappLinks++;
      if (el.attribs.target !== undefined && el.attribs.target !== '_blank') delete el.attribs.target;
      if (el.attribs.target === '_blank') el.attribs.rel = 'noopener noreferrer';
      else delete el.attribs.rel;
    }
    if (tag === 'img') {
      const src = el.attribs.src?.trim() ?? '';
      if (/^data:/i.test(src)) {
        const problem = dataSvgProblem(src);
        if (problem) violations.push(`<img src>: ${problem}`);
      } else if (!isImagePlaceholder(wholePlaceholder(src)) && !isHttpsUrl(src)) {
        violations.push(`<img src="${src.slice(0, 60)}">: use {{hero}}, {{photo:N}}, {{logo}}, an https: URL, or a data:image/svg+xml URL`);
      }
      for (const candidate of (el.attribs.srcset ?? '').split(',').map((part) => part.trim().split(/\s+/)[0] ?? '').filter(Boolean)) {
        if (!isHttpsUrl(candidate) && !isImagePlaceholder(wholePlaceholder(candidate))) violations.push(`<img srcset>: ${candidate.slice(0, 60)} must be an https: URL`);
      }
      if (el.attribs.alt === undefined) lint.push('Every <img> needs an alt attribute (alt="" only when decorative).');
      if (el.attribs.width === undefined || el.attribs.height === undefined) lint.push('Every <img> needs explicit width and height attributes.');
      if (el.attribs.alt) text.texts.push(stripPlaceholders(el.attribs.alt));
    }
    if (tag === 'link') {
      const rel = el.attribs.rel?.toLowerCase().trim();
      const href = el.attribs.href?.trim() ?? '';
      const ok = (rel === 'stylesheet' && fromOrigins(href, STYLE_ORIGINS)) || (rel === 'preconnect' && fromOrigins(href, [...STYLE_ORIGINS, ...FONT_ORIGINS, ...SCRIPT_ORIGINS]));
      if (!ok) violations.push(`<link rel="${rel}" href="${href.slice(0, 60)}">: only stylesheets and preconnects from ${STYLE_ORIGINS.join(', ')}`);
    }
    if (tag === 'meta') {
      const name = el.attribs.name?.toLowerCase();
      const ok = (el.attribs.charset !== undefined && Object.keys(el.attribs).length === 1) || name === 'viewport' || name === 'description';
      if (!ok) violations.push('<meta> may only set the charset, the viewport, or the description');
      if (name === 'description' && el.attribs.content) text.texts.push(stripPlaceholders(el.attribs.content));
    }
    if (tag === 'div' && el.attribs[MAP_SLOT.attribute] !== undefined) {
      if (el.attribs[MAP_SLOT.attribute] !== MAP_SLOT.value) violations.push(`<div ${MAP_SLOT.attribute}> must be "${MAP_SLOT.value}"`);
      if (++maps > 1) violations.push(`only one <div ${MAP_SLOT.attribute}="${MAP_SLOT.value}">`);
      if (textOf(el).trim() || el.children.some(isElement)) violations.push(`<div ${MAP_SLOT.attribute}="${MAP_SLOT.value}"> must be empty: the map is added there`);
    }
    for (const name of ['title', 'aria-label']) if (el.attribs[name]) text.texts.push(stripPlaceholders(el.attribs[name]!));

    if (tag === 'script') {
      const src = el.attribs.src;
      if (src !== undefined && !fromOrigins(src, SCRIPT_ORIGINS)) violations.push(`<script src="${src.slice(0, 60)}">: scripts may only load from ${SCRIPT_ORIGINS.join(', ')}`);
      return true; // the code is kept as written; its text is not page text
    }
    if (tag === 'style') {
      const css = el.children.map((child) => (child.type === 'text' ? (child as Text).data : '')).join('');
      cssLength += css.length;
      el.children = [new Text(sanitizeCss(css, 'stylesheet', '<style>', violations, facts))];
      el.children[0]!.parent = el;
      return true;
    }
    if (tag === 'title' && !svg) text.title = stripPlaceholders(textOf(el));
    if (tag === 'h1') text.h1.push(stripPlaceholders(textOf(el)));

    el.children = el.children.filter((child) => visit(child, svg));
    return true;
  };

  dom.children = dom.children.filter((child) => visit(child, false));

  const html = dom.children.find((n): n is Element => isElement(n) && n.name === 'html');
  const has = (tag: string) => html?.children.some((n) => isElement(n) && n.name === tag);
  if (!html || !has('head') || !has('body')) violations.push('write one complete document: <!doctype html><html><head>…</head><body>…</body></html>');
  if (cssLength > MAX_CSS) violations.push(`too much CSS (${cssLength} characters, max ${MAX_CSS})`);
  if (whatsappLinks === 0) violations.push('the page needs at least one WhatsApp link: <a href="{{whatsapp_url}}">');

  // Visible text, by walking the rebuilt tree.
  const collect = (node: AnyNode) => {
    if (node.type === 'text') {
      const t = stripPlaceholders((node as Text).data);
      if (t) text.texts.push(t);
    } else if (isElement(node) && node.name !== 'style' && node.name !== 'script') node.children.forEach(collect);
  };
  if (html) collect(html);
  text.texts.push(...facts.contents.map(stripPlaceholders).filter(Boolean));

  // Hidden text: a hiding rule may match decoration, never readable text.
  const hasText = (el: Element) => stripPlaceholders(textOf(el)).length > 0 || el.attribs.alt;
  for (const { el, why } of styled) if (hasText(el)) violations.push(`hidden text is not allowed (${why} on <${el.name}> with text)`);
  for (const { selector, why } of facts.hiding) {
    const pseudoElement = /::?(before|after|marker|placeholder|selection|first-letter|first-line|backdrop)\b/.test(selector);
    const target = selector.replace(/:(hover|focus|focus-visible|focus-within|active|visited)\b/g, '');
    let matched: Element[];
    try {
      matched = pseudoElement ? [] : (selectAll(target, dom) as unknown as Element[]);
    } catch {
      violations.push(`the selector "${selector.slice(0, 60)}" is too complex for a rule with ${why}`);
      continue;
    }
    const hidden = matched.find(hasText);
    if (hidden) violations.push(`hidden text is not allowed ("${selector.slice(0, 60)}" sets ${why} on <${hidden.name}> with text)`);
  }

  // Quality lint (web-interface-guidelines subset).
  if (text.h1.length !== 1) lint.push(`Use exactly one <h1> (found ${text.h1.length}).`);
  if (facts.outlineRemoved && !facts.focusVisible) lint.push('You remove the focus outline without a :focus-visible replacement. Add a visible focus style.');
  if (facts.transitionAll) lint.push('Never use "transition: all". Transition only transform and opacity.');
  if (facts.motion && !facts.reducedMotion) lint.push('Animations and transitions need a prefers-reduced-motion media query.');
  if (!input.includes('fonts.googleapis.com/css')) lint.push('Load a distinctive Google Font pairing with one <link rel="stylesheet">.');

  const out = `<!doctype html>\n${render(dom.children.filter(isElement), { encodeEntities: 'utf8' })}\n`;
  return { html: out, violations: [...new Set(violations)], lint: [...new Set(lint)], text };
}
