(() => {
  const $ = (selector) => document.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  const actionCode = params.get("oobCode");
  const config = window.CREDMAIS_FIREBASE || {};
  let auth = null;

  function showMessage(title, description, success = false) {
    $("#actionLoading").hidden = true;
    $("#resetAction").hidden = true;
    $("#actionMessage").hidden = false;
    $("#actionTitle").textContent = title;
    $("#actionDescription").textContent = description;
    $("#actionIcon").textContent = success ? "✓" : "!";
    $("#actionIcon").classList.toggle("success", success);
    $("#actionEyebrow").textContent = success
      ? "TUDO CERTO"
      : "LINK NÃO CONFIRMADO";
  }

  function actionError(error) {
    const messages = {
      "auth/expired-action-code":
        "Este link expirou. Volte ao CredMais e solicite um novo e-mail.",
      "auth/invalid-action-code":
        "Este link é inválido ou já foi utilizado. Solicite um novo e-mail.",
      "auth/user-disabled": "Esta conta foi desativada.",
      "auth/user-not-found": "A conta deste link não foi encontrada.",
      "auth/weak-password":
        "Use ao menos 10 caracteres, com letra maiúscula, minúscula e número.",
    };
    return messages[error?.code] || "Não foi possível validar este link. Tente novamente.";
  }

  async function handleAction() {
    if (!["apiKey", "authDomain", "projectId", "appId"].every((key) => config[key])) {
      showMessage(
        "Firebase ainda não configurado",
        "O responsável pelo CredMais precisa concluir a configuração do projeto Firebase.",
      );
      return;
    }
    if (!mode || !actionCode) {
      showMessage(
        "Link incompleto",
        "Abra novamente o link original enviado pelo CredMais no seu e-mail.",
      );
      return;
    }
    try {
      const app = firebase.initializeApp(config, "credmais-email-action");
      auth = app.auth();
      auth.languageCode = params.get("lang") || "pt-BR";
      if (mode === "verifyEmail") {
        await auth.applyActionCode(actionCode);
        showMessage(
          "E-mail confirmado",
          "Sua conta está protegida e pronta. Agora você já pode entrar no CredMais.",
          true,
        );
      } else if (mode === "resetPassword") {
        const email = await auth.verifyPasswordResetCode(actionCode);
        $("#actionLoading").hidden = true;
        $("#resetAction").hidden = false;
        $("#resetAccount").textContent =
          `Crie uma nova senha para ${email}. Use 10 caracteres ou mais, com maiúscula, minúscula e número.`;
      } else if (mode === "recoverEmail") {
        await auth.applyActionCode(actionCode);
        showMessage(
          "E-mail recuperado",
          "O endereço anterior voltou a ser associado à sua conta CredMais.",
          true,
        );
      } else {
        showMessage(
          "Ação não reconhecida",
          "Este tipo de link não é compatível com o CredMais.",
        );
      }
    } catch (error) {
      showMessage("Não foi possível concluir", actionError(error));
    }
  }

  $("#resetPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = $("#actionPassword").value;
    const confirmation = $("#actionPasswordConfirm").value;
    if (
      password.length < 10 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/\d/.test(password)
    ) {
      $("#actionFeedback").textContent =
        "Use 10 caracteres ou mais, com maiúscula, minúscula e número.";
      $("#actionFeedback").className = "form-feedback error";
      return;
    }
    if (password !== confirmation) {
      $("#actionFeedback").textContent = "As duas senhas precisam ser iguais.";
      $("#actionFeedback").className = "form-feedback error";
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      await auth.confirmPasswordReset(actionCode, password);
      showMessage(
        "Senha atualizada",
        "Sua nova senha foi salva. Você já pode entrar no CredMais.",
        true,
      );
    } catch (error) {
      $("#actionFeedback").textContent = actionError(error);
      $("#actionFeedback").className = "form-feedback error";
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-password-toggle]");
    if (!button) return;
    const input = document.getElementById(button.dataset.passwordToggle);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.classList.toggle("is-visible", show);
    button.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    button.setAttribute("aria-pressed", String(show));
  });

  handleAction();
})();
