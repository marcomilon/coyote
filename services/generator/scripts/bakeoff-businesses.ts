import type { RawAnswers } from '../src/core/answers';

/**
 * Fixed businesses for the offline bake-off (PLAN-MODEL-SITES.md step 1). Some are deliberately vague, so the
 * model should ask questions; `canned` answers them the way an owner would.
 */
export interface Business {
  id: string;
  form: RawAnswers;
  canned: {
    /** Answer to the first free-text question. */
    details: string;
    phone?: string;
    email?: string;
    address?: string;
    instagram?: string;
  };
}

export const BUSINESSES: Business[] = [
  {
    id: 'salon-vago',
    form: { businessName: 'Salón Divina', about: 'Salón de belleza en Medellín.', whatsapp: '+57 300 555 1234', lang: 'es' },
    canned: {
      details: 'Cortes de dama desde $35.000, color y mechas, alisado con keratina, manicure y pedicure. Atendemos de martes a sábado de 9 a 7. Somos tres estilistas y trabajamos con cita.',
      address: 'Carrera 43A # 34-95, El Poblado',
      instagram: 'salondivina.med',
    },
  },
  {
    id: 'dentista',
    form: {
      businessName: 'Consultorio Dental Dra. Paula Ríos',
      about: 'Odontología general y estética en Providencia, Santiago. Limpiezas, tapaduras, blanqueamiento, ortodoncia con brackets y alineadores, y urgencias el mismo día. Atendemos niños y adultos. Lunes a viernes de 9:00 a 19:00 y sábados de 9:00 a 13:00. Aceptamos Fonasa y la mayoría de las isapres.',
      whatsapp: '+56 9 8765 4321',
      address: 'Av. Providencia 1208, oficina 402, Providencia',
      lang: 'es',
    },
    canned: { details: 'La primera evaluación es gratis.', phone: '+56 2 2345 6789', email: 'contacto@dentalrios.cl' },
  },
  {
    id: 'minimarket',
    form: { businessName: 'Minimarket Don Lucho', about: 'Bodega de barrio en Surquillo, Lima. Abarrotes, bebidas, frutas y verduras, pan fresco en la mañana. Delivery en la zona.', whatsapp: '+51 987 654 321', lang: 'es' },
    canned: { details: 'Abrimos todos los días de 7 a. m. a 11 p. m. El delivery es gratis por compras desde S/ 30 dentro de Surquillo. Aceptamos Yape y Plin.', address: 'Jr. Dante 845, Surquillo' },
  },
  {
    id: 'ferreteria',
    form: {
      businessName: 'Ferretería El Tornillo',
      about: 'Ferretería en Guadalajara con todo para construcción, plomería, electricidad y pintura. Cortamos vidrio y hacemos duplicado de llaves. Lunes a sábado de 8 a 19.',
      whatsapp: '+52 33 1234 5678',
      address: 'Av. Revolución 1450, Colonia Olímpica',
      facebook: 'ferreteriaeltornillo',
      lang: 'es',
    },
    canned: { details: 'Entregamos material a domicilio en camioneta dentro de Guadalajara.' },
  },
  {
    id: 'panaderia',
    form: {
      businessName: 'Panadería Luna',
      about: 'Panadería de barrio en Chapinero, Bogotá. Pan de masa madre, croissants de mantequilla y café del Huila. Horneamos desde las 5 a. m. Abrimos de lunes a sábado de 7 a 19. También hacemos pedidos para oficinas con un día de anticipación.',
      whatsapp: '+57 300 123 4567',
      address: 'Calle 60 # 9-12, Chapinero',
      instagram: 'panaderia.luna',
      lang: 'es',
    },
    canned: { details: 'La hogaza de masa madre cuesta $18.000 y el croissant $6.500.' },
  },
  {
    id: 'barberia',
    form: { businessName: 'Barbería Los Compadres', about: 'Barbería en Quito.', whatsapp: '+593 99 123 4567', instagram: 'loscompadres.barberia', lang: 'es' },
    canned: { details: 'Corte clásico $8, corte con diseño $10, barba con toalla caliente $6. Trabajamos con cita de lunes a sábado de 10 a 20. El café va por la casa.', address: 'Av. Coruña N27-12, La Floresta' },
  },
  {
    id: 'taqueria',
    form: {
      businessName: 'Tacos Don Beto',
      about: 'Taquería en el Obispado, Monterrey. Tacos de trompo al carbón con piña, bistec, gringas y quesadillas, aguas frescas. De martes a domingo de 7 de la noche a 1 de la mañana. Hacemos taquizas para fiestas desde 30 personas.',
      whatsapp: '+52 81 1234 5678',
      address: 'Calle Hidalgo 2100, Obispado',
      lang: 'es',
    },
    canned: { details: 'Orden de 5 tacos de trompo $95.' },
  },
  {
    id: 'cerrajero',
    form: { businessName: 'Cerrajería 24 Horas Martínez', about: 'Cerrajero a domicilio en Buenos Aires, zona norte. Aperturas, cambio de cerraduras, copias de llaves, cerraduras de seguridad.', whatsapp: '+54 9 11 5555 1234', lang: 'es' },
    canned: { details: 'Atendemos las 24 horas, los 365 días, y llegamos en 30 minutos en Vicente López, Olivos y San Isidro.', phone: '+54 11 4555 1234' },
  },
  {
    id: 'unhas-pt',
    form: { businessName: 'Studio Unhas da Bia', about: 'Manicure e pedicure em Belo Horizonte.', whatsapp: '+55 31 91234 5678', lang: 'pt' },
    canned: { details: 'Esmaltação em gel R$ 60, alongamento de fibra R$ 150, pé e mão R$ 55. Atendo só com hora marcada, de terça a sábado, das 9h às 19h, na Savassi.', address: 'Rua Pernambuco 1000, Savassi', instagram: 'unhasdabia' },
  },
  {
    id: 'psicologa-pt',
    form: {
      businessName: 'Ana Ribeiro Psicologia',
      about: 'Psicóloga clínica em Curitiba. Terapia para adultos com ansiedade, luto e mudanças de vida, presencial no Batel ou online. Sessões de 50 minutos. Segunda a quinta das 8h às 20h, sexta das 8h às 14h. A primeira conversa é gratuita, por vídeo.',
      whatsapp: '+55 41 91234 5678',
      address: 'Rua Bispo Dom José 2400, sala 5, Batel',
      instagram: 'anaribeiro.psi',
      lang: 'pt',
    },
    canned: { details: 'CRP 08/12345. Atendo também orientação para pais.', email: 'contato@anaribeiropsi.com.br' },
  },
];
