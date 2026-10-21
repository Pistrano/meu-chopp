/* ==========================================================
   BarrilFacil — ligação ao banco (Supabase)
   Os dados ficam no Supabase; nada é guardado na máquina do servidor.
   ========================================================== */
const { supabase } = require("./supabase");

async function initDatabase() {
  console.log("BarrilFacil conectado ao Supabase.");
  return supabase;
}

function getDb() {
  return supabase;
}

module.exports = { initDatabase, getDb };
