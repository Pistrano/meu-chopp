/* ==========================================================
   BarrilFacil — interações da tela de login (Etapa 1)
   ========================================================== */

(() => {
  const form = document.getElementById("loginForm");
  const identifier = document.getElementById("identifier");
  const password = document.getElementById("password");
  const alertBox = document.getElementById("formAlert");
  const submitBtn = document.getElementById("submitBtn");
  const toggleBtn = document.getElementById("togglePassword");

  const errorEls = {
    identifier: document.getElementById("identifierError"),
    password: document.getElementById("passwordError"),
  };

  /* Primeira vez usando o sistema: vai para a criação do administrador */
  BarrilFacilAuth.needsSetup().then((needs) => { if (needs) window.location.replace("setup.html"); });

  /* Sessão encerrada por inatividade */
  if (new URLSearchParams(location.search).has("expirada")) {
    alertBox.className = "alert alert-error";
    alertBox.textContent = "Sua sessão foi encerrada. Entre novamente.";
  }

  /* ---------- Mensagens ---------- */
  function showAlert(type, message) {
    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = message;
  }
  function hideAlert() {
    alertBox.className = "alert d-none";
    alertBox.textContent = "";
  }
  function setFieldError(input, key, message) {
    input.classList.add("is-invalid");
    input.setAttribute("aria-invalid", "true");
    errorEls[key].textContent = message;
  }
  function clearFieldError(input, key) {
    input.classList.remove("is-invalid");
    input.removeAttribute("aria-invalid");
    errorEls[key].textContent = "";
  }

  /* ---------- Validação ---------- */
  function validate() {
    let firstInvalid = null;
    clearFieldError(identifier, "identifier");
    clearFieldError(password, "password");

    if (identifier.value.trim() === "") {
      setFieldError(identifier, "identifier", "Informe seu e-mail.");
      firstInvalid = identifier;
    }
    else if (identifier.value.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(identifier.value.trim())) {
      setFieldError(identifier, "identifier", "Digite um e-mail válido, como nome@empresa.com.");
      firstInvalid = identifier;
    }
    if (password.value === "") {
      setFieldError(password, "password", "Informe sua senha.");
      firstInvalid = firstInvalid || password;
    }
    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.querySelector(".btn-label").textContent = isLoading ? "Entrando..." : "Entrar";
    submitBtn.querySelector(".spinner-border").classList.toggle("d-none", !isLoading);
  }

  /* ---------- Envio ---------- */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideAlert();
    if (!validate()) return;

    setLoading(true);
    const result = await BarrilFacilAuth.login(identifier.value, password.value);
    setLoading(false);

    if (result.ok) {
      showAlert("success", "Login realizado com sucesso. Redirecionando...");
      password.value = "";
      const destino = result.user.trocarSenha ? "primeiro-acesso.html" : "dashboard.html";
      setTimeout(() => { window.location.href = destino; }, 700);
    } else {
      showAlert("error", result.error || "E-mail ou senha incorretos.");
      password.focus();
      password.select();
    }
  });

  /* Limpa o erro do campo assim que o usuário volta a digitar */
  identifier.addEventListener("input", () => clearFieldError(identifier, "identifier"));
  password.addEventListener("input", () => clearFieldError(password, "password"));

  /* ---------- Mostrar/ocultar senha ---------- */
  toggleBtn.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggleBtn.setAttribute("aria-pressed", String(show));
    toggleBtn.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    toggleBtn.querySelector(".icon-eye").classList.toggle("d-none", show);
    toggleBtn.querySelector(".icon-eye-off").classList.toggle("d-none", !show);
    password.focus();
  });
})();
