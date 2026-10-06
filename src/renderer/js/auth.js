/* MeuChopp — autenticação real (substitui a sessão simulada) */
const MeuChoppAuth = {
  async login(identifier, password) {
    const res = await window.api.invoke("auth:login", { identifier: identifier.trim(), password });
    return res.ok ? { ok: true, user: res.data } : { ok: false, error: res.error };
  },
  async logout() {
    await window.api.invoke("auth:logout");
    window.location.href = "index.html";
  },
};
