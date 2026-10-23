// Proceso de producción para pm2.  Arranque:  pm2 start ecosystem.config.cjs
//
// `cwd` apunta a server/ a propósito: dotenv lee el .env del directorio de
// trabajo, y la configuración vive en server/.env (ver server/.env.example).
// Arrancarlo desde la raíz del repo dejaría la app sin AUTH_BASE, es decir,
// sin autenticación y escuchando en todas las interfaces.
module.exports = {
  apps: [
    {
      name: 'liquidacion',
      cwd: './server',
      script: 'src/index.js',
      instances: 1,
      // SQLite con better-sqlite3 es síncrono y de un solo archivo: varios
      // procesos escribiendo se estorban. Un solo proceso, en fork.
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
