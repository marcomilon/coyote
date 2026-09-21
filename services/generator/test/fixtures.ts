import type { Brief } from '../src/core/brief';
import { SiteContent } from '../src/core/content';

export const brief: Brief = {
  theme: 'editorial',
  palette: { ink: '#1f1a17', paper: '#f6efe4', accent: '#c2410c' },
  fontPairing: 'fraunces-worksans',
  tone: 'cálido y directo',
  signatureElement: 'Una franja gruesa color ladrillo bajo el nombre',
  headline: 'Pan de masa madre en Chapinero',
};

export const content: SiteContent = SiteContent.parse({
  businessName: 'Panadería Luna',
  lang: 'es',
  title: 'Panadería Luna — pan de masa madre en Chapinero, Bogotá',
  description: 'Pan de masa madre horneado cada mañana en Chapinero.',
  headline: 'Pan de masa madre, cada mañana en Chapinero',
  subhead: 'Horneamos desde las 5 a. m. con harinas colombianas.',
  about: 'Somos una panadería de barrio en Chapinero.',
  services: [{ name: 'Pan de masa madre', detail: 'Hogazas de 800 g' }, { name: 'Café de origen' }],
  hours: [{ days: 'Lunes a sábado', time: '7:00 – 19:00' }],
  location: { neighborhood: 'Chapinero', city: 'Bogotá' },
  ctaText: 'Pide por WhatsApp',
  contact: { whatsapp: '573001234567', address: 'Calle 60 # 9-12', instagram: 'panaderia.luna' },
});
