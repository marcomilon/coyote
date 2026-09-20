import { generate, parse, walk, type CssNode } from 'css-tree';

const MAX_LENGTH = 2000;

const ALLOWED_PROPERTIES = new Set([
  'color', 'opacity', 'mix-blend-mode',
  'background', 'background-color', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'background-clip',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-radius', 'outline', 'outline-offset', 'box-shadow', 'text-shadow',
  'font-size', 'font-weight', 'font-style', 'font-variant', 'letter-spacing', 'line-height', 'text-transform',
  'text-align', 'text-decoration', 'text-decoration-color', 'text-decoration-thickness', 'text-underline-offset',
  'text-wrap', 'white-space', 'writing-mode', '-webkit-text-stroke',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'gap', 'row-gap',
  'column-gap', 'align-items', 'align-self', 'justify-content', 'justify-self', 'place-items', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'position', 'top', 'right', 'bottom', 'left', 'inset', 'overflow',
  'transform', 'transform-origin', 'rotate', 'scale', 'translate', 'clip-path', 'content',
]);

const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'color-mix', 'var', 'calc', 'min', 'max', 'clamp', 'repeat', 'minmax',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient',
  'rotate', 'scale', 'scalex', 'scaley', 'translate', 'translatex', 'translatey', 'skew', 'skewx', 'skewy',
  'polygon', 'circle', 'ellipse', 'inset',
]);

const ALLOWED_POSITIONS = new Set(['static', 'relative', 'absolute']);

export type CssResult = { ok: true; css: string } | { ok: false; reasons: string[] };

/**
 * `signatureCss` is the only code the model writes. It is kept only if every rule is scoped to
 * `.signature` and uses allowlisted properties and functions. Anything else drops the whole block.
 * The output is re-serialized from the AST, never the raw input.
 */
export function sanitizeSignatureCss(input: string): CssResult {
  const reasons: string[] = [];
  if (input.length > MAX_LENGTH) return { ok: false, reasons: ['too long'] };

  const ast = parse(input, {
    positions: false,
    onParseError: (error) => reasons.push(`parse error: ${error.message}`),
  });

  walk(ast, (node: CssNode) => {
    switch (node.type) {
      case 'Atrule':
        if (node.name.toLowerCase() !== 'media') reasons.push(`at-rule @${node.name}`);
        break;
      case 'Rule':
        if (node.prelude.type !== 'SelectorList') {
          reasons.push('unparsable selector');
          break;
        }
        node.prelude.children.forEach((selector) => {
          if (selector.type !== 'Selector') return;
          const first = selector.children.first;
          if (first?.type !== 'ClassSelector' || first.name !== 'signature') {
            reasons.push(`selector outside .signature: ${generate(selector)}`);
          }
        });
        break;
      case 'Combinator':
        if (node.name === '~' || node.name === '+') reasons.push(`sibling combinator ${node.name}`);
        break;
      case 'Declaration': {
        const property = node.property.toLowerCase();
        if (!ALLOWED_PROPERTIES.has(property)) reasons.push(`property ${node.property}`);
        if (node.value.type === 'Raw') reasons.push(`unparsable value for ${node.property}`);
        if (property === 'position' && !ALLOWED_POSITIONS.has(generate(node.value).toLowerCase())) {
          reasons.push(`position: ${generate(node.value)}`);
        }
        break;
      }
      case 'Url':
        reasons.push('url()');
        break;
      case 'Function':
        if (!ALLOWED_FUNCTIONS.has(node.name.toLowerCase())) reasons.push(`function ${node.name}()`);
        break;
    }
  });

  const css = generate(ast);
  // The result is embedded in <style>: no markup, no CSS escapes that could hide a name.
  if (/[<\\]/.test(css)) reasons.push('"<" or "\\" in output');

  return reasons.length === 0 ? { ok: true, css } : { ok: false, reasons };
}
