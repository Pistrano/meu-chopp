/* MeuChopp — configuração inicial (cria o primeiro administrador) */
(async () => {
  const form = document.getElementById("authForm");
  const alertBox = document.getElementById("formAlert");
  const btn = document.getElementById("submitBtn");
  const $ = (id) => document.getElementById(id);
  MC.bindPasswordRules($("senha"), $("rules"));
  if (!(await MeuChoppAuth.needsSetup())) { window.location.replace("index.html"); return; }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    alertBox.className = "alert d-none";
    if ($("senha").value !== $("confirma").value) return fail("As senhas não são iguais.");
    btn.disabled = true;
    try {
      await MC.call("auth:setup", { nome: $("nome").value, email: $("email").value, senha: $("senha").value });
      window.location.href = "dashboard.html";
    } catch (err) {
      fail(err.message);
      btn.disabled = false;
    }
  });

  function fail(message) {
    alertBox.className = "alert alert-error";
    alertBox.textContent = message;
  }
})();
