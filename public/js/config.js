// ============================================================
// RADIO PORCHE · CONFIGURACIÓN ÚNICA
// Este archivo lo usan a la vez la app (navegador) y el servidor (Worker).
// Para cambiar textos, límites o datos legales, se toca SOLO aquí.
// ============================================================

export const APP = {
  name: 'Radio Porche',
  tagline: 'Radios de barrio en directo desde tu porche',
  description:
    'Abre tu porche y emite en directo con tus amigos desde el móvil. Escucha radios de barrio, comenta en el chat, pide micro y escucha los podcasts grabados.',
};

// --- Datos legales (sustituir antes de abrir al público) ---
export const LEGAL = {
  TITULAR: 'Marc Font',
  NIF: '38884935P',
  CORREO: 'phawna.info@gmail.com',
  DOMICILIO: 'Escoles 51, 08380, España',
  // Si cambias cualquier texto legal, sube esta versión: la app pedirá aceptar de nuevo.
  TERMS_VERSION: '2026-11-27',
};

// --- Duración y publicación ---
export const LIMITS = {
  MAX_PART_MIN: 40, // máximo por parte
  WARN_1_MIN: 35, // "Te quedan 5 minutos"
  WARN_2_MIN: 39, // último aviso
  MIN_PUBLISH_MIN: 5, // mínimo para publicar
  SERVER_MAX_MIN: 41, // el servidor rechaza más de esto
  MAX_PUBLICADOS: null, // null = sin cupo (preparado para premium)
  DRAFT_DAYS: 7, // los borradores se borran solos
  MAX_UPLOAD_BYTES: 26 * 1024 * 1024, // ~40 min de Opus mono
  COVER_MAX_BYTES: 500 * 1024,
  SOUND_MAX_BYTES: 40 * 1024 * 1024, // archivos propios (antes de comprimir)
  LIBRARY_MAX_BYTES: 8 * 1024 * 1024, // cada sonido "de serie" subido desde admin
  PORCH_MAX_BYTES: 600 * 1024 * 1024, // tope de lo publicado por porche
  GLOBAL_STORAGE_BYTES: 5 * 1024 * 1024 * 1024, // plan gratuito
  STORAGE_WARN_RATIO: 0.8,

  NAME_MIN: 2,
  NAME_MAX: 30,
  TITLE_MAX: 80,
  DESC_MAX: 500,
  PORCH_NAME_MAX: 40,
  CHAT_MAX: 300,
  COMMENT_MAX: 300,
  CHAPTERS_MAX: 30,
  NEXT_SHOW_MAX: 60,

  // Salas
  ROOM_MAX_CONN: 25,
  ROOM_MAX_PER_IP: 3,
  ROOM_MAX_MICS: 8,
  WS_MAX_BYTES: 8 * 1024,
  WS_IDLE_SEC: 75,

  // Límites por dispositivo/IP (servidor)
  CHAT_MIN_GAP_MS: 2000,
  CHAT_PER_MIN: 20,
  CHAT_MIN_GAP_MS_NEW: 4000,
  CHAT_PER_MIN_NEW: 10,
  MIC_REQ_GAP_S: 30,
  IDENTITIES_PER_HOUR_IP: 5,
  PUBLISH_PER_DAY: 5,
  PUBLISH_PER_DAY_NEW: 2,
  REPORTS_PER_DAY: 10,
  REPORTS_PER_DAY_NEW: 3,
  COMMENTS_PER_MIN: 6,
  GLOBAL_PUBLISH_PER_HOUR: 30,
  NEW_IDENTITY_HOURS: 24,

  // Ocultación automática
  AUTO_HIDE_REPORTS: 3,
  AUTO_HIDE_REPORTS_SERIOUS: 2,

  LISTEN_COUNT_SEC: 60, // escucha real: más de 1 minuto
};

export const NAME_PATTERN = "^[A-Za-zÀ-ÖØ-öø-ÿ0-9 ._'-]+$";

// --- Zonas de sonido de la cabina ---
export const ZONES = {
  fx: { label: 'Efectos', hint: 'Cortos, de un toque. Suenan encima de todo.' },
  bg: { label: 'Música de fondo', hint: 'Una pista en bucle bajo las voces. Baja sola cuando alguien habla.' },
  song: { label: 'Canciones', hint: 'Temas completos que suenan una vez. Ojo con los derechos si publicas.' },
};

// --- Voz ---
export const VOICE_FX = [
  { id: 'pitufo', name: 'Pitufo', hint: 'agudo' },
  { id: 'robot', name: 'Robot', hint: 'metálico' },
  { id: 'walkie', name: 'Walkie', hint: 'radio vieja' },
  { id: 'burbuja', name: 'Burbuja', hint: 'bajo el agua' },
  { id: 'gigante', name: 'Gigante', hint: 'grave' },
  { id: 'eco', name: 'Eco', hint: 'cueva' },
];

export const BROADCAST_MODES = [
  { id: 'ensayo', name: 'Ensayo', hint: 'Solo quien invites. No se graba.' },
  { id: 'directo', name: 'Solo directo', hint: 'Abierto a todos. No se graba nada.' },
  { id: 'rec', name: 'Directo + grabación', hint: 'Se guarda en tus borradores. Tú decides si se publica.' },
];

export const REPORT_REASONS = [
  { id: 'spam', name: 'Spam' },
  { id: 'acoso', name: 'Insultos o acoso' },
  { id: 'odio', name: 'Odio' },
  { id: 'privados', name: 'Datos privados de otros' },
  { id: 'menores', name: 'Menores' },
  { id: 'ilegal', name: 'Contenido ilegal' },
  { id: 'derechos', name: 'Derechos de autor' },
  { id: 'otro', name: 'Otro' },
];
export const SERIOUS_REASONS = ['menores', 'ilegal'];

// Lista inicial del filtro (editable desde el panel de administración)
export const DEFAULT_BADWORDS = [
  'gilipollas', 'subnormal', 'maricon', 'maricón', 'puta', 'zorra', 'hijoputa', 'hijo de puta',
  'mongolo', 'retrasado', 'sudaca', 'panchito', 'moro de mierda', 'negrata', 'malparido',
];

export const QUICK_REACTIONS = ['🔥', '😂', '👏', '❤️', '📻'];

export const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
