import {
  Apple, ArrowRight, Brush, CalendarCheck, Crown, Droplet, Eye, Hand, Heart, Leaf, Wind, ChefHat, Donut, Drumstick, Flame, GlassWater, Soup, Utensils, Baby, Backpack, Beef, BookOpen, Bone, Cake, Camera, Candy, Carrot, Clock, Coffee, Cookie, Croissant,
  CupSoda, Drill, Egg, Fish, Flower2, Footprints, Gem, Gift, Glasses, Hammer, IceCreamCone, Key, Lightbulb, MapPin,
  MessageCircle, Milk, Navigation, Notebook, Package, PaintBucket, Palette, PawPrint, Pencil, Phone, Mail, Pill, Pizza,
  Plug, Salad, Sandwich, Scissors, Shirt, ShoppingBasket, Smartphone, Snowflake, Sparkles, SprayCan, Sprout, Store,
  Truck, Users, Watch, Wheat, Wrench, type IconNode,
} from 'lucide';
import { html, raw, type SafeHtml } from './html';

/**
 * Lucide icons (https://lucide.dev, ISC license), bundled: rendered as inline SVG, so pages need no script,
 * CDN, or icon font. Import only the icons used here, so the bundle stays small.
 */
const ICONS = {
  apple: Apple, arrowRight: ArrowRight, baby: Baby, backpack: Backpack, beef: Beef, book: BookOpen, bone: Bone,
  cake: Cake, camera: Camera, candy: Candy, carrot: Carrot, clock: Clock, coffee: Coffee, cookie: Cookie,
  croissant: Croissant, soda: CupSoda, drill: Drill, egg: Egg, fish: Fish, flower: Flower2, shoe: Footprints,
  gem: Gem, gift: Gift, glasses: Glasses, hammer: Hammer, iceCream: IceCreamCone, key: Key, bulb: Lightbulb,
  pin: MapPin, chat: MessageCircle, milk: Milk, navigation: Navigation, notebook: Notebook, package: Package,
  paint: PaintBucket, palette: Palette, paw: PawPrint, pencil: Pencil, phone: Phone, mail: Mail, pill: Pill,
  pizza: Pizza, plug: Plug, salad: Salad, sandwich: Sandwich, scissors: Scissors, shirt: Shirt,
  basket: ShoppingBasket, smartphone: Smartphone, snowflake: Snowflake, sparkles: Sparkles, spray: SprayCan,
  sprout: Sprout, store: Store, chef: ChefHat, donut: Donut, drumstick: Drumstick, flame: Flame, water: GlassWater,
  soup: Soup, utensils: Utensils, brush: Brush, calendar: CalendarCheck, crown: Crown, droplet: Droplet, eye: Eye,
  hand: Hand, heart: Heart, leaf: Leaf, wind: Wind, truck: Truck, users: Users, watch: Watch, wheat: Wheat, wrench: Wrench,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const ATTR = /^[a-z-]+$/;
const VALUE = /^[\d\s.,a-zA-Z-]*$/;

/** One icon as inline SVG, drawn in currentColor. Decorative: hidden from screen readers. */
export function icon(name: IconName, className = 'icon'): SafeHtml {
  const children = ICONS[name]
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs).filter(([key, value]) => ATTR.test(key) && VALUE.test(String(value)));
      return `<${tag} ${pairs.map(([key, value]) => `${key}="${value}"`).join(' ')}/>`;
    })
    .join('');
  return html`<svg class="${className}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(children)}</svg>`;
}

/**
 * The icon for a product or service line, by keywords (es + pt, accents ignored). First match wins; the
 * fallback is a shopping basket.
 */
const KEYWORDS: [RegExp, IconName][] = [
  [/\b(trompo|carbon|asado|parrilla|brasa|churrasco|grill|a la lena)/, 'flame'],
  [/\b(taco|taquer|burrito|quesadilla|gringa|torta|arepa|empanada|tamal|enchilada|pastel de|salteña|pupusa|tapioca|coxinha)/, 'utensils'],
  [/\b(pollo|frango|alitas|broaster)/, 'drumstick'],
  [/\b(sopa|caldo|pozole|menudo|ceviche|ramen)/, 'soup'],
  [/\b(dona|donut|rosquinha)/, 'donut'],
  [/\b(agua fresca|aguas frescas|limonada|horchata)/, 'water'],
  [/\b(menu del dia|almuerzo ejecutivo|chef|cocina|prato feito|marmita)/, 'chef'],
  [/\b(pan|panes|panader|pao|paes|padaria|croissant|bolleria)/, 'croissant'],
  [/\b(torta|pastel|bolo|postre|doce)/, 'cake'],
  [/\b(galleta|biscoito|bizcocho)/, 'cookie'],
  [/\b(helad|sorvete)/, 'iceCream'],
  [/\b(dulce|golosina|confiter|bala|chocolate)/, 'candy'],
  [/\b(fruta|manzana|maca)/, 'apple'],
  [/\b(verdura|hortaliza|legume|vegetal)/, 'carrot'],
  [/\b(ensalada|salada|organic|organico)/, 'salad'],
  [/\b(bebida|gaseosa|refresco|jugo|suco|agua|refrigerante)/, 'soda'],
  [/\b(cafe)/, 'coffee'],
  [/\b(leche|lacteo|queso|yogur|leite|queijo|laticinio)/, 'milk'],
  [/\b(huevo|ovo)/, 'egg'],
  [/\b(carne|carniceria|acougue)/, 'beef'],
  [/\b(pescado|marisco|peixe|fruto do mar)/, 'fish'],
  [/\b(congelad|helado|frio)/, 'snowflake'],
  [/\b(abarrote|grano|arroz|harina|cereal|mercearia|feijao|despensa)/, 'wheat'],
  [/\b(sandwich|sanduiche|comida|almuerzo|lanche)/, 'sandwich'],
  [/\b(pizza)/, 'pizza'],
  [/\b(limpieza|limpeza|detergente|aseo|higiene)/, 'spray'],
  [/\b(farmacia|medicament|remedio|drogueria|botica|vitamina)/, 'pill'],
  [/\b(bebe|panal|fralda|infantil)/, 'baby'],
  [/\b(ropa|roupa|camisa|polo|vestido|moda|prenda)/, 'shirt'],
  [/\b(zapat|calzado|sapato|tenis|zapatilla)/, 'shoe'],
  [/\b(libro|livro|libreria|livraria|lectura)/, 'book'],
  [/\b(cuaderno|caderno|papeler|utiles|escolar)/, 'notebook'],
  [/\b(lapiz|lapis|boligrafo|caneta)/, 'pencil'],
  [/\b(mochila|bolso|cartera)/, 'backpack'],
  [/\b(herramienta|ferramenta|martillo|construc|material)/, 'hammer'],
  [/\b(taladro|furadeira)/, 'drill'],
  [/\b(gasfiter|plomer|encanamento|tuberia|repar)/, 'wrench'],
  [/\b(pintura|tinta|brocha)/, 'paint'],
  [/\b(electric|eletric|cable|enchufe|tomada)/, 'plug'],
  [/\b(foco|bombilla|lampada|iluminac)/, 'bulb'],
  [/\b(llave|chave|cerrajer|chaveiro|duplicado)/, 'key'],
  [/\b(mascota|pet|perro|gato|cachorro|veterinari)/, 'paw'],
  [/\b(alimento para|croqueta|racao)/, 'bone'],
  [/\b(regalo|presente|detalle)/, 'gift'],
  [/\b(flor|flores|floreria|floricultura)/, 'flower'],
  [/\b(planta|jardin|vivero|semilla)/, 'sprout'],
  [/\b(celular|telefono|recarga|accesorio)/, 'smartphone'],
  [/\b(reloj|relogio)/, 'watch'],
  [/\b(joya|joia|bijuteria|accesorios de moda)/, 'gem'],
  [/\b(lente|optica|oculos|anteojo)/, 'glasses'],
  [/\b(corte|peluquer|barber|cabelo)/, 'scissors'],
  [/\b(arte|manualidad|artesan)/, 'palette'],
  [/\b(delivery|domicilio|envio|entrega|reparto)/, 'truck'],
  [/\b(pedido|encargo|caja|embalaje|paquete)/, 'package'],
  [/\b(oferta|promo|nuevo|novedad)/, 'sparkles'],
  // Beauty. Last, and bounded on both sides, so they never steal a food or retail match.
  [/\b(manicur\w*|pedicur\w*|nails?|esmaltado|esmaltacao|acrilicas?|unas|unhas)\b/, 'hand'],
  [/\b(cejas?|pestanas|sobrancelhas?|cilios|lifting|laminado)\b/, 'eye'],
  [/\b(maquillaje|maquiagem|makeup|novias?|noivas?)\b/, 'brush'],
  [/\b(masajes?|massagem|spa|facial|faciales|limpeza de pele)\b/, 'leaf'],
  [/\b(coloracion|coloracao|tintes?|mechas|balayage|luzes|decoloracion|reflejos)\b/, 'droplet'],
  [/\b(alisado|alisamento|keratina|queratina|brushing|escova|peinados?|penteados?)\b/, 'wind'],
  [/\b(barbas?|afeitado|navaja|fade|degradado|cortes? de (pelo|cabello|dama|caballero))\b/, 'scissors'],
  [/\b(depilacion|depilacao|cera|laser)\b/, 'sparkles'],
  [/\b(tratamientos?|tratamentos?|hidratacion|hidratacao|botox capilar)\b/, 'heart'],
  [/\b(paquete|pacote|dia de novia|dia da noiva)\b/, 'crown'],
];

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function iconFor(name: string, detail = ''): IconName {
  // The name decides first ("Bebidas" with "jugos helados" is a drink, not ice cream); the detail is a fallback.
  const match = (text: string) => KEYWORDS.find(([pattern]) => pattern.test(normalize(text)))?.[1];
  return match(name) ?? match(detail) ?? 'basket';
}
