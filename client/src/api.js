// Prefijo donde está montada la app: '/' en local, '/liquidacion/' en el
// servidor (lo fija BASE_PATH al construir). Sin esto, un fetch a '/api/...'
// saldría a la raíz del dominio, donde vive OTRA aplicación con su propio
// /api — y las peticiones acabarían en la plataforma equivocada.
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Ruta de un archivo de public/ (logo, iconos) respetando el prefijo. */
export const recurso = (nombre) => `${BASE}/${nombre.replace(/^\/+/, '')}`;

/** Lanzado cuando la sesión no vale: la interfaz lo distingue de un error normal. */
export class ErrorSesion extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = 'ErrorSesion';
    this.codigo = codigo;
  }
}

async function pedir(url, opciones = {}) {
  const res = await fetch(BASE + '/api' + url, {
    headers: { 'Content-Type': 'application/json' },
    // La cookie de sesión la emite la plataforma en el mismo dominio; sin esto
    // el navegador no la adjunta en peticiones hechas desde JavaScript.
    credentials: 'same-origin',
    ...opciones,
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new ErrorSesion(datos.error || 'Tu sesión no es válida.', res.status);
  }
  if (!res.ok) throw new Error(datos.error || 'No se pudo completar la acción.');
  return datos;
}

export const api = {
  get: (url) => pedir(url),
  post: (url, body) => pedir(url, { method: 'POST', body }),
  put: (url, body) => pedir(url, { method: 'PUT', body }),
  del: (url) => pedir(url, { method: 'DELETE' }),
};

export const sesion = {
  quienSoy: () => api.get('/auth/me'),
  entrar: (username, password) => api.post('/auth/login', { username, password }),
  salir: () => api.post('/auth/logout'),
};

const fmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
export const pesos = (n) => fmt.format(Math.round(n || 0));
export const num = (n) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(n || 0);

export const duracion = (min) => {
  if (!min || min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h ${m ? m + ' min' : ''}`.trim() : `${m} min`;
};

export const minutosEntre = (ini, fin) => {
  if (!ini || !fin) return 0;
  const [h1, m1] = ini.split(':').map(Number);
  const [h2, m2] = fin.split(':').map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
};

export const hoyISO = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

export const fechaLarga = (iso) =>
  new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
