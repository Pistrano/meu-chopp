/* ==========================================================
   MeuChopp — Ligação à Nuvem (Supabase)
   Substitui a antiga base de dados local SQLite (v3).
   ========================================================== */
const { supabase } = require('./supabase'); 

// A variável db agora aponta para a ligação à nuvem em vez do ficheiro local
let db = supabase; 

// Mantemos as variáveis de inicialização para não quebrar a lógica do servidor antigo
const SCHEMA_VERSION = "nuvem";

async function initDatabase(userDataDir) {
  console.log("Sistema MeuChopp agora conectado à nuvem Supabase.");
  // Já não precisamos de inicializar ficheiros locais, criar pastas de backups 
  // nem correr PRAGMA, porque a nuvem gere as tabelas.
  return db; 
}

function getDb() {
  if (!db) throw new Error("Ligação ao Supabase não estabelecida.");
  return db;
}

module.exports = { initDatabase, getDb, SCHEMA_VERSION };