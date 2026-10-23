// Primero que nada: auth.js lee process.env al cargarse, y en ESM los imports
// se evalúan en orden, así que el .env tiene que estar leído antes que él.
// Si no existe el archivo, dotenv no se queja: es justo el caso de local.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { authActiva, requiereSesion, rutasSesion } from './auth.js';

const app = express();

// En desarrollo el cliente corre en otro puerto (Vite, 5173) y necesita CORS.
// En el servidor va detrás del mismo nginx, mismo origen: abrirlo no aporta
// nada y amplía la superficie, así que solo se activa en local.
if (!authActiva) app.use(cors());

app.use(express.json());

// Entrar y salir es lo único alcanzable sin sesión; el resto de /api va detrás
// del middleware. Tiene que declararse ANTES que las rutas de datos: Express
// recorre la pila en orden de registro.
rutasSesion(app);
app.use('/api', requiereSesion);

const PORT = process.env.PORT || 3001;
// Detrás de nginx solo debe escuchar en loopback: publicarlo en 0.0.0.0 dejaría
// la API accesible por IP:puerto, saltándose el proxy y la cookie de sesión.
const HOST = process.env.HOST || (authActiva ? '127.0.0.1' : '0.0.0.0');
const redondear = (n) => Math.round(n);
const minutosEntre = (ini, fin) => {
  const [h1, m1] = ini.split(':').map(Number);
  const [h2, m2] = fin.split(':').map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
};

/* ---------- Catálogos genéricos (trabajadores, prendas, adicionales) ---------- */
function catalogo(ruta, tabla, campos, orden) {
  app.get(`/api/${ruta}`, (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${tabla} ORDER BY ${orden}`).all());
  });

  app.post(`/api/${ruta}`, (req, res) => {
    try {
      // Solo los campos enviados: los demás toman el valor por defecto de la tabla
      const enviados = campos.filter((c) => req.body[c] !== undefined);
      const datos = Object.fromEntries(enviados.map((c) => [c, req.body[c]]));
      const cols = enviados.join(',');
      const vals = enviados.map((c) => '@' + c).join(',');
      const r = db.prepare(`INSERT INTO ${tabla} (${cols}) VALUES (${vals})`).run(datos);
      res.status(201).json(db.prepare(`SELECT * FROM ${tabla} WHERE id=?`).get(r.lastInsertRowid));
    } catch (e) {
      res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ese código ya existe.' : e.message });
    }
  });

  app.put(`/api/${ruta}/:id`, (req, res) => {
    try {
      const sets = campos.filter((c) => c in req.body);
      if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar.' });
      const datos = Object.fromEntries(sets.map((c) => [c, req.body[c]]));
      db.prepare(`UPDATE ${tabla} SET ${sets.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...datos, id: req.params.id });
      res.json(db.prepare(`SELECT * FROM ${tabla} WHERE id=?`).get(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ese código ya existe.' : e.message });
    }
  });
}

catalogo('trabajadores', 'trabajadores', ['codigo', 'nombre', 'tipo', 'especialidad', 'activo', 'livianas', 'jean'], 'tipo DESC, nombre');
catalogo('prendas', 'prendas', ['codigo', 'nombre', 'tarifa_interna', 'tarifa_externa', 'activo'], 'codigo');
catalogo('adicionales', 'adicionales', ['codigo', 'nombre', 'categoria', 'tarifa_interna', 'tarifa_externa', 'nota', 'activo'], 'categoria, codigo');
catalogo('jc/operaciones', 'jc_operaciones', ['codigo', 'nombre', 'proceso', 'area', 'maquina', 'valor', 'tiempo_estandar', 'nota', 'activo'], 'codigo');

/* ---------- Parámetros (costo del minuto de mano de obra) ---------- */
app.get('/api/parametros', (req, res) => {
  res.json(Object.fromEntries(db.prepare('SELECT clave, valor FROM parametros').all().map((p) => [p.clave, p.valor])));
});

app.put('/api/parametros/:clave', (req, res) => {
  const valor = Number(req.body.valor);
  if (!(valor > 0)) return res.status(400).json({ error: 'El valor debe ser mayor que cero.' });
  db.prepare('INSERT INTO parametros (clave,valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor').run(req.params.clave, valor);
  res.json({ clave: req.params.clave, valor });
});

const siguienteCodigo = (tabla, p) => {
  const filas = db.prepare(`SELECT codigo FROM ${tabla} WHERE codigo LIKE ?`).all(p + '%');
  const nums = filas.map((f) => f.codigo.slice(p.length)).filter((s) => /^\d+$/.test(s)).map(Number);
  const sig = (nums.length ? Math.max(...nums) : 0) + 1;
  return p + String(sig).padStart(3, '0');
};

// Siguiente código sugerido (OI005, TE011, P040...)
app.get('/api/siguiente-codigo/:prefijo', (req, res) => {
  const p = req.params.prefijo.toUpperCase();
  const tablas = { OI: 'trabajadores', TE: 'trabajadores', P: 'prendas', O: 'adicionales', OPR: 'adicionales' };
  const tabla = tablas[p];
  if (!tabla) return res.status(400).json({ error: 'Prefijo no válido' });
  res.json({ codigo: siguienteCodigo(tabla, p) });
});

// Jeans y chaquetas: OPR082 para jean, OCH001 para chaqueta
const PREFIJO_PROCESO = { JEAN: 'OPR', CHAQUETA: 'OCH' };
app.get('/api/jc/siguiente-codigo/:proceso', (req, res) => {
  const p = PREFIJO_PROCESO[req.params.proceso.toUpperCase()];
  if (!p) return res.status(400).json({ error: 'Proceso no válido' });
  res.json({ codigo: siguienteCodigo('jc_operaciones', p) });
});

app.get('/api/clientes', (req, res) => {
  res.json(db.prepare(`SELECT cliente FROM operaciones WHERE cliente IS NOT NULL AND cliente<>''
    UNION SELECT cliente FROM jc_registros WHERE cliente IS NOT NULL AND cliente<>'' ORDER BY cliente`).all().map((r) => r.cliente));
});

/* ---------- Operaciones ---------- */
const SELECT_OP = `
  SELECT o.*, t.nombre AS trabajador, t.codigo AS trabajador_codigo,
         p.codigo AS prenda_codigo, p.nombre AS prenda
  FROM operaciones o
  JOIN trabajadores t ON t.id = o.trabajador_id
  JOIN prendas p ON p.id = o.prenda_id`;

const adicionalesDe = db.prepare(`
  SELECT oa.*, a.codigo, a.nombre FROM operacion_adicionales oa
  JOIN adicionales a ON a.id = oa.adicional_id WHERE oa.operacion_id = ? ORDER BY oa.id`);

app.get('/api/operaciones', (req, res) => {
  const { desde, hasta, tipo, trabajador_id } = req.query;
  const where = [];
  const params = {};
  if (desde) { where.push('o.fecha >= @desde'); params.desde = desde; }
  if (hasta) { where.push('o.fecha <= @hasta'); params.hasta = hasta; }
  if (tipo) { where.push('o.tipo_trabajador = @tipo'); params.tipo = tipo; }
  if (trabajador_id) { where.push('o.trabajador_id = @tid'); params.tid = trabajador_id; }
  const sql = `${SELECT_OP} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.fecha DESC, o.hora_inicio DESC`;
  const ops = db.prepare(sql).all(params).map((o) => ({ ...o, adicionales: adicionalesDe.all(o.id) }));
  res.json(ops);
});

app.post('/api/operaciones', (req, res) => {
  const b = req.body;
  const faltan = ['trabajador_id', 'fecha', 'hora_inicio', 'hora_fin', 'tipo_doc', 'num_orden', 'prenda_id', 'cantidad'].filter((c) => !b[c]);
  if (faltan.length) return res.status(400).json({ error: `Faltan datos: ${faltan.join(', ')}` });

  const trab = db.prepare('SELECT * FROM trabajadores WHERE id=?').get(b.trabajador_id);
  const prenda = db.prepare('SELECT * FROM prendas WHERE id=?').get(b.prenda_id);
  if (!trab || !prenda) return res.status(400).json({ error: 'Trabajador o prenda no existe.' });

  const minutos = minutosEntre(b.hora_inicio, b.hora_fin);
  if (minutos <= 0) return res.status(400).json({ error: 'La hora de fin debe ser posterior a la hora de inicio.' });

  const cantidad = Number(b.cantidad);
  if (!Number.isInteger(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'La cantidad de prendas debe ser un número entero mayor que cero.' });

  const externo = trab.tipo === 'EXTERNO';
  // La tarifa se guarda en la operación: si después cambian las tarifas, las liquidaciones pasadas no se alteran
  const tarifaPrenda = externo ? prenda.tarifa_externa : prenda.tarifa_interna;
  const valorPrendas = redondear(tarifaPrenda * cantidad);

  const getAd = db.prepare('SELECT * FROM adicionales WHERE id=?');
  const adics = [];
  for (const a of b.adicionales || []) {
    const ad = getAd.get(a.adicional_id);
    if (!ad) return res.status(400).json({ error: 'Adicional no existe.' });
    const cpp = Number(a.cantidad_por_prenda) || 0;
    const prendas = Number(a.prendas) || cantidad;
    if (cpp <= 0) return res.status(400).json({ error: `Indica la cantidad por prenda de "${ad.nombre}".` });
    if (prendas > cantidad) return res.status(400).json({ error: `"${ad.nombre}": las prendas con adicional no pueden superar ${cantidad}.` });
    const tarifa = externo ? ad.tarifa_externa : ad.tarifa_interna;
    adics.push({ adicional_id: ad.id, cantidad_por_prenda: cpp, prendas, tarifa, valor: redondear(tarifa * cpp * prendas) });
  }
  const valorAdic = adics.reduce((s, a) => s + a.valor, 0);

  const guardar = db.transaction(() => {
    const r = db.prepare(`INSERT INTO operaciones
      (trabajador_id,tipo_trabajador,fecha,hora_inicio,hora_fin,minutos,tipo_doc,num_orden,orden_compra,cliente,talla,prenda_id,cantidad,tarifa_prenda,valor_prendas,valor_adicionales,total,observaciones)
      VALUES (@trabajador_id,@tipo_trabajador,@fecha,@hora_inicio,@hora_fin,@minutos,@tipo_doc,@num_orden,@orden_compra,@cliente,@talla,@prenda_id,@cantidad,@tarifa_prenda,@valor_prendas,@valor_adicionales,@total,@observaciones)`).run({
      trabajador_id: trab.id, tipo_trabajador: trab.tipo, fecha: b.fecha, hora_inicio: b.hora_inicio, hora_fin: b.hora_fin, minutos,
      tipo_doc: b.tipo_doc, num_orden: String(b.num_orden).trim(), orden_compra: b.orden_compra?.trim() || null,
      cliente: b.cliente?.trim().toUpperCase() || null, talla: b.talla?.trim().toUpperCase() || null,
      prenda_id: prenda.id, cantidad, tarifa_prenda: tarifaPrenda, valor_prendas: valorPrendas,
      valor_adicionales: valorAdic, total: valorPrendas + valorAdic, observaciones: b.observaciones?.trim() || null,
    });
    const insA = db.prepare('INSERT INTO operacion_adicionales (operacion_id,adicional_id,cantidad_por_prenda,prendas,tarifa,valor) VALUES (?,?,?,?,?,?)');
    adics.forEach((a) => insA.run(r.lastInsertRowid, a.adicional_id, a.cantidad_por_prenda, a.prendas, a.tarifa, a.valor));
    return r.lastInsertRowid;
  });

  const id = guardar();
  const op = db.prepare(`${SELECT_OP} WHERE o.id=?`).get(id);
  res.status(201).json({ ...op, adicionales: adicionalesDe.all(id) });
});

app.delete('/api/operaciones/:id', (req, res) => {
  const r = db.prepare('DELETE FROM operaciones WHERE id=?').run(req.params.id);
  res.json({ eliminada: r.changes > 0 });
});

/* ---------- Jeans y chaquetas: registros por prenda y operación ---------- */
const SELECT_JC = `
  SELECT r.*, t.nombre AS trabajador, t.codigo AS trabajador_codigo
  FROM jc_registros r JOIN trabajadores t ON t.id = r.trabajador_id`;

const operacionesDe = db.prepare(`
  SELECT ro.*, o.codigo, o.nombre, o.maquina, o.area FROM jc_registro_ops ro
  JOIN jc_operaciones o ON o.id = ro.operacion_id WHERE ro.registro_id = ? ORDER BY ro.id`);

// Comparativa del estudio de tiempos: tiempo estimado = Σ (tiempo estándar × cantidad); costo = minutos × costo del minuto.
// Solo es comparable si todas las operaciones del registro tienen tiempo estándar; si no, el estimado quedaría incompleto.
function conEficiencia(r) {
  const operaciones = operacionesDe.all(r.id);
  const sinTiempo = operaciones.filter((o) => o.tiempo_estandar == null).length;
  const minutosEstimados = operaciones.reduce((s, o) => s + (o.tiempo_estandar || 0) * o.cantidad, 0) / 60;
  const cm = r.costo_minuto || 0;
  return {
    ...r, operaciones,
    ops_sin_tiempo: sinTiempo,
    comparable: sinTiempo === 0,
    minutos_estimados: minutosEstimados,
    costo_estimado: minutosEstimados * cm,
    costo_real: r.minutos * cm,
  };
}

app.get('/api/jc/registros', (req, res) => {
  const { desde, hasta, tipo, trabajador_id, proceso } = req.query;
  const where = [];
  const params = {};
  if (desde) { where.push('r.fecha >= @desde'); params.desde = desde; }
  if (hasta) { where.push('r.fecha <= @hasta'); params.hasta = hasta; }
  if (tipo) { where.push('r.tipo_trabajador = @tipo'); params.tipo = tipo; }
  if (proceso) { where.push('r.proceso = @proceso'); params.proceso = proceso; }
  if (trabajador_id) { where.push('r.trabajador_id = @tid'); params.tid = trabajador_id; }
  const sql = `${SELECT_JC} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.fecha DESC, r.hora_inicio DESC`;
  res.json(db.prepare(sql).all(params).map(conEficiencia));
});

app.get('/api/jc/prendas', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT prenda FROM jc_registros ORDER BY prenda').all().map((r) => r.prenda));
});

app.post('/api/jc/registros', (req, res) => {
  const b = req.body;
  const faltan = ['trabajador_id', 'proceso', 'fecha', 'hora_inicio', 'hora_fin', 'tipo_doc', 'num_orden', 'prenda', 'cantidad'].filter((c) => !b[c]);
  if (faltan.length) return res.status(400).json({ error: `Faltan datos: ${faltan.join(', ')}` });
  if (!PREFIJO_PROCESO[b.proceso]) return res.status(400).json({ error: 'El proceso debe ser JEAN o CHAQUETA.' });

  const trab = db.prepare('SELECT * FROM trabajadores WHERE id=?').get(b.trabajador_id);
  if (!trab) return res.status(400).json({ error: 'El trabajador no existe.' });

  const minutos = minutosEntre(b.hora_inicio, b.hora_fin);
  if (minutos <= 0) return res.status(400).json({ error: 'La hora de fin debe ser posterior a la hora de inicio.' });

  const cantidad = Number(b.cantidad);
  if (!Number.isInteger(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'La cantidad de prendas debe ser un número entero mayor que cero.' });
  if (!b.operaciones?.length) return res.status(400).json({ error: 'Agrega al menos una operación.' });

  const getOp = db.prepare('SELECT * FROM jc_operaciones WHERE id=?');
  const lineas = [];
  for (const l of b.operaciones) {
    const op = getOp.get(l.operacion_id);
    if (!op) return res.status(400).json({ error: 'Operación no existe.' });
    const cant = l.cantidad === '' || l.cantidad == null ? cantidad : Number(l.cantidad);
    if (!(cant > 0)) return res.status(400).json({ error: `Indica la cantidad de "${op.nombre}".` });
    lineas.push({ operacion_id: op.id, cantidad: cant, valor_unitario: op.valor, valor: redondear(op.valor * cant), tiempo_estandar: op.tiempo_estandar });
  }
  const total = lineas.reduce((s, l) => s + l.valor, 0);

  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO jc_registros
      (trabajador_id,tipo_trabajador,proceso,fecha,hora_inicio,hora_fin,minutos,tipo_doc,num_orden,orden_compra,cliente,prenda,talla,cantidad,total,costo_minuto,observaciones)
      VALUES (@trabajador_id,@tipo_trabajador,@proceso,@fecha,@hora_inicio,@hora_fin,@minutos,@tipo_doc,@num_orden,@orden_compra,@cliente,@prenda,@talla,@cantidad,@total,@costo_minuto,@observaciones)`).run({
      trabajador_id: trab.id, tipo_trabajador: trab.tipo, proceso: b.proceso, fecha: b.fecha, hora_inicio: b.hora_inicio, hora_fin: b.hora_fin, minutos,
      tipo_doc: b.tipo_doc, num_orden: String(b.num_orden).trim(), orden_compra: b.orden_compra?.trim() || null,
      cliente: b.cliente?.trim().toUpperCase() || null, prenda: String(b.prenda).trim().toUpperCase(), talla: b.talla?.trim().toUpperCase() || null,
      cantidad, total, costo_minuto: db.prepare("SELECT valor FROM parametros WHERE clave='costo_minuto'").get()?.valor ?? null, observaciones: b.observaciones?.trim() || null,
    });
    const ins = db.prepare('INSERT INTO jc_registro_ops (registro_id,operacion_id,cantidad,valor_unitario,valor,tiempo_estandar) VALUES (?,?,?,?,?,?)');
    lineas.forEach((l) => ins.run(r.lastInsertRowid, l.operacion_id, l.cantidad, l.valor_unitario, l.valor, l.tiempo_estandar));
    return r.lastInsertRowid;
  })();

  res.status(201).json(conEficiencia(db.prepare(`${SELECT_JC} WHERE r.id=?`).get(id)));
});

app.delete('/api/jc/registros/:id', (req, res) => {
  const r = db.prepare('DELETE FROM jc_registros WHERE id=?').run(req.params.id);
  res.json({ eliminada: r.changes > 0 });
});

/* ---------- Frontend compilado (solo en el servidor) ---------- */
// En local no hace falta: Vite sirve el cliente en el 5173 y reenvía /api aquí.
// En el servidor no hay Vite, así que este mismo proceso entrega `client/dist`.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', '..', 'client', 'dist');

if (existsSync(DIST)) {
  app.use(express.static(DIST));
  // Fallback de SPA: cualquier ruta que no sea /api y no exista como archivo
  // devuelve index.html para que el enrutado lo resuelva el cliente.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(DIST, 'index.html')));
} else if (authActiva) {
  console.warn(`[AVISO] No existe ${DIST}. Ejecuta "npm run build --prefix client" antes de desplegar.`);
}

app.listen(PORT, HOST, () => console.log(`API de liquidación en http://${HOST}:${PORT}`));
