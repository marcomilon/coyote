/**
 * Renders every theme with fixed content (no model call) into out/themes/, plus an index page with all of
 * them side by side. Use it while designing themes:
 *   npm run themes:sheet            then open services/generator/out/themes/index.html
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEMES } from '../themes';
import { SiteContent } from '../src/core/content';
import { FONT_PAIRINGS, type FontPairingId } from '../src/core/fonts';
import { checkHtml } from '../src/core/policy';
import { render } from '../src/core/render';

const SAMPLES: Record<string, unknown> = {
  editorial: { businessName: 'Rivas & Asociados', lang: 'es', title: 'Rivas & Asociados — abogados laborales en Córdoba', description: 'Abogados laborales y de familia en Córdoba.', headline: 'Defendemos tu trabajo en Córdoba', subhead: 'Despidos, accidentes y divorcios, con una primera consulta sin cargo.', about: 'Somos un estudio de tres abogadas en el centro de Córdoba. Desde 2009 acompañamos a trabajadores y familias, con honorarios claros desde el primer día y atención en persona o por videollamada.', services: [{ name: 'Despidos e indemnizaciones', detail: 'Revisamos tu liquidación sin costo' }, { name: 'Accidentes de trabajo', detail: 'Reclamos ante la ART' }, { name: 'Divorcios y alimentos' }, { name: 'Sucesiones', detail: 'Trámite completo' }, { name: 'Contratos de alquiler' }], hours: [{ days: 'Lunes a viernes', time: '9:00 – 18:00' }], location: { neighborhood: 'Centro', city: 'Córdoba' }, ctaText: 'Consultanos hoy', contact: { whatsapp: '5493510000000', address: 'Av. Colón 455, piso 3', instagram: 'rivas.abogadas' } },
  cartel: { businessName: 'Taller El Pistón', lang: 'es', title: 'Taller El Pistón — mecánica en Guadalajara', description: 'Afinación, frenos y suspensión en Guadalajara.', headline: 'Tu carro listo el mismo día', subhead: 'Afinación, frenos y suspensión con diagnóstico por computadora en Guadalajara.', about: 'Veinte años arreglando carros en la colonia Americana. Te decimos qué tiene, cuánto cuesta y cuándo queda, antes de tocar una sola tuerca.', services: [{ name: 'Afinación mayor', detail: 'Bujías, filtros y escaneo' }, { name: 'Frenos', detail: 'Balatas y rectificado' }, { name: 'Suspensión' }, { name: 'Diagnóstico por computadora', detail: 'Todas las marcas' }], hours: [{ days: 'Lunes a viernes', time: '9 – 18' }, { days: 'Sábados', time: '9 – 14' }], location: { neighborhood: 'Americana', city: 'Guadalajara' }, ctaText: 'Agenda por WhatsApp', contact: { whatsapp: '523312345678', address: 'Av. Patria 1200', facebook: 'tallerelpiston' } },
  artesanal: { businessName: 'Panadería Luna', lang: 'es', title: 'Panadería Luna — masa madre en Chapinero', description: 'Pan de masa madre horneado cada mañana en Chapinero.', headline: 'Pan de masa madre, cada mañana en Chapinero', subhead: 'Horneamos desde las 5 a. m. con harinas colombianas y café del Huila.', about: 'Somos una panadería de barrio. Amasamos a mano, fermentamos despacio y vendemos lo que sale del horno ese día. También armamos pedidos para oficinas.', services: [{ name: 'Pan de masa madre', detail: 'Hogazas de 800 g, blancas e integrales' }, { name: 'Croissants', detail: 'De mantequilla, todos los días' }, { name: 'Café del Huila' }, { name: 'Pedidos para oficinas', detail: 'Con un día de anticipación' }], hours: [{ days: 'Lunes a sábado', time: '7:00 – 19:00' }], location: { neighborhood: 'Chapinero', city: 'Bogotá' }, ctaText: 'Pide por WhatsApp', contact: { whatsapp: '573001234567', address: 'Calle 60 # 9-12', instagram: 'panaderia.luna' } },
  nocturno: { businessName: 'Salão Bela Flor', lang: 'pt', title: 'Salão Bela Flor — beleza em Belo Horizonte', description: 'Corte, coloração e design de sobrancelhas em Belo Horizonte.', headline: 'Seu cabelo, do seu jeito', subhead: 'Corte, coloração e sobrancelhas na Savassi, com hora marcada e sem pressa.', about: 'Um salão pequeno, com três cadeiras e tempo para conversar. Trabalhamos com coloração sem amônia e atendemos só com hora marcada.', services: [{ name: 'Corte e finalização' }, { name: 'Coloração', detail: 'Sem amônia' }, { name: 'Design de sobrancelhas' }, { name: 'Manicure', detail: 'Esmaltação em gel' }, { name: 'Dia da noiva', detail: 'Pacote completo' }], hours: [{ days: 'Terça a sábado', time: '9h – 19h' }], location: { neighborhood: 'Savassi', city: 'Belo Horizonte' }, ctaText: 'Agende pelo WhatsApp', contact: { whatsapp: '5531912345678', address: 'Rua Pernambuco 1000', instagram: 'salaobelaflor' } },
  tropical: { businessName: 'Jugos La Palma', lang: 'es', title: 'Jugos La Palma — jugos naturales en Cartagena', description: 'Jugos naturales, cholados y ensaladas de fruta en Getsemaní.', headline: 'Fruta fresca, frío del bueno', subhead: 'Jugos, cholados y ensaladas de fruta hechos al momento en Getsemaní.', about: 'Compramos la fruta cada mañana en Bazurto y la servimos el mismo día. Sin polvos ni jarabes: fruta, hielo y, si quieres, leche.', services: [{ name: 'Jugos naturales', detail: 'Lulo, corozo, mango, níspero' }, { name: 'Cholados' }, { name: 'Ensalada de frutas', detail: 'Con queso y helado' }, { name: 'Limonada de coco' }, { name: 'Pedidos para eventos' }], hours: [{ days: 'Todos los días', time: '8:00 – 20:00' }], location: { neighborhood: 'Getsemaní', city: 'Cartagena' }, ctaText: 'Haz tu pedido', contact: { whatsapp: '573009876543', address: 'Calle de la Sierpe 29', instagram: 'jugoslapalma' } },
  clinico: { businessName: 'Veterinaria Patitas', lang: 'es', title: 'Veterinaria Patitas — Miraflores, Lima', description: 'Consulta, vacunas y peluquería canina en Miraflores.', headline: 'Cuidamos a tu mascota en Miraflores', subhead: 'Consulta, vacunas, cirugía menor y peluquería canina, con cita o por orden de llegada.', about: 'Dos veterinarias colegiadas y un equipo que conoce a cada paciente por su nombre. Tenemos laboratorio propio, así que la mayoría de resultados salen el mismo día.', services: [{ name: 'Consulta general', detail: 'Perros, gatos y conejos' }, { name: 'Vacunas y desparasitación' }, { name: 'Cirugía menor', detail: 'Esterilizaciones' }, { name: 'Peluquería canina' }, { name: 'Laboratorio', detail: 'Resultados el mismo día' }, { name: 'Atención a domicilio' }], hours: [{ days: 'Lunes a sábado', time: '9:00 – 20:00' }, { days: 'Domingos', time: '10:00 – 14:00' }], location: { neighborhood: 'Miraflores', city: 'Lima' }, ctaText: 'Pide tu cita', contact: { whatsapp: '51987654321', address: 'Av. Larco 730', facebook: 'vetpatitas' } },
};

const outDir = resolve('out/themes');
mkdirSync(outDir, { recursive: true });

for (const theme of Object.values(THEMES)) {
  const fontPairing = (Object.keys(FONT_PAIRINGS) as FontPairingId[]).find((id) => theme.meta.fontStyles.includes(FONT_PAIRINGS[id].style))!;
  const page = render({
    theme,
    content: SiteContent.parse(SAMPLES[theme.id] ?? SAMPLES.artesanal),
    brief: { theme: theme.id, palette: theme.meta.defaultPalette, fontPairing, tone: '', signatureElement: '', headline: '' },
    siteUrl: 'https://example.invalid/site/',
    reportUrl: 'https://example.invalid/reportar',
    privacyUrl: 'https://example.invalid/privacidad',
  });
  const violations = checkHtml(page, { platformOrigins: ['https://example.invalid'] });
  if (violations.length > 0) throw new Error(`${theme.id} breaks the HTML policy: ${JSON.stringify(violations)}`);
  writeFileSync(resolve(outDir, `${theme.id}.html`), page);
}

const ids = Object.keys(THEMES);
writeFileSync(
  resolve(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Coyote themes</title><style>body{margin:0;background:#222;color:#eee;font:14px system-ui;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:12px}figure{margin:0}iframe{width:200%;height:1400px;border:0;transform:scale(.5);transform-origin:0 0;background:#fff}div{height:700px;overflow:hidden}figcaption{padding:6px 2px}</style>${ids.map((id) => `<figure><figcaption>${id}</figcaption><div><iframe src="${id}.html"></iframe></div></figure>`).join('')}`,
);
console.log(`${ids.length} themes → ${resolve(outDir, 'index.html')}`);
