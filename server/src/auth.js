/**
 * auth.js — Sesión compartida con la plataforma de Seguimiento de Pedidos.
 *
 * Esta app no tiene usuarios propios. En el servidor convive con Seguimiento
 * bajo el mismo dominio (gandkcontrol.com), así que reutiliza su cookie de
 * sesión: el navegador la manda igual a /liquidacion/ porque se emite con
 * `path=/`.
 *
 * El token solo lleva el id del usuario (`{ uid }`), no el rol, así que no
 * basta con verificar la firma: hay que preguntarle a Seguimiento quién es.
 * Se consulta `GET /api/auth/me` reenviando la cookie. Dos ventajas sobre
 * copiar aquí el JWT_SECRET: el secreto no se duplica, y desactivar a alguien
 * en Seguimiento le cierra esta app de inmediato (como mucho, al expirar la
 * caché de abajo).
 *
 * Variables de entorno:
 *   AUTH_BASE  Origen de la API de Seguimiento, p. ej. http://127.0.0.1:3007
 *              Si no está definida, la autenticación queda DESACTIVADA. Es el
 *              caso de desarrollo local (`npm run dev`), donde no hay
 *              plataforma contra la que validar.
 *   ROL        Rol exigido. Por defecto 'Liquidacion'.
 */

const AUTH_BASE = (process.env.AUTH_BASE || '').replace(/\/+$/, '');
const ROL = process.env.ROL || 'Liquidacion';
const COOKIE = 'token';

/** Sin AUTH_BASE no hay contra qué validar: modo local, todo abierto. */
export const authActiva = Boolean(AUTH_BASE);

// Usuario ficticio para desarrollo local. Que el cliente reciba siempre la
// misma forma de respuesta evita tener dos caminos distintos en la interfaz.
const USUARIO_LOCAL = { id: 0, username: 'local', nombre: 'Desarrollo local', role: ROL };

/**
 * Caché de sesiones resueltas, para no consultar a Seguimiento en cada
 * petición (la interfaz lanza cinco llamadas solo al abrirse). La clave es el
 * token completo, así que un token distinto nunca reutiliza una entrada ajena.
 */
const CACHE_MS = 60_000;
const cache = new Map();

function cacheLeer(token) {
  const hit = cache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.expira) {
    cache.delete(token);
    return null;
  }
  return hit.usuario;
}

function cacheGuardar(token, usuario) {
  // Poda perezosa: sin esto el Map crece sin límite con tokens ya expirados.
  if (cache.size > 500) {
    const ahora = Date.now();
    for (const [k, v] of cache) if (ahora > v.expira) cache.delete(k);
  }
  cache.set(token, { usuario, expira: Date.now() + CACHE_MS });
}

/** Lee una cookie de la cabecera cruda. Evita sumar cookie-parser como dependencia. */
function leerCookie(req, nombre) {
  const cabecera = req.headers.cookie;
  if (!cabecera) return null;
  for (const trozo of cabecera.split(';')) {
    const i = trozo.indexOf('=');
    if (i < 0) continue;
    if (trozo.slice(0, i).trim() === nombre) return decodeURIComponent(trozo.slice(i + 1).trim());
  }
  return null;
}

/**
 * Resuelve el usuario de la petición.
 * Devuelve { usuario } o { error, codigo } — nunca lanza.
 */
async function resolverUsuario(req) {
  if (!authActiva) return { usuario: USUARIO_LOCAL };

  const token = leerCookie(req, COOKIE);
  if (!token) return { error: 'Inicia sesión para continuar.', codigo: 401 };

  const enCache = cacheLeer(token);
  if (enCache) return { usuario: enCache };

  let res;
  try {
    res = await fetch(`${AUTH_BASE}/api/auth/me`, {
      headers: { cookie: `${COOKIE}=${encodeURIComponent(token)}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Seguimiento caído o inalcanzable. Se deniega: dejar pasar "por si acaso"
    // convertiría una caída ajena en un agujero de acceso.
    return { error: 'No se puede verificar la sesión en este momento.', codigo: 503 };
  }

  if (res.status === 401) return { error: 'Tu sesión expiró. Vuelve a entrar.', codigo: 401 };
  if (!res.ok) return { error: 'No se puede verificar la sesión en este momento.', codigo: 503 };

  const datos = await res.json().catch(() => null);
  const usuario = datos?.user;
  if (!usuario) return { error: 'No se puede verificar la sesión en este momento.', codigo: 503 };

  cacheGuardar(token, usuario);
  return { usuario };
}

/** Middleware: exige sesión válida y el rol correcto. */
export async function requiereSesion(req, res, next) {
  const { usuario, error, codigo } = await resolverUsuario(req);
  if (!usuario) return res.status(codigo).json({ error });
  if (usuario.role !== ROL) {
    return res.status(403).json({ error: 'Tu usuario no tiene acceso a Liquidación.' });
  }
  req.usuario = usuario;
  next();
}

/**
 * Rutas de sesión. Van ANTES del middleware, porque quien aún no ha entrado
 * tiene que poder llamarlas.
 *
 * El login no se implementa aquí: se reenvía a Seguimiento, que es quien tiene
 * los usuarios y firma la cookie. Así esta app nunca ve ni almacena
 * contraseñas, y existe un único sitio donde se inicia sesión.
 */
export function rutasSesion(app) {
  app.get('/api/auth/me', async (req, res) => {
    const { usuario, error, codigo } = await resolverUsuario(req);
    if (!usuario) return res.status(codigo).json({ error });
    // 403 explícito: la interfaz distingue "no has entrado" de "entraste pero
    // este no es tu sitio", y el segundo mensaje evita reintentos inútiles.
    if (usuario.role !== ROL) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso a Liquidación.', usuario: { nombre: usuario.nombre } });
    }
    res.json({ usuario });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!authActiva) return res.json({ usuario: USUARIO_LOCAL });

    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Escribe usuario y contraseña.' });

    let respuesta;
    try {
      respuesta = await fetch(`${AUTH_BASE}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Sin esto, el limitador de intentos de Seguimiento vería todas las
          // peticiones viniendo de 127.0.0.1 y un solo usuario equivocándose
          // de contraseña bloquearía a todos los demás.
          'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
        },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return res.status(503).json({ error: 'No se puede contactar con el servidor de sesiones.' });
    }

    const datos = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
      return res.status(respuesta.status).json({ error: datos.error || 'Usuario o contraseña incorrectos.' });
    }

    // La cookie la emite Seguimiento; aquí solo se reenvía tal cual para que el
    // navegador la guarde con los mismos atributos (httpOnly, secure, path=/).
    const cookies = respuesta.headers.getSetCookie?.() ?? [];
    if (cookies.length) res.setHeader('set-cookie', cookies);

    const usuario = datos.user;
    if (usuario && usuario.role !== ROL) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso a Liquidación.' });
    }
    res.json({ usuario });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = leerCookie(req, COOKIE);
    if (token) cache.delete(token);

    if (authActiva) {
      try {
        const r = await fetch(`${AUTH_BASE}/api/auth/logout`, {
          method: 'POST',
          headers: { cookie: `${COOKIE}=${encodeURIComponent(token || '')}` },
          signal: AbortSignal.timeout(5000),
        });
        const cookies = r.headers.getSetCookie?.() ?? [];
        if (cookies.length) res.setHeader('set-cookie', cookies);
      } catch {
        /* Da igual: abajo se borra la cookie de todos modos. */
      }
    }
    res.json({ ok: true });
  });
}
