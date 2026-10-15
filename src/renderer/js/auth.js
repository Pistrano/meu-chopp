/* MeuChopp — autenticação (chama o sistema; nenhuma senha fica guardada na tela) */
const MeuChoppAuth = {
  async needsSetup() {
    const res = await window.api.invoke("auth:needsSetup");
    return res.ok && res.data === true;
  },
  async login(identifier, password) {
    const res = await window.api.invoke("auth:login", { identifier: identifier.trim(), password });
    return res.ok ? { ok: true, user: res.data } : { ok: false, error: res.error };
  },
  async logout() {
    await window.api.invoke("auth:logout");
    window.location.href = "index.html";
  },
};
