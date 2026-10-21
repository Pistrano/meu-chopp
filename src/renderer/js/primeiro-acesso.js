/* BarrilFacil — primeiro acesso / troca da senha temporária */
(async () => {
  const form = document.getElementById("authForm");
  const alertBox = document.getElementById("formAlert");
  const btn = document.getElementById("submitBtn");
  const $ = (id) => document.getElementById(id);
  MC.bindPasswordRules($("senha"), $("rules"));
  let me;
  try { me = await MC.call("auth:me"); } catch (_) { return; }
  if (!me) { window.location.replace("index.html"); return; }
  if (!me.trocarSenha) { window.location.replace("dashboard.html"); return; }
  if (me.email) { $("email").value = me.email; $("email").readOnly = true; }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    alertBox.className = "alert d-none";
    if ($("senha").value !== $("confirma").value) return fail("As senhas não são iguais.");
    btn.disabled = true;
    try {
      await MC.call("auth:completeProfile", { email: $("email").value, nova: $("senha").value });
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
