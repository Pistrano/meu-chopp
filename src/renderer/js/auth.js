/* BarrilFacil — autenticação (chama o sistema; nenhuma senha fica guardada na tela) */
/* Filtros e ordem lembrados pelas telas (sessionStorage, prefixo "bf:"): somem ao entrar e ao sair,
   para uma pessoa nunca herdar a tela da anterior no mesmo aparelho. */
function limparFiltrosLembrados() {
  try { Object.keys(sessionStorage).filter((k) => k.startsWith("bf:")).forEach((k) => sessionStorage.removeItem(k)); } catch (_) { /* ignora */ }
}

const BarrilFacilAuth = {
  async needsSetup() {
    const res = await window.api.invoke("auth:needsSetup");
    return res.ok && res.data === true;
  },
  async login(identifier, password) {
    const res = await window.api.invoke("auth:login", { identifier: identifier.trim(), password });
    if (res.ok) limparFiltrosLembrados();
    return res.ok ? { ok: true, user: res.data } : { ok: false, error: res.error };
  },
  async logout() {
    await window.api.invoke("auth:logout");
    limparFiltrosLembrados();
    window.location.href = "index.html";
  },
};
