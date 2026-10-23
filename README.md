# Liquidación de producción · GANDK Dotaciones

Plataforma local para registrar operaciones de producción y liquidar el pago por prenda a operarios internos y talleres externos.

**Fórmula:** `total = (tarifa de la prenda × cantidad) + Σ (tarifa del adicional × cantidad por prenda × prendas que lo llevan)`
La tarifa (interna o externa) se elige automáticamente según el tipo de trabajador y queda guardada en cada operación, así que cambiar una tarifa después no altera liquidaciones pasadas.

## Requisitos
- Node.js 20 o 22 (LTS) — https://nodejs.org
- VS Code

## Primer arranque
Abre la carpeta en VS Code, abre la terminal (Ctrl + ñ) y ejecuta:

```bash
npm run instalar
npm run dev
```

Abre http://localhost:5173. La API corre en http://localhost:3001.
También puedes iniciar con **Ctrl + Shift + B** (tarea "Iniciar plataforma").

La primera vez se crea `server/data/liquidacion.db` (SQLite) y se carga desde `server/data/seed.json`:
14 trabajadores (4 internos, 10 externos), 39 prendas con tarifa interna/externa (hoja PRENDAS VALOR) y 89 adicionales (8 operaciones adicionales + 81 operaciones de jean).

Para volver a la carga inicial (borra todas las operaciones): `npm run reset-db`.

## Módulos (menú ☰ arriba a la izquierda)
- **Prendas livianas:** se liquida por prenda + adicionales (secciones abajo).
- **Jeans y chaquetas:** se liquida por prenda y operación: `total = Σ (valor de la operación × cantidad)`. Tiene su propio registro, liquidación, trabajadores y catálogo de **Operaciones y valores** (hoja OPERACIONES JEAN: código, máquina/herramienta y valor). Las operaciones nuevas toman código OPR… (jean) u OCH… (chaqueta).

- **Eficiencia y costos** (en Jeans y chaquetas): compara tiempo y costo estimado contra real, como la tabla dinámica del CONSOLIDADO MANO DE OBRA JEAN.
  `tiempo estimado = Σ (tiempo estándar × cantidad)`, `tiempo real = hora fin − hora inicio`, `costo = minutos × costo del minuto` (hoja salarios: $191,74).
  Si el real no supera al estimado: **EFICIENCIA**; si lo supera: **SOBRECOSTO**. Los registros con operaciones sin tiempo estándar no entran en la comparativa.
  El tiempo estándar y el costo del minuto quedan guardados en cada registro, así que cambiarlos después no altera lo ya calculado.

La lista de trabajadores es una sola; cada trabajador se marca en las secciones donde trabaja. Al crear la base, quien tenga JEAN o CHAQUETA en la especialidad queda en Jeans y chaquetas.

## Secciones de prendas livianas
- **Registrar operación:** trabajador, fecha, hora inicio/fin, OC/ORC y n.º de orden de corte, orden de compra y cliente, talla, prenda, cantidad y adicionales. Calcula en vivo y, al guardar, conserva la orden para registrar la siguiente talla rápido.
- **Liquidación:** rango de fechas con calendario y atajos (hoy, semana, quincena, mes), filtro por internos/externos y por trabajador. Muestra total general, total por trabajador, desglose por referencia, adicionales y detalle de cada operación. Exporta a CSV (Excel) e imprime.
- **Trabajadores:** crear operarios internos o talleres externos, editarlos y desactivarlos.
- **Tarifas:** editar tarifas de prendas y adicionales, crear nuevos.

## Estructura
```
server/  API Express + SQLite (better-sqlite3)
  src/db.js       esquema y carga inicial
  src/index.js    rutas /api/...
  data/seed.json  datos extraídos del Excel CONTROL TALLERES
client/  React + Vite
  src/pages/      Registro, Liquidacion, Trabajadores, Tarifas
```

## Si `npm run instalar` falla en better-sqlite3 (Windows)
Usa Node LTS (20 o 22). Si persiste, instala "Desktop development with C++" de Visual Studio Build Tools y repite.

## Despliegue en el servidor

En producción la app vive en **https://gandkcontrol.com/liquidacion/**, junto a la
plataforma de Seguimiento de Pedidos, y **comparte su login**: no tiene usuarios
propios. Solo entran las cuentas con rol `Liquidacion`, que no da acceso a ninguna
otra parte de GANDK Control.

La sesión se comprueba contra la API de Seguimiento (`GET /api/auth/me`,
reenviando la cookie `token`), con una caché de 60 s. Así el `JWT_SECRET` no se
duplica aquí, y desactivar a alguien allí le cierra esta app casi al instante.

### Diferencias con el arranque local
- Sin `AUTH_BASE` **no hay autenticación**: es el modo de desarrollo descrito arriba.
- Con `AUTH_BASE` definida, el proceso escucha solo en `127.0.0.1` (detrás de
  nginx), desactiva CORS y sirve él mismo `client/dist`, porque no hay Vite.

### Pasos
```bash
cd /var/www/liquidacion
git pull
npm run instalar
BASE_PATH=/liquidacion/ npm run build --prefix client   # el prefijo va en el build
pm2 restart liquidacion        # la primera vez: pm2 start ecosystem.config.cjs
```

`BASE_PATH` es imprescindible: sin él, el cliente pediría `/api/...` en la raíz
del dominio, donde responde la **otra** aplicación.

El proceso se arranca con `ecosystem.config.cjs`, que fija `cwd` en `server/`.
Importa: dotenv lee el `.env` del directorio de trabajo, así que arrancarlo
desde la raíz del repo dejaría la app **sin `AUTH_BASE`** — es decir, sin
autenticación y escuchando en todas las interfaces.

Configuración en `server/.env` (ver `server/.env.example`):

```
PORT=3008
AUTH_BASE=http://127.0.0.1:3007
ROL=Liquidacion
```

Y en nginx, dentro del `server` de `gandkcontrol.com`:

```nginx
location /liquidacion/ {
    proxy_pass http://127.0.0.1:3008/;   # la barra final quita /liquidacion/
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Dar acceso a un usuario
El rol `Liquidacion` no aparece en el panel `/users` de Seguimiento (su lista de
roles está fija en el frontend), así que se asigna en su base de datos:

```bash
sudo -u www-data sqlite3 /var/www/seguimiento-server/prisma/dev.db \
  "UPDATE User SET role='Liquidacion' WHERE username='NOMBRE';"
```

Haz copia del `.db` antes de tocarlo. El cambio tarda hasta 60 s en notarse (la
caché de sesión), o cierra sesión y vuelve a entrar.
