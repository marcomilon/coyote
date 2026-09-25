import render from 'dom-serializer';
import { Element, Text, type AnyNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { SiteDoc } from './drafts';
import { strings } from './i18n';
import { MAP_SLOT, NEEDS_ATTRIBUTE, PLACEHOLDER, wholePlaceholder } from './placeholders';
import type { Urls } from './urls';

const isElement = (node: AnyNode): node is Element => node.type === 'tag' || node.type === 'style' || node.type === 'script';

/** Every placeholder's value for this site. Undefined = the owner has none, so the element goes. */
export function placeholderValues(doc: SiteDoc, urls: Urls): Record<string, string | undefined> {
  const { contact, lang } = doc.answers;
  const { media } = doc;
  const greeting = encodeURIComponent(strings(lang).whatsappGreeting);
  return {
    whatsapp_url: `https://wa.me/${contact.whatsapp}?text=${greeting}`,
    whatsapp_display: `+${contact.whatsapp}`,
    phone_url: contact.phone && `tel:+${contact.phone}`,
    phone_display: contact.phone && `+${contact.phone}`,
    email_url: contact.email && `mailto:${contact.email}`,
    email_display: contact.email,
    maps_url: contact.address && urls.mapsUrl(contact.address),
    address: contact.address,
    map: contact.address,
    instagram_url: contact.instagram && `https://instagram.com/${contact.instagram}`,
    instagram_display: contact.instagram && `@${contact.instagram}`,
    facebook_url: contact.facebook && `https://facebook.com/${contact.facebook}`,
    facebook_display: contact.facebook,
    logo: media.logo,
    hero: media.hero ?? media.photos[0],
    'photo:1': media.photos[0],
    'photo:2': media.photos[1],
    'photo:3': media.photos[2],
  };
}

const CSS_IMAGE = /url\(\s*(["']?)\{\{([a-z:0-9]+)\}\}\1\s*\)/g;

/**
 * Sanitized source → the page a visitor sees. Pure: same source and site record, same page, no model call.
 * Every value comes from the owner's input and is escaped by the serializer. A placeholder with no value
 * removes the element that carries it, so the model can design every contact option and the page shows
 * only the ones the owner has. The Google map and the platform footer are added here, after sanitizing.
 */
export function fillPage(source: string, doc: SiteDoc, slug: string, urls: Urls): string {
  const values = placeholderValues(doc, urls);
  const t = strings(doc.answers.lang);
  const dom = parseDocument(source, { recognizeSelfClosing: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const doomed = new Set<AnyNode>();
  const cssImages = (css: string) => css.replace(CSS_IMAGE, (_, _q, name: string) => (values[name] ? `url("${values[name]}") ` : 'none '));

  const visit = (node: AnyNode): void => {
    if (node.type === 'text' && node.parent) {
      const text = node as Text;
      if (isElement(node.parent) && node.parent.name === 'style') {
        text.data = cssImages(text.data);
        return;
      }
      let missing = false;
      text.data = text.data.replace(PLACEHOLDER, (_, name: string) => values[name] ?? ((missing = true), ''));
      if (missing) doomed.add(node.parent);
      return;
    }
    if (!isElement(node)) return;
    const el = node;
    for (const [name, value] of Object.entries(el.attribs)) {
      if (name === 'href' || name === 'src') {
        const placeholder = wholePlaceholder(value);
        if (placeholder === undefined) continue;
        const filled = values[placeholder];
        if (filled === undefined) doomed.add(el);
        else el.attribs[name] = filled;
      } else if (name === 'style') {
        el.attribs.style = cssImages(value);
      } else if (name === NEEDS_ATTRIBUTE) {
        if (value.trim().split(/\s+/).some((needed) => !values[needed])) doomed.add(el);
        delete el.attribs[name];
      } else if (value.includes('{{')) {
        el.attribs[name] = value.replace(PLACEHOLDER, (_, n: string) => values[n] ?? '');
      }
    }
    if (el.name === 'div' && el.attribs[MAP_SLOT.attribute] === MAP_SLOT.value) {
      const address = doc.answers.contact.address;
      if (!address) doomed.add(el);
      else {
        const iframe = new Element('iframe', {
          title: `${t.map}: ${doc.answers.businessName}, ${address}`,
          loading: 'lazy',
          referrerpolicy: 'no-referrer-when-downgrade',
          src: urls.mapEmbedUrl(address),
          'data-coyote-map': '',
          style: 'border:0;display:block;width:100%;height:100%;min-height:240px',
        });
        iframe.parent = el;
        el.children = [iframe];
      }
    }
    if (el.name === 'html') el.attribs.lang = t.htmlLang;
    el.children.forEach(visit);
  };
  dom.children.forEach(visit);

  for (const node of doomed) {
    const siblings = node.parent?.children;
    if (siblings && !(isElement(node) && (node.name === 'body' || node.name === 'html' || node.name === 'head'))) siblings.splice(siblings.indexOf(node), 1);
  }

  const body = dom.children.filter(isElement).flatMap((n) => (n.name === 'html' ? n.children : [])).find((n): n is Element => isElement(n) && n.name === 'body');
  if (body) {
    const { reportUrl, privacyUrl } = urls.pageLinks(slug, doc.answers.lang);
    const footer = parseDocument(
      `<footer class="coyote-footer" style="padding:1.5rem 1.25rem 6rem;font:13px/1.5 system-ui,sans-serif;text-align:center;opacity:.75"></footer>`,
    ).children[0] as Element;
    const link = (href: string, label: string) => Object.assign(new Element('a', { href, style: 'color:inherit;margin-left:.75rem' }), { children: [new Text(label)] });
    footer.children = [new Text(t.madeWith), link(reportUrl, t.report), link(privacyUrl, t.privacy)];
    footer.children.forEach((child) => (child.parent = footer));
    footer.parent = body;
    body.children.push(footer);
  }

  return `<!doctype html>\n${render(dom.children.filter(isElement), { encodeEntities: 'utf8' })}\n`;
}
