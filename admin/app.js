const $ = (selector) => document.querySelector(selector);
const bridge = window.credmaisBridge;
const state = {
  user: null,
  accounts: [],
  settings: null,
  log: [],
  payments: [],
  paymentTotals: null,
  adminIds: [],
  filter: "all",
  paymentFilter: "all",
  overviewFeed: "recent",
  search: "",
  section: "overview",
  managedUserId: null,
  chargedUserId: null,
  currentPayment: null,
  recentAccountEvents: [],
  profileRequestId: 0,
  historyUserId: null,
  historyOffset: 0,
  historyEvents: [],
  historyLoading: false,
  historyRequestId: 0,
  refreshFailed: false,
};
const DEFAULT_MESSAGE = `Olá, *{nome}*! 👋

💎 *CREDMAIS PREMIUM*
━━━━━━━━━━━━━━━━
💳 Mensalidade: *{valor}*
📅 Vencimento: *{vencimento}*

⚡ *PAGAMENTO AUTOMÁTICO*
Entre na sua conta do CredMais, escolha o período e toque em *Pagar agora*. O pagamento é feito no ambiente seguro do Mercado Pago.

✅ Assim que o Mercado Pago confirmar, seu acesso será liberado automaticamente. Não é necessário enviar comprovante.

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
  const content = button.innerHTML;
  button.disabled = true;
  button.textContent = "Aguarde...";
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.innerHTML = content;
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
  if (
    password.length < 10 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password)
  )
    return feedback(
      "registerFeedback",
      "Use 10 caracteres ou mais, com maiúscula, minúscula e número.",
      "error",
    );
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
    $("#authThemeToggle").hidden = false;
    setAuthView("activation");
  } catch (error) {
    $("#authView").hidden = false;
    $("#adminView").hidden = true;
    $("#authThemeToggle").hidden = false;
    feedback("loginFeedback", error.message || "Não foi possível validar o administrador.", "error");
    setAuthView("login");
  }
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
const hasProtectedAutomaticAccess = (account) =>
  Boolean(
    account &&
    effectiveStatus(account) === "active" &&
    account.access_type === "paid" &&
    account.paid_until &&
    account.last_payment_transaction_id,
  );
const statusLabel = (status) =>
  ({
    active: "Ativo",
    pending: "Pendente",
    expired: "Bloqueado por atraso",
    blocked: "Bloqueio manual",
  })[status] || "Pendente";
const accountFee = (account) =>
  Number(account.monthly_fee ?? state.settings?.default_monthly_fee ?? 0);
const accountPricingTier = (account) => {
  if (account?.access_type === "lifetime") return "lifetime";
  if (["global", "launch_locked", "custom"].includes(account?.pricing_tier))
    return account.pricing_tier;
  return account?.monthly_fee === null || account?.monthly_fee === undefined
    ? "global"
    : "custom";
};
const accountPricingLabel = (account) =>
  ({
    global: "Preço global atual",
    launch_locked: "Lançamento protegido",
    custom: "Desconto especial",
    lifetime: "Sem cobrança",
  })[accountPricingTier(account)] || "Preço global atual";
const selectedPricingTier = () =>
  document.querySelector('[name="managePricing"]:checked')?.value || "global";
const managedMonthlyFee = () => {
  const tier = selectedPricingTier();
  if (tier === "launch_locked")
    return Number(state.settings?.launch_monthly_fee || 39.9);
  if (tier === "global")
    return Number(state.settings?.default_monthly_fee || 0);
  return readMoneyInput($("#manageFee"));
};
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
    result = new Date(today.getFullYear(), today.getMonth(), today.getDate() + period.value - 1, 12);
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
const recentCustomerAccounts = () => {
  const threshold = Date.now() - 7 * 86400000;
  return customerAccounts()
    .filter((account) => new Date(account.created_at).getTime() >= threshold)
    .sort((first, second) => new Date(second.created_at) - new Date(first.created_at));
};
const approvedAutomaticPayments = () =>
  state.payments
    .filter(
      (payment) =>
        payment.status === "approved" &&
        Boolean(payment.accessGrantedAt) &&
        payment.liveMode !== false,
    )
    .sort(
      (first, second) =>
        new Date(second.paidAt || second.updatedAt || second.createdAt) -
        new Date(first.paidAt || first.updatedAt || first.createdAt),
    );
const paymentsForUser = (userId) =>
  state.payments
    .filter((payment) => payment.userId === userId)
    .sort(
      (first, second) =>
        new Date(second.paidAt || second.updatedAt || second.createdAt) -
        new Date(first.paidAt || first.updatedAt || first.createdAt),
    );
const latestApprovedPayment = (userId) =>
  approvedAutomaticPayments().find((payment) => payment.userId === userId) || null;
const paymentStatusLabel = (status) =>
  ({
    approved: "Aprovado",
    pending: "Aguardando pagamento",
    creating: "Preparando checkout",
    in_process: "Em análise",
    authorized: "Autorizado",
    rejected: "Recusado",
    cancelled: "Cancelado",
    refunded: "Estornado",
    charged_back: "Contestado",
    expired: "Expirado",
    error: "Erro no checkout",
  })[status] || "Aguardando";
const paymentStatusGroup = (status) => {
  if (status === "approved") return "approved";
  if (["creating", "pending", "in_process", "authorized"].includes(status))
    return "pending";
  return "failed";
};
const paymentMethodLabel = (payment) => {
  const method = String(payment?.paymentMethod || "").toLowerCase(),
    type = String(payment?.paymentType || "").toLowerCase();
  if (method === "pix" || type === "bank_transfer") return "Pix";
  if (type === "credit_card") return method ? `Cartão de crédito · ${method.toUpperCase()}` : "Cartão de crédito";
  if (type === "debit_card") return method ? `Cartão de débito · ${method.toUpperCase()}` : "Cartão de débito";
  if (type === "account_money") return "Saldo Mercado Pago";
  return method ? method.replaceAll("_", " ") : "Mercado Pago";
};
const manualPaymentLabel = (method) => ({
  cash: "Dinheiro em espécie",
  pix_direct: "Pix direto",
  bank_transfer: "Transferência bancária",
  card_external: "Cartão fora da plataforma",
  other: "Outro meio",
})[method] || "Meio não registrado";
const paymentPlanLabel = (payment) => {
  if (!payment) return "Nenhum plano pago";
  if (payment.mode === "subscription") return "Assinatura mensal automática";
  const months = Number(payment.planMonths || 1);
  return `${months} ${months === 1 ? "mês" : "meses"} · pagamento único`;
};
const paymentAccount = (payment) =>
  state.accounts.find((account) => account.user_id === payment.userId);
const isCurrentMonth = (value) => {
  const date = new Date(value || 0),
    now = new Date();
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth()
  );
};
function renderStats() {
  const customers = customerAccounts(),
    statuses = customers.map(effectiveStatus),
    automaticPayments = approvedAutomaticPayments(),
    receivedThisMonth = automaticPayments.filter((payment) =>
      isCurrentMonth(payment.paidAt || payment.accessGrantedAt),
    );
  $("#statTotal").textContent = customers.length;
  $("#statRecent").textContent = recentCustomerAccounts().length;
  $("#statAutomaticPaid").textContent = customers.filter(hasProtectedAutomaticAccess).length;
  $("#statActive").textContent = statuses.filter((status) => status === "active").length;
  $("#statReceivedMonth").textContent = money(state.paymentTotals?.approvedAmountMonth ??
    receivedThisMonth.reduce((total, payment) => total + Number(payment.amount || 0), 0));
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
function renderOverviewFeed() {
  const feed = $("#overviewFeed");
  if (!feed) return;
  document.querySelectorAll("[data-overview-feed]").forEach((button) =>
    button.classList.toggle("active", button.dataset.overviewFeed === state.overviewFeed),
  );
  if (state.overviewFeed === "paid") {
    const payments = approvedAutomaticPayments().slice(0, 6);
    feed.innerHTML = payments.length
      ? payments
          .map((payment) => {
            const account = paymentAccount(payment),
              userId = escapeHtml(payment.userId),
              name = escapeHtml(account?.display_name || account?.email || "Conta sem nome");
            return `<article class="feed-item paid-feed" data-manage-row="${userId}"><span class="feed-avatar paid">✓</span><div class="feed-main"><b>${name}</b><small>${escapeHtml(paymentMethodLabel(payment))} · ${dateTimeLabel(payment.paidAt || payment.accessGrantedAt)}</small></div><div class="feed-value"><b>${money(payment.amount)}</b><small>${escapeHtml(paymentPlanLabel(payment))}</small></div><button data-manage="${userId}" aria-label="Abrir perfil de ${name}">›</button></article>`;
          })
          .join("")
      : '<div class="empty-state"><span>◆</span><b>Nenhum pagamento automático ainda</b><p>As confirmações do Mercado Pago aparecerão aqui.</p></div>';
    return;
  }
  const accounts = recentCustomerAccounts().slice(0, 6);
  feed.innerHTML = accounts.length
    ? accounts
        .map((account) => {
          const status = effectiveStatus(account),
            userId = escapeHtml(account.user_id),
            name = escapeHtml(account.display_name || account.email || "Conta sem nome");
          return `<article class="feed-item" data-manage-row="${userId}"><span class="feed-avatar">${escapeHtml(accountInitials(account))}</span><div class="feed-main"><b>${name}<em>Novo</em></b><small>${escapeHtml(account.email || "E-mail não informado")}</small></div><div class="feed-value"><b>${statusLabel(status)}</b><small>Criado em ${dateTimeLabel(account.created_at)}</small></div><button data-manage="${userId}" aria-label="Abrir perfil de ${name}">›</button></article>`;
        })
        .join("")
    : '<div class="empty-state"><span>＋</span><b>Nenhum cadastro nos últimos 7 dias</b><p>Novos usuários aparecerão aqui automaticamente.</p></div>';
}
function renderPayments() {
  const approvedThisMonth = approvedAutomaticPayments().filter((payment) =>
      isCurrentMonth(payment.paidAt || payment.accessGrantedAt),
    ),
    pending = state.payments.filter(
      (payment) => paymentStatusGroup(payment.status) === "pending",
    ),
    failed = state.payments.filter(
      (payment) => paymentStatusGroup(payment.status) === "failed",
    );
  $("#paymentApprovedMonth").textContent = state.paymentTotals?.approvedCountMonth ?? approvedThisMonth.length;
  $("#paymentApprovedAmount").textContent = `${money(
    state.paymentTotals?.approvedAmountMonth ?? approvedThisMonth.reduce((total, payment) => total + Number(payment.amount || 0), 0),
  )} recebidos`;
  $("#paymentPendingCount").textContent = state.paymentTotals?.pendingCount ?? pending.length;
  $("#paymentFailedCount").textContent = state.paymentTotals?.failedCount ?? failed.length;
  document.querySelectorAll("[data-payment-filter]").forEach((button) =>
    button.classList.toggle("active", button.dataset.paymentFilter === state.paymentFilter),
  );
  const payments = state.payments
    .filter(
      (payment) =>
        state.paymentFilter === "all" ||
        paymentStatusGroup(payment.status) === state.paymentFilter,
    )
    .sort(
      (first, second) =>
        new Date(second.paidAt || second.updatedAt || second.createdAt) -
        new Date(first.paidAt || first.updatedAt || first.createdAt),
    );
  $("#paymentList").innerHTML = payments.length
    ? payments
        .map((payment) => {
          const account = paymentAccount(payment),
            userId = escapeHtml(payment.userId),
            name = escapeHtml(account?.display_name || account?.email || "Conta sem nome"),
            group = paymentStatusGroup(payment.status),
            when = payment.paidAt || payment.updatedAt || payment.createdAt;
          return `<article class="payment-row ${group}" data-manage-row="${userId}"><span class="payment-state-icon">${group === "approved" ? "✓" : group === "pending" ? "◷" : "!"}</span><div class="payment-user"><b>${name}</b><small>${escapeHtml(account?.email || "E-mail não informado")}</small></div><div class="payment-description"><b>${escapeHtml(paymentPlanLabel(payment))}</b><small>${group === "approved" ? escapeHtml(paymentMethodLabel(payment)) : paymentStatusLabel(payment.status)} · ${dateTimeLabel(when)}</small></div><div class="payment-amount"><b>${money(payment.amount)}</b><span class="payment-status ${group}">${paymentStatusLabel(payment.status)}</span></div><button data-manage="${userId}" aria-label="Abrir cobrança de ${name}">›</button></article>`;
        })
        .join("")
    : '<div class="empty-state"><span>◆</span><b>Nenhum pagamento neste filtro</b><p>Os pagamentos gerados pelo Mercado Pago aparecerão aqui.</p></div>';
}
function renderOverview() {
  renderStats();
  renderExpiryAlert();
  renderOverviewFeed();
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
          recent = recentCustomerAccounts().some((item) => item.user_id === account.user_id),
          automaticPaid = hasProtectedAutomaticAccess(account),
          matchesFilter =
            state.filter === "all" ||
            (state.filter === "lifetime"
              ? lifetime
              : state.filter === "recent"
                ? recent
                : state.filter === "auto_paid"
                  ? automaticPaid
                  : state.filter === status),
          haystack = `${account.display_name || ""} ${account.email || ""} ${account.phone || ""}`.toLowerCase();
        return matchesFilter && haystack.includes(term);
      })
      .sort((first, second) => {
        if (state.filter === "recent")
          return new Date(second.created_at) - new Date(first.created_at);
        if (state.filter === "auto_paid")
          return (
            new Date(latestApprovedPayment(second.user_id)?.paidAt || 0) -
            new Date(latestApprovedPayment(first.user_id)?.paidAt || 0)
          );
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
            freeAccess = isFreeAccess(account),
            recent = recentCustomerAccounts().some((item) => item.user_id === account.user_id);
          const userId = escapeHtml(account.user_id),
            name = escapeHtml(account.display_name || "Conta sem nome"),
            email = escapeHtml(account.email || "E-mail não informado");
          return `<article class="account-row" data-manage-row="${userId}">
            <div class="account-user"><span class="account-avatar">${escapeHtml(accountInitials(account))}</span><div><b>${name}${recent ? '<em class="new-tag">Novo</em>' : ""}</b><small>${email}</small></div></div>
            <div class="account-compact-access"><b>${lifetime ? "Colaborador" : freeAccess ? "Teste gratuito" : hasProtectedAutomaticAccess(account) ? "Pago pelo Mercado Pago" : money(accountFee(account))}</b><small>${lifetime ? "Acesso vitalício" : `${hasProtectedAutomaticAccess(account) ? "Pagamento confirmado" : accountPricingLabel(account)} · vence: ${accessDateLabel(account)}`}</small></div>
            <div class="account-compact-status"><span class="status ${lifetime ? "lifetime" : status}">${lifetime ? "Vitalício" : statusLabel(status)}</span></div>
            <div class="account-actions"><button data-manage="${userId}" aria-label="Abrir perfil e ações de ${name}" title="Abrir perfil">›</button></div>
          </article>`;
        })
        .join("")
    : '<div class="panel empty">Nenhuma conta encontrada neste filtro.</div>';
}
function renderSettings() {
  const launchFee = Number(state.settings?.launch_monthly_fee || 39.9),
    standardFee = Number(state.settings?.standard_monthly_fee || 59.9),
    phase = state.settings?.pricing_phase === "standard" ? "standard" : "launch",
    currentFee = phase === "launch" ? launchFee : standardFee;
  setMoneyInput($("#standardMonthlyFee"), standardFee);
  $("#pricingPhase").value = phase;
  $("#launchPricePreview").textContent = `${money(launchFee)}/mês`;
  $("#standardPricePreview").textContent = `${money(standardFee)}/mês`;
  $("#trialDaysPreview").textContent = `${Number(state.settings?.trial_days || 15)} dias`;
  $("#globalPricePreview").textContent = `${money(currentFee)} por mês`;
  $("#pricingPhaseBadge").textContent =
    phase === "launch" ? "FASE DE LANÇAMENTO" : "PREÇO NORMAL ATIVO";
  $("#pricingPhaseWarning").textContent =
    phase === "launch"
      ? `O CredMais está em lançamento por ${money(launchFee)}. Ativar o preço normal afetará somente novas contas e usuários no valor global.`
      : `O preço normal de ${money(standardFee)} está ativo. Os primeiros usuários continuam protegidos por ${money(launchFee)}.`;
  $("#supportPhone").value = formatPhone(state.settings?.support_phone || "");
  $("#settingsSupportSummary").textContent = state.settings?.support_phone
    ? `Suporte: ${formatPhone(state.settings.support_phone)}`
    : "Suporte: não configurado";
  const savedMessage = state.settings?.billing_message || "";
  $("#billingMessage").value = /\{pix\}|\{recebedor\}|chave\s+pix|envie\s+o\s+comprovante/i.test(savedMessage)
    ? DEFAULT_MESSAGE
    : savedMessage || DEFAULT_MESSAGE;
}
async function loadDashboard(notify = false) {
  const indicator = $("#syncIndicator");
  indicator.textContent = "Atualizando…";
  indicator.className = "sync-indicator loading";
  let result;
  try {
    result = await bridge.loadPlatformAdmin();
  } catch (error) {
    indicator.textContent = "Falha ao atualizar";
    indicator.className = "sync-indicator error";
    if (notify || !state.refreshFailed)
      toast(error.message || "Não foi possível atualizar o painel. Os dados exibidos podem estar desatualizados.");
    state.refreshFailed = true;
    throw error;
  }
  state.accounts = result.accounts;
  state.settings = result.settings;
  state.log = result.log;
  state.payments = result.payments || [];
  state.paymentTotals = result.paymentTotals || null;
  state.adminIds = result.adminIds || [];
  renderOverview();
  renderAccounts();
  renderPayments();
  renderSettings();
  indicator.textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  indicator.className = "sync-indicator success";
  if (state.refreshFailed) toast("Conexão restabelecida. Painel atualizado.");
  state.refreshFailed = false;
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
  $("#authThemeToggle").hidden = true;
}
function setActivityMenu(open) {
  const menu = $("#activityMenu"),
    button = $("#activityMenuButton");
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) menu.scrollTop = 0;
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
    ({
      overview: "Visão geral",
      accounts: "Usuários",
      payments: "Pagamentos",
      settings: "Configurações",
    })[
      section
    ];
  setActivityMenu(false);
  document.querySelector(".admin-app aside").classList.remove("open");
}
function openModal(id) {
  document.querySelectorAll(".modal").forEach((modal) => (modal.hidden = true));
  $("#modalBackdrop").hidden = false;
  const modal = $(`#${id}`);
  modal.hidden = false;
  modal.scrollTop = 0;
  modal.tabIndex = -1;
  modal.focus({ preventScroll: true });
  $("#authView").inert = true;
  $("#adminView").inert = true;
  document.body.style.overflow = "hidden";
}
function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => (modal.hidden = true));
  $("#modalBackdrop").hidden = true;
  $("#authView").inert = false;
  $("#adminView").inert = false;
  document.body.style.overflow = "";
}
function renderHistoryEvent(event) {
  const account = state.accounts.find((item) => item.user_id === event.userId),
    method = event.kind === "payment"
      ? paymentMethodLabel(event)
      : event.paymentMethod ? manualPaymentLabel(event.paymentMethod) : "Alteração administrativa",
    amount = event.amount == null ? "" : ` · ${money(event.amount)}`;
  return `<article class="history-event"><span class="history-event-icon ${event.kind === "payment" ? "payment" : "access"}">${event.kind === "payment" ? "◆" : "✓"}</span><div><b>${escapeHtml(event.label || "Atividade registrada")}</b><small>${account && state.historyUserId === null ? `${escapeHtml(account.display_name || account.email || "Conta")} · ` : ""}${dateTimeLabel(event.occurredAt)} · ${escapeHtml(method)}${amount}</small></div></article>`;
}
async function loadProfileHistory(userId, requestId) {
  try {
    const result = await bridge.loadPlatformHistory(userId, 0, 4);
    if (state.managedUserId !== userId || state.profileRequestId !== requestId) return;
    state.currentPayment = result.currentPayment || null;
    state.recentAccountEvents = result.events || [];
    const account = state.accounts.find((item) => item.user_id === userId);
    if (account) renderManagedBilling(account, state.currentPayment);
  } catch (error) {
    if (state.managedUserId !== userId || state.profileRequestId !== requestId) return;
    $("#managePaymentHistory").innerHTML = '<div class="payment-history-empty">Não foi possível carregar o histórico. Tente abrir o perfil novamente.</div>';
    feedback("profileFeedback", error.message || "Falha ao consultar o histórico.", "error");
  }
}
async function loadMoreHistory() {
  if (state.historyLoading) return;
  state.historyLoading = true;
  const userId = state.historyUserId,
    offset = state.historyOffset,
    requestId = state.historyRequestId,
    button = $("#historyLoadMore");
  button.disabled = true;
  feedback("historyFeedback", "Carregando histórico…");
  try {
    const result = await bridge.loadPlatformHistory(userId, offset, 20);
    if (state.historyRequestId !== requestId || state.historyUserId !== userId || state.historyOffset !== offset) return;
    state.historyEvents.push(...(result.events || []));
    state.historyOffset = result.nextOffset;
    $("#historyList").innerHTML = state.historyEvents.length
      ? state.historyEvents.map(renderHistoryEvent).join("")
      : '<p class="history-empty">Nenhum acontecimento registrado.</p>';
    button.hidden = !result.hasMore;
    feedback("historyFeedback");
  } catch (error) {
    if (state.historyRequestId === requestId)
      feedback("historyFeedback", error.message || "Não foi possível carregar o histórico.", "error");
  } finally {
    if (state.historyRequestId === requestId) {
      state.historyLoading = false;
      button.disabled = false;
    }
  }
}
function openHistory(userId = null) {
  state.historyRequestId += 1;
  state.historyLoading = false;
  state.historyUserId = userId;
  state.historyOffset = 0;
  state.historyEvents = [];
  const account = state.accounts.find((item) => item.user_id === userId);
  $("#historyTitle").textContent = account
    ? `Histórico de ${account.display_name || account.email || "usuário"}`
    : "Histórico do painel";
  $("#historySubtitle").textContent = account
    ? "Pagamentos, liberações e mudanças de acesso desta conta."
    : "Pagamentos e alterações de todos os usuários.";
  $("#historyBackProfile").hidden = !userId;
  $("#historyList").innerHTML = "";
  $("#historyLoadMore").hidden = true;
  openModal("historyModal");
  loadMoreHistory();
}
function openAccountAction(id) {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId);
  if (!account) return toast("Esta conta não foi encontrada.");
  if (["accessModal", "dangerModal"].includes(id) && hasProtectedAutomaticAccess(account))
    return toast("Este período pago está protegido; só dados e preço futuro podem ser alterados.");
  if (id === "accessModal" && isLifetimeAccount(account))
    return toast("Para alterar um colaborador vitalício, use primeiro o reset em ações sensíveis.");
  if (id === "accessModal") {
    $("#manageMonths").value = "months:1";
    $("#manualPaymentMethod").value = "";
    document.querySelector('[name="manageGrantType"][value="paid"]').checked = true;
    syncManagePeriod();
  }
  if (id === "editAccountModal") syncPricingMode(false);
  openModal(id);
}
function renderManagedBilling(account, currentPayment = null) {
  const events = state.recentAccountEvents,
    automatic = hasProtectedAutomaticAccess(account),
    lifetime = isLifetimeAccount(account),
    free = account.access_type === "free" && Boolean(account.paid_until),
    manuallyPaid =
      !automatic &&
      !lifetime &&
      !free &&
      account.access_type === "paid" && Number(account.access_amount) > 0 &&
      Boolean(account.approved_at) && !account.last_payment_transaction_id;
  const verifiedPayment = Boolean(account.last_payment_transaction_id) &&
    String(currentPayment?.transactionId) === String(account.last_payment_transaction_id)
      ? currentPayment : null;
  const recordedAutomatic = automatic || Boolean(verifiedPayment),
    expired = effectiveStatus(account) === "expired",
    blocked = effectiveStatus(account) === "blocked",
    reversed = ["refunded", "charged_back"].includes(verifiedPayment?.status);
  const origin = recordedAutomatic
    ? reversed ? "Mercado Pago · revertido" : expired ? "Mercado Pago · encerrado" : "Mercado Pago"
    : lifetime
      ? "Colaborador vitalício"
      : free
        ? expired ? "Teste encerrado" : "Teste gratuito"
        : manuallyPaid
          ? expired ? "Manual · encerrado" : "Liberação manual paga"
          : "Sem pagamento confirmado";
  $("#managePaymentOrigin").textContent = origin;
  $("#managePaymentOrigin").className = `payment-origin-badge ${recordedAutomatic ? "automatic" : manuallyPaid ? "manual" : free || lifetime ? "free" : "empty"}`;
  $("#managePaymentStatus").textContent = recordedAutomatic
    ? reversed ? verifiedPayment.status === "refunded" ? "Pagamento estornado; acesso não está liberado" : "Pagamento contestado; acesso não está liberado"
      : expired ? "Pagamento anterior confirmado; o acesso está vencido"
      : verifiedPayment ? "Pagamento confirmado para o acesso atual" : "Consultando confirmação do pagamento atual…"
    : manuallyPaid ? expired ? "Pagamento manual anterior; o acesso está vencido"
      : blocked ? "Pagamento manual registrado; acesso bloqueado" : "Pagamento recebido e liberado manualmente"
      : free ? expired ? "Cortesia encerrada, sem pagamento" : "Cortesia ativa, sem pagamento" : lifetime ? "Colaborador com acesso sem vencimento"
        : "Nenhum pagamento ativo nesta conta";
  $("#managePaymentMethod").textContent = recordedAutomatic
    ? verifiedPayment ? paymentMethodLabel(verifiedPayment) : "Mercado Pago (consultando)"
    : manuallyPaid
      ? manualPaymentLabel(account.manual_payment_method)
      : free
        ? "Cortesia"
        : lifetime
          ? "Sem cobrança"
          : "Ainda não pagou";
  $("#managePaymentAmount").textContent = recordedAutomatic
    ? money(verifiedPayment?.amount ?? account.access_amount)
    : manuallyPaid
      ? money(account.access_amount)
      : money(0);
  $("#managePaymentPlan").textContent = recordedAutomatic
    ? verifiedPayment?.planMonths ? `${verifiedPayment.planMonths} ${verifiedPayment.planMonths === 1 ? "mês" : "meses"}` : "Plano pago"
    : lifetime
      ? "Vitalício"
      : free
        ? "Teste gratuito"
        : manuallyPaid
          ? "Acesso liberado manualmente"
          : "Nenhum plano pago";
  $("#managePaymentDate").textContent = recordedAutomatic
    ? dateTimeLabel(verifiedPayment?.paidAt || verifiedPayment?.accessGrantedAt || account.approved_at)
    : manuallyPaid
      ? dateTimeLabel(account.approved_at)
      : "Sem confirmação";
  $("#managePaymentHistory").innerHTML = events.length
    ? events.map(renderHistoryEvent).join("")
    : '<div class="payment-history-empty">Nenhum acontecimento registrado para esta conta.</div>';
}
function openManage(userId) {
  const account = state.accounts.find((item) => item.user_id === userId);
  if (!account) return toast("Esta conta não foi encontrada.");
  state.managedUserId = userId;
  state.currentPayment = null;
  state.recentAccountEvents = [];
  const requestId = ++state.profileRequestId;
  $("#manageUserId").value = userId;
  $("#manageName").textContent = account.display_name || "Conta sem nome";
  $("#manageEmail").textContent = account.email || "E-mail não informado";
  $("#manageAvatar").textContent = accountInitials(account);
  $("#managePhone").value = formatPhone(account.phone || "");
  const lifetime = isLifetimeAccount(account),
    pricingTier = lifetime ? "global" : accountPricingTier(account);
  setMoneyInput(
    $("#manageFee"),
    Number(account.monthly_fee) > 0
      ? Number(account.monthly_fee)
      : Number(state.settings?.default_monthly_fee || 0),
  );
  document.querySelector(
    `[name="managePricing"][value="${pricingTier}"]`,
  ).checked = true;
  $("#manageLaunchFeeLabel").textContent = `${money(state.settings?.launch_monthly_fee || 39.9)} por mês; não muda quando o preço normal for ativado.`;
  $("#manageGlobalFeeLabel").textContent = `${money(state.settings?.default_monthly_fee || 0)} por mês; acompanha futuras alterações globais.`;
  $("#manageNotes").value = account.notes || "";
  const status = effectiveStatus(account);
  $("#manageMonths").value = lifetime ? "lifetime" : "months:1";
  document.querySelector('[name="manageGrantType"][value="paid"]').checked = true;
  $("#manageStatus").textContent = lifetime ? "Vitalício" : statusLabel(status);
  $("#manageStatus").className = `status ${lifetime ? "lifetime" : status}`;
  $("#managePaidUntil").textContent = lifetime
    ? "Vitalício, sem vencimento"
    : account.paid_until
      ? `${account.access_type === "free" ? "Teste gratuito" : "Acesso pago"} até ${dateLabel(account.paid_until)}`
      : "Ainda não liberado";
  $("#manageAccessDescription").textContent = lifetime
    ? "Colaborador sem cobrança recorrente."
    : status === "active" ? `Acesso disponível até ${dateLabel(account.paid_until)}.`
      : status === "expired" ? `O período terminou em ${dateLabel(account.paid_until)}.`
        : status === "blocked" ? "Bloqueio manual registrado no painel."
          : "Conta sem acesso liberado no momento.";
  $("#manageNextPrice").textContent = lifetime
    ? "Sem mensalidade"
    : `${money(accountFee(account))}/mês · ${accountPricingLabel(account)}`;
  $("#manageLastSeen").textContent = dateTimeLabel(account.last_seen_at, "Ainda não acessou");
  $("#manageRequestedAt").textContent = dateTimeLabel(
    account.access_requested_at,
    "Não solicitou",
  );
  $("#manageCreatedAt").textContent = dateTimeLabel(account.created_at, "Data indisponível");
  renderManagedBilling(account);
  $("#managePaymentHistory").innerHTML = '<div class="payment-history-empty">Carregando acontecimentos…</div>';
  const protectedPaidAccess = hasProtectedAutomaticAccess(account);
  $("#managePlanProtection").hidden = !protectedPaidAccess;
  $("#managePlanProtection").textContent = protectedPaidAccess
    ? `✓ Período pago pelo Mercado Pago protegido até ${dateLabel(account.paid_until)}. Bloqueio, reset e troca do plano ficam indisponíveis. Você ainda pode atualizar o contato e o preço de compras futuras.`
    : "";
  $("#manageAccessSection").hidden = protectedPaidAccess || lifetime;
  $("#resetAccessSection").hidden = protectedPaidAccess;
  $("#toggleBlock").hidden = protectedPaidAccess;
  $("#actionGrant").hidden = protectedPaidAccess || lifetime;
  $("#actionDanger").hidden = protectedPaidAccess;
  $("#toggleBlock").textContent =
    status === "blocked" ? "↻ Reabrir solicitação" : "⊘ Bloquear acesso";
  $("#toggleBlock").classList.toggle("restore", status === "blocked");
  const protectedAdminAccount = state.adminIds.includes(account.user_id);
  $("#resetPlatformAccess").disabled = protectedAdminAccount;
  $("#resetPlatformAccess").title = protectedAdminAccount
    ? "A conta proprietária do painel não pode ter o acesso resetado."
    : "Zerar somente o plano e a validade desta conta";
  $("#chargeAccount").disabled = lifetime;
  $("#chargeAccount").title = lifetime
    ? "Colaboradores vitalícios não possuem cobrança mensal."
    : "Gerar mensagem de cobrança";
  const hasPhone = digits(account.phone).length >= 10;
  $("#copyUserPhone").disabled = !hasPhone;
  $("#contactUser").disabled = !hasPhone;
  $("#copyUserPhone").title = hasPhone ? "Copiar número" : "WhatsApp não cadastrado";
  $("#contactUser").title = hasPhone ? "Abrir conversa" : "WhatsApp não cadastrado";
  feedback("profileFeedback");
  feedback("manageFeedback");
  feedback("grantFeedback");
  feedback("dangerFeedback");
  syncManagePeriod();
  openModal("manageModal");
  loadProfileHistory(userId, requestId);
}
function syncManagePeriod() {
  const period = selectedAccessPeriod(),
    lifetime = period.lifetime;
  $("#grantTypeBlock").hidden = lifetime;
  if (lifetime) {
    $("#managePeriodHelp").textContent =
      "Colaboradores ficam sem vencimento e sem cobrança mensal.";
    $("#grantAccess").textContent = "Liberar vitalício";
  } else {
    $("#managePeriodHelp").textContent = `A validade será definida até ${accessDateFromToday(period)}, contando a partir de hoje. Uma nova liberação substituirá a data anterior.`;
  }
  syncGrantType(true);
}
function syncPricingMode(resetAmount = true) {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId),
    lifetime = isLifetimeAccount(account),
    pricingTier = selectedPricingTier(),
    feeField = $("#manageFeeField"),
    feeInput = $("#manageFee");
  document.querySelectorAll('[name="managePricing"]').forEach((input) => {
    input.disabled = lifetime;
  });
  feeField.hidden = lifetime || pricingTier !== "custom";
  feeInput.disabled = lifetime || pricingTier !== "custom";
  const sourceLabel = {
    global: "preço global atual",
    launch_locked: "lançamento protegido",
    custom: "desconto especial",
  }[pricingTier];
  $("#manageEffectiveFee").textContent = lifetime
    ? "Sem cobrança mensal"
    : `${money(managedMonthlyFee())} por mês · ${sourceLabel}`;
}
function syncGrantType(resetAmount = false) {
  const period = selectedAccessPeriod();
  if (period.lifetime) {
    $("#manualPaymentMethodField").hidden = true;
    return;
  }
  const accessType = document.querySelector('[name="manageGrantType"]:checked')?.value || "paid",
    free = accessType === "free",
    amountInput = $("#manageGrantAmount"),
    account = state.accounts.find((item) => item.user_id === state.managedUserId),
    monthlyFee = account ? accountFee(account) : 0,
    suggestedAmount = period.unit === "days"
      ? Math.round((monthlyFee * period.value / 30) * 100) / 100
      : monthlyFee * period.value;
  if (resetAmount || free) setMoneyInput(amountInput, free ? 0 : suggestedAmount);
  amountInput.disabled = free;
  $("#manualPaymentMethodField").hidden = free;
  $("#manualPaymentMethod").required = !free;
  $("#manageGrantTypeHelp").textContent = free
    ? "Será registrado como cortesia. A mensalidade cadastrada continuará disponível para cobranças futuras."
    : "Informe o valor que você recebeu. O histórico registrará esta liberação como paga.";
  $("#grantAccess").textContent = free ? "Liberar teste gratuito" : "Liberar acesso pago";
}
async function saveManagedAccount(showToast = true) {
  const pricingTier = selectedPricingTier(),
    monthlyFee = pricingTier === "custom" ? readMoneyInput($("#manageFee")) : null;
  if (pricingTier === "custom" && (!Number.isFinite(monthlyFee) || monthlyFee <= 0))
    throw new Error("Informe uma mensalidade personalizada maior que zero.");
  const account = await bridge.updatePlatformAccount(state.managedUserId, {
    phone: formatPhone($("#managePhone").value),
    notes: $("#manageNotes").value.trim(),
    pricingTier,
    monthlyFee,
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
      openManage(state.managedUserId);
    } catch (error) {
      feedback("manageFeedback", error.message || "Não foi possível salvar.", "error");
    }
  });
}
async function grantAccess() {
  const currentAccount = state.accounts.find((item) => item.user_id === state.managedUserId);
  if (!currentAccount) return feedback("grantFeedback", "Esta conta não foi encontrada.", "error");
  if (hasProtectedAutomaticAccess(currentAccount))
    return feedback("grantFeedback", "O período pago automaticamente está protegido. Ajuste somente o preço de compras futuras.", "error");
  if (isLifetimeAccount(currentAccount))
    return feedback("grantFeedback", "Resete primeiro o acesso vitalício para alterar o plano.", "error");
  feedback("grantFeedback");
  await loading($("#grantAccess"), async () => {
    try {
      const period = selectedAccessPeriod(),
        accessType = document.querySelector('[name="manageGrantType"]:checked')?.value || "paid",
        pricingTier = accountPricingTier(currentAccount),
        monthlyFee = pricingTier === "custom" ? Number(currentAccount.monthly_fee) : null,
        paymentMethod = accessType === "paid" && !period.lifetime
          ? $("#manualPaymentMethod").value : null,
        accountDetails = {
          phone: currentAccount.phone || "",
          notes: currentAccount.notes || "",
        };
      if (!period.lifetime && accessType === "paid" && !paymentMethod)
        throw new Error("Selecione como recebeu o pagamento.");
      if (!period.lifetime && pricingTier === "custom" && (!Number.isFinite(monthlyFee) || monthlyFee <= 0))
        throw new Error("Informe uma mensalidade personalizada maior que zero.");
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
          monthlyFee,
          pricingTier,
          accessType,
          readMoneyInput($("#manageGrantAmount")),
          paymentMethod,
          accountDetails,
        );
      await loadDashboard();
      openManage(state.managedUserId);
      toast(
        period.lifetime
          ? "Acesso vitalício liberado para o colaborador."
          : `${accessType === "free" ? "Teste gratuito" : "Acesso pago"} de ${accessPeriodLabel(period)} liberado até ${dateLabel(updatedAccount.paid_until)}.`,
      );
    } catch (error) {
      feedback("grantFeedback", error.message || "Não foi possível liberar.", "error");
    }
  });
}
async function toggleBlock() {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId),
    nextStatus = effectiveStatus(account) === "blocked" ? "pending" : "blocked";
  if (hasProtectedAutomaticAccess(account))
    return feedback("dangerFeedback", "Não é possível bloquear um período pago e ativo pelo Mercado Pago.", "error");
  await loading($("#toggleBlock"), async () => {
    try {
      await bridge.setPlatformAccountStatus(state.managedUserId, nextStatus);
      await loadDashboard();
      openManage(state.managedUserId);
      toast(nextStatus === "blocked" ? "Acesso bloqueado." : "Solicitação reaberta.");
    } catch (error) {
      feedback("dangerFeedback", error.message || "Não foi possível alterar o acesso.", "error");
    }
  });
}
async function resetPlatformAccess() {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId);
  if (!account) return toast("Esta conta não foi encontrada.");
  if (hasProtectedAutomaticAccess(account))
    return feedback("dangerFeedback", "Não é possível resetar um período pago e ativo pelo Mercado Pago.", "error");
  if (state.adminIds.includes(account.user_id))
    return feedback(
      "dangerFeedback",
      "A conta proprietária do painel não pode ter o acesso resetado.",
      "error",
    );

  const accountName = account.display_name || account.email || "este usuário";
  const confirmed = window.confirm(
    `Resetar o plano de ${accountName}?\n\n` +
      "A conta ficará sem plano e sem data de validade. Clientes, empréstimos, histórico e preço especial serão preservados.\n\n" +
      "Cobranças pendentes serão invalidadas. Esta ação não estorna pagamentos já realizados.",
  );
  if (!confirmed) {
    feedback("dangerFeedback", "Reset cancelado. Nenhum dado foi alterado.");
    return;
  }

  feedback("dangerFeedback");
  await loading($("#resetPlatformAccess"), async () => {
    try {
      await bridge.resetPlatformAccess(account.user_id);
      await loadDashboard();
      openManage(state.managedUserId);
      toast("Plano resetado. A conta agora está sem validade e pronta para um novo teste.");
    } catch (error) {
      feedback(
        "dangerFeedback",
        error.message || "Não foi possível resetar o plano.",
        "error",
      );
    }
  });
}
function billingMessage(account) {
  const savedTemplate = state.settings?.billing_message || "",
    template = /\{pix\}|\{recebedor\}|chave\s+pix|envie\s+o\s+comprovante/i.test(savedTemplate)
      ? DEFAULT_MESSAGE
      : savedTemplate || DEFAULT_MESSAGE,
    replacements = {
      nome: account.display_name || account.email?.split("@")[0] || "cliente",
      valor: money(accountFee(account)),
      vencimento: dateLabel(account.paid_until || todayValue()),
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
  return {
    greeting,
    details: blocks.shift() || "",
    payment: blocks.shift() || "",
    closing: blocks.join("\n\n"),
  };
}
function syncChargePreview() {
  $("#chargePreview").value = [
    $("#chargeGreeting").value.trim(),
    $("#chargeDetails").value.trim(),
    $("#chargePayment").value.trim(),
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
  $("#chargePayment").value = parts.payment;
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
      "profileFeedback",
      field === "email" ? "E-mail copiado com sucesso." : "WhatsApp copiado com sucesso.",
      "success",
    );
    toast(field === "email" ? "E-mail copiado." : "WhatsApp copiado.");
  } catch {
    feedback("profileFeedback", "Não foi possível copiar. Tente novamente.", "error");
  }
}
function contactManagedUser() {
  const account = state.accounts.find((item) => item.user_id === state.managedUserId),
    phone = digits(account?.phone);
  if (phone.length < 10) return toast("Cadastre um WhatsApp válido nesta conta.");
  feedback("profileFeedback", "Abrindo a conversa no WhatsApp...", "success");
  window.open(`https://wa.me/55${phone}`, "_blank", "noopener");
}
async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('[type="submit"]');
  feedback("settingsFeedback");
  await loading(button, async () => {
    try {
      const standardMonthlyFee = readMoneyInput($("#standardMonthlyFee")),
        pricingPhase = $("#pricingPhase").value,
        supportPhone = formatPhone($("#supportPhone").value);
      if (!Number.isFinite(standardMonthlyFee) || standardMonthlyFee < 39.9)
        throw new Error("O preço normal deve ser igual ou maior que R$ 39,90.");
      if (!["launch", "standard"].includes(pricingPhase))
        throw new Error("Escolha uma fase de preço válida.");
      if (supportPhone && ![10, 11].includes(digits(supportPhone).length))
        throw new Error("Informe um WhatsApp de suporte válido com DDD.");
      state.settings = await bridge.savePlatformSettings({
        standardMonthlyFee,
        pricingPhase,
        supportPhone,
        billingMessage: $("#billingMessage").value.trim(),
      });
      renderSettings();
      renderOverview();
      renderAccounts();
      feedback(
        "settingsFeedback",
        pricingPhase === "launch"
          ? "Política salva. O lançamento continua em R$ 39,90."
          : "Preço normal ativado para novas contas; os usuários de lançamento foram preservados.",
        "success",
      );
      closeModals();
      toast("Política comercial atualizada.");
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
  [$("#themeToggle"), $("#authThemeToggle")].filter(Boolean).forEach((button) => {
    button.textContent = dark ? "☀" : "☾";
    button.title = dark ? "Usar tema claro" : "Usar tema escuro";
  });
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0f1713" : "#075b43";
  localStorage.setItem("credmais_admin_theme", dark ? "dark" : "light");
}

$("#adminLogin").addEventListener("submit", signIn);
$("#googleLogin").onclick = signInGoogle;
$("#adminRegister").addEventListener("submit", register);
$("#adminForgot").addEventListener("submit", forgot);
$("#activationLogout").onclick = signOut;
$("#adminLogout").onclick = signOut;
$("#manageForm").addEventListener("submit", saveManage);
$("#grantAccess").onclick = grantAccess;
$("#manageMonths").onchange = syncManagePeriod;
document.querySelectorAll('[name="manageGrantType"]').forEach((input) =>
  input.addEventListener("change", () => syncGrantType(true)),
);
document.querySelectorAll('[name="managePricing"]').forEach((input) =>
  input.addEventListener("change", () => syncPricingMode(true)),
);
$("#toggleBlock").onclick = toggleBlock;
$("#resetPlatformAccess").onclick = resetPlatformAccess;
$("#openEditAccount").onclick = () => openAccountAction("editAccountModal");
$("#openManageActions").onclick = () => openAccountAction("actionsModal");
$("#actionEdit").onclick = () => openAccountAction("editAccountModal");
$("#actionGrant").onclick = () => openAccountAction("accessModal");
$("#actionDanger").onclick = () => openAccountAction("dangerModal");
$("#viewAccountHistory").onclick = () => openHistory(state.managedUserId);
$("#historyLoadMore").onclick = loadMoreHistory;
$("#openPaymentHistory").onclick = () => openHistory();
$("#openGlobalHistory").onclick = () => {
  setActivityMenu(false);
  openHistory();
};
$("#openSettingsEdit").onclick = () => {
  renderSettings();
  feedback("settingsFeedback");
  openModal("settingsModal");
};
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
$("#headerRefresh").onclick = () => loading($("#headerRefresh"), () => loadDashboard(true));
$("#openCurrentFeed").onclick = () => {
  if (state.overviewFeed === "paid") {
    state.paymentFilter = "approved";
    renderPayments();
    setSection("payments");
    return;
  }
  state.filter = "recent";
  document.querySelectorAll("[data-filter]").forEach((button) =>
    button.classList.toggle("active", button.dataset.filter === "recent"),
  );
  renderAccounts();
  setSection("accounts");
};
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
$("#standardMonthlyFee").addEventListener("input", (event) => {
  maskMoney(event);
  $("#standardPricePreview").textContent = `${money(readMoneyInput(event.currentTarget))}/mês`;
  if ($("#pricingPhase").value === "standard")
    $("#globalPricePreview").textContent = `${money(readMoneyInput(event.currentTarget))} por mês`;
});
$("#pricingPhase").addEventListener("change", () => {
  const phase = $("#pricingPhase").value,
    fee = phase === "launch" ? 39.9 : readMoneyInput($("#standardMonthlyFee"));
  $("#globalPricePreview").textContent = `${money(fee)} por mês`;
  $("#pricingPhaseBadge").textContent =
    phase === "launch" ? "FASE DE LANÇAMENTO" : "PREÇO NORMAL ATIVO";
  $("#pricingPhaseWarning").textContent =
    phase === "launch"
      ? "O CredMais continuará oferecendo R$ 39,90 às novas contas."
      : "Ao salvar, o preço normal valerá para novas contas e usuários no valor global. Os primeiros usuários não serão alterados.";
});
$("#manageFee").addEventListener("input", (event) => {
  maskMoney(event);
  syncPricingMode(false);
});
$("#manageGrantAmount").addEventListener("input", maskMoney);
[$("#supportPhone"), $("#managePhone")].forEach((input) =>
  input.addEventListener("input", (event) => (event.target.value = formatPhone(event.target.value))),
);
$("#themeToggle").onclick = () => applyTheme(!document.body.classList.contains("dark"));
$("#authThemeToggle").onclick = () => applyTheme(!document.body.classList.contains("dark"));
$("#activityMenuButton").onclick = () =>
  setActivityMenu($("#activityMenu").hidden);
$("#activityMenuClose").onclick = () => setActivityMenu(false);
$("#installAdmin").onclick = installAdmin;
$("#menuButton").onclick = () => document.querySelector(".admin-app aside").classList.toggle("open");
$("#modalBackdrop").onclick = closeModals;
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) {
    if (button.dataset.passwordToggle) {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.classList.toggle("is-visible", show);
      button.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
      button.setAttribute("aria-pressed", String(show));
      return;
    }
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
    if (button.dataset.overviewFeed) {
      state.overviewFeed = button.dataset.overviewFeed;
      renderOverviewFeed();
    }
    if (button.dataset.paymentFilter) {
      state.paymentFilter = button.dataset.paymentFilter;
      renderPayments();
    }
    if (button.dataset.manage) openManage(button.dataset.manage);
    if (button.dataset.charge) openCharge(button.dataset.charge);
    if (button.hasAttribute("data-back-profile")) openManage(state.managedUserId);
    if (button.hasAttribute("data-close-modal")) closeModals();
  }
  const accountRow = event.target.closest("[data-manage-row]");
  if (accountRow && !button) openManage(accountRow.dataset.manageRow);
  const activityMenu = $("#activityMenu");
  if (
    !activityMenu.hidden &&
    !activityMenu.contains(event.target) &&
    !$("#activityMenuButton").contains(event.target)
  )
    setActivityMenu(false);
  const aside = document.querySelector(".admin-app aside");
  if (aside?.classList.contains("open") && !aside.contains(event.target) && !$("#menuButton").contains(event.target))
    aside.classList.remove("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModals();
    setActivityMenu(false);
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
