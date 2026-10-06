/* ==========================================================
   MeuChopp — interações da tela de login (Etapa 1)
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
      setFieldError(identifier, "identifier", "Informe seu usuário ou e-mail.");
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
    const result = await MeuChoppAuth.login(identifier.value, password.value);
    setLoading(false);

    if (result.ok) {
      showAlert("success", "Login realizado com sucesso. Redirecionando...");
      password.value = "";
      setTimeout(() => {
        window.location.href = "dashboard.html";
      }, 900);
    } else {
      showAlert("error", "Usuário ou senha incorretos. Verifique os dados e tente novamente.");
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
