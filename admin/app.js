const $ = (selector) => document.querySelector(selector);
const bridge = window.credmaisBridge;
const state = {
  user: null,
  accounts: [],
  settings: null,
  log: [],
  adminIds: [],
  filter: "all",
  search: "",
  section: "overview",
  managedUserId: null,
  chargedUserId: null,
};
const DEFAULT_MESSAGE = `Olá, *{nome}*! 👋

📌 *MENSALIDADE CREDMAIS*
━━━━━━━━━━━━━━━━

💳 Valor: *{valor}*
📅 Vencimento: *{vencimento}*

💠 *PAGAMENTO VIA PIX*
👤 Recebedor: *{recebedor}*
🔑 Chave PIX: {pix}

Após o pagamento, envie o comprovante por aqui para a liberação do acesso.

Atenciosamente,
*CredMais*`;
const digits = (value) => String(value || "").replace(/\D/g, "");
const money = (value) =>
  Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const formatPhone = (value) => {
  const number = digits(value).slice(0, 11);
  return number.length <= 10
    ? number.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2")
    : number.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2");
};
function setMoneyInput(input, value) {
  input.dataset.value = String(Math.max(0, Number(value) || 0));
  input.value = money(input.dataset.value);
}
function readMoneyInput(input) {
  return Number(input.dataset.value || 0);
}
function maskMoney(event) {
  setMoneyInput(event.currentTarget, Number(digits(event.currentTarget.value) || 0) / 100);
}
function feedback(id, message = "", type = "") {
  const element = $(`#${id}`);
  element.textContent = message;
  element.className = `feedback ${type}`;
}
function toast(message) {
  const element = $("#adminToast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3200);
}
async function loading(button, action) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Aguarde...";
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
function setAuthView(name) {
  ["login", "register", "forgot", "activation"].forEach((view) => {
    $(`#${view}View`).hidden = view !== name;
  });
}
async function signIn(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  feedback("loginFeedback");
  await loading(button, async () => {
    try {
      state.user = await bridge.signIn($("#loginEmail").value, $("#loginPassword").value);
      await authorize();
    } catch (error) {
      feedback("loginFeedback", error.message || "Não foi possível entrar.", "error");
    }
  });
}
async function signInGoogle() {
  feedback("loginFeedback");
  await loading($("#googleLogin"), async () => {
    try {
      state.user = await bridge.signInWithGoogle();
      await authorize();
    } catch (error) {
      feedback("loginFeedback", error.message || "Não foi possível entrar com Google.", "error");
    }
  });
}
async function register(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('[type="submit"]'),
    name = $("#registerName").value.trim(),
    email = $("#registerEmail").value.trim(),
    password = $("#registerPassword").value,
    confirmation = $("#registerPasswordConfirm").value;
  if (password.length < 6)
    return feedback("registerFeedback", "Use uma senha com pelo menos 6 caracteres.", "error");
  if (password !== confirmation)
    return feedback("registerFeedback", "As senhas não são iguais.", "error");
  feedback("registerFeedback");
  await loading(button, async () => {
    try {
      const result = await bridge.signUp(name, email, password);
      form.reset();
      setAuthView("login");
      feedback(
        "loginFeedback",
        result.requiresVerification
          ? "Conta criada. Confirme o e-mail recebido e depois entre no painel."
          : "Conta criada. Entre para ativar o painel.",
        "success",
      );
    } catch (error) {
      feedback("registerFeedback", error.message || "Não foi possível criar a conta.", "error");
    }
  });
}
async function forgot(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  feedback("forgotFeedback");
  await loading(button, async () => {
    try {
      await bridge.sendPasswordReset($("#forgotEmail").value.trim());
      feedback("forgotFeedback", "E-mail enviado. Confira também a pasta Spam.", "success");
    } catch (error) {
      feedback("forgotFeedback", error.message || "Não foi possível enviar o e-mail.", "error");
    }
  });
}
async function authorize() {
  try {
    if (await bridge.isPlatformAdmin()) {
      await showDashboard();
      return;
    }
    $("#authView").hidden = false;
    $("#adminView").hidden = true;
    setAuthView("activation");
  } catch (error) {
    $("#authView").hidden = false;
    $("#adminView").hidden = true;
    feedback("loginFeedback", error.message || "Não foi possível validar o administrador.", "error");
    setAuthView("login");
  }
}
async function activateAdmin(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  feedback("activationFeedback");
  await loading(button, async () => {
    try {
      await bridge.bootstrapPlatformAdmin($("#activationCode").value);
      $("#activationCode").value = "";
      await showDashboard();
      toast("Painel administrativo ativado com segurança.");
    } catch (error) {
      const message = String(error.message || "");
      feedback(
        "activationFeedback",
        message.includes("ADMIN_ALREADY_CONFIGURED")
          ? "Este painel já possui um proprietário. Entre com a conta administrativa correta."
          : message.includes("INVALID_ACTIVATION_CODE")
            ? "Código de ativação inválido. Confira e tente novamente."
            : message || "Não foi possível ativar o painel.",
        "error",
      );
    }
  });
}
async function signOut() {
  await bridge.signOut();
  state.user = null;
  location.reload();
}
function effectiveStatus(account) {
  if (account.status === "active" && account.paid_until) {
    const end = new Date(`${account.paid_until}T23:59:59`);
    if (end < new Date()) return "expired";
  }
  return account.status || "pending";
}
const isLifetimeAccount = (account) =>
  effectiveStatus(account) === "active" && !account.paid_until;
const statusLabel = (status) =>
  ({
    active: "Ativo",
    pending: "Pendente",
    expired: "Bloqueado por atraso",
    blocked: "Bloqueio manual",
  })[status] || "Pendente";
const accountFee = (account) =>
  Number(account.monthly_fee ?? state.settings?.default_monthly_fee ?? 0);
const dateLabel = (value) =>
  value ? new Date(`${value}T12:00`).toLocaleDateString("pt-BR") : "Não liberado";
const accessDateLabel = (account) =>
  isLifetimeAccount(account) ? "Sem vencimento" : dateLabel(account.paid_until);
const dateTimeLabel = (value, fallback = "Não informado") => {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const accountInitials = (account) => {
  const source = (account.display_name || account.email || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : source.slice(0, 2)).toUpperCase();
};
const todayValue = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
};
function selectedAccessPeriod() {
  const raw = $("#manageMonths")?.value || "months:1";
  if (raw === "lifetime") return { lifetime: true, unit: "lifetime", value: 0 };
  const [unit, value] = raw.includes(":") ? raw.split(":") : ["months", raw];
  return { lifetime: false, unit, value: Number(value) };
}
function accessPeriodLabel(period) {
  if (period.lifetime) return "vitalício";
  if (period.unit === "days")
    return `${period.value} ${period.value === 1 ? "dia" : "dias"}`;
  return `${period.value} ${period.value === 1 ? "mês" : "meses"}`;
}
function accessDateFromToday(period) {
  const today = new Date();
  let result;
  if (period.unit === "days") {
    result = new Date(today.getFullYear(), today.getMonth(), today.getDate() + period.value, 12);
  } else {
    const targetMonth = today.getMonth() + period.value,
      lastDay = new Date(today.getFullYear(), targetMonth + 1, 0).getDate();
    result = new Date(
      today.getFullYear(),
      targetMonth,
      Math.min(today.getDate(), lastDay),
      12,
    );
  }
  return result.toLocaleDateString("pt-BR");
}
const isFreeAccess = (account) =>
  account?.access_type === "free" &&
  effectiveStatus(account) === "active" &&
  Boolean(account.paid_until);
const customerAccounts = () =>
  state.accounts.filter((account) => !state.adminIds.includes(account.user_id));
function renderStats() {
  const customers = customerAccounts(),
    statuses = customers.map(effectiveStatus),
    activeAccounts = customers.filter(
      (account) =>
        effectiveStatus(account) === "active" &&
        !isLifetimeAccount(account) &&
        !isFreeAccess(account),
    );
  $("#statTotal").textContent = customers.length;
  $("#statActive").textContent = statuses.filter((status) => status === "active").length;
  $("#statPending").textContent = statuses.filter((status) => status === "pending").length;
  $("#statRevenue").textContent = money(
    activeAccounts.reduce((total, account) => total + accountFee(account), 0),
  );
}
const expiryNoticeStorageKey = () =>
  `credmais_admin_expiry_notices:${state.user?.id || "owner"}`;
function expiredCustomerAccounts() {
  return customerAccounts().filter(
    (account) => effectiveStatus(account) === "expired",
  );
}
function renderExpiryAlert() {
  const accounts = expiredCustomerAccounts(),
    alert = $("#expiryAlert");
  alert.hidden = accounts.length === 0;
  if (!accounts.length) return;
  const names = accounts
    .slice(0, 3)
    .map((account) => account.display_name || account.email || "Conta sem nome"),
    remaining = accounts.length - names.length;
  $("#expiryAlertTitle").textContent = `${accounts.length} ${
    accounts.length === 1 ? "acesso foi bloqueado" : "acessos foram bloqueados"
  } automaticamente`;
  $("#expiryAlertMessage").textContent = `${names.join(", ")}${
    remaining > 0 ? ` e mais ${remaining}` : ""
  }. Motivo: pagamento vencido. Os dados continuam visíveis, mas nenhuma alteração é permitida até a renovação.`;
}
function notifyAutomaticExpirations(expirySync = null) {
  const expired = expiredCustomerAccounts(),
    currentIds = expired.map((account) => account.user_id),
    backendIds = new Set(
      (expirySync?.accounts || []).map((account) => account.userId),
    );
  let previousIds = [];
  try {
    previousIds = JSON.parse(localStorage.getItem(expiryNoticeStorageKey()) || "[]");
  } catch {
    previousIds = [];
  }
  const previous = new Set(previousIds),
    newlyBlocked = expired.filter(
      (account) => backendIds.has(account.user_id) || !previous.has(account.user_id),
    );
  localStorage.setItem(expiryNoticeStorageKey(), JSON.stringify(currentIds));
  if (!newlyBlocked.length) return false;
  toast(
    newlyBlocked.length === 1
      ? `${newlyBlocked[0].display_name || newlyBlocked[0].email || "Um usuário"} foi bloqueado automaticamente por pagamento vencido.`
      : `${newlyBlocked.length} usuários foram bloqueados automaticamente por pagamento vencido.`,
  );
  return true;
}
function needsAttention(account) {
  const status = effectiveStatus(account);
  if (status !== "active") return true;
  if (isLifetimeAccount(account)) return false;
  const end = new Date(`${account.paid_until}T12:00`),
    days = Math.ceil((end - new Date()) / 86400000);
  return days <= 7;
}
function renderOverview() {
  renderStats();
  renderExpiryAlert();
  const attention = customerAccounts()
    .filter(needsAttention)
    .sort((first, second) => {
      const order = { pending: 0, expired: 1, blocked: 2, active: 3 };
      return order[effectiveStatus(first)] - order[effectiveStatus(second)];
    })
    .slice(0, 7);
  $("#attentionList").innerHTML = attention.length
    ? attention
        .map((account) => {
          const status = effectiveStatus(account);
          return `<div class="attention-item"><div><b>${escapeHtml(account.display_name || account.email || "Conta sem nome")}</b><small>${statusLabel(status)}${account.paid_until ? ` · até ${dateLabel(account.paid_until)}` : ""}</small></div><button data-manage="${escapeHtml(account.user_id)}">Gerenciar</button></div>`;
        })
        .join("")
    : '<div class="empty">Nenhuma conta precisa de atenção agora.</div>';
  $("#accessLog").innerHTML = state.log.length
    ? state.log
        .map(
          (item) =>
            `<div class="log-item"><b>${escapeHtml(item.action_label || "Alteração de acesso")}</b><small>${escapeHtml(state.accounts.find((account) => account.user_id === item.user_id)?.display_name || "Conta")} · ${new Date(item.created_at).toLocaleString("pt-BR")}</small></div>`,
        )
        .join("")
    : '<div class="empty">As próximas ações aparecerão aqui.</div>';
}
function renderAccounts() {
  const term = state.search.toLowerCase(),
    accounts = customerAccounts()
      .filter((account) => {
        const status = effectiveStatus(account),
          lifetime = isLifetimeAccount(account),
          matchesFilter =
            state.filter === "all" ||
            (state.filter === "lifetime" ? lifetime : state.filter === status),
          haystack = `${account.display_name || ""} ${account.email || ""} ${account.phone || ""}`.toLowerCase();
        return matchesFilter && haystack.includes(term);
      })
      .sort((first, second) => {
        const order = { pending: 0, expired: 1, blocked: 2, active: 3 };
        const difference = order[effectiveStatus(first)] - order[effectiveStatus(second)];
        if (difference) return difference;
        return String(first.display_name || first.email || "").localeCompare(
          String(second.display_name || second.email || ""),
          "pt-BR",
        );
      });
  const resultCount = $("#accountsResultCount");
  if (resultCount)
    resultCount.textContent = `${accounts.length} ${accounts.length === 1 ? "usuário" : "usuários"}`;
  $("#accountsList").innerHTML = accounts.length
    ? accounts
        .map((account) => {
          const status = effectiveStatus(account),
            lifetime = isLifetimeAccount(account),
            freeAccess = isFreeAccess(account);
          const userId = escapeHtml(account.user_id),
            name = escapeHtml(account.display_name || "Conta sem nome"),
            email = escapeHtml(account.email || "E-mail não informado");
          return `<article class="account-row" data-manage-row="${userId}">
            <div class="account-user"><span class="account-avatar">${escapeHtml(accountInitials(account))}</span><div><b>${name}</b><small>${email}</small></div></div>
            <div class="account-compact-access"><b>${lifetime ? "Colaborador" : freeAccess ? "Teste gratuito" : money(accountFee(account))}</b><small>${lifetime ? "Acesso vitalício" : `Vence: ${accessDateLabel(account)}`}</small></div>
            <div class="account-compact-status"><span class="status ${lifetime ? "lifetime" : status}">${lifetime ? "Vitalício" : statusLabel(status)}</span></div>
            <div class="account-actions"><button data-manage="${userId}" aria-label="Abrir perfil e ações de ${name}" title="Abrir perfil">›</button></div>
          </article>`;
        })
        .join("")
    : '<div class="panel empty">Nenhuma conta encontrada neste filtro.</div>';
}
function renderSettings() {
  setMoneyInput($("#defaultMonthlyFee"), state.settings?.default_monthly_fee || 0);
  $("#supportPhone").value = formatPhone(state.settings?.support_phone || "");
  $("#billingRecipient").value = state.settings?.billing_recipient || "";
  $("#billingPixType").value = state.settings?.billing_pix_type || "Chave aleatória";
  $("#billingPixKey").value = state.settings?.billing_pix_key || "";
  $("#billingMessage").value = state.settings?.billing_message || DEFAULT_MESSAGE;
}
async function loadDashboard(notify = false) {
  const result = await bridge.loadPlatformAdmin();
  state.accounts = result.accounts;
  state.settings = result.settings;
  state.log = result.log;
  state.adminIds = result.adminIds || [];
  renderOverview();
  renderAccounts();
  renderSettings();
  const informedExpiration = notifyAutomaticExpirations(result.expirySync);
  if (notify && !informedExpiration) toast("Painel atualizado.");
}
async function showDashboard() {
  try {
    await loadDashboard();
  } catch (error) {
    toast(error.message || "Não foi possível carregar o painel.");
    throw error;
  }
  $("#ownerName").textContent = state.user?.name || "Administrador";
  $("#ownerGreeting").textContent = (state.user?.name || "Administrador").split(" ")[0];
  $("#ownerInitial").textContent = (state.user?.name || "A")[0].toUpperCase();
  $("#authView").hidden = true;
  $("#adminView").hidden = false;
}
function setSection(section) {
  state.section = section;
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("active", page.id === `${section}Section`);
  });
  document.querySelectorAll("[data-section]").forEach((button) =>
    button.classList.toggle("active", button.dataset.section === section),
  );
  $("#sectionTitle").textContent =
    ({ overview: "Visão geral", accounts: "Assinaturas", settings: "Configurações" })[
      section
    ];
  document.querySelector(".admin-app aside").classList.remove("open");
}
function openModal(id) {
  $("#modalBackdrop").hidden = false;
  const modal = $(`#${id}`);
  modal.hidden = false;
  modal.scrollTop = 0;
  document.body.style.overflow = "hidden";
}
function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => (modal.hidden = true));
  $("#modalBackdrop").hidden = true;
  document.body.style.overflow = "";
}
function openManage(userId) {
  const account = state.accounts.find((item) => item.user_id === userId);
  if (!account) return toast("Esta conta não foi encontrada.");
  state.managedUserId = userId;
  $("#manageUserId").value = userId;
  $("#manageName").textContent = account.display_name || "Conta sem nome";
  $("#manageEmail").textContent = account.email || "E-mail não informado";
  $("#manageAvatar").textContent = accountInitials(account);
  $("#managePhone").value = formatPhone(account.phone || "");
  setMoneyInput($("#manageFee"), accountFee(account));
  $("#manageNotes").value = account.notes || "";
  const status = effectiveStatus(account);
  const lifetime = isLifetimeAccount(account);
  $("#manageMonths").value = lifetime ? "lifetime" : "months:1";
  document.querySelector('[name="manageGrantType"][value="paid"]').checked = true;
  $("#manageStatus").textContent = lifetime ? "Vitalício" : statusLabel(status);
  $("#manageStatus").className = `status ${lifetime ? "lifetime" : status}`;
  $("#managePaidUntil").textContent = lifetime
    ? "Vitalício, sem vencimento"
    : account.paid_until
      ? `${isFreeAccess(account) ? "Teste gratuito" : "Acesso pago"} até ${dateLabel(account.paid_until)}`
      : "Ainda não liberado";
  $("#manageLastSeen").textContent = dateTimeLabel(account.last_seen_at, "Ainda não acessou");
  $("#manageRequestedAt").textContent = dateTimeLabel(
    account.access_requested_at,
    "Não solicitou",
  );
  $("#manageCreatedAt").textContent = dateTimeLabel(account.created_at, "Data indisponível");
  $("#toggleBlock").textContent =
    status === "blocked" ? "↻ Reabrir solicitação" : "⊘ Bloquear acesso";
  $("#toggleBlock").classList.toggle("restore", status === "blocked");
  $("#chargeAccount").disabled = lifetime;
  $("#chargeAccount").title = lifetime
    ? "Colaboradores vitalícios não possuem cobrança mensal."
    : "Gerar mensagem de cobrança";
  const hasPhone = digits(account.phone).length >= 10;
  $("#copyUserPhone").disabled = !hasPhone;
  $("#contactUser").disabled = !hasPhone;
  $("#copyUserPhone").title = hasPhone ? "Copiar número" : "WhatsApp não cadastrado";
  $("#contactUser").title = hasPhone ? "Abrir conversa" : "WhatsApp não cadastrado";
  feedback("manageFeedback");
  syncManagePeriod();
  openModal("manageModal");
}
function syncManagePeriod() {
  const period = selectedAccessPeriod(),
    lifetime = period.lifetime,
    account = state.accounts.find((item) => item.user_id === state.managedUserId),
    feeInput = $("#manageFee");
  $("#grantTypeBlock").hidden = lifetime;
  if (lifetime) {
    setMoneyInput(feeInput, 0);
    feeInput.disabled = true;
    $("#managePeriodHelp").textContent =
      "Colaboradores ficam sem vencimento e sem cobrança mensal.";
    $("#grantAccess").textContent = "Liberar vitalício";
    return;
  }
  if (feeInput.disabled) {
    const normalFee = Number(account?.monthly_fee) > 0
      ? Number(account.monthly_fee)
      : Number(state.settings?.default_monthly_fee || 0);
    setMoneyInput(feeInput, normalFee);
  }
  feeInput.disabled = false;
  $("#managePeriodHelp").textContent = `A validade será definida até ${accessDateFromToday(period)}, contando a partir de hoje. Uma nova liberação substituirá a data anterior.`;
  syncGrantType(true);
}
function syncGrantType(resetAmount = false) {
  const period = selectedAccessPeriod();
  if (period.lifetime) return;
  const accessType = document.querySelector('[name="manageGrantType"]:checked')?.value || "paid",
    free = accessType === "free",
    amountInput = $("#manageGrantAmount"),
    monthlyFee = readMoneyInput($("#manageFee")),
    suggestedAmount = period.unit === "days"
      ? Math.round((monthlyFee * period.value / 30) * 100) / 100
      : monthlyFee * period.value;
  if (resetAmount || free) setMoneyInput(amountInput, free ? 0 : suggestedAmount);
  amountInput.disabled = free;
  $("#manageGrantTypeHelp").textContent = free
    ? "Será registrado como cortesia. A mensalidade cadastrada continuará disponível para cobranças futuras."
    : "Informe o valor que você recebeu. O histórico registrará esta liberação como paga.";
  $("#grantAccess").textContent = free ? "Liberar teste gratuito" : "Liberar acesso pago";
}
async function saveManagedAccount(showToast = true) {
  const account = await bridge.updatePlatformAccount(state.managedUserId, {
    phone: formatPhone($("#managePhone").value),
    notes: $("#manageNotes").value.trim(),
    monthlyFee: readMoneyInput($("#manageFee")),
  });
  const index = state.accounts.findIndex((item) => item.user_id === account.user_id);
  if (index >= 0) state.accounts[index] = account;
  renderOverview();
  renderAccounts();
  if (showToast) toast("Dados da conta atualizados.");
  return account;
}
async function saveManage(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  feedback("manageFeedback");
  await loading(button, async () => {
    try {
      await saveManagedAccount();
      closeModals();
    } catch (error) {
      feedback("manageFeedback", error.message || "Não foi possível salvar.", "error");
    }
  });
}
async function grantAccess() {
  feedback("manageFeedback");
  await loading($("#grantAccess"), async () => {
    try {
      const period = selectedAccessPeriod(),
        accessType = document.querySelector('[name="manageGrantType"]:checked')?.value || "paid",
        accountDetails = {
          phone: formatPhone($("#managePhone").value),
          notes: $("#manageNotes").value.trim(),
        };
      let updatedAccount;
      if (period.lifetime)
        updatedAccount = await bridge.grantPlatformLifetime(
          state.managedUserId,
          accountDetails,
        );
      else
        updatedAccount = await bridge.grantPlatformAccess(
          state.managedUserId,
          period.value,
          period.unit,
          readMoneyInput($("#manageFee")),
          accessType,
          readMoneyInput($("#manageGrantAmount")),
          accountDetails,
        );
      closeModals();
      await loadDashboard();
      toast(
        period.lifetime
          ? "Acesso vitalício liberado para o colaborador."
          : `${accessType === "free" ? "Teste gratuito" : "Acesso pago"} de ${accessPeriodLabel(period)} liberado até ${dateLabel(updatedAccount.paid_until)}.`,
      );
    } catch (error) {
      feedback("manageFeedback", error.message || "Não foi possível liberar.", "error");
    }
  });
}
async function toggleBlock() {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId),
    nextStatus = effectiveStatus(account) === "blocked" ? "pending" : "blocked";
  await loading($("#toggleBlock"), async () => {
    try {
      await bridge.setPlatformAccountStatus(state.managedUserId, nextStatus);
      closeModals();
      await loadDashboard();
      toast(nextStatus === "blocked" ? "Acesso bloqueado." : "Solicitação reaberta.");
    } catch (error) {
      feedback("manageFeedback", error.message || "Não foi possível alterar o acesso.", "error");
    }
  });
}
function billingMessage(account) {
  const template = state.settings?.billing_message || DEFAULT_MESSAGE,
    replacements = {
      nome: account.display_name || account.email?.split("@")[0] || "cliente",
      valor: money(accountFee(account)),
      vencimento: dateLabel(account.paid_until || todayValue()),
      pix: state.settings?.billing_pix_key || "Solicite a chave PIX",
      recebedor: state.settings?.billing_recipient || "CredMais",
    };
  return Object.entries(replacements).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, value),
    template,
  );
}
function splitBillingMessage(message) {
  const blocks = String(message || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const greeting = blocks.shift() || "Olá! 👋";
  const pixIndex = blocks.findIndex((block) => /pix|chave/i.test(block));
  if (pixIndex >= 0)
    return {
      greeting,
      details: blocks.slice(0, pixIndex).join("\n\n"),
      pix: blocks[pixIndex],
      closing: blocks.slice(pixIndex + 1).join("\n\n"),
    };
  return {
    greeting,
    details: blocks.shift() || "",
    pix: blocks.shift() || "",
    closing: blocks.join("\n\n"),
  };
}
function syncChargePreview() {
  $("#chargePreview").value = [
    $("#chargeGreeting").value.trim(),
    $("#chargeDetails").value.trim(),
    $("#chargePix").value.trim(),
    $("#chargeClosing").value.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Alguns PWAs bloqueiam a API moderna; o método compatível abaixo mantém a ação disponível.
    }
  }
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.appendChild(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  if (!copied) throw new Error("COPY_NOT_SUPPORTED");
}
function openCharge(userId) {
  const account = state.accounts.find((item) => item.user_id === userId);
  if (!account) return toast("Esta conta não foi encontrada.");
  if (isLifetimeAccount(account))
    return toast("Colaboradores vitalícios não possuem cobrança mensal.");
  state.chargedUserId = userId;
  $("#chargeName").textContent = `Cobrar ${account.display_name || "mensalidade"}`;
  $("#chargeSubtitle").textContent = `${money(accountFee(account))} · vencimento ${dateLabel(account.paid_until || todayValue())}`;
  const parts = splitBillingMessage(billingMessage(account));
  $("#chargeGreeting").value = parts.greeting;
  $("#chargeDetails").value = parts.details;
  $("#chargePix").value = parts.pix;
  $("#chargeClosing").value = parts.closing;
  syncChargePreview();
  $("#sendCharge").disabled = digits(account.phone).length < 10;
  $("#sendCharge").title = $("#sendCharge").disabled
    ? "Cadastre o WhatsApp desta conta para enviar."
    : "Abrir WhatsApp";
  feedback(
    "chargeFeedback",
    $("#sendCharge").disabled
      ? "Cadastre o WhatsApp no perfil para habilitar o envio."
      : "Mensagem pronta. Você pode editar qualquer bloco.",
    $("#sendCharge").disabled ? "error" : "success",
  );
  closeModals();
  openModal("chargeModal");
}
async function copyCharge() {
  syncChargePreview();
  try {
    await writeClipboard($("#chargePreview").value);
    feedback("chargeFeedback", "Mensagem premium copiada com sucesso.", "success");
    toast("Mensagem de cobrança copiada.");
  } catch (error) {
    feedback("chargeFeedback", "Não foi possível copiar. Tente novamente.", "error");
  }
}
function sendCharge() {
  const account = state.accounts.find((item) => item.user_id === state.chargedUserId),
    phone = digits(account?.phone);
  if (phone.length < 10) {
    feedback("chargeFeedback", "Cadastre um WhatsApp válido no perfil desta conta.", "error");
    return toast("WhatsApp não cadastrado.");
  }
  syncChargePreview();
  feedback("chargeFeedback", "Abrindo a conversa no WhatsApp...", "success");
  window.open(
    `https://wa.me/55${phone}?text=${encodeURIComponent($("#chargePreview").value)}`,
    "_blank",
    "noopener",
  );
}
async function copyManagedContact(field) {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId),
    value = field === "email" ? account?.email : formatPhone(account?.phone || "");
  if (!value) return toast(field === "email" ? "E-mail não informado." : "WhatsApp não cadastrado.");
  try {
    await writeClipboard(value);
    feedback(
      "manageFeedback",
      field === "email" ? "E-mail copiado com sucesso." : "WhatsApp copiado com sucesso.",
      "success",
    );
    toast(field === "email" ? "E-mail copiado." : "WhatsApp copiado.");
  } catch {
    feedback("manageFeedback", "Não foi possível copiar. Tente novamente.", "error");
  }
}
function contactManagedUser() {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId),
    phone = digits(account?.phone);
  if (phone.length < 10) return toast("Cadastre um WhatsApp válido nesta conta.");
  feedback("manageFeedback", "Abrindo a conversa no WhatsApp...", "success");
  window.open(`https://wa.me/55${phone}`, "_blank", "noopener");
}
async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('[type="submit"]');
  feedback("settingsFeedback");
  await loading(button, async () => {
    try {
      state.settings = await bridge.savePlatformSettings({
        defaultMonthlyFee: readMoneyInput($("#defaultMonthlyFee")),
        supportPhone: formatPhone($("#supportPhone").value),
        billingRecipient: $("#billingRecipient").value.trim(),
        billingPixKey: $("#billingPixKey").value.trim(),
        billingPixType: $("#billingPixType").value,
        billingMessage: $("#billingMessage").value.trim(),
      });
      renderOverview();
      renderAccounts();
      feedback("settingsFeedback", "Configurações salvas com sucesso.", "success");
    } catch (error) {
      feedback("settingsFeedback", error.message || "Não foi possível salvar.", "error");
    }
  });
}
let deferredInstallPrompt = null;
async function installAdmin() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return;
  }
  toast(
    /iphone|ipad|ipod/i.test(navigator.userAgent)
      ? "No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início."
      : "Abra o menu do navegador e escolha Instalar aplicativo.",
  );
}
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  $("#themeToggle").textContent = dark ? "☀" : "☾";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0f1713" : "#075b43";
  localStorage.setItem("credmais_admin_theme", dark ? "dark" : "light");
}

$("#adminLogin").addEventListener("submit", signIn);
$("#googleLogin").onclick = signInGoogle;
$("#adminRegister").addEventListener("submit", register);
$("#adminForgot").addEventListener("submit", forgot);
$("#adminActivation").addEventListener("submit", activateAdmin);
$("#activationLogout").onclick = signOut;
$("#adminLogout").onclick = signOut;
$("#manageForm").addEventListener("submit", saveManage);
$("#grantAccess").onclick = grantAccess;
$("#manageMonths").onchange = syncManagePeriod;
document.querySelectorAll('[name="manageGrantType"]').forEach((input) =>
  input.addEventListener("change", () => syncGrantType(true)),
);
$("#toggleBlock").onclick = toggleBlock;
$("#chargeAccount").onclick = () => openCharge(state.managedUserId);
$("#copyUserEmail").onclick = () => copyManagedContact("email");
$("#copyUserPhone").onclick = () => copyManagedContact("phone");
$("#contactUser").onclick = contactManagedUser;
$("#copyCharge").onclick = copyCharge;
$("#sendCharge").onclick = sendCharge;
document.querySelectorAll("[data-charge-part]").forEach((input) =>
  input.addEventListener("input", () => {
    syncChargePreview();
    feedback("chargeFeedback", "Alteração aplicada à mensagem.", "success");
  }),
);
$("#settingsForm").addEventListener("submit", saveSettings);
$("#refreshAccounts").onclick = () => loading($("#refreshAccounts"), () => loadDashboard(true));
$("#openExpiredAccounts").onclick = () => {
  state.filter = "expired";
  document.querySelectorAll("[data-filter]").forEach((button) =>
    button.classList.toggle("active", button.dataset.filter === "expired"),
  );
  setSection("accounts");
  renderAccounts();
};
$("#accountSearch").oninput = (event) => {
  state.search = event.target.value;
  renderAccounts();
};
$("#defaultMonthlyFee").addEventListener("input", maskMoney);
$("#manageFee").addEventListener("input", (event) => {
  maskMoney(event);
  if (!selectedAccessPeriod().lifetime) syncGrantType(true);
});
$("#manageGrantAmount").addEventListener("input", maskMoney);
[$("#supportPhone"), $("#managePhone")].forEach((input) =>
  input.addEventListener("input", (event) => (event.target.value = formatPhone(event.target.value))),
);
$("#themeToggle").onclick = () => applyTheme(!document.body.classList.contains("dark"));
$("#installAdmin").onclick = installAdmin;
$("#menuButton").onclick = () => document.querySelector(".admin-app aside").classList.toggle("open");
$("#modalBackdrop").onclick = closeModals;
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) {
    if (button.dataset.authView) setAuthView(button.dataset.authView);
    if (button.dataset.section) setSection(button.dataset.section);
    if (button.dataset.sectionTarget) setSection(button.dataset.sectionTarget);
    if (button.dataset.filter) {
      state.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) =>
        item.classList.toggle("active", item === button),
      );
      renderAccounts();
    }
    if (button.dataset.manage) openManage(button.dataset.manage);
    if (button.dataset.charge) openCharge(button.dataset.charge);
    if (button.hasAttribute("data-close-modal")) closeModals();
  }
  const accountRow = event.target.closest("[data-manage-row]");
  if (accountRow && !button) openManage(accountRow.dataset.manageRow);
  const aside = document.querySelector(".admin-app aside");
  if (aside?.classList.contains("open") && !aside.contains(event.target) && !$("#menuButton").contains(event.target))
    aside.classList.remove("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModals();
    document.querySelector(".admin-app aside")?.classList.remove("open");
  }
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn(error));
applyTheme(
  localStorage.getItem("credmais_admin_theme")
    ? localStorage.getItem("credmais_admin_theme") === "dark"
    : window.matchMedia?.("(prefers-color-scheme: dark)").matches,
);
(async () => {
  try {
    state.user = await bridge.currentUser();
    if (state.user) await authorize();
  } catch (error) {
    feedback("loginFeedback", error.message || "Não foi possível restaurar a sessão.", "error");
  } finally {
    setTimeout(() => $("#adminLoader").classList.add("hide"), 350);
  }
})();
setInterval(() => {
  const modalOpen = [...document.querySelectorAll(".modal")].some((modal) => !modal.hidden);
  if (
    !$("#adminView").hidden &&
    !document.hidden &&
    state.section !== "settings" &&
    !modalOpen
  )
    loadDashboard().catch(() => {});
}, 30000);
