import { useState } from 'react';
import { recurso, sesion } from './api.js';

/**
 * Entrada a la plataforma. Las credenciales son las mismas de GANDK Control:
 * este formulario no las valida, las reenvía al servidor de sesiones, que es
 * quien tiene los usuarios. Aquí no se guarda ninguna contraseña.
 */
export default function Login({ alEntrar, avisoInicial = '' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(avisoInicial);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    if (enviando) return;
    setEnviando(true);
    setError('');
    try {
      const { usuario } = await sesion.entrar(username.trim(), password);
      alEntrar(usuario);
    } catch (err) {
      setError(err.message || 'No se pudo iniciar sesión.');
      setPassword('');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login-fondo">
      <form className="login-caja" onSubmit={enviar}>
        <img className="login-logo" src={recurso('logo.png')} alt="GANDK Dotaciones" />
        <h1>Liquidación de producción</h1>
        <p className="login-sub">GANDK Dotaciones</p>

        {error && <div className="aviso aviso-error" role="alert">{error}</div>}

        <label>
          Usuario
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="login-boton" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>

        <p className="login-nota">Usa las mismas credenciales de GANDK Control.</p>
      </form>
    </div>
  );
}
