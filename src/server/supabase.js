/* ==========================================================
   Cliente Supabase do SERVIDOR.
   Usa a chave SECRETA (sb_secret_...), que ignora o RLS.
   NUNCA coloque essa chave no front-end nem no código-fonte:
   ela fica só no arquivo .env da máquina que roda o servidor.

   .env (na pasta do projeto, ao lado do .exe):
     SUPABASE_URL=https://sclkdshwmzkkofkfglae.supabase.co
     SUPABASE_SECRET_KEY=sb_secret_xxxxxxxxxxxx
   ========================================================== */
const path = require("path");

// Carrega o .env se o pacote "dotenv" estiver instalado (npm i dotenv)
try {
  const dotenv = require("dotenv");
  const candidatos = [
    process.env.MEUCHOPP_ENV,
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(process.execPath), ".env"),
    path.join(__dirname, "..", "..", ".env"),   // raiz do projeto (src/server -> raiz)
  ].filter(Boolean);
  for (const p of candidatos) dotenv.config({ path: p });
} catch (_) { /* sem dotenv: usa só as variáveis do sistema */ }

const { createClient } = require("@supabase/supabase-js");

// A URL é só a base do projeto, sem /rest/v1/
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Configuração do Supabase ausente: defina SUPABASE_URL e SUPABASE_SECRET_KEY no arquivo .env."
  );
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabase };