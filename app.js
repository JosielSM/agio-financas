const $ = (selector) => document.querySelector(selector);
const initialUser = JSON.parse(localStorage.getItem("credmais_user") || "null");
const initialCacheOwner = localStorage.getItem("credmais_cache_owner");
const ownsInitialCache = Boolean(
  initialUser?.id && initialCacheOwner === initialUser.id,
);
const state = {
  user: initialUser,
  clients: ownsInitialCache
    ? JSON.parse(localStorage.getItem("credmais_clients") || "[]")
    : [],
  loans: ownsInitialCache
    ? JSON.parse(localStorage.getItem("credmais_loans") || "[]")
    : [],
  history: ownsInitialCache
    ? JSON.parse(localStorage.getItem("credmais_history") || "[]")
    : [],
  platformAccess: null,
  accessPromptDismissed: false,
  paidView: "loans",
  billing: {
    configured: null,
    environment: "sandbox",
    selectedMonths: 1,
    plans: [1, 2, 3, 6],
  },
};
if (state.user?.id && !localStorage.getItem("credmais_cache_owner"))
  localStorage.setItem("credmais_cache_owner", state.user.id);
let pendingModalId = null;
const modalStack = [];
let expandedInstallment = null;
let selectedClientProfileId = null;
let clientProfileTab = "loans";
let returnToClientId = null;
let pendingDelete = null;
let toastTimer = null;
let autoRefreshTimer = null;
let accessRecoveryTimer = null;
let renderedMonthKey = null;
let refreshingFromCloud = false;
let deferredInstallPrompt = null;
let billingConfigPromise = null;
let billingReturnHandled = false;
const submissionLocks = new Set();
const STRONG_PASSWORD_MESSAGE =
  "Use ao menos 10 caracteres, com letra maiúscula, minúscula e número.";
const strongPassword = (password) =>
  password.length >= 10 &&
  /[a-z]/.test(password) &&
  /[A-Z]/.test(password) &&
  /\d/.test(password);
const money = (value) =>
  Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
const roundCurrency = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const pendingSyncStorageKey = (userId) =>
  `credmais_pending_sync:${String(userId || "")}`;
function pendingSyncPayload(userId, allowCurrentCache = true) {
  if (!userId) return null;
  try {
    const stored = JSON.parse(
      localStorage.getItem(pendingSyncStorageKey(userId)) || "null",
    );
    if (stored?.clients && stored?.loans && stored?.history) return stored;
  } catch (error) {
    console.warn("Fila local de sincronização inválida:", error.message);
  }
  if (
    allowCurrentCache &&
    localStorage.getItem("credmais_sync_pending") === userId &&
    localStorage.getItem("credmais_cache_owner") === userId
  )
    return {
      clients: structuredClone(state.clients),
      loans: structuredClone(state.loans),
      history: structuredClone(state.history),
    };
  return null;
}
function rememberPendingSync(userId, payload = null) {
  if (!userId) return;
  const data = payload || {
    clients: state.clients,
    loans: state.loans,
    history: state.history,
  };
  localStorage.setItem("credmais_sync_pending", userId);
  localStorage.setItem(pendingSyncStorageKey(userId), JSON.stringify(data));
}
function clearPendingSync(userId) {
  if (!userId) return;
  if (localStorage.getItem("credmais_sync_pending") === userId)
    localStorage.removeItem("credmais_sync_pending");
  localStorage.removeItem(pendingSyncStorageKey(userId));
}
function setCurrencyInput(input, value, showZero = true) {
  const amount = Math.max(0, Number(value) || 0);
  input.dataset.value = String(amount);
  input.value = amount || showZero ? money(amount) : "";
}
function readCurrencyInput(input) {
  return Number(input.dataset.value || 0);
}
function maskCurrencyInput(event) {
  const input = event.currentTarget,
    amount = Number(digits(input.value) || 0) / 100;
  setCurrencyInput(input, amount);
  input.setSelectionRange(input.value.length, input.value.length);
}
const digits = (value) => String(value || "").replace(/\D/g, "");
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const searchableText = (...values) =>
  values
    .flat()
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const initials = (name) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const save = async ({ allowReadOnly = false } = {}) => {
  if (
    !allowReadOnly &&
    state.platformAccess?.enabled &&
    !platformAccessAllowed(state.platformAccess)
  )
    throw new Error(
      "Sua conta está em modo de visualização. Solicite a liberação para salvar alterações.",
    );
  if (allowReadOnly && platformReadOnly()) return true;
  if (!window.credmaisBridge?.enabled) {
    persistWorkspaceCache();
    return true;
  }
  const liveAccess = await resolvePlatformAccess();
  if (liveAccess.offline) {
    showOfflineMode(liveAccess);
    throw new Error(
      "Não foi possível confirmar seu acesso agora. Nenhuma alteração foi salva; o sistema tentará novamente automaticamente.",
    );
  }
  state.platformAccess = liveAccess;
  renderTrialBanner(liveAccess);
  if (!platformAccessAllowed(liveAccess)) {
    applyPlatformRestrictions();
    throw new Error(
      "Sua assinatura não permite alterações. Nenhuma alteração foi salva.",
    );
  }
  try {
    await window.credmaisBridge.sync(
      state.user,
      state.clients,
      state.loans,
      state.history,
    );
    persistWorkspaceCache();
    clearPendingSync(state.user.id);
    return true;
  } catch (error) {
    rememberPendingSync(state.user.id);
    persistWorkspaceCache();
    console.error("Falha ao sincronizar Supabase:", error.message);
    return false;
  }
};
function persistWorkspaceCache() {
  localStorage.setItem("credmais_clients", JSON.stringify(state.clients));
  localStorage.setItem("credmais_loans", JSON.stringify(state.loans));
  localStorage.setItem("credmais_history", JSON.stringify(state.history));
  if (state.user?.id) localStorage.setItem("credmais_cache_owner", state.user.id);
}
function addHistory(category, title, description) {
  state.history.push({
    id: crypto.randomUUID(),
    category,
    title,
    description,
    createdAt: new Date().toISOString(),
  });
}
const bytesToBase64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function hashLocalPassword(password, saltBase64) {
  const salt = saltBase64
    ? Uint8Array.from(atob(saltBase64), (character) => character.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
    key,
    256,
  );
  return { salt: bytesToBase64(salt), passwordHash: bytesToBase64(hash) };
}
const formatCpf = (value) =>
  digits(value)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
function isValidCpf(value) {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const verificationDigit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1)
      sum += Number(cpf[index]) * (length + 1 - index);
    const digit = (sum * 10) % 11;
    return digit === 10 ? 0 : digit;
  };
  return (
    verificationDigit(9) === Number(cpf[9]) &&
    verificationDigit(10) === Number(cpf[10])
  );
}
function renderClientCpfValidation(force = false) {
  const input = $("#clientCpf"),
    help = $("#clientCpfHelp"),
    cpf = digits(input.value),
    invalid = Boolean(cpf) && (cpf.length === 11 ? !isValidCpf(cpf) : force);
  input.setAttribute("aria-invalid", String(invalid));
  help.classList.toggle("error", invalid);
  help.textContent = invalid
    ? "CPF inválido. Corrija os números ou deixe o campo em branco."
    : cpf && isValidCpf(cpf)
      ? "CPF válido."
      : "Se informar, o CPF será validado antes de salvar.";
  return !invalid;
}
const formatPhone = (value) => {
  const number = digits(value).slice(0, 11);
  return number.length <= 10
    ? number.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2")
    : number.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2");
};
const isBusinessDay = (date) => ![0, 6].includes(date.getDay());
function nextBusinessDayOrSame(date) {
  const result = new Date(date);
  while (!isBusinessDay(result)) result.setDate(result.getDate() + 1);
  return result;
}
function addBusinessDays(date, amount) {
  const result = new Date(date);
  let remaining = Math.max(0, Number(amount) || 0);
  if (remaining === 0) return nextBusinessDayOrSame(result);
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (isBusinessDay(result)) remaining -= 1;
  }
  return result;
}
function addScheduleIntervals(date, frequency, businessDays, amount = 1) {
  if (businessDays) return addBusinessDays(date, amount);
  const result = new Date(date);
  result.setDate(result.getDate() + Number(frequency || 30) * amount);
  return result;
}
const dateFor = (loan, installment) => {
  if (loan.customDates?.[installment]) {
    const customDate = new Date(`${loan.customDates[installment]}T12:00`);
    return loan.businessDays ? nextBusinessDayOrSame(customDate) : customDate;
  }
  const storedFirstDate = new Date(`${loan.dueDate}T12:00`),
    firstDate = loan.businessDays
      ? nextBusinessDayOrSame(storedFirstDate)
      : storedFirstDate;
  return addScheduleIntervals(
    firstDate,
    loan.frequency || 30,
    Boolean(loan.businessDays),
    installment,
  );
};
const dueStatus = (date) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  return due < today
    ? "Vencida"
    : due.getTime() === today.getTime()
      ? "Vence hoje"
      : "A vencer";
};
const formatFrequency = (days, businessDays = false) =>
  businessDays
    ? "Diário (segunda a sexta)"
    : ({ 1: "Diário", 7: "Semanal", 15: "Quinzenal", 30: "Mensal" })[
        Number(days)
      ] || `A cada ${days} dias`;
const standardFrequencies = new Set([1, 7, 15, 30, 45]);
const selectedBusinessDays = () => $("#loanFrequency").value === "business";
function selectedFrequencyDays() {
  const preset = $("#loanFrequency").value;
  if (preset === "business") return 1;
  if (preset !== "custom") return Number(preset);
  const custom = Number($("#loanCustomFrequency").value);
  return Number.isInteger(custom) && custom >= 1 && custom <= 365 ? custom : 0;
}
function syncCustomFrequencyField() {
  const custom = $("#loanFrequency").value === "custom",
    field = $("#loanCustomFrequencyField"),
    input = $("#loanCustomFrequency");
  field.hidden = !custom;
  input.disabled = !custom;
  input.required = custom;
  $("#businessDaysNotice").hidden = !selectedBusinessDays();
}
function setLoanFrequency(days, businessDays = false) {
  const frequency = Math.max(1, Number(days) || 30);
  if (businessDays) {
    $("#loanFrequency").value = "business";
    $("#loanCustomFrequency").value = "";
  } else if (standardFrequencies.has(frequency)) {
    $("#loanFrequency").value = String(frequency);
    $("#loanCustomFrequency").value = "";
  } else {
    $("#loanFrequency").value = "custom";
    $("#loanCustomFrequency").value = String(frequency);
  }
  syncCustomFrequencyField();
}
const dateInputValue = (date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
function dueRelativeLabel(date) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((date - today) / 86400000);
  if (days === 0) return "hoje";
  if (days === 1) return "amanhã";
  if (days > 1) return `daqui a ${days} dias`;
  return `há ${Math.abs(days)} dia${days === -1 ? "" : "s"}`;
}
function updateLoanDuePreview() {
  const value = $("#loanDueDate").value,
    firstLabel = $("#loanDuePrimary"),
    scheduleLabel = $("#loanDueSecondary"),
    frequency = selectedFrequencyDays(),
    businessDays = selectedBusinessDays();
  if (!frequency) {
    firstLabel.textContent = "Informe o intervalo personalizado em dias";
    scheduleLabel.textContent = "Depois disso, os vencimentos serão calculados automaticamente.";
    return;
  }
  if (!value) {
    firstLabel.textContent = "Escolha a data do primeiro vencimento";
    scheduleLabel.textContent = "As demais datas serão calculadas automaticamente.";
    return;
  }
  let first = new Date(`${value}T12:00`);
  if (businessDays && !isBusinessDay(first)) {
    first = nextBusinessDayOrSame(first);
    $("#loanDueDate").value = dateInputValue(first);
  }
  const installments = Math.max(1, Number($("#loanInstallments").value) || 1),
    next = addScheduleIntervals(first, frequency, businessDays, 1),
    last = addScheduleIntervals(
      first,
      frequency,
      businessDays,
      installments - 1,
    );
  firstLabel.textContent = `1º vencimento: ${first.toLocaleDateString("pt-BR")} (${dueRelativeLabel(first)})`;
  scheduleLabel.textContent =
    installments > 1
      ? `2º vencimento: ${next.toLocaleDateString("pt-BR")} · Último previsto: ${last.toLocaleDateString("pt-BR")}${businessDays ? " · sem finais de semana" : ""}`
      : "Este empréstimo possui um único pagamento.";
}
function suggestFirstDueDate() {
  const frequency = selectedFrequencyDays(),
    businessDays = selectedBusinessDays();
  if (!frequency) {
    $("#loanDueDate").value = "";
    updateLoanDuePreview();
    return;
  }
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  const suggested = addScheduleIntervals(date, frequency, businessDays, 1);
  $("#loanDueDate").value = dateInputValue(suggested);
  updateLoanDuePreview();
}
function interestModeFor(loan) {
  if (!loan) return "flat";
  if (["flat", "simple", "compound"].includes(loan.interestMode))
    return loan.interestMode;
  const amount = Number(loan.amount || 0),
    rate = Number(loan.rate || 0),
    installments = Math.max(1, Number(loan.installments || 1)),
    flatTotal = amount * (1 + rate),
    simpleTotal = amount * (1 + rate * installments),
    compoundTotal = amount * Math.pow(1 + rate, installments);
  return [
    ["flat", flatTotal],
    ["simple", simpleTotal],
    ["compound", compoundTotal],
  ].sort(
    (first, second) =>
      Math.abs(Number(loan.total) - first[1]) -
      Math.abs(Number(loan.total) - second[1]),
  )[0][0];
}
const interestDescription = (loan) => {
  const rate = (loan.rate * 100).toLocaleString("pt-BR"),
    mode = interestModeFor(loan);
  if (mode === "compound") return `juros compostos de ${rate}% por período`;
  if (mode === "simple") return `juros simples de ${rate}% por período`;
  return `taxa única de ${rate}% sobre o contrato`;
};
function setLoanInterestMode(mode = "flat") {
  const selected = ["flat", "simple", "compound"].includes(mode)
    ? mode
    : "flat";
  const field = $("#loanInterestMode");
  if (field) field.value = selected;
  document
    .querySelectorAll('[name="loanInterestModeChoice"]')
    .forEach((input) => {
      input.checked = input.value === selected;
    });
  const guidance = $("#interestModeGuidance");
  if (!guidance) return;
  guidance.innerHTML = {
    flat: "<b>Taxa única:</b> use quando a porcentagem representa o ganho total do contrato, como 30% no empréstimo diário inteiro.",
    simple:
      "<b>Juros simples:</b> a taxa vale para cada período, mas é sempre calculada sobre o valor originalmente emprestado.",
    compound:
      "<b>Juros compostos:</b> a taxa vale para cada período e passa a incidir sobre o valor já acrescido dos juros anteriores.",
  }[selected];
}
const paymentStateFor = (loan, index) => {
  const payment = loan.paymentStates?.[index];
  return typeof payment === "object" ? payment.status : payment;
};
const scheduledInstallmentFor = (loan, index) => {
  const installments = Math.max(1, Number(loan.installments) || 1),
    total = roundCurrency(loan.total),
    regular = roundCurrency(
      Number(loan.installment) || total / installments,
    );
  return index === installments - 1
    ? roundCurrency(total - regular * (installments - 1))
    : regular;
};
const scheduledPrincipalFor = (loan, index) => {
  const installments = Math.max(1, Number(loan.installments) || 1),
    amount = roundCurrency(loan.amount),
    regular = roundCurrency(amount / installments);
  return index === installments - 1
    ? roundCurrency(amount - regular * (installments - 1))
    : regular;
};
function principalPositionFor(loan, index) {
  let carry = 0;
  for (let current = 0; current <= index; current += 1) {
    const due = roundCurrency(scheduledPrincipalFor(loan, current) + carry),
      payment = loan.paymentStates?.[current],
      paymentStatus = paymentStateFor(loan, current);
    let paid = 0,
      remaining = due;
    if (paymentStatus === "paid") {
      paid = Math.min(
        due,
        Math.max(
          0,
          Number(
            typeof payment === "object" && payment.principalPaid != null
              ? payment.principalPaid
              : due,
          ),
        ),
      );
      remaining = Math.max(0, due - paid);
    } else if (
      (paymentStatus === "partial" || paymentStatus === "interest") &&
      typeof payment === "object"
    ) {
      if (payment.principalPaid != null) {
        paid = Math.min(due, Math.max(0, Number(payment.principalPaid)));
      } else if (paymentStatus === "partial") {
        const partialReceived = Array.isArray(payment.receipts)
            ? payment.receipts
                .filter((receipt) => receipt.type === "partial")
                .reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0)
            : Number(payment.paidAmount || 0),
          referenceDue = Math.max(
            Number(payment.originalDue || payment.currentDue || 0),
            partialReceived,
          );
        paid = referenceDue
          ? Math.min(due, roundCurrency(due * (partialReceived / referenceDue)))
          : 0;
      }
      remaining = Math.max(
        0,
        Math.min(
          due - paid,
          Number(
            payment.principalRemaining != null
              ? payment.principalRemaining
              : due - paid,
          ),
        ),
      );
    }
    const position = {
      due,
      paid: roundCurrency(paid),
      remaining: roundCurrency(remaining),
    };
    if (current === index) return position;
    carry =
      paymentStatus === "partial" || paymentStatus === "interest"
        ? position.remaining
        : 0;
  }
  return { due: 0, paid: 0, remaining: 0 };
}
const installmentStatus = (loan, index, date) =>
  paymentStateFor(loan, index) === "paid"
    ? "Quitada"
    : paymentStateFor(loan, index) === "interest"
      ? "Só juros"
      : paymentStateFor(loan, index) === "partial"
        ? "Pagamento parcial"
      : paymentStateFor(loan, index) === "missed"
        ? "Não pagou"
        : dueStatus(date);
const installmentStatusClass = (status) =>
  ({
    Quitada: "status-paid",
    "A vencer": "status-upcoming",
    "Vence hoje": "status-today",
    Vencida: "status-overdue",
    "Não pagou": "status-overdue",
    "Só juros": "status-interest",
    "Pagamento parcial": "status-partial",
  })[status] || "status-upcoming";
const lateCharge = (loan, date) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  let days = 0;
  if (loan.businessDays) {
    const cursor = new Date(due);
    while (cursor < today) {
      cursor.setDate(cursor.getDate() + 1);
      if (isBusinessDay(cursor)) days += 1;
    }
  } else {
    days = Math.max(0, Math.floor((today - due) / 86400000));
  }
  return { days, value: days * Number(loan.lateFee || 0) };
};
function toast(message, undoAction = null) {
  const element = $("#toast");
  clearTimeout(toastTimer);
  element.classList.toggle("has-undo", Boolean(undoAction));
  element.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  element.append(text);
  if (undoAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Desfazer";
    button.onclick = async () => {
      button.disabled = true;
      try {
        await undoAction();
        addHistory("undo", "Ação desfeita", message);
        await save();
        renderHistory();
        toast("Ação desfeita com sucesso.");
      } catch (error) {
        toast(error.message || "Não foi possível desfazer a ação.");
      }
    };
    element.append(button);
  }
  element.classList.add("show");
  toastTimer = setTimeout(
    () => element.classList.remove("show"),
    undoAction ? 8000 : 3200,
  );
}
const stateSnapshot = () => ({
  clients: structuredClone(state.clients),
  loans: structuredClone(state.loans),
  history: structuredClone(state.history),
});
async function restoreSnapshot(snapshot, page = null, loanId = null) {
  if (!requirePlatformAccess("desfazer esta alteração"))
    throw new Error("Liberação necessária para desfazer esta alteração.");
  state.clients = structuredClone(snapshot.clients);
  state.loans = structuredClone(snapshot.loans);
  state.history = structuredClone(snapshot.history);
  const synced = await save();
  render();
  if (page) setPage(page);
  if (loanId && state.loans.some((loan) => loan.id === loanId)) details(loanId);
  if (!synced)
    throw new Error("A ação foi revertida neste dispositivo, mas falta sincronizar.");
}
function setFeedback(id, message = "", type = "") {
  const element = $(`#${id}`);
  element.textContent = message;
  element.className = `form-feedback ${type}`;
}
function setFormLoading(form, loading) {
  const button = form?.querySelector('button[type="submit"]');
  if (!button) return;
  button.classList.toggle("is-loading", loading);
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
}
function beginSubmission(form, key) {
  if (submissionLocks.has(key)) {
    toast("Aguarde: este cadastro já está sendo salvo.");
    return false;
  }
  submissionLocks.add(key);
  setFormLoading(form, true);
  return true;
}
function endSubmission(form, key) {
  submissionLocks.delete(key);
  setFormLoading(form, false);
}
function openPix() {
  if (!requirePlatformAccess("configurar os dados de cobrança")) return;
  $("#pixRecipientName").value =
    state.user?.pixRecipientName || state.user?.name || "";
  $("#pixKey").value = state.user?.pixKey || "";
  $("#pixType").value = state.user?.pixType || "Chave aleatória";
  openModal("pixModal");
}
const accountProviders = () =>
  Array.isArray(state.user?.providers)
    ? state.user.providers
    : state.user?.provider === "local" || !window.credmaisBridge?.enabled
      ? ["password"]
      : [];
const hasAccountProvider = (...providers) =>
  accountProviders().some((provider) => providers.includes(provider));
function formatAccountDate(value) {
  if (!value) return "Não disponível";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Não disponível"
    : date.toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      });
}
function openProfile() {
  const user = state.user || {},
    googleConnected = hasAccountProvider("google.com", "google"),
    passwordConnected = hasAccountProvider("password", "email"),
    usesFirebase =
      window.credmaisBridge?.enabled &&
      window.credmaisBridge.authProvider === "firebase",
    emailVerified = Boolean(user.emailVerified || googleConnected),
    avatar = $("#profileAvatarLarge"),
    photo = $("#profilePhoto"),
    googleButton = $("#profileGoogleButton"),
    googleStatus = $("#profileGoogleStatus"),
    passwordButton = $("#profilePasswordButton"),
    resetButton = $("#profileResetPasswordButton");
  $("#profileName").textContent = user.name || "Usuário";
  $("#profileEmail").textContent = user.email || "E-mail não informado";
  $("#profileInitials").textContent = initials(user.name || "Usuário");
  $("#profileEmailStatus").textContent = emailVerified
    ? "E-mail verificado"
    : "Verificação pendente";
  $("#profileEmailStatus").classList.toggle("connected", emailVerified);
  googleStatus.classList.toggle("connected", googleConnected);
  $("#profileGoogleDescription").textContent = googleConnected
    ? "Você pode entrar no CredMais usando sua conta Google."
    : usesFirebase
      ? "Vincule para entrar com o Google sem digitar sua senha."
      : "Disponível somente para contas autenticadas pelo Firebase.";
  googleButton.disabled = googleConnected || !usesFirebase;
  googleButton.classList.toggle("connected", googleConnected);
  googleStatus.textContent = googleConnected
    ? "Conectado ✓"
    : usesFirebase
      ? "Vincular"
      : "Indisponível";
  $("#profilePasswordStatus").textContent = passwordConnected
    ? "Configurada"
    : "Não configurada";
  $("#profilePasswordStatus").classList.toggle(
    "connected",
    passwordConnected,
  );
  $("#profilePasswordDescription").textContent = passwordConnected
    ? "Você pode entrar com e-mail e senha."
    : "Sem senha de acesso configurada.";
  $("#profilePasswordAction").textContent = passwordConnected
    ? "Alterar →"
    : usesFirebase ? "Configurar →" : "Indisponível";
  passwordButton.disabled = !passwordConnected && (!usesFirebase || !user.email);
  passwordButton.setAttribute(
    "aria-label",
    passwordConnected ? "Alterar senha do CredMais" : "Configurar senha do CredMais por e-mail",
  );
  $("#profileSecurityDescription").textContent = passwordConnected
    ? "Altere sua senha com segurança"
    : "Configure uma senha pelo link enviado ao e-mail";
  $("#profileSecurityAction").textContent = passwordConnected ? "Abrir →" : "Configurar →";
  resetButton.disabled = !usesFirebase || !user.email;
  resetButton.hidden = !passwordConnected;
  $("#profileLastAccess").textContent = formatAccountDate(user.lastSignInAt);
  if (user.photoURL) {
    photo.src = user.photoURL;
    photo.alt = `Foto de ${user.name || "usuário"}`;
    photo.hidden = false;
    avatar.classList.add("has-photo");
  } else {
    photo.removeAttribute("src");
    photo.hidden = true;
    avatar.classList.remove("has-photo");
  }
  $("#profileDangerZone").hidden = true;
  $("#profileDangerToggle").setAttribute("aria-expanded", "false");
  $("#profileDangerToggle em").textContent = "Mostrar";
  $(".sidebar").classList.remove("open");
  openModal("profileModal");
}
async function linkProfileGoogle() {
  const button = $("#profileGoogleButton");
  if (button.disabled || submissionLocks.has("profile-google")) return;
  submissionLocks.add("profile-google");
  button.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  toast("Abrindo o Google para vincular sua conta...");
  try {
    const linkedUser = await window.credmaisBridge.linkGoogle();
    state.user = {
      ...state.user,
      ...linkedUser,
      pixKey: linkedUser.pixKey || state.user.pixKey || "",
      pixType: linkedUser.pixType || state.user.pixType || "Chave aleatória",
      pixRecipientName:
        linkedUser.pixRecipientName || state.user.pixRecipientName || "",
    };
    localStorage.setItem("credmais_user", JSON.stringify(state.user));
    addHistory(
      "settings",
      "Conta Google vinculada",
      `A conta Google ${state.user.email} foi vinculada ao perfil.`,
    );
    await save({ allowReadOnly: true });
    openProfile();
    toast("Conta Google vinculada com sucesso.");
  } catch (error) {
    toast(error.message || "Não foi possível vincular a conta Google.");
  } finally {
    submissionLocks.delete("profile-google");
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    if (!hasAccountProvider("google.com", "google")) button.disabled = false;
  }
}
async function sendProfilePasswordReset(button = $("#profileResetPasswordButton")) {
  if (button.disabled || submissionLocks.has("profile-password-reset")) return;
  submissionLocks.add("profile-password-reset");
  button.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  toast("Enviando o e-mail de recuperação...");
  try {
    await window.credmaisBridge.sendPasswordReset(state.user.email);
    addHistory(
      "settings",
      "Recuperação de senha solicitada",
      `Foi solicitado um link de recuperação para ${state.user.email}.`,
    );
    await save({ allowReadOnly: true });
    toast("Se o e-mail puder receber um link de senha, confira a caixa de entrada e a pasta Spam.");
  } catch (error) {
    toast(error.message || "Não foi possível enviar o e-mail de recuperação.");
  } finally {
    submissionLocks.delete("profile-password-reset");
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
}
function toggleProfileDanger() {
  const zone = $("#profileDangerZone"),
    button = $("#profileDangerToggle"),
    willOpen = zone.hidden;
  zone.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
  button.querySelector("em").textContent = willOpen ? "Ocultar" : "Mostrar";
  if (willOpen)
    requestAnimationFrame(() =>
      zone.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
}
function openDeleteAccount() {
  const usesFirebase =
    window.credmaisBridge?.enabled &&
    window.credmaisBridge.authProvider === "firebase";
  if (!usesFirebase)
    return toast(
      "Conecte-se à internet e entre novamente antes de apagar sua conta.",
    );
  const googleConnected = hasAccountProvider("google.com", "google"),
    form = $("#deleteAccountForm"),
    passwordField = $("#deleteAccountPasswordField"),
    passwordInput = $("#deleteAccountPassword");
  form.reset();
  setFeedback("deleteAccountFeedback");
  $("#deleteAccountEmail").textContent =
    state.user?.email || "E-mail não informado";
  passwordField.hidden = googleConnected;
  passwordInput.required = !googleConnected;
  $("#deleteGoogleConfirmation").hidden = !googleConnected;
  openModal("deleteAccountModal");
}
function clearDeletedAccountData(userId) {
  stopAccessRecovery();
  clearPendingSync(userId);
  localStorage.removeItem(platformAccessStorageKey(userId));
  [
    "credmais_user",
    "credmais_account",
    "credmais_clients",
    "credmais_loans",
    "credmais_history",
    "credmais_cache_owner",
  ].forEach((key) => localStorage.removeItem(key));
  state.user = null;
  state.clients = [];
  state.loans = [];
  state.history = [];
}
function clearSignedOutData() {
  stopAccessRecovery();
  const userId = state.user?.id;
  if (userId) {
    clearPendingSync(userId);
    localStorage.removeItem(platformAccessStorageKey(userId));
  }
  [
    "credmais_user",
    "credmais_clients",
    "credmais_loans",
    "credmais_history",
    "credmais_cache_owner",
    "credmais_sync_pending",
  ].forEach((key) => localStorage.removeItem(key));
  state.user = null;
  state.clients = [];
  state.loans = [];
  state.history = [];
}
async function signOutCurrentUser() {
  if (submissionLocks.has("sign-out")) return;
  submissionLocks.add("sign-out");
  toast("Saindo da sua conta...");
  try {
    if (window.credmaisBridge?.enabled) await window.credmaisBridge.signOut();
    clearSignedOutData();
    location.reload();
  } catch (error) {
    submissionLocks.delete("sign-out");
    toast(error.message || "Não foi possível sair da conta. Tente novamente.");
  }
}
async function deleteAccountAndData(event) {
  event.preventDefault();
  const form = event.currentTarget,
    confirmation = $("#deleteAccountConfirmation").value.trim().toUpperCase(),
    acknowledged = $("#deleteAccountAcknowledgement").checked,
    passwordField = $("#deleteAccountPasswordField"),
    password = $("#deleteAccountPassword").value;
  if (confirmation !== "APAGAR")
    return setFeedback(
      "deleteAccountFeedback",
      "Digite APAGAR exatamente como mostrado para confirmar.",
      "error",
    );
  if (!acknowledged)
    return setFeedback(
      "deleteAccountFeedback",
      "Marque a confirmação de que você entende a exclusão permanente.",
      "error",
    );
  if (!passwordField.hidden && password.length < 6)
    return setFeedback(
      "deleteAccountFeedback",
      "Informe sua senha atual para confirmar sua identidade.",
      "error",
    );
  if (!beginSubmission(form, "delete-account")) return;
  setFeedback(
    "deleteAccountFeedback",
    "Confirmando sua identidade e apagando os dados...",
  );
  try {
    const userId = state.user.id;
    await window.credmaisBridge.deleteAccount(password);
    clearDeletedAccountData(userId);
    closeModals();
    location.replace(`${location.pathname}?conta=apagada`);
  } catch (error) {
    setFeedback(
      "deleteAccountFeedback",
      error.message || "Não foi possível apagar a conta.",
      "error",
    );
  } finally {
    endSubmission(form, "delete-account");
  }
}
function openSecurity() {
  if (!hasAccountProvider("password", "email")) {
    sendProfilePasswordReset($("#profilePasswordButton"));
    return;
  }
  $("#passwordChangeForm").reset();
  setFeedback("passwordChangeFeedback");
  $(".sidebar").classList.remove("open");
  openModal("securityModal");
}
function openProfilePasswordSettings() {
  if (!hasAccountProvider("password", "email")) {
    sendProfilePasswordReset($("#profilePasswordButton"));
    return;
  }
  openSecurity();
}
async function changePassword(event) {
  event.preventDefault();
  if (!hasAccountProvider("password", "email"))
    return setFeedback("passwordChangeFeedback", "Configure a senha pelo link enviado ao seu e-mail.", "error");
  const form = event.currentTarget,
    newPassword = $("#newPassword").value,
    confirmation = $("#confirmNewPassword").value;
  if (!strongPassword(newPassword))
    return setFeedback(
      "passwordChangeFeedback",
      STRONG_PASSWORD_MESSAGE,
      "error",
    );
  if (newPassword !== confirmation)
    return setFeedback(
      "passwordChangeFeedback",
      "A confirmação não corresponde à nova senha.",
      "error",
    );
  setFeedback("passwordChangeFeedback");
  setFormLoading(form, true);
  try {
    if (window.credmaisBridge?.enabled) {
      await window.credmaisBridge.changePassword(newPassword);
      state.user = {
        ...state.user,
        providers: Array.from(
          new Set([...(state.user.providers || []), "password"]),
        ),
      };
      localStorage.setItem("credmais_user", JSON.stringify(state.user));
    } else {
      const account = JSON.parse(
        localStorage.getItem("credmais_account") || "null",
      );
      if (!account) throw new Error("Conta local não encontrada.");
      const credentials = await hashLocalPassword(newPassword);
      localStorage.setItem(
        "credmais_account",
        JSON.stringify({
          name: account.name,
          email: account.email,
          ...credentials,
        }),
      );
    }
    addHistory(
      "settings",
      "Senha alterada",
      "A senha de acesso da conta foi atualizada.",
    );
    await save({ allowReadOnly: true });
    closeModals();
    form.reset();
    toast("Senha alterada com sucesso.");
  } catch (error) {
    setFeedback(
      "passwordChangeFeedback",
      error.message || "Não foi possível alterar a senha.",
      "error",
    );
  } finally {
    setFormLoading(form, false);
  }
}
async function savePix(event) {
  event.preventDefault();
  if (!requirePlatformAccess("salvar os dados de cobrança")) return;
  const form = event.currentTarget,
    previousUser = { ...state.user },
    pixRecipientName = $("#pixRecipientName").value.trim(),
    pixKey = $("#pixKey").value.trim(),
    pixType = $("#pixType").value;
  if (!pixRecipientName) return toast("Informe o nome de quem vai receber.");
  if (!pixKey) return toast("Informe sua chave PIX.");
  setFormLoading(form, true);
  try {
    if (window.credmaisBridge?.enabled)
      state.user = await window.credmaisBridge.updatePix(
        pixKey,
        pixType,
        pixRecipientName,
      );
    else state.user = { ...state.user, pixKey, pixType, pixRecipientName };
    localStorage.setItem("credmais_user", JSON.stringify(state.user));
    addHistory(
      "settings",
      "Dados de cobrança atualizados",
      `Nome exibido nas mensagens: ${pixRecipientName}.`,
    );
    await save();
    closeModals();
    toast("Nome e dados PIX atualizados nas mensagens.", async () => {
      if (window.credmaisBridge?.enabled)
        state.user = await window.credmaisBridge.updatePix(
          previousUser.pixKey || "",
          previousUser.pixType || "Chave aleatória",
          previousUser.pixRecipientName || previousUser.name || "",
        );
      else state.user = previousUser;
      localStorage.setItem("credmais_user", JSON.stringify(state.user));
    });
  } catch (error) {
    toast(error.message || "Não foi possível salvar os dados PIX.");
  } finally {
    setFormLoading(form, false);
  }
}
function validateRegistration() {
  const password = $("#registerPassword").value,
    confirm = $("#registerPasswordConfirm").value;
  const enough = strongPassword(password),
    matches = Boolean(confirm) && password === confirm;
  $("#passwordRule").classList.toggle("valid", enough);
  $("#passwordRule").textContent =
    `${enough ? "✓" : "○"} 10 caracteres, maiúscula, minúscula e número`;
  $("#passwordMatch").classList.toggle("valid", matches);
  $("#passwordMatch").textContent =
    `${matches ? "✓" : "○"} As senhas precisam ser iguais`;
  return enough && matches;
}
function setAuth(view) {
  ["login", "register", "forgot", "verification"].forEach((name) => {
    $(`#${name}Form`).hidden = view !== name;
  });
  if (view === "forgot")
    $("#forgotEmail").value = $("#loginEmail").value.trim();
}
const platformAccessStorageKey = (userId) =>
  `credmais_platform_access:${String(userId || "")}`;
function cachedPlatformAccess(userId = state.user?.id) {
  if (!userId) return null;
  try {
    return JSON.parse(
      localStorage.getItem(platformAccessStorageKey(userId)) || "null",
    );
  } catch (error) {
    console.warn("Situação de acesso salva inválida:", error.message);
    try {
      localStorage.removeItem(platformAccessStorageKey(userId));
    } catch (storageError) {
      console.warn("Não foi possível limpar o cache de acesso:", storageError.message);
    }
    return null;
  }
}
function rememberVerifiedPlatformAccess(access) {
  const verified = {
    ...access,
    offline: false,
    connectionState: "online",
    verifiedAt: new Date().toISOString(),
  };
  if (state.user?.id)
    try {
      localStorage.setItem(
        platformAccessStorageKey(state.user.id),
        JSON.stringify(verified),
      );
    } catch (error) {
      console.warn("Não foi possível atualizar o cache de acesso:", error.message);
    }
  return verified;
}
function offlinePlatformAccess(error = null, connectionState = "unavailable") {
  const cached = cachedPlatformAccess();
  return {
    ...(cached || {
      enabled: true,
      status: "unknown",
      monthlyFee: 0,
      defaultMonthlyFee: 0,
    }),
    enabled: true,
    offline: true,
    connectionState,
    connectionMessage: error?.message || "",
  };
}
function platformAccessAllowed(access) {
  if (access?.offline) return false;
  if (!access?.enabled || access.status === "admin") return true;
  if (access.status !== "active") return false;
  if (!access.paidUntil) return true;
  const paidUntil = new Date(`${access.paidUntil}T23:59:59`);
  return !Number.isNaN(paidUntil.getTime()) && paidUntil >= new Date();
}
function whatsappDestination(value) {
  const number = digits(value);
  if (number.length === 10 || number.length === 11) return `55${number}`;
  if (number.startsWith("55") && (number.length === 12 || number.length === 13))
    return number;
  return "";
}
function platformSupportNumber(access = state.platformAccess) {
  return whatsappDestination(access?.supportPhone || "");
}
function renderPlatformSupport(access = state.platformAccess) {
  const available = Boolean(platformSupportNumber(access));
  document.querySelectorAll("[data-platform-support]").forEach((button) => {
    button.classList.toggle("is-unavailable", !available);
    button.setAttribute("aria-disabled", String(!available));
    button.title = available
      ? "Falar com o suporte pelo WhatsApp"
      : "WhatsApp de suporte aguardando configuração";
  });
}
function openPlatformSupport() {
  const phone = platformSupportNumber();
  if (!phone)
    return toast("O WhatsApp de suporte ainda não foi configurado.");
  $(".sidebar").classList.remove("open");
  window.open(`https://wa.me/${phone}`, "_blank", "noopener");
}
const PLATFORM_MUTATION_SELECTOR = [
  ".add-loan",
  "#addClientBtn",
  "#pixBtn",
  "#monthlyReportBtn",
  "[data-open-client]",
  "[data-edit-client]",
  "[data-delete-client]",
  "[data-edit-loan]",
  "[data-payment]",
  "[data-postpone]",
  "[data-partial]",
  "[data-toggle-blacklist]",
  "[data-archive-loan]",
  "[data-delete-loan]",
  "[data-whatsapp]",
  "[data-contract-whatsapp]",
].join(",");
const PLATFORM_MUTATION_FORM_SELECTOR = [
  "#clientForm",
  "#loanForm",
  "#postponeForm",
  "#partialForm",
  "#monthlyReportForm",
  "#pixForm",
].join(",");
function platformOfflineReadOnly(access = state.platformAccess) {
  return Boolean(access?.enabled && access?.offline);
}
function platformPaymentLocked(access = state.platformAccess) {
  return Boolean(
    access?.enabled && !access?.offline && !platformAccessAllowed(access),
  );
}
function platformReadOnly() {
  return platformOfflineReadOnly() || platformPaymentLocked();
}
function activeFreeTrial(access = state.platformAccess) {
  return Boolean(
    access?.accessType === "free" &&
      access?.status === "active" &&
      platformAccessAllowed(access),
  );
}
function accessContent(access) {
  const status = access?.status || "pending";
  if (status === "active" && access?.accessType === "free") {
    return {
      status: "active",
      content: {
        badge: "TESTE GRATUITO ATIVO",
        icon: "🎁",
        title: "Aproveite seus 15 dias gratuitos",
        message:
          "Todas as funções estão disponíveis. Você pode assinar agora e o período pago começará depois do fim do teste.",
      },
    };
  }
  if (status === "active") {
    return {
      status,
      content: {
        badge: "ACESSO ATIVO",
        icon: "✓",
        title: "Seu CredMais está liberado",
        message:
          "Você pode escolher um novo período de acesso. Confira o valor e a duração antes de pagar.",
      },
    };
  }
  if (status === "expired" && access?.accessType === "free") {
    return {
      status,
      content: {
        badge: "TESTE GRATUITO ENCERRADO",
        icon: "◷",
        title: "Seus 15 dias gratuitos terminaram",
        message:
          "Seus dados continuam protegidos e disponíveis para consulta. Escolha um plano para voltar a cadastrar e alterar informações.",
      },
    };
  }
  return {
    status,
    content:
      {
        pending: {
          badge: "AGUARDANDO LIBERAÇÃO",
          icon: "◷",
          title: "Sua solicitação está pendente",
          message:
            "Você pode conhecer toda a plataforma. Para cadastrar, cobrar ou alterar dados, aguarde a liberação do administrador.",
        },
        expired: {
          badge: "BLOQUEADO POR PAGAMENTO VENCIDO",
          icon: "!",
          title: "Seu acesso foi bloqueado automaticamente",
          message:
            "A mensalidade venceu. Seus dados continuam visíveis, mas nenhuma alteração é permitida até a renovação do acesso.",
        },
        blocked: {
          badge: "AÇÕES BLOQUEADAS",
          icon: "×",
          title: "Esta conta está em modo de visualização",
          message:
            "Você pode navegar pelo CredMais, mas precisa regularizar o acesso antes de realizar qualquer operação.",
        },
      }[status] || {
        badge: "LIBERAÇÃO NECESSÁRIA",
        icon: "◷",
        title: "Conheça o CredMais",
        message:
          "Navegue normalmente pela plataforma e solicite a liberação quando quiser começar a usar as funcionalidades.",
      },
  };
}
function applyPlatformRestrictions() {
  const offline = platformOfflineReadOnly(),
    paymentLocked = platformPaymentLocked(),
    locked = offline || paymentLocked,
    banner = $("#subscriptionBanner"),
    offlineBanner = $("#offlineBanner");
  document.body.classList.toggle("platform-read-only", locked);
  document.body.classList.toggle("platform-offline", offline);
  if (banner) banner.hidden = !paymentLocked;
  if (offlineBanner) offlineBanner.hidden = !offline;
  document.querySelectorAll(PLATFORM_MUTATION_SELECTOR).forEach((control) => {
    control.classList.toggle("requires-subscription", locked);
    if (locked) {
      control.setAttribute("aria-disabled", "true");
      if (!control.hasAttribute("data-subscription-title"))
        control.dataset.subscriptionTitle = control.getAttribute("title") || "";
      control.setAttribute(
        "title",
        offline
          ? "Aguarde a verificação do acesso para usar esta função"
          : "Liberação necessária para usar esta função",
      );
    } else {
      control.removeAttribute("aria-disabled");
      if (control.hasAttribute("data-subscription-title")) {
        if (control.dataset.subscriptionTitle)
          control.setAttribute("title", control.dataset.subscriptionTitle);
        else control.removeAttribute("title");
        control.removeAttribute("data-subscription-title");
      }
    }
  });
}
function requirePlatformAccess(action = "usar esta função") {
  if (!platformReadOnly()) return true;
  if (platformOfflineReadOnly()) {
    showOfflineMode(state.platformAccess);
    toast(`Aguarde a verificação automática da conexão para ${action}.`);
    return false;
  }
  showAccessGate(state.platformAccess, { openPrompt: true });
  toast(`Liberação necessária para ${action}.`);
  return false;
}
async function probeAppReachability() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`/api/health?connectivity=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch (error) {
    console.warn("Verificação de conexão com o CredMais indisponível:", error.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
async function resolvePlatformAccess() {
  if (!window.credmaisBridge?.platformAccess || !state.user?.id)
    return { enabled: false, status: "active" };
  try {
    return rememberVerifiedPlatformAccess(
      await window.credmaisBridge.platformAccess(state.user),
    );
  } catch (error) {
    const appReachable = await probeAppReachability();
    return offlinePlatformAccess(error, appReachable ? "unavailable" : "offline");
  }
}
function startAccessRecovery() {
  if (accessRecoveryTimer || !state.user?.id || !window.credmaisBridge?.enabled)
    return;
  accessRecoveryTimer = setInterval(() => {
    if (!document.hidden)
      void refreshFromCloud({ allowWhileModalOpen: true });
  }, 2000);
}
function stopAccessRecovery() {
  if (!accessRecoveryTimer) return;
  clearInterval(accessRecoveryTimer);
  accessRecoveryTimer = null;
}
function showOfflineMode(access = offlinePlatformAccess()) {
  state.platformAccess = { ...access, enabled: true, offline: true };
  startAccessRecovery();
  renderPlatformSupport(state.platformAccess);
  $("#authView").hidden = true;
  $("#appView").hidden = false;
  $("#accessView").hidden = true;
  $("#subscriptionBanner").hidden = true;
  $("#trialBanner").hidden = true;
  const title = $("#offlineBannerTitle");
  const message = $("#offlineBannerMessage");
  if (title)
    title.textContent =
      state.platformAccess.connectionState === "offline"
        ? "Sem conexão com o CredMais"
        : "Verificação de acesso indisponível";
  if (message)
    message.textContent =
      state.platformAccess.connectionState === "offline"
        ? "Não foi possível alcançar o CredMais. Seus dados salvos continuam disponíveis para consulta; verificaremos a conexão automaticamente."
        : "Seu aparelho pode estar conectado, mas não foi possível confirmar o acesso no momento. Seus dados continuam disponíveis para consulta e tentaremos novamente automaticamente.";
  applyPlatformRestrictions();
}
function showAccessGate(access, { openPrompt = true } = {}) {
  if (access?.offline) {
    showOfflineMode(access);
    return;
  }
  const wasOpen = !$("#accessView").hidden;
  stopAccessRecovery();
  state.platformAccess = access;
  renderPlatformSupport(access);
  $("#authView").hidden = true;
  $("#appView").hidden = false;
  const offlineBanner = $("#offlineBanner");
  if (offlineBanner) offlineBanner.hidden = true;
  $("#accessView").hidden = !openPrompt;
  const { status, content } = accessContent(access);
  const statusBadge = $("#accessStatus");
  statusBadge.textContent = content.badge;
  statusBadge.className = `access-status ${status}`;
  $("#accessIcon").textContent = content.icon;
  $("#accessTitle").textContent = content.title;
  $("#accessMessage").textContent = content.message;
  $("#accessPriceLabel").textContent =
    access?.accessType === "free" ? "Preço depois do teste" : "Mensalidade informada";
  $("#accessMonthlyFee").textContent = money(
    access?.monthlyFee ?? access?.defaultMonthlyFee ?? 0,
  );
  $("#accessPaidUntil").textContent = access?.paidUntil
    ? `${access?.accessType === "free" ? "Teste gratuito" : "Último período liberado"} até ${new Date(`${access.paidUntil}T12:00`).toLocaleDateString("pt-BR")}.`
    : "A liberação será válida pelo período contratado.";
  renderBillingPanel();
  void loadBillingConfig();
  $("#subscriptionBannerTitle").textContent = content.title;
  $("#subscriptionBannerMessage").textContent = content.message;
  $("#subscriptionBannerFee").textContent = money(
    access?.monthlyFee ?? access?.defaultMonthlyFee ?? 0,
  );
  $("#subscriptionRequestButton").textContent = "Ver planos";
  applyPlatformRestrictions();
  if (openPrompt && !wasOpen)
    requestAnimationFrame(() => $("#accessDismiss").focus());
}
function renderTrialBanner(access = state.platformAccess) {
  const banner = $("#trialBanner");
  if (!banner) return;
  const active = activeFreeTrial(access);
  banner.hidden = !active;
  if (!active) return;
  const endDate = access?.paidUntil
      ? new Date(`${access.paidUntil}T12:00`).toLocaleDateString("pt-BR")
      : "data não informada",
    launchProtected = access?.monthlyFeeSource === "launch_locked";
  $("#trialBannerMessage").textContent =
    `Acesso completo até ${endDate}.${launchProtected ? " Seu preço de lançamento está protegido." : ""}`;
  $("#trialBannerFee").textContent = `${money(billingMonthlyFee())}/mês`;
}
function billingMonthlyFee() {
  return Number(
    state.platformAccess?.monthlyFee ??
      state.platformAccess?.defaultMonthlyFee ??
      0,
  );
}
function renderBillingPanel() {
  const panel = $("#automaticPayment");
  if (!panel) return;
  const fee = billingMonthlyFee(),
    selectedMonths = state.billing.selectedMonths,
    total = fee * selectedMonths;
  document.querySelectorAll("[data-payment-months]").forEach((button) => {
    const months = Number(button.dataset.paymentMonths),
      active = months === selectedMonths;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    const price = $(`#paymentPlan${months}Price`);
    if (price) price.textContent = money(fee * months);
  });
  $("#automaticPaymentTotal").textContent = money(total);
  $("#automaticPaymentPeriod").textContent =
    `${selectedMonths} ${selectedMonths === 1 ? "mês" : "meses"} de acesso`;
  $("#automaticPaymentButtonLabel").textContent = `Pagar ${money(total)} agora`;
  panel.classList.toggle("is-sandbox", state.billing.environment === "sandbox");
}
async function loadBillingConfig({ force = false } = {}) {
  if (billingConfigPromise) return billingConfigPromise;
  if (!force && state.billing.configured !== null) {
    return {
      enabled: state.billing.configured,
      environment: state.billing.environment,
      plans: state.billing.plans,
    };
  }
  if (!window.credmaisBridge?.billingConfig) {
    state.billing.configured = false;
    renderBillingPanel();
    return null;
  }
  billingConfigPromise = window.credmaisBridge
    .billingConfig()
    .then((config) => {
      state.billing.configured = Boolean(config.enabled);
      state.billing.environment = config.environment || "sandbox";
      state.billing.plans = Array.isArray(config.plans)
        ? config.plans
        : state.billing.plans;
      renderBillingPanel();
      if (!config.enabled) {
        setFeedback(
          "automaticPaymentFeedback",
          "Pagamento pelo Mercado Pago temporariamente indisponível. Tente novamente em alguns instantes.",
          "error",
        );
      } else if (config.environment === "sandbox") {
        setFeedback(
          "automaticPaymentFeedback",
          "Ambiente de testes ativo: nenhum pagamento real será cobrado.",
        );
      }
      return config;
    })
    .catch((error) => {
      state.billing.configured = false;
      renderBillingPanel();
      setFeedback(
        "automaticPaymentFeedback",
        error.message || "Pagamento pelo Mercado Pago indisponível no momento.",
        "error",
      );
      return null;
    })
    .finally(() => {
      billingConfigPromise = null;
    });
  return billingConfigPromise;
}
function selectBillingPlan(months) {
  const selected = Number(months);
  if (!state.billing.plans.includes(selected)) return;
  state.billing.selectedMonths = selected;
  renderBillingPanel();
  setFeedback("automaticPaymentFeedback");
}
async function startBillingCheckout() {
  if (submissionLocks.has("billing-checkout")) {
    return toast("Seu pagamento já está sendo preparado.");
  }
  await loadBillingConfig({ force: state.billing.configured === false });
  if (!state.billing.configured) {
    setFeedback(
      "automaticPaymentFeedback",
      "O pagamento pelo Mercado Pago ainda não está disponível. Tente novamente em alguns instantes.",
      "error",
    );
    return;
  }
  const buttons = [$("#automaticPaymentButton")];
  submissionLocks.add("billing-checkout");
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  setFeedback(
    "automaticPaymentFeedback",
    "Preparando seu checkout seguro...",
  );
  try {
    const result = await window.credmaisBridge.createBillingCheckout(
      state.billing.selectedMonths,
    );
    setFeedback(
      "automaticPaymentFeedback",
      "Checkout pronto. Abrindo o Mercado Pago...",
      "success",
    );
    location.assign(result.checkoutUrl);
  } catch (error) {
    setFeedback(
      "automaticPaymentFeedback",
      error.message || "Não foi possível iniciar o pagamento.",
      "error",
    );
    toast(error.message || "Não foi possível iniciar o pagamento.");
  } finally {
    submissionLocks.delete("billing-checkout");
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  }
}
async function handleBillingReturn() {
  if (billingReturnHandled) return;
  const returnStatus = new URLSearchParams(location.search).get("pagamento");
  if (!returnStatus) return;
  billingReturnHandled = true;
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("pagamento");
  history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  if (returnStatus === "falha") {
    if (platformReadOnly()) showAccessGate(state.platformAccess, { openPrompt: true });
    setFeedback(
      "automaticPaymentFeedback",
      "O pagamento não foi concluído. Você pode tentar novamente sem cobrança duplicada.",
      "error",
    );
    return toast("Pagamento não concluído.");
  }
  if (platformReadOnly()) showAccessGate(state.platformAccess, { openPrompt: true });
  setFeedback(
    "automaticPaymentFeedback",
    returnStatus === "pendente"
      ? "Pagamento pendente. A liberação ocorrerá automaticamente após a confirmação."
      : "Pagamento enviado. Confirmando com o Mercado Pago...",
  );
  toast("Estamos confirmando seu pagamento com segurança.");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const access = await window.credmaisBridge.platformAccess(state.user);
      state.platformAccess = access;
      localStorage.setItem(
        platformAccessStorageKey(state.user.id),
        JSON.stringify(access),
      );
      if (platformAccessAllowed(access)) {
        await showApp(access);
        return toast("Pagamento confirmado. Seu acesso foi liberado!");
      }
    } catch (error) {
      console.warn("Confirmação de pagamento ainda indisponível:", error.message);
    }
  }
  setFeedback(
    "automaticPaymentFeedback",
    "A confirmação ainda está pendente e será verificada automaticamente. Não pague novamente.",
  );
}
function dismissAccessPrompt() {
  $("#accessView").hidden = true;
  state.accessPromptDismissed = true;
  toast(platformPaymentLocked()
    ? "Modo de visualização ativo. Use o aviso no topo para abrir os planos."
    : "Planos fechados. Você pode abri-los novamente pelo aviso no topo.");
}
async function refreshPlatformAccess() {
  const buttons = [$("#subscriptionRefreshButton")].filter(Boolean);
  buttons.forEach((button) => {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = "Atualizando...";
  });
  try {
    const access = await resolvePlatformAccess();
    if (access?.offline) {
      showOfflineMode(access);
      toast("Ainda não foi possível confirmar o acesso. Tentaremos novamente automaticamente.");
    } else if (platformAccessAllowed(access)) {
      await showApp(access);
      toast("Acesso liberado. Todas as funções estão disponíveis.");
    } else {
      showAccessGate(access, { openPrompt: true });
      setFeedback("automaticPaymentFeedback", "Situação atualizada.", "success");
    }
  } catch (error) {
    toast(error.message || "Não foi possível atualizar a situação agora.");
    setFeedback(
      "automaticPaymentFeedback",
      error.message || "Não foi possível atualizar agora.",
      "error",
    );
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.textContent = button.dataset.originalText || "Atualizar";
      delete button.dataset.originalText;
    });
  }
}
async function showApp(resolvedAccess = null) {
  const access = resolvedAccess || (await resolvePlatformAccess()),
    writeAllowed = platformAccessAllowed(access);
  state.platformAccess = access;
  if (!access?.offline) stopAccessRecovery();
  renderPlatformSupport(access);
  if (window.credmaisBridge?.enabled) {
    const cacheOwner = localStorage.getItem("credmais_cache_owner"),
      ownsCache = cacheOwner === state.user.id;
    if (!ownsCache) {
      if (
        cacheOwner &&
        localStorage.getItem("credmais_sync_pending") === cacheOwner &&
        !localStorage.getItem(pendingSyncStorageKey(cacheOwner))
      )
        rememberPendingSync(cacheOwner, {
          clients: state.clients,
          loans: state.loans,
          history: state.history,
        });
      state.clients = [];
      state.loans = [];
      state.history = [];
      localStorage.setItem("credmais_clients", "[]");
      localStorage.setItem("credmais_loans", "[]");
      localStorage.setItem("credmais_history", "[]");
      localStorage.setItem("credmais_cache_owner", state.user.id);
    }
    if (access?.offline) {
      console.info("Modo offline: mantendo os dados salvos neste aparelho.");
    } else if (writeAllowed) {
      try {
        const pending = pendingSyncPayload(state.user.id, ownsCache);
        if (pending) {
          await window.credmaisBridge.sync(
            state.user,
            pending.clients,
            pending.loans,
            pending.history,
          );
          clearPendingSync(state.user.id);
        }
        const cloud = await window.credmaisBridge.load();
        state.clients = cloud.clients;
        state.loans = cloud.loans;
        state.history = cloud.history ?? state.history;
        if (cloud.profile) {
          state.user = { ...state.user, ...cloud.profile };
          localStorage.setItem("credmais_user", JSON.stringify(state.user));
        }
        localStorage.setItem("credmais_clients", JSON.stringify(state.clients));
        localStorage.setItem("credmais_loans", JSON.stringify(state.loans));
        localStorage.setItem("credmais_history", JSON.stringify(state.history));
        localStorage.setItem("credmais_cache_owner", state.user.id);
      } catch (error) {
        toast(`Usando os dados salvos neste dispositivo: ${error.message}`);
      }
    } else {
      try {
        const cloud = await window.credmaisBridge.load(),
          cloudHasData = Boolean(
            cloud.clients.length ||
              cloud.loans.length ||
              (cloud.history || []).length,
          ),
          localHasData = Boolean(
            state.clients.length || state.loans.length || state.history.length,
          );
        if (cloudHasData || !localHasData) {
          state.clients = cloud.clients;
          state.loans = cloud.loans;
          state.history = cloud.history ?? state.history;
          localStorage.setItem("credmais_clients", JSON.stringify(state.clients));
          localStorage.setItem("credmais_loans", JSON.stringify(state.loans));
          localStorage.setItem("credmais_history", JSON.stringify(state.history));
        }
        if (cloud.profile) {
          state.user = { ...state.user, ...cloud.profile };
          localStorage.setItem("credmais_user", JSON.stringify(state.user));
        }
      } catch (error) {
        console.warn("Consulta em modo de visualização indisponível:", error.message);
      }
    }
  }
  $("#accessView").hidden = true;
  $("#authView").hidden = true;
  $("#appView").hidden = false;
  $("#userName").textContent = state.user.name;
  $("#greetingName").textContent = state.user.name.split(" ")[0];
  $("#initials").textContent = initials(state.user.name);
  const requestedPage = location.hash.slice(1);
  if ($(`#${requestedPage}Page`)) setPage(requestedPage);
  else setPage("dashboard");
  renderTrialBanner(access);
  startAutoRefresh();
  if (writeAllowed) {
    $("#accessView").hidden = true;
    $("#subscriptionBanner").hidden = true;
    const offlineBanner = $("#offlineBanner");
    if (offlineBanner) offlineBanner.hidden = true;
    applyPlatformRestrictions();
  } else if (access?.offline) showOfflineMode(access);
  else showAccessGate(access, { openPrompt: !state.accessPromptDismissed });
  void handleBillingReturn();
  return true;
}
function hasOpenModal() {
  return Array.from(document.querySelectorAll(".modal")).some(
    (modal) => !modal.hidden,
  );
}
async function refreshFromCloud({ notify = false, allowWhileModalOpen = false } = {}) {
  const modalOpen = hasOpenModal();
  if (
    refreshingFromCloud ||
    !window.credmaisBridge?.enabled ||
    !state.user?.id ||
    document.hidden ||
    (modalOpen && !allowWhileModalOpen)
  )
    return false;
  refreshingFromCloud = true;
  try {
    const wasOffline = platformOfflineReadOnly(),
      previousConnectionState = state.platformAccess?.connectionState,
      accessWasPaymentLocked = platformPaymentLocked();
    const access = await resolvePlatformAccess();
    const accessPromptVisible = !$("#accessView").hidden;
    if (access?.offline) {
      showOfflineMode(access);
      if (notify && !wasOffline)
        toast("Não foi possível confirmar o acesso. O CredMais está em modo de consulta.");
      return false;
    }
    stopAccessRecovery();
    if (access?.enabled && !platformAccessAllowed(access)) {
      renderTrialBanner(access);
      showAccessGate(access, {
        openPrompt: accessPromptVisible || !state.accessPromptDismissed,
      });
      return false;
    }
    state.platformAccess = access;
    renderPlatformSupport(access);
    renderTrialBanner(access);
    if (accessPromptVisible)
      showAccessGate(access, { openPrompt: true });
    else $("#accessView").hidden = true;
    const offlineBanner = $("#offlineBanner");
    if (offlineBanner) offlineBanner.hidden = true;
    applyPlatformRestrictions();
    if (modalOpen) {
      if (wasOffline)
        toast(
          previousConnectionState === "offline"
            ? "Conexão com o CredMais restabelecida. Seu acesso continua liberado."
            : "Acesso verificado novamente. Suas funções estão liberadas.",
        );
      return true;
    }
    const pending = pendingSyncPayload(state.user.id),
      hadPendingSync = Boolean(pending);
    if (pending) {
      await window.credmaisBridge.sync(
        state.user,
        pending.clients,
        pending.loans,
        pending.history,
      );
      clearPendingSync(state.user.id);
    }
    const cloud = await window.credmaisBridge.load();
    const nextHistory = cloud.history ?? state.history;
    const changed =
      JSON.stringify(state.clients) !== JSON.stringify(cloud.clients) ||
      JSON.stringify(state.loans) !== JSON.stringify(cloud.loans) ||
      JSON.stringify(state.history) !== JSON.stringify(nextHistory);
    if (!changed) {
      render();
      if (wasOffline)
        toast(
          previousConnectionState === "offline"
            ? "Conexão com o CredMais restabelecida. Seu acesso continua liberado."
            : "Acesso verificado novamente. Suas funções estão liberadas.",
        );
      else if (accessWasPaymentLocked)
        toast("Acesso liberado. Todas as funções estão disponíveis.");
      else if (notify && hadPendingSync)
        toast("Dados pendentes sincronizados com sucesso.");
      return false;
    }
    state.clients = cloud.clients;
    state.loans = cloud.loans;
    state.history = nextHistory;
    localStorage.setItem("credmais_clients", JSON.stringify(state.clients));
    localStorage.setItem("credmais_loans", JSON.stringify(state.loans));
    localStorage.setItem("credmais_history", JSON.stringify(state.history));
    render();
    if (wasOffline)
      toast(
        previousConnectionState === "offline"
          ? "Conexão com o CredMais restabelecida. Dados atualizados."
          : "Acesso verificado novamente. Dados atualizados.",
      );
    else if (notify)
      toast(
        hadPendingSync
          ? "Dados pendentes sincronizados e atualizados."
          : "Dados atualizados automaticamente.",
      );
    return true;
  } catch (error) {
    console.warn("Atualização automática indisponível:", error.message);
    return false;
  } finally {
    refreshingFromCloud = false;
  }
}
function startAutoRefresh() {
  if (autoRefreshTimer || !window.credmaisBridge?.enabled) return;
  autoRefreshTimer = setInterval(
    () => refreshFromCloud({ notify: true }),
    30000,
  );
}
const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  window.navigator.standalone === true;
function openInstall() {
  const instructions = $("#installInstructions"),
    confirmButton = $("#confirmInstallBtn"),
    isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isStandalone()) return toast("O CredMais já está instalado.");
  if (deferredInstallPrompt) {
    instructions.innerHTML =
      "<p>Instale o CredMais para abrir em tela cheia e acessar mais rapidamente pela tela inicial.</p>";
    confirmButton.hidden = false;
  } else if (isiOS) {
    instructions.innerHTML =
      '<p>No iPhone, abra este link no <b>Safari</b> e siga estes passos:</p><ol class="install-steps"><li>Toque no botão <b>Compartilhar</b>.</li><li>Escolha <b>Adicionar à Tela de Início</b>.</li><li>Confirme tocando em <b>Adicionar</b>.</li></ol><p>Se o link abriu dentro do WhatsApp, use a opção <b>Abrir no Safari</b> antes de instalar.</p>';
    confirmButton.hidden = true;
  } else {
    instructions.innerHTML =
      "<p>Abra o menu do navegador e escolha <b>Instalar aplicativo</b> ou <b>Adicionar à tela inicial</b>. Se a opção não aparecer, abra este link no Chrome ou Edge.</p>";
    confirmButton.hidden = true;
  }
  openModal("installModal");
}
async function installPWA() {
  if (!deferredInstallPrompt) return openInstall();
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  closeModals();
  toast(
    choice.outcome === "accepted"
      ? "Instalação iniciada."
      : "Instalação cancelada.",
  );
}
function setupPWA() {
  const installButtons = [$("#profileInstallButton"), $("#authInstallButton")];
  const syncInstallButtons = () => installButtons.forEach((button) => {
    button.hidden = isStandalone();
  });
  syncInstallButtons();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    syncInstallButtons();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installButtons.forEach((button) => { button.hidden = true; });
    toast("CredMais instalado com sucesso.");
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        setInterval(() => registration.update(), 60 * 60 * 1000);
      })
      .catch((error) => console.warn("PWA indisponível:", error.message));
  }
}
async function login(event) {
  event.preventDefault();
  const form = event.currentTarget,
    email = $("#loginEmail").value.trim(),
    password = $("#loginPassword").value;
  if (!email || !email.includes("@"))
    return setFeedback("loginFeedback", "Informe um e-mail válido.", "error");
  if (password.length < 6)
    return setFeedback(
      "loginFeedback",
      "A senha precisa ter pelo menos 6 caracteres.",
      "error",
    );
  setFeedback("loginFeedback");
  setFormLoading(form, true);
  try {
    if (window.credmaisBridge?.enabled) {
      const cachedUser = state.user;
      state.user = await window.credmaisBridge.signIn(email, password);
      if (
        window.credmaisBridge.authProvider === "firebase" &&
        cachedUser?.email?.toLowerCase() === state.user.email?.toLowerCase() &&
        (cachedUser.pixKey || cachedUser.pixRecipientName)
      ) {
        state.user = {
          ...state.user,
          pixKey: state.user.pixKey || cachedUser.pixKey || "",
          pixType:
            state.user.pixType || cachedUser.pixType || "Chave aleatória",
          pixRecipientName:
            state.user.pixRecipientName ||
            cachedUser.pixRecipientName ||
            cachedUser.name ||
            "",
        };
        if (state.user.pixKey)
          state.user = await window.credmaisBridge.updatePix(
            state.user.pixKey,
            state.user.pixType,
            state.user.pixRecipientName,
          );
      }
    } else {
      const account = JSON.parse(
        localStorage.getItem("credmais_account") || "null",
      );
      if (!account || account.email !== email)
        throw new Error("E-mail ou senha incorretos.");
      const validPassword = account.passwordHash
        ? (await hashLocalPassword(password, account.salt)).passwordHash ===
          account.passwordHash
        : account.password === password;
      if (!validPassword) throw new Error("E-mail ou senha incorretos.");
      if (!account.passwordHash) {
        const credentials = await hashLocalPassword(password);
        localStorage.setItem(
          "credmais_account",
          JSON.stringify({ name: account.name, email: account.email, ...credentials }),
        );
      }
      state.user = { name: account.name, email: account.email };
    }
    localStorage.setItem("credmais_user", JSON.stringify(state.user));
    await showApp();
  } catch (error) {
    setFeedback(
      "loginFeedback",
      error.message || "Não foi possível entrar.",
      "error",
    );
    setFormLoading(form, false);
  }
}
async function loginWithGoogle() {
  const button = $("#googleSignInButton");
  setFeedback("loginFeedback");
  button.classList.add("is-loading");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (
      !window.credmaisBridge?.enabled ||
      window.credmaisBridge.authProvider !== "firebase"
    )
      throw new Error("O acesso com Google ainda não está disponível.");
    const cachedUser = state.user;
    state.user = await window.credmaisBridge.signInWithGoogle();
    if (
      cachedUser?.email?.toLowerCase() === state.user.email?.toLowerCase() &&
      (cachedUser.pixKey || cachedUser.pixRecipientName)
    ) {
      state.user = {
        ...state.user,
        pixKey: state.user.pixKey || cachedUser.pixKey || "",
        pixType: state.user.pixType || cachedUser.pixType || "Chave aleatória",
        pixRecipientName:
          state.user.pixRecipientName ||
          cachedUser.pixRecipientName ||
          cachedUser.name ||
          "",
      };
      if (state.user.pixKey)
        state.user = await window.credmaisBridge.updatePix(
          state.user.pixKey,
          state.user.pixType,
          state.user.pixRecipientName,
        );
    }
    localStorage.setItem("credmais_user", JSON.stringify(state.user));
    await showApp();
    toast("Acesso com Google realizado com sucesso.");
  } catch (error) {
    setFeedback(
      "loginFeedback",
      error.message || "Não foi possível entrar com o Google.",
      "error",
    );
  } finally {
    button.classList.remove("is-loading");
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
  }
}
async function requestPasswordReset(event) {
  event.preventDefault();
  const form = event.currentTarget,
    email = $("#forgotEmail").value.trim();
  if (!email || !email.includes("@"))
    return setFeedback(
      "forgotFeedback",
      "Informe o e-mail usado na sua conta.",
      "error",
    );
  setFeedback("forgotFeedback");
  setFormLoading(form, true);
  try {
    if (
      !window.credmaisBridge?.enabled ||
      window.credmaisBridge.authProvider !== "firebase"
    )
      throw new Error(
        "A recuperação por Firebase ficará disponível assim que as chaves do projeto forem configuradas.",
      );
    await window.credmaisBridge.sendPasswordReset(email);
    setFeedback(
      "forgotFeedback",
      "E-mail enviado. Confira sua caixa de entrada e também a pasta Spam.",
      "success",
    );
  } catch (error) {
    setFeedback(
      "forgotFeedback",
      error.message || "Não foi possível enviar o e-mail.",
      "error",
    );
  } finally {
    setFormLoading(form, false);
  }
}
async function register(event) {
  event.preventDefault();
  const form = event.currentTarget,
    name = $("#registerName").value.trim(),
    email = $("#registerEmail").value.trim(),
    password = $("#registerPassword").value;
  if (name.length < 2)
    return setFeedback(
      "registerFeedback",
      "Informe seu nome para continuar.",
      "error",
    );
  if (!email || !email.includes("@"))
    return setFeedback(
      "registerFeedback",
      "Informe um e-mail válido.",
      "error",
    );
  if (!validateRegistration())
    return setFeedback(
      "registerFeedback",
      "Revise a senha e a confirmação.",
      "error",
    );
  setFeedback("registerFeedback");
  setFormLoading(form, true);
  try {
    if (window.credmaisBridge?.enabled) {
      const result = await window.credmaisBridge.signUp(name, email, password);
      if (result.requiresVerification) {
        $("#verificationMessage").textContent =
          `Enviamos para ${email} um link de confirmação com a identidade do CredMais.`;
        setFeedback("verificationFeedback");
        form.reset();
        validateRegistration();
        setAuth("verification");
        setFormLoading(form, false);
        return;
      }
      if (!result.hasSession) {
        setFeedback(
          "registerFeedback",
          "Conta criada. Faça login para continuar.",
          "success",
        );
        setFormLoading(form, false);
        return;
      }
      state.user = result.user;
    } else {
      const credentials = await hashLocalPassword(password);
      localStorage.setItem(
        "credmais_account",
        JSON.stringify({ name, email, ...credentials }),
      );
      state.user = { name, email };
    }
    localStorage.setItem("credmais_user", JSON.stringify(state.user));
    await showApp();
    toast("Conta criada. Boas-vindas!");
  } catch (error) {
    setFeedback(
      "registerFeedback",
      error.message || "Não foi possível criar a conta.",
      "error",
    );
    setFormLoading(form, false);
  }
}
function resetClientForm() {
  $("#clientForm").reset();
  $("#clientId").value = "";
  renderClientCpfValidation();
  $("#clientModalEyebrow").textContent = "NOVO CADASTRO";
  $("#clientModalTitle").textContent = "Adicionar cliente";
  $("#clientSaveBtn").textContent = "Salvar cliente";
}
function resetLoanForm() {
  $("#loanForm").reset();
  $("#loanId").value = "";
  setCurrencyInput($("#loanAmount"), 0, false);
  $("#loanInterest").value = "10";
  setLoanInterestMode("flat");
  setLoanFrequency(30, false);
  setCurrencyInput($("#loanLateFee"), 0);
  $("#loanInstallments").value = "6";
  suggestFirstDueDate();
  $("#loanModalEyebrow").textContent = "NOVA OPERAÇÃO";
  $("#loanModalTitle").textContent = "Novo empréstimo";
  $("#loanSaveBtn").textContent = "Confirmar empréstimo";
}
function formSnapshot(modal) {
  return Array.from(modal.querySelectorAll("input, select, textarea"))
    .map(
      (field) =>
        `${field.id}:${field.type === "checkbox" ? field.checked : field.value}`,
    )
    .join("|");
}
function rememberModalState(id) {
  const modal = $(`#${id}`),
    form = modal?.querySelector("form");
  if (form && !form.hasAttribute("data-passive-form"))
    modal.dataset.initialState = formSnapshot(modal);
}
function syncModalViewport() {
  if (!document.body.classList.contains("modal-open")) return;
  const root = document.documentElement;
  if (window.innerWidth > 680) {
    root.style.removeProperty("--modal-visual-top");
    root.style.removeProperty("--modal-visual-height");
    return;
  }
  const viewport = window.visualViewport;
  const visibleHeight = Math.min(window.innerHeight, viewport?.height || window.innerHeight);
  const visibleTop = Math.max(0, viewport?.offsetTop || 0);
  root.style.setProperty("--modal-visual-top", `${Math.round(visibleTop + 8)}px`);
  root.style.setProperty("--modal-visual-height", `${Math.max(80, Math.floor(visibleHeight - 16))}px`);
}
function clearModalViewport() {
  document.documentElement.style.removeProperty("--modal-visual-top");
  document.documentElement.style.removeProperty("--modal-visual-height");
}
function keepFocusedModalFieldVisible() {
  const field = document.activeElement;
  const modal = field?.closest?.(".modal");
  if (!modal || modal.hidden || !field.matches("input, select, textarea")) return;
  const modalBounds = modal.getBoundingClientRect();
  const fieldBounds = field.getBoundingClientRect();
  if (fieldBounds.bottom > modalBounds.bottom - 20)
    modal.scrollTop += fieldBounds.bottom - modalBounds.bottom + 20;
  else if (fieldBounds.top < modalBounds.top + 20)
    modal.scrollTop -= modalBounds.top + 20 - fieldBounds.top;
}
function syncModalLayers(activeModal = null) {
  const modals = Array.from(document.querySelectorAll(".modal"));
  const visible = modals.filter((modal) => !modal.hidden);
  const top = activeModal && !activeModal.hidden ? activeModal : visible.at(-1);
  if (top) {
    top.tabIndex = -1;
    top.focus({ preventScroll: true });
  }
  modals.forEach((modal) => {
    const behind = !modal.hidden && modal !== top;
    modal.classList.toggle("modal-underlay", behind);
    if (behind) modal.setAttribute("aria-hidden", "true");
    else modal.removeAttribute("aria-hidden");
  });
  ["authView", "appView", "accessView"].forEach((id) => {
    const view = document.getElementById(id);
    if (view) view.inert = Boolean(top);
  });
}
function openModal(id) {
  if (id === "loanModal" && !state.clients.length) {
    toast("Cadastre um cliente antes de criar um empréstimo.");
    return openClient();
  }
  document.body.classList.add("modal-open");
  $("#modalBackdrop").hidden = false;
  const modal = $(`#${id}`);
  const previousIndex = modalStack.indexOf(id);
  if (previousIndex !== -1) modalStack.splice(previousIndex, 1);
  modalStack.push(id);
  modal.hidden = false;
  if (previousIndex === -1) modal.scrollTop = 0;
  syncModalLayers(modal);
  syncModalViewport();
  rememberModalState(id);
}
function closeModals() {
  modalStack.length = 0;
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.hidden = true;
  });
  syncModalLayers();
  $("#modalBackdrop").hidden = true;
  document.body.classList.remove("modal-open");
  clearModalViewport();
  pendingModalId = null;
  returnToClientId = null;
}
function closeTopModal() {
  const id = modalStack.pop();
  if (id) $(`#${id}`).hidden = true;
  const previous = modalStack.length ? $(`#${modalStack.at(-1)}`) : null;
  if (previous && !previous.hidden) {
    syncModalLayers(previous);
    syncModalViewport();
    return;
  }
  closeModals();
}
function requestClose() {
  const modal = modalStack.length ? $(`#${modalStack.at(-1)}`) : null;
  if (!modal) return closeModals();
  if (modal.id === "confirmDeleteModal") return cancelDelete();
  if (modal.id === "discardModal") return keepEditing();
  const form = modal.querySelector("form");
  if (
    form &&
    !form.hasAttribute("data-passive-form") &&
    modal.dataset.initialState !== formSnapshot(modal)
  ) {
    pendingModalId = modal.id;
    openModal("discardModal");
    return;
  }
  closeTopModal();
}
function keepEditing() {
  closeTopModal();
  pendingModalId = null;
}
function discardChanges() {
  const discardedId = pendingModalId;
  closeTopModal();
  if (discardedId && modalStack.at(-1) === discardedId) closeTopModal();
  pendingModalId = null;
}
function askDelete({ title, message, action }) {
  pendingDelete = action;
  $("#confirmDeleteTitle").textContent = title;
  $("#confirmDeleteMessage").textContent = message;
  openModal("confirmDeleteModal");
}
function cancelDelete() {
  pendingDelete = null;
  closeTopModal();
}
async function confirmDelete() {
  if (!pendingDelete) return cancelDelete();
  const action = pendingDelete;
  pendingDelete = null;
  const button = $("[data-confirm-delete]");
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}
function openClient(id) {
  if (!requirePlatformAccess(id ? "editar clientes" : "cadastrar clientes"))
    return;
  resetClientForm();
  if (id) {
    const client = state.clients.find((item) => item.id === id);
    if (!client) return;
    $("#clientId").value = client.id;
    $("#clientName").value = client.name;
    $("#clientCpf").value = client.cpf;
    renderClientCpfValidation();
    $("#clientPhone").value = client.phone;
    $("#clientNote").value = client.note || "";
    $("#clientModalEyebrow").textContent = "EDITAR CLIENTE";
    $("#clientModalTitle").textContent = "Atualizar cadastro";
    $("#clientSaveBtn").textContent = "Salvar alterações";
  }
  openModal("clientModal");
}
function prepareLoan(id) {
  $("#loanClient").innerHTML = state.clients
    .map(
      (client) =>
        `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`,
    )
    .join("");
  if (!id) resetLoanForm();
  else {
    const loan = state.loans.find((item) => item.id === id);
    if (!loan) return;
    $("#loanId").value = loan.id;
    $("#loanClient").value = loan.clientId;
    setCurrencyInput($("#loanAmount"), loan.amount);
    $("#loanInterest").value = loan.rate * 100;
    setLoanInterestMode(interestModeFor(loan));
    $("#loanInstallments").value = loan.installments;
    setLoanFrequency(loan.frequency || 30, Boolean(loan.businessDays));
    setCurrencyInput($("#loanLateFee"), loan.lateFee || 0);
    $("#loanDueDate").value = loan.dueDate;
    $("#loanModalEyebrow").textContent = "EDITAR OPERAÇÃO";
    $("#loanModalTitle").textContent = "Atualizar empréstimo";
    $("#loanSaveBtn").textContent = "Salvar alterações";
  }
  calc();
  updateLoanDuePreview();
}
function openLoan(id) {
  if (!requirePlatformAccess(id ? "editar empréstimos" : "criar empréstimos"))
    return;
  if (!state.clients.length) return openModal("loanModal");
  prepareLoan(id);
  openModal("loanModal");
}
function setPage(page) {
  const target = $(`#${page}Page`);
  if (!target) return;
  document
    .querySelectorAll(".page")
    .forEach((item) =>
      item.classList.toggle("active", item.id === `${page}Page`),
    );
  document
    .querySelectorAll("[data-page]")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.page === page),
    );
  $("#pageTitle").textContent = {
    dashboard: "Visão geral",
    clients: "Clientes",
    loans: "Empréstimos",
    paid: "Quitados",
    history: "Histórico",
    blacklist: "Lista negra",
  }[page];
  window.history.replaceState(null, "", `#${page}`);
  $(".sidebar").classList.remove("open");
  render();
}
function render() {
  renderStats();
  renderClients();
  if (!$("#clientProfileModal").hidden) renderClientProfile();
  renderLoans();
  renderPaid();
  renderHistory();
  renderBlacklist();
  applyPlatformRestrictions();
}
const isLoanFullyPaid = (loan) =>
  Array.from({ length: loan.installments }, (_, index) =>
    paymentStateFor(loan, index),
  ).every((status) => status === "paid");
function receivedAmountFor(loan, index, info = installmentInfo(loan, index)) {
  const payment = loan.paymentStates?.[index],
    status = paymentStateFor(loan, index);
  if (typeof payment === "object" && payment.receivedTotal != null)
    return Number(payment.receivedTotal);
  if (status === "paid") return Number(info.due || 0);
  if (status === "interest") return Number(info.interestOnlyValue || 0);
  if (status === "partial") return Number(payment?.paidAmount || 0);
  return 0;
}
const monthKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
function receiptEntriesFor(loan, index, info = installmentInfo(loan, index)) {
  const payment = loan.paymentStates?.[index];
  if (typeof payment === "object" && Array.isArray(payment.receipts))
    return payment.receipts
      .map((receipt) => ({
        amount: Number(receipt.amount || 0),
        createdAt: receipt.createdAt,
        type: receipt.type || payment.status || "payment",
        principalAmount:
          receipt.principalAmount == null
            ? null
            : Number(receipt.principalAmount || 0),
        interestAmount:
          receipt.interestAmount == null
            ? null
            : Number(receipt.interestAmount || 0),
      }))
      .filter((receipt) => receipt.amount > 0 && receipt.createdAt);
  const amount =
    typeof payment === "object" && payment.lastPayment != null
      ? Number(payment.lastPayment)
      : receivedAmountFor(loan, index, info);
  if (amount <= 0) return [];
  return [
    {
      amount,
      createdAt:
        (typeof payment === "object" && payment.createdAt) ||
        dateFor(loan, index).toISOString(),
      type:
        (typeof payment === "object" && payment.status) ||
        paymentStateFor(loan, index) ||
        "payment",
      principalAmount: null,
      interestAmount: null,
    },
  ];
}
function receiptBreakdownFor(loan, index) {
  const receipts = receiptEntriesFor(loan, index),
    payment = loan.paymentStates?.[index],
    explicitPrincipal = receipts.reduce(
      (sum, receipt) => sum + Number(receipt.principalAmount || 0),
      0,
    ),
    principalRecorded =
      typeof payment === "object" && payment.principalPaid != null
        ? Number(payment.principalPaid || 0)
        : principalPositionFor(loan, index).paid,
    unclassified = receipts.filter(
      (receipt) =>
        receipt.type !== "interest" && receipt.principalAmount == null,
    ),
    unclassifiedTotal = unclassified.reduce(
      (sum, receipt) => sum + receipt.amount,
      0,
    ),
    principalToAllocate = Math.max(
      0,
      Math.min(unclassifiedTotal, principalRecorded - explicitPrincipal),
    );
  return receipts.map((receipt) => {
    const principal =
      receipt.principalAmount != null
        ? receipt.principalAmount
        : receipt.type === "interest"
          ? 0
          : unclassifiedTotal
            ? Math.min(
                receipt.amount,
                roundCurrency(
                  principalToAllocate * (receipt.amount / unclassifiedTotal),
                ),
              )
            : 0;
    return {
      ...receipt,
      principalAmount: roundCurrency(principal),
      interestAmount: roundCurrency(
        receipt.interestAmount != null
          ? receipt.interestAmount
          : Math.max(0, receipt.amount - principal),
      ),
    };
  });
}
function receivedInMonth(referenceDate = new Date()) {
  const selectedMonth = monthKey(referenceDate);
  return state.loans.reduce(
    (loanTotal, loan) =>
      loanTotal +
      Array.from({ length: loan.installments }, (_, index) =>
        receiptEntriesFor(loan, index),
      )
        .flat()
        .filter((receipt) => {
          const date = new Date(receipt.createdAt);
          return !Number.isNaN(date.getTime()) && monthKey(date) === selectedMonth;
        })
        .reduce((sum, receipt) => sum + receipt.amount, 0),
    0,
  );
}
function receivedBreakdownInMonth(referenceDate = new Date()) {
  const selectedMonth = monthKey(referenceDate);
  const result = state.loans.reduce(
    (totals, loan) => {
      Array.from({ length: loan.installments }, (_, index) =>
        receiptBreakdownFor(loan, index),
      )
        .flat()
        .forEach((receipt) => {
          const date = new Date(receipt.createdAt);
          if (Number.isNaN(date.getTime()) || monthKey(date) !== selectedMonth)
            return;
          totals.principal += receipt.principalAmount;
          totals.interest += receipt.interestAmount;
        });
      return totals;
    },
    { principal: 0, interest: 0 },
  );
  return {
    principal: roundCurrency(result.principal),
    interest: roundCurrency(result.interest),
  };
}
const reportMonthValue = (date = new Date()) => monthKey(date);
function reportPeriod(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const year = Number(match[1]),
    month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0),
    end = new Date(year, month, 1, 0, 0, 0, 0);
  return {
    key: value,
    year,
    month,
    start,
    end,
    days: new Date(year, month, 0).getDate(),
    label: start.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
  };
}
function isInReportPeriod(value, period) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= period.start && date < period.end;
}
const reportPaymentLabel = (type) =>
  ({ paid: "Quitação", partial: "Pagamento parcial", interest: "Somente juros" })[
    type
  ] || "Recebimento";
function monthlyReceiptRows(period) {
  return state.loans
    .flatMap((loan) =>
      Array.from({ length: Number(loan.installments) || 0 }, (_, index) => {
        const client = state.clients.find((item) => item.id === loan.clientId);
        return receiptEntriesFor(loan, index).map((receipt) => ({
          ...receipt,
          clientName: client?.name || "Cliente removido",
          contract: loan.contract || "Sem contrato",
          installment: index + 1,
          installments: loan.installments,
          loanId: loan.id,
        }));
      }).flat(),
    )
    .filter((receipt) => isInReportPeriod(receipt.createdAt, period))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function monthlyReportData(period) {
  const receipts = monthlyReceiptRows(period),
    loansCreated = state.loans
      .filter((loan) => isInReportPeriod(loan.createdAt, period))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    activities = state.history
      .filter((entry) => isInReportPeriod(entry.createdAt, period))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    received = receipts.reduce((sum, item) => sum + item.amount, 0),
    lent = loansCreated.reduce((sum, loan) => sum + Number(loan.amount || 0), 0),
    clients = new Set([
      ...receipts.map((item) => item.clientName),
      ...loansCreated.map(
        (loan) =>
          state.clients.find((client) => client.id === loan.clientId)?.name ||
          "Cliente removido",
      ),
    ]),
    currentPortfolio = state.loans
      .filter((loan) => !loan.archived)
      .reduce(
        (totals, loan) => {
          const values = financialsForLoan(loan);
          totals.lent += values.lent;
          totals.receivable += values.receivable;
          return totals;
        },
        { lent: 0, receivable: 0 },
      );
  const installments = state.loans
    .filter((loan) => !loan.archived)
    .flatMap((loan) =>
      Array.from({ length: Number(loan.installments) || 0 }, (_, index) => {
        const date = dateFor(loan, index),
          status = installmentStatus(loan, index, date);
        return status === "Quitada"
          ? "paid"
          : status === "Vencida" || status === "Não pagou"
            ? "overdue"
            : "open";
      }),
    );
  const status = installments.reduce(
    (totals, item) => ({ ...totals, [item]: totals[item] + 1 }),
    { paid: 0, open: 0, overdue: 0 },
  );
  return {
    receipts,
    loansCreated,
    activities,
    received,
    lent,
    clients: clients.size,
    currentPortfolio,
    status,
  };
}
function updateReportPreview() {
  const period = reportPeriod($("#reportMonth").value),
    preview = $("#reportPreview");
  if (!period) {
    preview.innerHTML = "<p>Escolha um mês válido.</p>";
    return;
  }
  const data = monthlyReportData(period);
  preview.innerHTML = `<div><span>Recebido</span><b>${money(data.received)}</b></div><div><span>Empréstimos</span><b>${data.loansCreated.length}</b></div><div><span>Atividades</span><b>${data.activities.length}</b></div>`;
}
function openMonthlyReport() {
  if (!requirePlatformAccess("abrir o relatório mensal")) return;
  $("#reportMonth").value = reportMonthValue();
  updateReportPreview();
  $(".sidebar").classList.remove("open");
  openModal("monthlyReportModal");
}
function reportDailyChart(period, receipts) {
  const totals = Array.from({ length: period.days }, () => 0);
  receipts.forEach((receipt) => {
    const date = new Date(receipt.createdAt);
    totals[date.getDate() - 1] += receipt.amount;
  });
  const maximum = Math.max(...totals, 1);
  return totals
    .map((value, index) => {
      const day = index + 1,
        height = value ? Math.max(5, Math.round((value / maximum) * 100)) : 2,
        showLabel = day === 1 || day === period.days || day % 5 === 0;
      return `<div class="pdf-bar-column"><span class="pdf-bar-value">${value ? money(value) : ""}</span><i style="height:${height}%" class="${value ? "has-value" : ""}"></i><small>${showLabel ? day : ""}</small></div>`;
    })
    .join("");
}
function reportTable(headers, rows, emptyMessage) {
  if (!rows.length)
    return `<div class="pdf-empty">${escapeHtml(emptyMessage)}</div>`;
  return `<table class="pdf-table"><thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function buildMonthlyReport(period, data) {
  const generatedAt = new Date(),
    owner = state.user?.pixRecipientName || state.user?.name || "Usuário CredMais",
    loanRows = data.loansCreated.map((loan) => {
      const client = state.clients.find((item) => item.id === loan.clientId);
      return `<tr><td>${new Date(loan.createdAt).toLocaleDateString("pt-BR")}</td><td><b>${escapeHtml(client?.name || "Cliente removido")}</b><small>${escapeHtml(loan.contract || "Sem contrato")}</small></td><td>${escapeHtml(formatFrequency(loan.frequency, loan.businessDays))}</td><td class="pdf-money">${money(loan.amount)}</td><td class="pdf-money">${money(loan.total)}</td></tr>`;
    }),
    receiptRows = data.receipts.map(
      (receipt) =>
        `<tr><td>${new Date(receipt.createdAt).toLocaleDateString("pt-BR")}</td><td><b>${escapeHtml(receipt.clientName)}</b><small>${escapeHtml(receipt.contract)} · Parcela ${receipt.installment}/${receipt.installments}</small></td><td>${escapeHtml(reportPaymentLabel(receipt.type))}</td><td class="pdf-money pdf-positive">${money(receipt.amount)}</td></tr>`,
    ),
    activityRows = data.activities.map(
      (entry) =>
        `<tr><td>${new Date(entry.createdAt).toLocaleDateString("pt-BR")}<small>${new Date(entry.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></td><td><b>${escapeHtml(entry.title)}</b><small>${escapeHtml(entry.description || "Sem detalhes")}</small></td></tr>`,
    ),
    statusTotal = data.status.paid + data.status.open + data.status.overdue,
    statusWidth = (value) =>
      statusTotal ? Math.max(value ? 3 : 0, (value / statusTotal) * 100) : 0,
    article = document.createElement("article"),
    stage = document.createElement("div");
  article.className = "pdf-report";
  article.setAttribute("aria-hidden", "true");
  article.innerHTML = `
    <header class="pdf-report-header"><div class="pdf-brand"><span>C</span><div><strong>CredMais</strong><small>Gestão de empréstimos</small></div></div><div class="pdf-period"><span>RELATÓRIO MENSAL</span><strong>${escapeHtml(period.label)}</strong></div></header>
    <section class="pdf-report-intro"><div><p>Responsável</p><h1>${escapeHtml(owner)}</h1><small>Relatório gerado em ${generatedAt.toLocaleDateString("pt-BR")} às ${generatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></div><span class="pdf-report-seal">Fechamento<br>mensal</span></section>
    <section class="pdf-kpis"><div class="pdf-kpi emphasis"><span>Recebido no mês</span><strong>${money(data.received)}</strong><small>${data.receipts.length} movimentaç${data.receipts.length === 1 ? "ão" : "ões"}</small></div><div class="pdf-kpi"><span>Capital emprestado</span><strong>${money(data.lent)}</strong><small>${data.loansCreated.length} novo${data.loansCreated.length === 1 ? " contrato" : "s contratos"}</small></div><div class="pdf-kpi"><span>Clientes movimentados</span><strong>${data.clients}</strong><small>com empréstimo ou recebimento</small></div><div class="pdf-kpi"><span>Alterações registradas</span><strong>${data.activities.length}</strong><small>ações no histórico</small></div></section>
    <section class="pdf-grid pdf-avoid-break"><div class="pdf-card pdf-chart-card"><div class="pdf-section-heading"><div><span>ENTRADAS</span><h2>Recebimentos por dia</h2></div><strong>${money(data.received)}</strong></div><div class="pdf-bar-chart">${reportDailyChart(period, data.receipts)}</div><p class="pdf-chart-caption">Cada barra representa o total recebido no dia; os valores detalhados aparecem na tabela de recebimentos.</p></div><div class="pdf-card pdf-status-card"><div class="pdf-section-heading"><div><span>CARTEIRA</span><h2>Situação atual das parcelas</h2></div></div><div class="pdf-status-total"><strong>${statusTotal}</strong><span>parcelas</span></div><div class="pdf-status-track"><i class="paid" style="width:${statusWidth(data.status.paid)}%"></i><i class="open" style="width:${statusWidth(data.status.open)}%"></i><i class="overdue" style="width:${statusWidth(data.status.overdue)}%"></i></div><div class="pdf-status-legend"><p><i class="paid"></i><span>Quitadas</span><b>${data.status.paid}</b></p><p><i class="open"></i><span>Em aberto</span><b>${data.status.open}</b></p><p><i class="overdue"></i><span>Vencidas</span><b>${data.status.overdue}</b></p></div></div></section>
    <section class="pdf-card pdf-portfolio pdf-avoid-break"><div class="pdf-section-heading"><div><span>POSIÇÃO CONSULTADA EM ${generatedAt.toLocaleDateString("pt-BR")}</span><h2>Resumo atual da carteira</h2></div></div><div><p>Capital ainda emprestado<strong>${money(data.currentPortfolio.lent)}</strong></p><p>Saldo total a receber<strong>${money(data.currentPortfolio.receivable)}</strong></p><p>Juros previstos no saldo<strong>${money(Math.max(0, data.currentPortfolio.receivable - data.currentPortfolio.lent))}</strong></p></div><small>Estes três valores mostram a posição atual no momento da geração; as demais seções consideram apenas ${escapeHtml(period.label)}.</small></section>
    <section class="pdf-section"><div class="pdf-section-heading"><div><span>NOVAS OPERAÇÕES</span><h2>Empréstimos cadastrados no mês</h2></div><b>${data.loansCreated.length}</b></div>${reportTable(["Data", "Cliente / contrato", "Frequência", "Emprestado", "Total previsto"], loanRows, "Nenhum empréstimo foi cadastrado neste mês.")}</section>
    <section class="pdf-section"><div class="pdf-section-heading"><div><span>CAIXA</span><h2>Recebimentos do mês</h2></div><b>${money(data.received)}</b></div>${reportTable(["Data", "Cliente / parcela", "Tipo", "Valor"], receiptRows, "Nenhum recebimento foi registrado neste mês.")}</section>
    <section class="pdf-section"><div class="pdf-section-heading"><div><span>RASTREABILIDADE</span><h2>Histórico completo do mês</h2></div><b>${data.activities.length}</b></div>${reportTable(["Quando", "Alteração realizada"], activityRows, "Nenhuma alteração foi registrada neste mês.")}</section>
    <footer class="pdf-report-footer"><div><b>CredMais</b><span>Relatório de ${escapeHtml(period.label)}</span></div><p>Documento gerado pelo sistema. Confira as informações antes de imprimir ou compartilhar.</p></footer>`;
  stage.className = "pdf-render-stage";
  stage.appendChild(article);
  document.body.appendChild(stage);
  return article;
}
async function downloadMonthlyReport(event) {
  event.preventDefault();
  if (!requirePlatformAccess("gerar o relatório mensal")) return;
  const form = event.currentTarget,
    period = reportPeriod($("#reportMonth").value);
  if (!period) return toast("Escolha um mês válido para gerar o relatório.");
  if (!window.html2pdf)
    return toast("O gerador de PDF não carregou. Atualize o aplicativo e tente novamente.");
  if (!beginSubmission(form, "monthly-report")) return;
  let report,
    renderMask;
  try {
    toast("Preparando o relatório mensal...");
    const data = monthlyReportData(period);
    report = buildMonthlyReport(period, data);
    renderMask = document.createElement("div");
    renderMask.className = "pdf-render-mask";
    renderMask.innerHTML = '<div><span class="loader-spinner"></span><b>Gerando seu relatório</b><small>Organizando gráficos e movimentações...</small></div>';
    document.body.appendChild(renderMask);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const filename = `credmais-relatorio-${period.key}.pdf`,
      worker = window
        .html2pdf()
        .set({
          margin: [7, 7, 11, 7],
          filename,
          image: { type: "jpeg", quality: 0.97 },
          html2canvas: {
            scale: 1.65,
            useCORS: true,
            backgroundColor: "#f2f6f4",
            logging: false,
            scrollX: -window.scrollX,
            scrollY: -window.scrollY,
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"], avoid: ["tr", ".pdf-avoid-break"] },
        })
        .from(report);
    await worker.save();
    closeModals();
    toast(`Relatório de ${period.label} baixado com sucesso.`);
  } catch (error) {
    console.error("Falha ao gerar relatório:", error);
    toast("Não foi possível gerar o PDF. Tente novamente.");
  } finally {
    report?.closest(".pdf-render-stage")?.remove();
    renderMask?.remove();
    endSubmission(form, "monthly-report");
  }
}
function financialsForLoan(loan) {
  let receivable = 0,
    received = 0,
    principalPaid = 0;
  for (let index = 0; index < loan.installments; index += 1) {
    const info = installmentInfo(loan, index),
      status = paymentStateFor(loan, index);
    received += receivedAmountFor(loan, index, info);
    principalPaid += principalPositionFor(loan, index).paid;
    if (status === "paid") continue;
    if (status === "interest") {
      if (index === loan.installments - 1) receivable += info.deferred;
      continue;
    }
    if (status === "partial") {
      if (index === loan.installments - 1)
        receivable += Number(info.partial?.adjustedRemaining || 0);
      continue;
    }
    receivable += Number(info.due || 0);
  }
  const lent = Math.max(
    0,
    roundCurrency(Number(loan.amount) - Math.min(loan.amount, principalPaid)),
  );
  return { lent, receivable, received };
}
function outstandingInstallmentAmount(loan, index, date, includeLate = false) {
  const status = paymentStateFor(loan, index),
    info = installmentInfo(loan, index),
    isLast = index === Number(loan.installments) - 1;
  if (status === "paid") return 0;
  if (status === "interest")
    return isLast ? roundCurrency(Number(info.deferred || 0)) : 0;
  if (status === "partial")
    return isLast
      ? roundCurrency(Number(info.partial?.adjustedRemaining || 0))
      : 0;
  const late = includeLate ? lateCharge(loan, date).value : 0;
  return roundCurrency(Number(info.due || 0) + Number(late || 0));
}
function financialDashboardSummary(loans, referenceDate = new Date()) {
  const today = new Date(referenceDate);
  today.setHours(0, 0, 0, 0);
  const endOfToday = new Date(today);
  endOfToday.setDate(endOfToday.getDate() + 1);
  const endOf7Days = new Date(today);
  endOf7Days.setDate(endOf7Days.getDate() + 8);
  const endOf30Days = new Date(today);
  endOf30Days.setDate(endOf30Days.getDate() + 31);
  const clientOverdue = new Map();
  const summary = {
    overdueTotal: 0,
    overdueCount: 0,
    topOverdueClient: null,
    today: 0,
    sevenDays: 0,
    thirtyDays: 0,
  };
  loans.forEach((loan) => {
    Array.from({ length: Number(loan.installments) || 0 }, (_, index) => {
      const date = dateFor(loan, index),
        status = paymentStateFor(loan, index),
        isOverdue = status === "missed" || dueStatus(date) === "Vencida",
        baseAmount = outstandingInstallmentAmount(loan, index, date);
      if (isOverdue) {
        const overdueAmount = outstandingInstallmentAmount(
          loan,
          index,
          date,
          true,
        );
        if (overdueAmount > 0) {
          summary.overdueTotal += overdueAmount;
          summary.overdueCount += 1;
          clientOverdue.set(
            loan.clientId,
            (clientOverdue.get(loan.clientId) || 0) + overdueAmount,
          );
        }
        return;
      }
      if (baseAmount <= 0 || date < today || date >= endOf30Days) return;
      if (date < endOfToday) summary.today += baseAmount;
      if (date < endOf7Days) summary.sevenDays += baseAmount;
      summary.thirtyDays += baseAmount;
    });
  });
  const topEntry = Array.from(clientOverdue.entries()).sort(
    (first, second) => second[1] - first[1],
  )[0];
  if (topEntry) {
    const client = state.clients.find((item) => item.id === topEntry[0]);
    summary.topOverdueClient = {
      name: client?.name || "Cliente removido",
      amount: roundCurrency(topEntry[1]),
    };
  }
  summary.overdueTotal = roundCurrency(summary.overdueTotal);
  summary.today = roundCurrency(summary.today);
  summary.sevenDays = roundCurrency(summary.sevenDays);
  summary.thirtyDays = roundCurrency(summary.thirtyDays);
  return summary;
}
function activeLoanOperationalSummary(loans) {
  const summary = { total: 0, paid: 0, open: 0, overdue: 0, progress: 0 };
  loans.forEach((loan) => {
    const installments = Math.max(0, Number(loan.installments) || 0);
    for (let index = 0; index < installments; index += 1) {
      const paymentState = paymentStateFor(loan, index);
      summary.total += 1;
      if (paymentState === "paid") {
        summary.paid += 1;
        continue;
      }
      summary.open += 1;
      if (
        paymentState === "missed" ||
        dueStatus(dateFor(loan, index)) === "Vencida"
      )
        summary.overdue += 1;
    }
  });
  summary.progress = summary.total
    ? Math.round((summary.paid / summary.total) * 100)
    : 0;
  return summary;
}
function renderStats() {
  const now = new Date();
  renderedMonthKey = monthKey(now);
  const activeLoans = state.loans.filter(
    (loan) => !loan.archived && !isLoanFullyPaid(loan),
  ),
    activeClientIds = new Set(activeLoans.map((loan) => loan.clientId)),
    activeClients = state.clients.filter((client) =>
      activeClientIds.has(client.id),
    ).length,
    loanOperations = activeLoanOperationalSummary(activeLoans);
  const totals = state.loans
    .filter((loan) => !loan.archived)
    .reduce(
      (sum, loan) => {
        const values = financialsForLoan(loan);
        sum.lent += values.lent;
        sum.receivable += values.receivable;
        return sum;
      },
      { lent: 0, receivable: 0 },
    );
  const { lent, receivable } = totals,
    received = receivedInMonth(now),
    receivedBreakdown = receivedBreakdownInMonth(now),
    financialSummary = financialDashboardSummary(activeLoans, now);
  const interest = Math.max(0, receivable - lent);
  $("#statLent").textContent = money(lent);
  $("#statReceivable").textContent = money(receivable);
  $("#statReceived").textContent = money(received);
  $("#statReceived").previousElementSibling.textContent =
    `Recebido em ${now.toLocaleDateString("pt-BR", { month: "long" })}`;
  $("#statClients").textContent = state.clients.length;
  $("#statActiveClients").textContent = activeClients;
  $("#statLoans").textContent = activeLoans.length;
  $("#statOpenInstallments").textContent = `${loanOperations.open} parcela${loanOperations.open === 1 ? "" : "s"} em aberto`;
  const loanAlert = $("#statLoanAlert");
  loanAlert.textContent = loanOperations.overdue
    ? `${loanOperations.overdue} vencida${loanOperations.overdue === 1 ? "" : "s"}`
    : "Tudo em dia";
  loanAlert.classList.toggle("overdue", loanOperations.overdue > 0);
  loanAlert.classList.toggle("healthy", loanOperations.overdue === 0);
  const loanProgress = $("#activeLoanProgress");
  loanProgress.style.setProperty("--active-progress", `${loanOperations.progress}%`);
  loanProgress.setAttribute("aria-valuenow", String(loanOperations.progress));
  $("#statLoanProgressText").textContent = loanOperations.total
    ? `${loanOperations.progress}% das parcelas quitadas`
    : "Sem parcelas cadastradas";
  $("#chartTotal").textContent = money(receivable);
  $("#legendLent").textContent = money(lent);
  $("#legendInterest").textContent = money(interest);
  $("#overdueTotal").textContent = money(financialSummary.overdueTotal);
  $("#overdueCount").textContent = financialSummary.overdueCount;
  $("#topOverdueClient").textContent = financialSummary.topOverdueClient
    ? `Maior atraso: ${financialSummary.topOverdueClient.name} · ${money(financialSummary.topOverdueClient.amount)}`
    : "Nenhum cliente em atraso";
  $("#forecastToday").textContent = money(financialSummary.today);
  $("#forecast7Days").textContent = money(financialSummary.sevenDays);
  $("#forecast30Days").textContent = money(financialSummary.thirtyDays);
  $("#realInterestReceived").textContent = money(receivedBreakdown.interest);
  $("#capitalRecovered").textContent = money(receivedBreakdown.principal);
  $("#viewOverdueButton").disabled = financialSummary.overdueCount === 0;
  $("#financeChart").style.setProperty(
    "--lent-percent",
    `${receivable ? Math.round((lent / receivable) * 100) : 100}%`,
  );
  const recent = $("#recentLoans");
  if (!activeLoans.length) {
    recent.className = "empty";
    recent.innerHTML =
      '<span>◫</span><h4>Nenhum empréstimo ainda</h4><p>Comece cadastrando um novo empréstimo.</p><button class="outline add-loan">Criar empréstimo</button>';
  } else {
    recent.className = "loan-list";
    recent.innerHTML = activeLoans.slice(-4).reverse().map(loanRow).join("");
  }
  renderDueLoans();
}
function renderDueLoans(overdueOnly = false) {
  const pending = state.loans
    .filter((loan) => !loan.archived)
    .flatMap((loan) =>
      Array.from({ length: loan.installments }, (_, index) => ({
        loan,
        index,
        date: dateFor(loan, index),
      })),
    )
    .filter((item) => {
      const status = installmentStatus(item.loan, item.index, item.date);
      if (status === "Quitada") return false;
      if (overdueOnly)
        return (
          (paymentStateFor(item.loan, item.index) === "missed" ||
            dueStatus(item.date) === "Vencida") &&
          outstandingInstallmentAmount(item.loan, item.index, item.date, true) >
            0
        );
      return dueStatus(item.date) !== "A vencer";
    })
    .sort((a, b) => b.date - a.date),
    visible = overdueOnly ? pending : pending.slice(0, 4);
  $("#duePanelTitle").textContent = overdueOnly
    ? "Parcelas atrasadas"
    : "Cobranças para hoje";
  $("#duePanelDescription").textContent = overdueOnly
    ? "Lista completa das cobranças que já venceram."
    : "Parcelas que exigem atenção.";
  $("#dueLoans").innerHTML = visible.length
    ? visible
        .map(({ loan, index, date }) => {
          const client = state.clients.find(
              (item) => item.id === loan.clientId,
            ),
            late = lateCharge(loan, date);
          return `<div class="due-item"><div><b>${escapeHtml(client?.name || "Cliente removido")}</b><span>${installmentStatus(loan, index, date)}${late.value ? ` · +${money(late.value)}` : ""}</span></div><button class="whatsapp" data-whatsapp="${escapeHtml(loan.id)}" data-installment="${index}"><img class="whatsapp-button-icon" src="icons/whatsapp.svg" alt="" aria-hidden="true">Cobrar</button></div>`;
        })
        .join("")
    : '<div class="empty compact"><span>✓</span><h4>Tudo em dia</h4><p>Não há cobranças vencidas ou para hoje.</p></div>';
}
function renderClients() {
  const term = searchableText($("#clientSearch")?.value || "");
  const clients = state.clients.filter((client) =>
    searchableText(client.name, client.cpf, client.phone).includes(term),
  );
  $("#clientCount").textContent =
    `${clients.length} cliente${clients.length === 1 ? "" : "s"}`;
  $("#clientsList").innerHTML = clients.length
    ? clients
        .map((client) => {
          const count = state.loans.filter(
            (loan) => loan.clientId === client.id,
          ).length;
          return `<article class="client-card"><button class="client-card-open" type="button" data-client-profile="${escapeHtml(client.id)}" aria-label="Ver perfil e empréstimos de ${escapeHtml(client.name)}"><span class="client-avatar">${escapeHtml(initials(client.name))}</span><span class="client-card-body"><span class="client-card-name">${escapeHtml(client.name)}</span><span class="client-card-contact">${escapeHtml(client.phone || client.email || "Sem contato informado")}</span><span class="client-card-meta"><span>${count} empréstimo${count === 1 ? "" : "s"}</span><span class="badge ${client.blacklisted ? "danger" : ""}">${client.blacklisted ? "Lista negra" : "Ativo"}</span><span class="client-card-arrow" aria-hidden="true">›</span></span></span></button><div class="card-actions"><button class="edit-button" type="button" data-edit-client="${escapeHtml(client.id)}" aria-label="Editar ${escapeHtml(client.name)}">✎</button><button class="edit-button delete-button" type="button" data-delete-client="${escapeHtml(client.id)}" aria-label="Excluir ${escapeHtml(client.name)}">⌫</button></div></article>`;
        })
        .join("")
    : '<div class="empty"><span>♙</span><h4>Nenhum cliente encontrado</h4><p>Cadastre seu primeiro cliente para começar.</p><button class="outline" data-open-client>Novo cliente</button></div>';
}
function openClientProfile(clientId, preserveTab = false) {
  if (!state.clients.some((client) => client.id === clientId)) {
    toast("Este cliente não está mais disponível. A lista foi atualizada.");
    renderClients();
    return;
  }
  selectedClientProfileId = clientId;
  if (!preserveTab) clientProfileTab = "loans";
  renderClientProfile();
  openModal("clientProfileModal");
}
function renderClientProfile() {
  const client = state.clients.find((item) => item.id === selectedClientProfileId);
  if (!client) {
    closeModals();
    return;
  }
  const loans = state.loans
    .filter((loan) => loan.clientId === client.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const activeCount = loans.filter((loan) => !loan.archived && (Number(loan.installments) <= 0 || !isLoanFullyPaid(loan))).length;
  const paidCount = loans.filter((loan) => Number(loan.installments) > 0 && isLoanFullyPaid(loan)).length;
  const installments = loans.flatMap((loan) =>
    Array.from({ length: Math.max(0, Number(loan.installments) || 0) }, (_, index) => ({ loan, index, due: dateFor(loan, index) })),
  ).sort((a, b) => {
    const aPaid = paymentStateFor(a.loan, a.index) === "paid";
    const bPaid = paymentStateFor(b.loan, b.index) === "paid";
    return Number(aPaid) - Number(bPaid) || a.due - b.due;
  });
  if (!installments.length) clientProfileTab = "loans";
  const loanCards = loans.length
    ? loans.map((loan) => {
      const settled = Number(loan.installments) > 0 && isLoanFullyPaid(loan);
      const status = settled ? "Quitado" : loan.archived ? "Arquivado" : "Em andamento";
      const statusClass = settled ? "settled" : loan.archived ? "archived" : "active";
      const paidInstallments = Array.from({ length: Number(loan.installments) || 0 }, (_, index) => paymentStateFor(loan, index)).filter((item) => item === "paid").length;
      const financials = financialsForLoan(loan);
      const created = loan.createdAt ? new Date(loan.createdAt) : null;
      const createdLabel = created && !Number.isNaN(created.getTime()) ? `Criado em ${created.toLocaleDateString("pt-BR")}` : "Empréstimo cadastrado";
      return `<article class="client-loan-card"><div class="client-loan-top"><div><span class="client-loan-contract">${escapeHtml(loan.contract || "Empréstimo")}</span><small>${createdLabel}</small></div><span class="client-loan-status ${statusClass}">${status}</span></div><div class="client-loan-values"><span><small>Emprestado</small><strong>${money(loan.amount)}</strong></span><span><small>Saldo a receber</small><strong>${money(financials.receivable)}</strong></span></div><div class="client-loan-bottom"><span>${paidInstallments} de ${Number(loan.installments) || 0} parcelas quitadas</span><button class="outline small" type="button" data-client-loan="${escapeHtml(loan.id)}">${Number(loan.installments) > 0 ? "Ver parcelas" : "Ver empréstimo"} →</button></div></article>`;
    }).join("")
    : '<div class="client-profile-empty"><span aria-hidden="true">◫</span><h3>Nenhum empréstimo ainda</h3><p>Quando houver um empréstimo para este cliente, ele aparecerá aqui.</p><button class="primary" type="button" data-client-new-loan>Fazer primeiro empréstimo</button></div>';
  const installmentCards = installments.map(({ loan, index, due }) => {
    const status = installmentStatus(loan, index, due);
    const info = installmentInfo(loan, index);
    const lateValue = status === "Vencida" || status === "Não pagou" ? lateCharge(loan, due).value : 0;
    const amount = status === "Quitada" ? receivedAmountFor(loan, index, info)
      : status === "Só juros" ? Number(info.interestOnlyValue || 0)
        : status === "Pagamento parcial" ? Number(info.partial?.adjustedRemaining || 0)
          : Number(info.due || 0) + lateValue;
    return `<button class="client-installment-row" type="button" data-client-loan="${escapeHtml(loan.id)}" data-client-installment="${index}" aria-label="Ver parcela ${index + 1} de ${escapeHtml(loan.contract || "empréstimo")}"><span class="client-installment-main"><b>Parcela ${index + 1} de ${Number(loan.installments) || 0}</b><small>${escapeHtml(loan.contract || "Empréstimo")} · vence ${due.toLocaleDateString("pt-BR")}</small></span><span class="client-installment-end"><em class="due ${installmentStatusClass(status)}">${status}</em><strong>${money(amount)}</strong></span><span class="client-installment-arrow" aria-hidden="true">›</span></button>`;
  }).join("");
  $("#clientProfileContent").innerHTML = `<div class="client-profile-hero"><div class="client-profile-avatar" aria-hidden="true">${escapeHtml(initials(client.name))}</div><div><span class="eyebrow">PERFIL DO CLIENTE</span><h2 id="clientProfileTitle">${escapeHtml(client.name)}</h2><span class="badge ${client.blacklisted ? "danger" : ""}">${client.blacklisted ? "Lista negra" : "Cliente cadastrado"}</span></div></div><div class="client-profile-info"><div><small>Telefone / WhatsApp</small><b>${escapeHtml(client.phone || "Não informado")}</b></div>${client.cpf ? `<div><small>CPF</small><b>${escapeHtml(client.cpf)}</b></div>` : ""}${client.note ? `<div class="client-profile-note"><small>Observação</small><p>${escapeHtml(client.note)}</p></div>` : ""}</div><div class="client-profile-stats" aria-label="Resumo dos empréstimos"><div><strong>${loans.length}</strong><span>Empréstimos</span></div><div><strong>${activeCount}</strong><span>Em andamento</span></div><div><strong>${paidCount}</strong><span>Quitados</span></div></div><div class="client-profile-actions"><button class="primary" type="button" data-client-new-loan>＋ Novo empréstimo</button><button class="outline" type="button" data-edit-client="${escapeHtml(client.id)}">Editar cliente</button></div><div class="client-profile-tabs" role="group" aria-label="Histórico do cliente"><button type="button" data-client-profile-tab="loans" aria-pressed="${clientProfileTab === "loans"}">Empréstimos <b>${loans.length}</b></button>${installments.length ? `<button type="button" data-client-profile-tab="installments" aria-pressed="${clientProfileTab === "installments"}">Parcelas <b>${installments.length}</b></button>` : ""}</div><div class="client-profile-list">${clientProfileTab === "installments" ? installmentCards : loanCards}</div>`;
}
function openClientLoanDetails(loanId, installmentIndex) {
  const loan = state.loans.find((item) => item.id === loanId && item.clientId === selectedClientProfileId);
  if (!loan) {
    toast("Este empréstimo não está mais disponível. O perfil foi atualizado.");
    renderClientProfile();
    return;
  }
  const clientId = selectedClientProfileId;
  returnToClientId = clientId;
  expandedInstallment = Number.isInteger(installmentIndex) && installmentIndex >= 0 && installmentIndex < Number(loan.installments)
    ? `${loanId}:${installmentIndex}` : null;
  details(loanId);
}
function openLoanForClient() {
  const clientId = selectedClientProfileId;
  if (!state.clients.some((item) => item.id === clientId) || !requirePlatformAccess("criar empréstimos")) return;
  openLoan();
  if ($("#loanModal").hidden) return;
  $("#loanClient").value = clientId;
  calc();
  rememberModalState("loanModal");
}
function renderBlacklist() {
  const clients = state.clients.filter((client) => client.blacklisted);
  $("#blacklistList").innerHTML = clients.length
    ? clients
        .map(
          (client) =>
            `<article class="client-card"><button class="client-card-open" type="button" data-client-profile="${escapeHtml(client.id)}" aria-label="Ver perfil e empréstimos de ${escapeHtml(client.name)}"><span class="client-avatar">${escapeHtml(initials(client.name))}</span><span class="client-card-body"><span class="client-card-name">${escapeHtml(client.name)}</span><span class="client-card-contact">${escapeHtml(client.phone || "Sem telefone")}</span><span class="client-card-meta"><span>Marcado para atenção</span><span class="badge danger">Lista negra</span><span class="client-card-arrow" aria-hidden="true">›</span></span></span></button><div class="card-actions"><button class="edit-button" type="button" data-toggle-blacklist="${escapeHtml(client.id)}" aria-label="Remover ${escapeHtml(client.name)} da lista negra">✓</button></div></article>`,
        )
        .join("")
    : '<div class="empty"><span>✓</span><h4>Nenhum cliente na lista</h4><p>Clientes marcados aparecem aqui.</p></div>';
}
function loanRow(loan) {
  const client = state.clients.find((item) => item.id === loan.clientId) || {
    name: "Cliente removido",
    },
    financials = financialsForLoan(loan),
    firstInstallment = scheduledInstallmentFor(loan, 0),
    lastInstallment = scheduledInstallmentFor(
      loan,
      Number(loan.installments) - 1,
    ),
    paymentSummary =
      firstInstallment === lastInstallment
        ? `${loan.installments} pagamentos de ${money(firstInstallment)}`
        : `${loan.installments} pagamentos de ${money(firstInstallment)} · último de ${money(lastInstallment)}`;
  return `<article class="loan-row"><div><h3>${escapeHtml(client.name)}</h3><p>${paymentSummary} · ${formatFrequency(loan.frequency || 30, loan.businessDays)}</p></div><div class="loan-extra"><p>Emprestado</p><b>${money(loan.amount)}</b></div><div class="loan-extra"><p>1º vencimento</p><b>${dateFor(loan, 0).toLocaleDateString("pt-BR")}</b></div><div class="loan-value"><small>Saldo a receber</small><b>${money(financials.receivable)}</b></div><button data-details="${escapeHtml(loan.id)}">Detalhes →</button></article>`;
}
function renderLoans() {
  const term = searchableText($("#loanSearch")?.value || "");
  const activeLoans = state.loans
    .filter((loan) => !loan.archived && !isLoanFullyPaid(loan))
    .filter((loan) => {
      const client = state.clients.find((item) => item.id === loan.clientId),
        financials = financialsForLoan(loan);
      return searchableText(
        client?.name,
        client?.phone,
        client?.cpf,
        loan.contract,
        loan.amount,
        money(loan.amount),
        financials.receivable,
        money(financials.receivable),
        formatFrequency(loan.frequency || 30, loan.businessDays),
      ).includes(term);
    });
  const loanCount = $("#loanCount");
  if (loanCount)
    loanCount.textContent = `${activeLoans.length} empréstimo${activeLoans.length === 1 ? "" : "s"}`;
  $("#loansList").innerHTML = activeLoans.length
    ? activeLoans.slice().reverse().map(loanRow).join("")
    : term
      ? '<div class="empty"><span>⌕</span><h4>Nenhum empréstimo encontrado</h4><p>Tente buscar por outro nome, contrato ou valor.</p></div>'
      : '<div class="empty"><span>◫</span><h4>Nenhum empréstimo ativo</h4><p>Crie uma operação quando estiver pronto.</p><button class="outline add-loan">Criar empréstimo</button></div>';
}
function renderPaid() {
  const paidLoans = state.loans
    .filter((loan) => Number(loan.installments) > 0 && isLoanFullyPaid(loan))
    .map((loan) => ({
      loan,
      paidAt: Array.from({ length: loan.installments }, (_, index) =>
        paidInstallmentDate(loan, index),
      ).sort((a, b) => b - a)[0],
    }))
    .sort((a, b) => b.paidAt - a.paidAt);
  const paidInstallments = state.loans
    .flatMap((loan) =>
      Array.from({ length: loan.installments }, (_, index) => ({
        loan,
        index,
        status: paymentStateFor(loan, index),
        paidAt: paidInstallmentDate(loan, index),
      })),
    )
    .filter((item) => item.status === "paid")
    .sort((a, b) => b.paidAt - a.paidAt);
  $("#paidLoanCount").textContent = paidLoans.length;
  $("#paidInstallmentCount").textContent = paidInstallments.length;
  $("#paidLoansList").innerHTML = paidLoans.length
    ? paidLoans
        .map(({ loan, paidAt }) => {
          const client = state.clients.find((item) => item.id === loan.clientId);
          return `<article class="settlement-card"><span class="settlement-icon" aria-hidden="true">✓</span><div class="settlement-content"><span class="settlement-kicker">${escapeHtml(loan.contract || "Empréstimo")} · CONTRATO QUITADO</span><div class="settlement-heading"><h3>${escapeHtml(client?.name || "Cliente removido")}</h3><strong>${money(financialsForLoan(loan).received)}</strong></div><div class="settlement-bottom"><p>${loan.installments} ${loan.installments === 1 ? "parcela" : "parcelas"} · quitado em ${paidAt.toLocaleDateString("pt-BR")}</p><button class="outline small" type="button" data-details="${escapeHtml(loan.id)}">Detalhes →</button></div></div></article>`;
        })
        .join("")
    : '<div class="empty compact"><span>✓</span><h4>Nenhum empréstimo quitado</h4><p>Os contratos aparecerão aqui quando todas as parcelas forem pagas.</p><button class="outline" type="button" data-paid-view="installments">Ver parcelas quitadas</button></div>';
  $("#paidInstallmentsList").innerHTML = paidInstallments.length
    ? paidInstallments
        .map(({ loan, index, paidAt }) => {
          const client = state.clients.find((item) => item.id === loan.clientId),
            info = installmentInfo(loan, index),
            received = receivedAmountFor(loan, index, info);
          return `<article class="settlement-card"><span class="settlement-icon" aria-hidden="true">✓</span><div class="settlement-content"><span class="settlement-kicker">${escapeHtml(loan.contract || "Empréstimo")} · PARCELA ${index + 1}/${loan.installments}</span><div class="settlement-heading"><h3>${escapeHtml(client?.name || "Cliente removido")}</h3><strong>${money(received)}</strong></div><div class="settlement-bottom"><p>Quitada em ${paidAt.toLocaleDateString("pt-BR")}</p><button class="outline small" type="button" data-details="${escapeHtml(loan.id)}">Detalhes →</button></div></div></article>`;
        })
        .join("")
    : '<div class="empty compact"><span>✓</span><h4>Nenhuma parcela quitada</h4><p>As parcelas pagas aparecerão aqui conforme os recebimentos forem registrados.</p></div>';
  selectPaidView(state.paidView);
}
function paidInstallmentDate(loan, index) {
  const recorded = loan.paymentStates?.[index]?.createdAt,
    paidAt = recorded ? new Date(recorded) : null;
  return paidAt && !Number.isNaN(paidAt.getTime())
    ? paidAt
    : dateFor(loan, index);
}
function selectPaidView(view) {
  if (view !== "loans" && view !== "installments") return;
  state.paidView = view;
  $("#paidLoansPanel").hidden = view !== "loans";
  $("#paidInstallmentsPanel").hidden = view !== "installments";
  document.querySelectorAll("[data-paid-view]").forEach((button) => {
    if (!button.classList.contains("paid-view-tab")) return;
    button.setAttribute("aria-pressed", String(button.dataset.paidView === view));
  });
}
function renderHistory() {
  const archived = state.loans.filter((loan) => loan.archived);
  const icons = {
    client: "♙",
    loan: "◫",
    payment: "R$",
    settings: "◇",
    undo: "↶",
  };
  $("#activityHistory").innerHTML = state.history.length
    ? state.history
        .slice()
        .reverse()
        .map((entry) => {
          const date = new Date(entry.createdAt);
          return `<article class="activity-item"><span class="activity-icon">${escapeHtml(icons[entry.category] || "•")}</span><div><h4>${escapeHtml(entry.title)}</h4><p>${escapeHtml(entry.description || "")}</p></div><time datetime="${escapeHtml(entry.createdAt)}">${date.toLocaleDateString("pt-BR")}<small>${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></time></article>`;
        })
        .join("")
    : '<div class="empty compact"><span>◷</span><h4>Nenhuma atividade registrada</h4><p>As próximas alterações feitas no sistema aparecerão aqui.</p></div>';
  $("#historyList").innerHTML = archived.length
    ? archived
        .slice()
        .reverse()
        .map((loan) =>
          `${loanRow(loan).replace("Detalhes →", "Ver →")}`.replace(
            "</article>",
            '<span class="archived-tag">Arquivado</span></article>',
          ),
        )
        .join("")
    : '<div class="empty compact"><span>✓</span><h4>Nenhum empréstimo arquivado</h4><p>Os contratos arquivados aparecerão nesta seção.</p></div>';
}
function calc() {
  const amount = readCurrencyInput($("#loanAmount"));
  const rate = (Number($("#loanInterest").value) || 0) / 100;
  const periods = Math.max(1, Number($("#loanInstallments").value) || 1);
  const mode = $("#loanInterestMode").value;
  const frequencyDays = selectedFrequencyDays(),
    businessDays = selectedBusinessDays(),
    frequency = frequencyDays
      ? formatFrequency(frequencyDays, businessDays).toLowerCase()
      : "personalizado";
  const total = roundCurrency(
    mode === "compound"
      ? amount * Math.pow(1 + rate, periods)
      : mode === "simple"
        ? amount * (1 + rate * periods)
      : amount * (1 + rate),
  );
  const installment = roundCurrency(total / periods);
  $("#calcInterest").textContent = money(total - amount);
  $("#calcTotal").textContent = money(total);
  $("#calcInstallment").textContent = money(installment);
  const rateLabel = (rate * 100).toLocaleString("pt-BR");
  $("#calcExplanation").textContent =
    mode === "compound"
      ? `${rateLabel}% de juros compostos por período: os juros são reaplicados ${periods} vez${periods === 1 ? "" : "es"}, chegando a ${money(total)}, com vencimento ${frequency}.`
      : mode === "simple"
        ? `${rateLabel}% de juros simples sobre ${money(amount)} em cada um dos ${periods} período${periods === 1 ? "" : "s"}: total de ${money(total)}, com vencimento ${frequency}.`
        : `${money(amount)} + taxa única de ${rateLabel}% = ${money(total)}. A quantidade de pagamentos apenas divide esse total, com vencimento ${frequency}.`;
  return {
    amount,
    rate,
    periods,
    total,
    installment,
    frequency: frequencyDays,
    businessDays,
    interestMode: mode,
  };
}
async function saveClient(event) {
  event.preventDefault();
  if (!requirePlatformAccess("salvar clientes")) return;
  const form = event.currentTarget;
  const snapshot = stateSnapshot();
  const cpf = digits($("#clientCpf").value),
    phone = digits($("#clientPhone").value);
  if (cpf && !isValidCpf(cpf)) {
    renderClientCpfValidation(true);
    $("#clientCpf").focus();
    return toast("CPF inválido. Corrija os números ou deixe o campo em branco.");
  }
  if (phone.length < 10 || phone.length > 11)
    return toast("Informe um telefone válido com DDD.");
  if (!beginSubmission(form, "client")) return;
  const previous = state.clients.find(
    (item) => item.id === $("#clientId").value,
  );
  const client = {
    id: $("#clientId").value || crypto.randomUUID(),
    name: $("#clientName").value.trim(),
    cpf: cpf ? formatCpf(cpf) : "",
    phone: formatPhone(phone),
    email: previous?.email || "",
    note: $("#clientNote").value.trim(),
    blacklisted: previous?.blacklisted || false,
  };
  const index = state.clients.findIndex((item) => item.id === client.id);
  if (index >= 0) state.clients[index] = client;
  else state.clients.push(client);
  addHistory(
    "client",
    index >= 0 ? "Cliente atualizado" : "Cliente cadastrado",
    `${client.name} teve o cadastro ${index >= 0 ? "alterado" : "criado"}.`,
  );
  try {
    const synced = await save();
    closeModals();
    render();
    const message =
      !synced
        ? "Cliente salvo neste dispositivo. A sincronização será tentada novamente."
        : index >= 0
          ? "Cliente atualizado com sucesso."
          : "Cliente cadastrado com sucesso.";
    toast(message, async () => {
      if (index < 0 && window.credmaisBridge?.enabled)
        await window.credmaisBridge.deleteClient(client.id);
      await restoreSnapshot(snapshot, "clients");
    });
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    render();
    toast(error.message || "Não foi possível salvar o cliente.");
  } finally {
    endSubmission(form, "client");
  }
}
async function saveLoan(event) {
  event.preventDefault();
  if (!requirePlatformAccess("salvar empréstimos")) return;
  const form = event.currentTarget;
  const snapshot = stateSnapshot();
  const calculation = calc();
  if (!calculation.amount) return toast("Informe o valor emprestado.");
  if (!calculation.frequency)
    return toast("Informe o intervalo personalizado entre 1 e 365 dias.");
  if (!beginSubmission(form, "loan")) return;
  const previous = state.loans.find((item) => item.id === $("#loanId").value);
  const loan = {
    id: $("#loanId").value || crypto.randomUUID(),
    contract: previous?.contract || `EMP-${String(Date.now()).slice(-5)}`,
    clientId: $("#loanClient").value,
    amount: calculation.amount,
    rate: calculation.rate,
    interestMode: calculation.interestMode,
    installments: calculation.periods,
    frequency: calculation.frequency,
    businessDays: calculation.businessDays,
    lateFee: readCurrencyInput($("#loanLateFee")),
    total: calculation.total,
    installment: calculation.installment,
    dueDate: $("#loanDueDate").value,
    paymentStates: previous?.paymentStates || {},
    customDates: previous?.customDates || {},
    archived: previous?.archived || false,
    createdAt: previous?.createdAt || new Date().toISOString(),
  };
  const index = state.loans.findIndex((item) => item.id === loan.id);
  if (index >= 0) state.loans[index] = loan;
  else state.loans.push(loan);
  const loanClient = state.clients.find((client) => client.id === loan.clientId);
  addHistory(
    "loan",
    index >= 0 ? "Empréstimo atualizado" : "Empréstimo criado",
    `${loan.contract} · ${loanClient?.name || "Cliente"} · ${money(loan.amount)} · ${formatFrequency(loan.frequency, loan.businessDays)} · ${interestDescription(loan)} · total ${money(loan.total)}.`,
  );
  try {
    const synced = await save();
    closeModals();
    setPage("loans");
    const message =
      !synced
        ? "Empréstimo salvo neste dispositivo. A sincronização será tentada novamente."
        : index >= 0
          ? "Empréstimo atualizado com sucesso."
          : "Empréstimo cadastrado com sucesso.";
    toast(message, async () => {
      if (index < 0) {
        closeModals();
        if (window.credmaisBridge?.enabled)
          await window.credmaisBridge.deleteLoan(loan.id);
      }
      await restoreSnapshot(snapshot, "loans");
    });
    if (index < 0) openContractShare(loan.id);
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    render();
    toast(error.message || "Não foi possível salvar o empréstimo.");
  } finally {
    endSubmission(form, "loan");
  }
}
function installmentInfo(loan, index) {
  let carry = 0;
  for (let current = 0; current < index; current += 1) {
    const scheduledInterest = Math.min(
        scheduledInstallmentFor(loan, current),
        interestModeFor(loan) === "flat"
          ? Math.max(0, loan.total - loan.amount) / loan.installments
          : loan.amount * loan.rate,
      ),
      due = roundCurrency(scheduledInstallmentFor(loan, current) + carry),
      previousPayment = loan.paymentStates?.[current],
      previousState = paymentStateFor(loan, current);
    carry =
      previousState === "interest"
        ? Number(
            typeof previousPayment === "object" &&
              previousPayment.deferredRemaining != null
              ? previousPayment.deferredRemaining
              : due - scheduledInterest,
          )
        : previousState === "partial" && typeof previousPayment === "object"
          ? Number(previousPayment.adjustedRemaining || 0)
          : 0;
  }
  const scheduledInterest = Math.min(
      scheduledInstallmentFor(loan, index),
      interestModeFor(loan) === "flat"
        ? Math.max(0, loan.total - loan.amount) / loan.installments
        : loan.amount * loan.rate,
    ),
    due = roundCurrency(scheduledInstallmentFor(loan, index) + carry),
    payment = loan.paymentStates?.[index],
    state = paymentStateFor(loan, index),
    partial = state === "partial" && typeof payment === "object" ? payment : null,
    interestOnlyValue = Math.max(
      0,
      state === "partial"
        ? Number(partial.adjustedRemaining || 0) - Number(partial.remaining || 0)
        : state === "interest" &&
            typeof payment === "object" &&
            payment.lastPayment != null
          ? Number(payment.lastPayment)
          : Math.min(scheduledInterest, due),
    ),
    deferred = Math.max(
      0,
      state === "partial"
        ? Number(partial.remaining ?? partial.adjustedRemaining ?? 0)
        : state === "interest" &&
            typeof payment === "object" &&
            payment.deferredRemaining != null
          ? Number(payment.deferredRemaining)
          : due - interestOnlyValue,
    );
  return {
    due,
    interestOnlyValue: Math.min(interestOnlyValue, due),
    deferred,
    nextDue:
      index < loan.installments - 1
        ? roundCurrency(
            scheduledInstallmentFor(loan, index + 1) + deferred,
          )
        : 0,
    state,
    partial,
  };
}
function toggleInstallment(loanId, index) {
  const key = `${loanId}:${index}`;
  expandedInstallment = expandedInstallment === key ? null : key;
  details(loanId);
}
function details(id) {
  const loan = state.loans.find((item) => item.id === id);
  if (!loan) {
    closeModals();
    toast("Este empréstimo não está mais disponível. A tela foi atualizada.");
    return;
  }
  const client = state.clients.find((item) => item.id === loan.clientId),
    financials = financialsForLoan(loan);
  const items = Array.from({ length: loan.installments }, (_, index) => {
    const date = dateFor(loan, index),
      status = installmentStatus(loan, index, date),
      late = lateCharge(loan, date),
      info = installmentInfo(loan, index),
      expanded = expandedInstallment === `${loan.id}:${index}`,
      visualStatus = installmentStatusClass(status),
      lateValue =
        status === "Vencida" || status === "Não pagou" ? late.value : 0,
      partial = info.partial,
      value =
        status === "Só juros"
          ? info.interestOnlyValue
          : status === "Pagamento parcial"
            ? Number(partial?.adjustedRemaining || 0)
            : info.due + lateValue,
      charge = lateValue
        ? `${late.days} dia(s) de atraso · +${money(lateValue)}`
        : status === "Pagamento parcial"
          ? `Recebido ${money(partial?.receivedTotal ?? partial?.paidAmount)} · saldo atual ${money(partial?.adjustedRemaining)}`
          : "",
      interestGuide =
        index < loan.installments - 1
          ? `Pagar somente ${money(info.interestOnlyValue)} agora. O saldo de ${money(info.deferred)} será somado à próxima parcela, que ficará em ${money(info.nextDue)}.`
          : `Pagar ${money(info.interestOnlyValue)} de juros e renovar esta parcela ${loan.businessDays ? "para o próximo dia útil" : `por mais ${Number(loan.frequency || 30)} dias`}. O saldo principal continuará em aberto até a quitação.`,
      partialGuide = partial
        ? index < loan.installments - 1
          ? `💡 Total recebido nesta parcela: ${money(partial.receivedTotal ?? partial.paidAmount)}. Após o último pagamento de ${money(partial.lastPayment ?? partial.paidAmount)}, o saldo ficou em ${money(partial.adjustedRemaining)} e foi somado à próxima parcela.`
          : `💡 Total recebido nesta parcela: ${money(partial.receivedTotal ?? partial.paidAmount)}. O saldo atual de ${money(partial.adjustedRemaining)} permanece em aberto nesta última parcela.`
        : "";
    const actionIcon = '<span class="payment-action-icon" aria-hidden="true"></span>';
    const paymentActions = `<div class="payment-actions" role="group" aria-label="Ações da parcela">
      <p class="payment-actions-heading">Ações da parcela</p>
      <button type="button" data-payment="paid" data-loan="${loan.id}" data-installment="${index}">${actionIcon}<span>Marcar quitada</span></button>
      <button type="button" data-payment="interest" data-loan="${loan.id}" data-installment="${index}">${actionIcon}<span>Só juros</span></button>
      <button type="button" class="partial-button" data-partial="${loan.id}" data-installment="${index}">${actionIcon}<span>Pagamento parcial</span></button>
      <button type="button" data-postpone="${loan.id}" data-installment="${index}">${actionIcon}<span>Adiar prazo</span></button>
      <button type="button" class="danger-button" data-payment="missed" data-loan="${loan.id}" data-installment="${index}">${actionIcon}<span>Não pagou</span></button>
      <button type="button" class="open-button" data-payment="open" data-loan="${loan.id}" data-installment="${index}" ${loan.paymentStates?.[index] ? "" : 'disabled title="A parcela já está em aberto"'}>${actionIcon}<span>Deixar em aberto</span></button>
    </div>`;
    return `<article class="installment-card ${visualStatus} ${expanded ? "expanded" : ""}" data-installment-card="${index}"><button class="installment-summary" data-toggle-installment="${loan.id}" data-installment="${index}" aria-expanded="${expanded}"><span><b>Parcela ${index + 1} de ${loan.installments}</b><small>📅 ${date.toLocaleDateString("pt-BR")}${charge ? ` · ${charge}` : ""}</small></span><span class="installment-side"><em class="due ${visualStatus}">${status}</em><strong>${money(value)}</strong><i>${expanded ? "⌃" : "⌄"}</i></span></button>${expanded ? `<div class="installment-body"><p class="installment-help">${status === "Pagamento parcial" ? partialGuide : status === "Só juros" ? index < loan.installments - 1 ? `💡 Juros recebidos: ${money(info.interestOnlyValue)}. O próximo pagamento passa a ser ${money(info.nextDue)}.` : `💡 Juros recebidos: ${money(info.interestOnlyValue)}. Esta última parcela foi renovada e o saldo principal continua em aberto.` : interestGuide}</p><div class="installment-main-action"><button class="whatsapp" data-whatsapp="${loan.id}" data-installment="${index}"><img class="whatsapp-button-icon" src="icons/whatsapp.svg" alt="" aria-hidden="true">Enviar mensagem no WhatsApp</button></div>${paymentActions}</div>` : ""}</article>`;
  }).join("");
  $("#loanDetails").innerHTML =
    `${returnToClientId === loan.clientId ? '<button class="details-back-client" type="button" data-return-client>← Voltar ao cliente</button>' : ""}<div class="details-head"><div><span class="eyebrow">${escapeHtml(loan.contract || "EMP-S/CONTRATO")}</span><h2>${escapeHtml(client?.name || "Cliente")}</h2><p class="muted">${formatFrequency(loan.frequency || 30, loan.businessDays)} · ${interestDescription(loan)}</p></div><button class="outline small details-actions-trigger" data-toggle-details-actions aria-expanded="false">Ações ⋮</button></div><div class="details-actions-menu" data-details-actions-menu hidden><button class="outline small contract-message-action" data-contract-whatsapp="${escapeHtml(loan.id)}"><img class="whatsapp-button-icon" src="icons/whatsapp.svg" alt="" aria-hidden="true"> Enviar resumo do contrato no WhatsApp</button><button class="outline small" data-edit-loan="${escapeHtml(loan.id)}"><span>✎</span> Editar empréstimo</button><button class="outline small" data-edit-client="${escapeHtml(client?.id || "")}"><span>♙</span> Editar cliente</button><button class="outline small" data-toggle-blacklist="${escapeHtml(client?.id || "")}" data-loan-context="${escapeHtml(loan.id)}"><span>⚑</span> ${client?.blacklisted ? "Remover da lista negra" : "Adicionar à lista negra"}</button><button class="outline small" data-archive-loan="${escapeHtml(loan.id)}"><span>◷</span> ${loan.archived ? "Restaurar empréstimo" : "Arquivar empréstimo"}</button><button class="outline small delete-button" data-delete-loan="${escapeHtml(loan.id)}"><span>⌫</span> Excluir empréstimo</button></div><div class="details-summary"><div><span>Valor emprestado</span><b>${money(loan.amount)}</b></div><div><span>Saldo a receber</span><b>${money(financials.receivable)}</b></div><div><span>Valor recebido</span><b>${money(financials.received)}</b></div></div><p class="details-late-fee">Juros no atraso: ${money(loan.lateFee || 0)} por ${loan.businessDays ? "dia útil" : "dia"}.</p><h3>Parcelas</h3><p class="muted charge-note">Toque em uma parcela para ver as ações e a explicação do pagamento.</p><div class="installment-list">${items}</div>`;
  openModal("detailsModal");
  if (expandedInstallment?.startsWith(`${loan.id}:`)) {
    const installmentIndex = expandedInstallment.split(":")[1];
    requestAnimationFrame(() => {
      const card = $(`[data-installment-card="${installmentIndex}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}
function toggleDetailsActions(button) {
  const menu = $("[data-details-actions-menu]");
  if (!menu) return;
  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
  button.textContent = willOpen ? "Fechar ações ×" : "Ações ⋮";
}
async function updatePayment(loanId, installment, status, triggerButton = null) {
  if (!requirePlatformAccess("alterar parcelas")) return;
  const actionKey = "payment-action";
  if (submissionLocks.has(actionKey))
    return toast("Aguarde: outra alteração de parcela ainda está sendo salva.");
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return toast("Este empréstimo não foi encontrado. Atualize a tela.");
  const snapshot = stateSnapshot();
  loan.paymentStates = loan.paymentStates || {};
  const installmentIndex = Number(installment),
    infoBefore = installmentInfo(loan, installmentIndex),
    principalBefore = principalPositionFor(loan, installmentIndex),
    previousPayment = loan.paymentStates[installment],
    previousStatus = paymentStateFor(loan, installmentIndex),
    previousReceived = receivedAmountFor(
      loan,
      installmentIndex,
      infoBefore,
    ),
    previousReceipts = receiptEntriesFor(
      loan,
      installmentIndex,
      infoBefore,
    ),
    paymentCreatedAt = new Date().toISOString();
  const isLastInterest =
    status === "interest" && installmentIndex === loan.installments - 1;
  if (previousStatus === status && !isLastInterest)
    return toast("Esta parcela já está com essa situação.");
  if (status === "interest" && Number(infoBefore.interestOnlyValue || 0) <= 0)
    return toast("Este saldo não possui juros pendentes para receber.");
  submissionLocks.add(actionKey);
  const actionButtons = Array.from(
    triggerButton?.closest(".payment-actions")?.querySelectorAll("button") || [],
  );
  actionButtons.forEach((button) => {
    button.disabled = true;
  });
  triggerButton?.classList.add("is-action-loading");
  triggerButton?.setAttribute("aria-busy", "true");
  const actionFeedback = {
    paid: "Registrando a quitação e atualizando os saldos...",
    interest: "Registrando o pagamento dos juros...",
    missed: "Atualizando a situação da parcela...",
    open: "Reabrindo a parcela...",
  };
  toast(actionFeedback[status] || "Atualizando a parcela...");
  try {
    const remainingPayment =
      previousStatus === "partial" && typeof previousPayment === "object"
        ? Number(previousPayment.adjustedRemaining || 0)
        : previousStatus === "interest"
          ? Number(infoBefore.deferred || 0)
          : Number(infoBefore.due || 0);
    if (isLastInterest) {
      const renewedDate = addScheduleIntervals(
        dateFor(loan, installmentIndex),
        loan.frequency || 30,
        Boolean(loan.businessDays),
        1,
      );
      loan.customDates = loan.customDates || {};
      loan.customDates[installment] = renewedDate.toISOString().slice(0, 10);
    }
    if (status === "open") delete loan.paymentStates[installment];
    else if (status === "paid")
      loan.paymentStates[installment] = {
        status,
        principalPaid: roundCurrency(
          principalBefore.paid + principalBefore.remaining,
        ),
        principalRemaining: 0,
        receivedTotal: roundCurrency(
          (previousStatus === "partial" || previousStatus === "interest"
            ? previousReceived
            : 0) + remainingPayment,
        ),
        lastPayment: remainingPayment,
        receipts: [
          ...(previousStatus === "partial" || previousStatus === "interest"
            ? previousReceipts
            : []),
          {
            amount: remainingPayment,
            createdAt: paymentCreatedAt,
            type: "paid",
            principalAmount: roundCurrency(principalBefore.remaining),
            interestAmount: roundCurrency(
              Math.max(0, remainingPayment - principalBefore.remaining),
            ),
          },
        ],
        createdAt: paymentCreatedAt,
      };
    else if (status === "interest")
      loan.paymentStates[installment] = {
        status,
        principalPaid: principalBefore.paid,
        principalRemaining: principalBefore.remaining,
        receivedTotal: roundCurrency(
          (previousStatus === "partial" ||
          (previousStatus === "interest" && isLastInterest)
            ? previousReceived
            : 0) + Number(infoBefore.interestOnlyValue || 0),
        ),
        lastPayment: Number(infoBefore.interestOnlyValue || 0),
        receipts: [
          ...(previousStatus === "partial" ||
          (previousStatus === "interest" && isLastInterest)
            ? previousReceipts
            : []),
          {
            amount: Number(infoBefore.interestOnlyValue || 0),
            createdAt: paymentCreatedAt,
            type: "interest",
            principalAmount: 0,
            interestAmount: Number(infoBefore.interestOnlyValue || 0),
          },
        ],
        renewals:
          Number(
            typeof previousPayment === "object"
              ? previousPayment.renewals || 0
              : previousStatus === "interest"
                ? 1
                : 0,
          ) + (isLastInterest ? 1 : 0),
        deferredRemaining: Number(infoBefore.deferred || 0),
        createdAt: paymentCreatedAt,
      };
    else
      loan.paymentStates[installment] = {
        status,
        receivedTotal: 0,
        receipts: [],
        createdAt: paymentCreatedAt,
      };
    const paymentLabels = {
        paid: "marcada como quitada",
        interest: "marcada como somente juros",
        missed: "marcada como não paga",
        open: "deixada em aberto novamente",
      },
      renewalDescription = isLastInterest
        ? loan.businessDays
          ? " e renovada para o próximo dia útil"
          : ` e renovada por mais ${Number(loan.frequency || 30)} dias`
        : "";
    addHistory(
      "payment",
      `Parcela ${Number(installment) + 1} alterada`,
      `${loan.contract}: parcela ${paymentLabels[status]}${renewalDescription}.`,
    );
    const syncPromise = save();
    render();
    expandedInstallment = `${loanId}:${installment}`;
    details(loanId);
    const synced = await syncPromise,
      message =
        !synced
          ? "Alteração salva neste dispositivo. A sincronização será tentada novamente."
          : status === "paid"
            ? "Parcela quitada, saldo atualizado e registro enviado para Quitados."
            : status === "interest"
              ? isLastInterest
                ? "Juros registrados; a última parcela foi renovada pelo mesmo prazo."
                : "Juros registrados; o saldo foi levado para a próxima parcela."
              : status === "open"
                ? "Parcela deixada em aberto novamente."
                : "Parcela marcada como não paga.";
    toast(message, () => restoreSnapshot(snapshot, null, loanId));
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    try {
      await save();
    } catch {}
    render();
    if (!$("#detailsModal").hidden) details(loanId);
    toast(error.message || "Não foi possível atualizar esta parcela.");
  } finally {
    submissionLocks.delete(actionKey);
    actionButtons.forEach((button) => {
      button.disabled = false;
    });
    triggerButton?.classList.remove("is-action-loading");
    triggerButton?.removeAttribute("aria-busy");
  }
}
function openPostpone(loanId, installment) {
  if (!requirePlatformAccess("adiar parcelas")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return toast("Este empréstimo não foi encontrado. Atualize a tela.");
  const client = state.clients.find((item) => item.id === loan.clientId),
    date = dateFor(loan, installment),
    info = installmentInfo(loan, Number(installment)),
    currentAmount =
      info.state === "partial"
        ? Number(info.partial?.adjustedRemaining || 0)
        : info.state === "interest"
          ? Number(info.deferred || 0)
          : Number(info.due || 0);
  $("#postponeLoanId").value = loanId;
  $("#postponeInstallment").value = installment;
  $("#postponeDate").value = date.toISOString().slice(0, 10);
  $("#postponeSummary").innerHTML =
    `<span>Cliente</span><b>${escapeHtml(client?.name || "Cliente")}</b><span>Parcela</span><b>${Number(installment) + 1} de ${loan.installments} · ${money(currentAmount)}</b><span>Data atual</span><b>${date.toLocaleDateString("pt-BR")}</b>`;
  openModal("postponeModal");
}
function calculatePartialPayment() {
  const due = Number($("#partialDueAmount").value) || 0,
    paid = readCurrencyInput($("#partialPaidAmount")),
    rate = (Number($("#partialInterest").value) || 0) / 100,
    remaining = roundCurrency(Math.max(0, due - paid)),
    adjusted = roundCurrency(remaining * (1 + rate));
  $("#partialRemaining").textContent = money(remaining);
  $("#partialAdjusted").textContent = money(adjusted);
  return { due, paid, rate, remaining, adjusted };
}
function openPartialPayment(loanId, installment) {
  if (!requirePlatformAccess("registrar pagamentos parciais")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return toast("Este empréstimo não foi encontrado. Atualize a tela.");
  const paymentStatus = paymentStateFor(loan, Number(installment));
  if (paymentStatus === "paid")
    return toast("Esta parcela está quitada. Deixe-a em aberto antes de registrar outro pagamento.");
  const client = state.clients.find((item) => item.id === loan.clientId),
    index = Number(installment),
    date = dateFor(loan, index),
    status = installmentStatus(loan, index, date),
    info = installmentInfo(loan, index),
    late = lateCharge(loan, date),
    lateValue = status === "Vencida" || status === "Não pagou" ? late.value : 0,
    existing = info.partial,
    continuingBalance = existing || paymentStatus === "interest",
    alreadyReceived = continuingBalance
      ? receivedAmountFor(loan, index, info)
      : 0,
    due = existing
      ? Number(existing.adjustedRemaining ?? existing.remaining ?? info.due)
      : paymentStatus === "interest"
        ? Number(info.deferred || 0)
        : Number(info.due + lateValue);
  $("#partialForm").reset();
  $("#partialLoanId").value = loanId;
  $("#partialInstallment").value = index;
  $("#partialDueAmount").value = due;
  setCurrencyInput($("#partialPaidAmount"), 0, false);
  $("#partialInterest").value = Number(existing?.interestRate || 0) * 100;
  $("#partialSummary").innerHTML =
    `<span>Cliente</span><b>${escapeHtml(client?.name || "Cliente")}</b><span>Parcela</span><b>${index + 1} de ${loan.installments}</b>${continuingBalance ? `<span>Já recebido</span><b>${money(alreadyReceived)}</b>` : ""}<span>${continuingBalance ? "Saldo atual" : "Valor devido"}</span><b>${money(due)}</b>`;
  $("#partialDestination").textContent =
    index < loan.installments - 1
      ? "O saldo com juros será acrescentado à próxima parcela."
      : "O saldo com juros continuará nesta última parcela.";
  calculatePartialPayment();
  openModal("partialModal");
}
async function savePartialPayment(event) {
  event.preventDefault();
  if (!requirePlatformAccess("registrar pagamentos parciais")) return;
  const form = event.currentTarget,
    snapshot = stateSnapshot(),
    loanId = $("#partialLoanId").value,
    installment = Number($("#partialInstallment").value),
    calculation = calculatePartialPayment();
  if (calculation.paid <= 0)
    return toast("Informe o valor que o cliente pagará.");
  if (calculation.paid >= calculation.due)
    return toast("Para pagar o valor completo, use a opção Quitado.");
  if (calculation.rate < 0 || calculation.rate > 1)
    return toast("Informe juros entre 0% e 100%.");
  if (!beginSubmission(form, "partial-payment")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) {
    endSubmission(form, "partial-payment");
    return toast("Este empréstimo não foi encontrado. Atualize a tela e tente novamente.");
  }
  try {
    loan.paymentStates = loan.paymentStates || {};
    const previousPayment = loan.paymentStates[installment],
      previousInfo = installmentInfo(loan, installment),
      principalBefore = principalPositionFor(loan, installment),
      previousStatus = paymentStateFor(loan, installment),
      continuesPreviousPayment =
        previousStatus === "partial" || previousStatus === "interest",
      previousReceived = continuesPreviousPayment
        ? Number(previousPayment?.receivedTotal ?? previousPayment?.paidAmount ?? 0)
        : 0,
      previousReceipts = continuesPreviousPayment
        ? receiptEntriesFor(loan, installment, previousInfo)
        : [],
      receivedTotal = roundCurrency(previousReceived + calculation.paid),
      principalPaidNow = roundCurrency(
        Math.min(
          principalBefore.remaining,
          calculation.due
            ? principalBefore.remaining *
                Math.min(1, calculation.paid / calculation.due)
            : 0,
        ),
      ),
      paymentCreatedAt = new Date().toISOString();
    loan.paymentStates[installment] = {
      status: "partial",
      paidAmount: receivedTotal,
      receivedTotal,
      lastPayment: calculation.paid,
      principalPaid: roundCurrency(
        principalBefore.paid + principalPaidNow,
      ),
      principalRemaining: roundCurrency(
        principalBefore.remaining - principalPaidNow,
      ),
      receipts: [
        ...previousReceipts,
        {
          amount: calculation.paid,
          createdAt: paymentCreatedAt,
          type: "partial",
          principalAmount: principalPaidNow,
          interestAmount: roundCurrency(
            Math.max(0, calculation.paid - principalPaidNow),
          ),
        },
      ],
      originalDue: Number(previousPayment?.originalDue ?? previousInfo.due),
      currentDue: calculation.due,
      remaining: calculation.remaining,
      interestRate: calculation.rate,
      adjustedRemaining: calculation.adjusted,
      partialPayments:
        Number(
          previousPayment?.partialPayments ||
            previousReceipts.filter((receipt) => receipt.type === "partial").length ||
            0,
        ) + 1,
      createdAt: paymentCreatedAt,
    };
    addHistory(
      "payment",
      `Pagamento parcial na parcela ${installment + 1}`,
      `${loan.contract}: recebido agora ${money(calculation.paid)}; total recebido ${money(receivedTotal)}; saldo atualizado para ${money(calculation.adjusted)}.`,
    );
    const syncPromise = save();
    closeModals();
    render();
    expandedInstallment = `${loanId}:${installment}`;
    details(loanId);
    toast(
      `Pagamento de ${money(calculation.paid)} registrado. Sincronizando os dados...`,
    );
    const synced = await syncPromise;
    toast(
      synced
        ? `Pagamento registrado. Saldo reduzido para ${money(calculation.adjusted)}.`
        : "Pagamento salvo neste dispositivo. A sincronização será tentada novamente.",
      () => restoreSnapshot(snapshot, null, loanId),
    );
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    try {
      await save();
    } catch {}
    render();
    if (!$("#detailsModal").hidden) details(loanId);
    toast(error.message || "Não foi possível registrar o pagamento parcial.");
  } finally {
    endSubmission(form, "partial-payment");
  }
}
async function savePostpone(event) {
  event.preventDefault();
  if (!requirePlatformAccess("alterar vencimentos")) return;
  const form = event.currentTarget,
    snapshot = stateSnapshot(),
    loanId = $("#postponeLoanId").value,
    installment = $("#postponeInstallment").value,
    requestedDate = $("#postponeDate").value,
    actionKey = `postpone:${loanId}:${installment}`;
  if (!requestedDate) return toast("Escolha uma nova data.");
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan)
    return toast("Este empréstimo não foi encontrado. Atualize a tela.");
  const requestedDateValue = new Date(`${requestedDate}T12:00`),
    next = loan.businessDays
      ? dateInputValue(nextBusinessDayOrSame(requestedDateValue))
      : requestedDate,
    weekendAdjusted = next !== requestedDate;
  if (!beginSubmission(form, actionKey)) return;
  toast("Atualizando a data de vencimento...");
  try {
    loan.customDates = loan.customDates || {};
    const previousDate = dateFor(
      loan,
      Number(installment),
    ).toLocaleDateString("pt-BR");
    loan.customDates[installment] = next;
    addHistory(
      "payment",
      "Vencimento adiado",
      `${loan.contract}: parcela ${Number(installment) + 1}, de ${previousDate} para ${new Date(`${next}T12:00`).toLocaleDateString("pt-BR")}.`,
    );
    const synced = await save();
    closeModals();
    render();
    details(loanId);
    toast(
      synced
        ? weekendAdjusted
          ? "O final de semana foi pulado. Vencimento movido para segunda-feira."
          : "Data da parcela atualizada."
        : "Data salva neste dispositivo. A sincronização será tentada novamente.",
      () => restoreSnapshot(snapshot, null, loanId),
    );
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    render();
    toast(error.message || "Não foi possível atualizar o vencimento.");
  } finally {
    endSubmission(form, actionKey);
  }
}
async function toggleBlacklist(clientId, loanContext = null) {
  if (!requirePlatformAccess("alterar a lista negra")) return;
  const client = state.clients.find((item) => item.id === clientId);
  if (!client) return;
  const actionKey = `blacklist:${clientId}`;
  if (submissionLocks.has(actionKey))
    return toast("Aguarde: a situação deste cliente ainda está sendo salva.");
  const snapshot = stateSnapshot(),
    buttons = Array.from(
      document.querySelectorAll("[data-toggle-blacklist]"),
    ).filter((button) => button.dataset.toggleBlacklist === clientId);
  submissionLocks.add(actionKey);
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  toast("Atualizando a situação do cliente...");
  try {
    client.blacklisted = !client.blacklisted;
    addHistory(
      "client",
      client.blacklisted
        ? "Cliente adicionado à lista negra"
        : "Cliente removido da lista negra",
      client.name,
    );
    const synced = await save();
    render();
    if (loanContext) details(loanContext);
    const message = !synced
      ? "Alteração salva neste dispositivo. A sincronização será tentada novamente."
      : client.blacklisted
        ? "Cliente adicionado à lista negra."
        : "Cliente removido da lista negra.";
    toast(message, () => restoreSnapshot(snapshot, null, loanContext));
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    render();
    if (loanContext) details(loanContext);
    toast(error.message || "Não foi possível alterar a lista negra.");
  } finally {
    submissionLocks.delete(actionKey);
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  }
}
async function archiveLoan(loanId) {
  if (!requirePlatformAccess("arquivar empréstimos")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return toast("Este empréstimo não foi encontrado.");
  const actionKey = `archive:${loanId}`;
  if (submissionLocks.has(actionKey))
    return toast("Aguarde: este empréstimo ainda está sendo atualizado.");
  const snapshot = stateSnapshot(),
    buttons = Array.from(
      document.querySelectorAll("[data-archive-loan]"),
    ).filter((button) => button.dataset.archiveLoan === loanId);
  submissionLocks.add(actionKey);
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  toast(loan.archived ? "Restaurando empréstimo..." : "Arquivando empréstimo...");
  try {
    loan.archived = !loan.archived;
    addHistory(
      "loan",
      loan.archived ? "Empréstimo arquivado" : "Empréstimo restaurado",
      loan.contract,
    );
    const synced = await save();
    closeModals();
    render();
    setPage(loan.archived ? "history" : "loans");
    const message = !synced
      ? "Alteração salva neste dispositivo. A sincronização será tentada novamente."
      : loan.archived
        ? "Empréstimo arquivado."
        : "Empréstimo restaurado.";
    toast(message, () =>
      restoreSnapshot(snapshot, loan.archived ? "loans" : "history"),
    );
  } catch (error) {
    state.clients = structuredClone(snapshot.clients);
    state.loans = structuredClone(snapshot.loans);
    state.history = structuredClone(snapshot.history);
    render();
    toast(error.message || "Não foi possível atualizar o empréstimo.");
  } finally {
    submissionLocks.delete(actionKey);
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  }
}
function requestDeleteClient(clientId) {
  if (!requirePlatformAccess("excluir clientes")) return;
  const client = state.clients.find((item) => item.id === clientId);
  if (!client) return;
  const linkedLoans = state.loans.filter((loan) => loan.clientId === clientId);
  askDelete({
    title: `Excluir ${client.name}?`,
    message: linkedLoans.length
      ? `Este cliente possui ${linkedLoans.length} empréstimo${linkedLoans.length === 1 ? "" : "s"}. O cliente, os empréstimos e todo o histórico de parcelas serão apagados. Você terá 8 segundos para desfazer.`
      : "O cadastro deste cliente será apagado. Você terá 8 segundos para desfazer caso tenha sido um engano.",
    action: () => deleteClient(clientId),
  });
}
async function deleteClient(clientId) {
  const snapshot = stateSnapshot();
  try {
    if (window.credmaisBridge?.enabled)
      await window.credmaisBridge.deleteClient(clientId);
    state.loans = state.loans.filter((loan) => loan.clientId !== clientId);
    state.clients = state.clients.filter((client) => client.id !== clientId);
    const deletedClient = snapshot.clients.find((client) => client.id === clientId);
    const linkedCount = snapshot.loans.filter(
      (loan) => loan.clientId === clientId,
    ).length;
    addHistory(
      "client",
      "Cliente excluído",
      `${deletedClient?.name || "Cliente"}${linkedCount ? ` e ${linkedCount} empréstimo${linkedCount === 1 ? "" : "s"} relacionado${linkedCount === 1 ? "" : "s"}` : ""}.`,
    );
    await save();
    closeModals();
    render();
    setPage("clients");
    toast("Cliente e dados relacionados excluídos.", () =>
      restoreSnapshot(snapshot, "clients"),
    );
  } catch (error) {
    cancelDelete();
    toast(error.message || "Não foi possível excluir o cliente.");
  }
}
function requestDeleteLoan(loanId) {
  if (!requirePlatformAccess("excluir empréstimos")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return;
  askDelete({
    title: "Excluir empréstimo?",
    message: `O contrato ${loan.contract} e todo o histórico de parcelas serão apagados. Você terá 8 segundos para desfazer.`,
    action: () => deleteLoan(loanId),
  });
}
async function deleteLoan(loanId) {
  const snapshot = stateSnapshot();
  try {
    if (window.credmaisBridge?.enabled)
      await window.credmaisBridge.deleteLoan(loanId);
    state.loans = state.loans.filter((loan) => loan.id !== loanId);
    const deletedLoan = snapshot.loans.find((loan) => loan.id === loanId);
    addHistory(
      "loan",
      "Empréstimo excluído",
      `${deletedLoan?.contract || "Contrato"} · ${money(deletedLoan?.amount || 0)}.`,
    );
    await save();
    closeModals();
    render();
    setPage("loans");
    toast("Empréstimo excluído.", () =>
      restoreSnapshot(snapshot, "loans", loanId),
    );
  } catch (error) {
    cancelDelete();
    toast(error.message || "Não foi possível excluir o empréstimo.");
  }
}
function openWhatsApp(loanId, installmentIndex) {
  if (!requirePlatformAccess("enviar cobranças")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return toast("Este empréstimo não foi encontrado. Atualize a tela.");
  const client = state.clients.find((item) => item.id === loan.clientId),
    phone = digits(client?.phone),
    index = Number(installmentIndex);
  if (phone.length < 10)
    return toast("Este cliente não possui um telefone válido.");
  const date = dateFor(loan, index),
    status = installmentStatus(loan, index, date),
    info = installmentInfo(loan, index),
    late = lateCharge(loan, date),
    lateValue = status === "Vencida" || status === "Não pagou" ? late.value : 0,
    value =
      status === "Só juros"
        ? info.interestOnlyValue
        : status === "Pagamento parcial"
          ? Number(info.partial?.paidAmount || 0)
          : info.due + lateValue,
    pixKey = state.user?.pixKey?.trim(),
    pixRecipientName =
      state.user?.pixRecipientName?.trim() || state.user?.name?.trim(),
    pixPayment = pixKey
      ? `\n\n💠 *PAGAMENTO VIA PIX*\n👤 Recebedor: *${pixRecipientName || "Não informado"}*\n🔑 Chave (${state.user.pixType || "PIX"}):\n${pixKey}`
      : "\n\n💳 Para efetuar o pagamento, solicite a chave PIX pelo WhatsApp.",
    action =
      status === "Quitada"
        ? `✅ Confirmamos o pagamento de *${money(value)}*. Esta parcela está quitada.`
        : status === "Pagamento parcial"
          ? `◑ Confirmamos o pagamento parcial de *${money(info.partial?.lastPayment ?? info.partial?.paidAmount)}*. Total recebido nesta parcela: *${money(info.partial?.receivedTotal ?? info.partial?.paidAmount)}*. O saldo foi atualizado para *${money(info.partial?.adjustedRemaining)}*${index < loan.installments - 1 ? " e acrescentado à próxima parcela" : " e continua em aberto nesta parcela"}.`
        : status === "Só juros"
          ? index < loan.installments - 1
            ? `◔ Recebemos *${money(info.interestOnlyValue)}* referentes aos juros. O saldo de *${money(info.deferred)}* foi levado para a próxima parcela, que ficará em *${money(info.nextDue)}*.`
            : `◔ Recebemos *${money(info.interestOnlyValue)}* referentes aos juros. O saldo principal permanece em aberto nesta última parcela, com novo vencimento em *${date.toLocaleDateString("pt-BR")}*.`
          : status === "Não pagou"
            ? `⚠️ Esta parcela está em aberto. O valor atualizado para pagamento é *${money(value)}*.`
            : `💰 *Valor para pagamento*\n${money(value)}`;
  const title =
    status === "Quitada"
      ? "CONFIRMAÇÃO DE PAGAMENTO"
      : status === "Pagamento parcial"
        ? "PAGAMENTO PARCIAL REGISTRADO"
      : status === "Só juros"
        ? "PAGAMENTO DE JUROS REGISTRADO"
        : "LEMBRETE DE PAGAMENTO";
  const senderName = pixRecipientName || "CredMais";
  const message = `Olá, *${client.name}*! 👋\n\n📌 *${title}*\n━━━━━━━━━━━━━━━━\n\n🧾 Contrato: *${loan.contract}*\n🔢 Parcela: *${index + 1} de ${loan.installments}*\n📅 Vencimento: *${date.toLocaleDateString("pt-BR")}*\n⏰ Situação: *${status}*\n\n${action}${status === "Quitada" ? "" : pixPayment}\n\n━━━━━━━━━━━━━━━━\n${status === "Quitada" ? "🤝 Obrigado pela pontualidade!" : "✅ Após o pagamento, envie o comprovante por aqui."}\n\nAtenciosamente,\n*${senderName}*`;
  window.open(
    `https://wa.me/55${phone}?text=${encodeURIComponent(message)}`,
    "_blank",
    "noopener",
  );
}
function contractInstallmentSummary(loan) {
  const installments = Math.max(1, Number(loan.installments) || 1),
    firstValue = scheduledInstallmentFor(loan, 0),
    lastValue = scheduledInstallmentFor(loan, installments - 1);
  if (installments === 1) return `1 parcela de ${money(firstValue)}`;
  if (firstValue === lastValue)
    return `${installments} parcelas de ${money(firstValue)}`;
  return `${installments - 1} parcelas de ${money(firstValue)} e a última de ${money(lastValue)}`;
}
function contractMessageFor(loan, client) {
  const firstDue = dateFor(loan, 0),
    lastDue = dateFor(loan, Math.max(0, Number(loan.installments) - 1)),
    pixKey = state.user?.pixKey?.trim(),
    pixRecipientName =
      state.user?.pixRecipientName?.trim() || state.user?.name?.trim(),
    senderName = pixRecipientName || "CredMais",
    interestValue = roundCurrency(Number(loan.total) - Number(loan.amount)),
    lateFee = Number(loan.lateFee || 0),
    scheduleRule = loan.businessDays
      ? "\n📆 Regra: *os vencimentos pulam sábados e domingos*."
      : "",
    lateFeeRule = lateFee
      ? `\n⏰ Atraso: *${money(lateFee)} por ${loan.businessDays ? "dia útil" : "dia"}*.`
      : "\n⏰ Atraso: *sem juros de atraso cadastrados*.",
    pixPayment = pixKey
      ? `\n\n💠 *DADOS PARA PAGAMENTO*\n👤 Recebedor: *${pixRecipientName || "Não informado"}*\n🔑 Chave ${state.user.pixType || "PIX"}:\n${pixKey}`
      : "\n\n💳 Para realizar os pagamentos, solicite a chave PIX por este WhatsApp.";
  return `Olá, *${client.name}*! 👋\n\n📄 *RESUMO DO EMPRÉSTIMO*\n━━━━━━━━━━━━━━━━\n\n🧾 Contrato: *${loan.contract}*\n💵 Valor emprestado: *${money(loan.amount)}*\n📈 Cálculo: *${interestDescription(loan)}*\n➕ Valor dos juros: *${money(interestValue)}*\n💰 Total do contrato: *${money(loan.total)}*\n\n📦 Plano: *${contractInstallmentSummary(loan)}*\n🔁 Frequência: *${formatFrequency(loan.frequency || 30, loan.businessDays)}*\n📅 Primeiro vencimento: *${firstDue.toLocaleDateString("pt-BR")}*\n🏁 Último vencimento previsto: *${lastDue.toLocaleDateString("pt-BR")}*${scheduleRule}${lateFeeRule}${pixPayment}\n\n━━━━━━━━━━━━━━━━\n📌 Guarde esta mensagem para consultar as condições combinadas. Os lembretes de cada parcela serão enviados separadamente.\n\nAtenciosamente,\n*${senderName}*`;
}
function openContractWhatsApp(loanId) {
  if (!requirePlatformAccess("enviar o contrato")) return;
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan) return toast("Este empréstimo não foi encontrado. Atualize a tela.");
  const client = state.clients.find((item) => item.id === loan.clientId),
    phone = digits(client?.phone);
  if (!client) return toast("O cliente deste empréstimo não foi encontrado.");
  if (phone.length < 10)
    return toast("Este cliente não possui um telefone válido.");
  window.open(
    `https://wa.me/55${phone}?text=${encodeURIComponent(contractMessageFor(loan, client))}`,
    "_blank",
    "noopener",
  );
}
function openContractShare(loanId) {
  if (!requirePlatformAccess("compartilhar o contrato")) return;
  const loan = state.loans.find((item) => item.id === loanId),
    client = state.clients.find((item) => item.id === loan?.clientId);
  if (!loan || !client) return;
  const firstDue = dateFor(loan, 0),
    lastDue = dateFor(loan, Math.max(0, Number(loan.installments) - 1)),
    scheduleNote = loan.businessDays
      ? `<small><span>SEG–SEX</span> Finais de semana serão pulados</small>`
      : "";
  $("#contractSharePreview").innerHTML = `<div class="contract-share-client"><span>Cliente</span><b>${escapeHtml(client.name)}</b><small>${escapeHtml(loan.contract)}</small></div><div class="contract-share-values"><span><small>Valor emprestado</small><b>${money(loan.amount)}</b></span><span><small>Total do contrato</small><b>${money(loan.total)}</b></span></div><div class="contract-share-plan"><span>◫</span><div><b>${escapeHtml(contractInstallmentSummary(loan))}</b><small>${escapeHtml(formatFrequency(loan.frequency || 30, loan.businessDays))} · ${firstDue.toLocaleDateString("pt-BR")} até ${lastDue.toLocaleDateString("pt-BR")}</small>${scheduleNote}</div></div>`;
  $("#contractShareButton").dataset.contractWhatsapp = loan.id;
  openModal("contractShareModal");
}
function applyTheme(dark, persist = true) {
  document.body.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const label = dark ? "Ativar modo claro" : "Ativar modo noturno";
  [$("#headerTheme"), $("#authTheme"), $("#accessTheme")]
    .filter(Boolean)
    .forEach((button) => {
    const icon = button.querySelector(".theme-icon");
    const text = button.querySelector(".theme-label");
    if (icon) icon.textContent = dark ? "☀" : "☾";
    else button.textContent = dark ? "☀" : "☾";
    if (text) text.textContent = dark ? "Modo claro" : "Modo noturno";
    button.setAttribute("aria-label", label);
    button.title = label;
    });
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dark ? "#101714" : "#0e9f6e";
  if (persist)
    localStorage.setItem("credmais_theme", dark ? "dark" : "light");
}
function toggleTheme() {
  const dark = !document.body.classList.contains("dark");
  applyTheme(dark);
}
document.addEventListener(
  "click",
  (event) => {
    if (!platformReadOnly()) return;
    const control = event.target.closest?.(PLATFORM_MUTATION_SELECTOR);
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requirePlatformAccess("usar esta função");
  },
  true,
);
document.addEventListener(
  "submit",
  (event) => {
    if (
      !platformReadOnly() ||
      !event.target.matches(PLATFORM_MUTATION_FORM_SELECTOR)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requirePlatformAccess("salvar esta alteração");
  },
  true,
);
$("#login").addEventListener("submit", login);
$("#googleSignInButton").addEventListener("click", loginWithGoogle);
$("#register").addEventListener("submit", register);
$("#forgotPassword").addEventListener("submit", requestPasswordReset);
$("#clientForm").addEventListener("submit", saveClient);
$("#loanForm").addEventListener("submit", saveLoan);
$("#postponeForm").addEventListener("submit", savePostpone);
$("#partialForm").addEventListener("submit", savePartialPayment);
$("#monthlyReportForm").addEventListener("submit", downloadMonthlyReport);
$("#pixForm").addEventListener("submit", savePix);
$("#passwordChangeForm").addEventListener("submit", changePassword);
[$("#loanAmount"), $("#loanLateFee"), $("#partialPaidAmount")].forEach(
  (input) => input.addEventListener("input", maskCurrencyInput),
);
$("#partialPaidAmount").addEventListener("input", calculatePartialPayment);
$("#partialInterest").addEventListener("input", calculatePartialPayment);
$("#clientCpf").addEventListener("input", (event) => {
  event.target.value = formatCpf(event.target.value);
  renderClientCpfValidation();
});
$("#clientCpf").addEventListener("blur", () => renderClientCpfValidation(true));
$("#clientPhone").addEventListener("input", (event) => {
  event.target.value = formatPhone(event.target.value);
});
["registerPassword", "registerPasswordConfirm"].forEach((id) =>
  $(`#${id}`).addEventListener("input", () => {
    validateRegistration();
    setFeedback("registerFeedback");
  }),
);
[
  "loanAmount",
  "loanInterest",
  "loanInstallments",
].forEach((id) =>
  $(`#${id}`).addEventListener("input", () => {
    calc();
    if (id === "loanInstallments") updateLoanDuePreview();
  }),
);
document
  .querySelectorAll('[name="loanInterestModeChoice"]')
  .forEach((input) =>
    input.addEventListener("change", () => {
      if (!input.checked) return;
      setLoanInterestMode(input.value);
      calc();
    }),
  );
$("#loanFrequency").addEventListener("change", () => {
  syncCustomFrequencyField();
  suggestFirstDueDate();
  calc();
  if ($("#loanFrequency").value === "custom")
    $("#loanCustomFrequency").focus();
});
$("#loanCustomFrequency").addEventListener("input", () => {
  suggestFirstDueDate();
  calc();
});
$("#loanDueDate").addEventListener("input", updateLoanDuePreview);
$("#reportMonth").addEventListener("input", updateReportPreview);
$("#clientSearch").addEventListener("input", renderClients);
$("#loanSearch").addEventListener("input", renderLoans);
$("#addClientBtn").onclick = () => openClient();
document
  .querySelectorAll(".nav-link i, .bottom-link i, .stat-icon")
  .forEach((icon) => icon.setAttribute("aria-hidden", "true"));
$("#menuBtn").onclick = () => $(".sidebar").classList.toggle("open");
$("#pixBtn").onclick = openPix;
$("#profileBtn").onclick = openProfile;
$("#monthlyReportBtn").onclick = openMonthlyReport;
document
  .querySelectorAll("[data-platform-support]")
  .forEach((button) => (button.onclick = openPlatformSupport));
$("#profileGoogleButton").onclick = linkProfileGoogle;
$("#profilePasswordButton").onclick = openProfilePasswordSettings;
$("#profileSecurityButton").onclick = openProfilePasswordSettings;
$("#profileResetPasswordButton").onclick = () => sendProfilePasswordReset();
$("#profilePixButton").onclick = () => {
  openPix();
};
$("#profileInstallButton").onclick = () => {
  openInstall();
};
$("#authInstallButton").onclick = openInstall;
$("#profileLogoutButton").onclick = async () => {
  closeModals();
  await signOutCurrentUser();
};
$("#profileDangerToggle").onclick = toggleProfileDanger;
$("#openDeleteAccountButton").onclick = openDeleteAccount;
$("#deleteAccountForm").addEventListener("submit", deleteAccountAndData);
$("#deleteAccountConfirmation").addEventListener("input", () =>
  setFeedback("deleteAccountFeedback"),
);
$("#deleteAccountPassword").addEventListener("input", () =>
  setFeedback("deleteAccountFeedback"),
);
$("#deleteAccountAcknowledgement").addEventListener("change", () =>
  setFeedback("deleteAccountFeedback"),
);
$("#profilePhoto").onerror = () => {
  $("#profilePhoto").hidden = true;
  $("#profileAvatarLarge").classList.remove("has-photo");
};
$("#headerTheme").onclick = toggleTheme;
$("#authTheme").onclick = toggleTheme;
$("#accessTheme").onclick = toggleTheme;
const offlineRefreshButton = $("#offlineRefreshButton");
if (offlineRefreshButton)
  offlineRefreshButton.onclick = async () => {
    offlineRefreshButton.disabled = true;
    offlineRefreshButton.textContent = "Verificando...";
    try {
      await refreshFromCloud({ notify: true });
      if (state.platformAccess?.offline)
        toast("Ainda não foi possível confirmar o acesso. O CredMais tentará novamente automaticamente.");
    } finally {
      offlineRefreshButton.disabled = false;
      offlineRefreshButton.textContent = "Tentar novamente";
    }
  };
$("#accessDismiss").onclick = dismissAccessPrompt;
document.querySelectorAll("[data-payment-months]").forEach((button) => {
  button.onclick = () => selectBillingPlan(button.dataset.paymentMonths);
});
$("#automaticPaymentButton").onclick = startBillingCheckout;
$("#subscriptionRequestButton").onclick = () =>
  showAccessGate(state.platformAccess, { openPrompt: true });
$("#trialUpgradeButton").onclick = () =>
  showAccessGate(state.platformAccess, { openPrompt: true });
$("#subscriptionRefreshButton").onclick = refreshPlatformAccess;
$("#confirmInstallBtn").onclick = installPWA;
$("#modalBackdrop").onclick = requestClose;
$("[data-keep-editing]").onclick = keepEditing;
$("[data-discard-changes]").onclick = discardChanges;
$("[data-cancel-delete]").onclick = cancelDelete;
$("[data-confirm-delete]").onclick = confirmDelete;
document.querySelectorAll("[data-auth]").forEach((button) => {
  button.onclick = () => setAuth(button.dataset.auth);
});
$(".logo").onclick = (event) => {
  event.preventDefault();
  setPage("dashboard");
};
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "financialSummaryToggle") {
    const details = $("#financialSummaryDetails"),
      panel = $("#financialSummaryPanel"),
      hint = $("#financialSummaryHint"),
      expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    details.hidden = !expanded;
    panel.classList.toggle("financial-expanded", expanded);
    hint.textContent = expanded
      ? "Toque para ocultar os detalhes"
      : "Toque para ver mais detalhes";
    return;
  }
  if (button.dataset.clientProfile) {
    openClientProfile(button.dataset.clientProfile);
    return;
  }
  if (button.dataset.clientProfileTab) {
    clientProfileTab = button.dataset.clientProfileTab;
    renderClientProfile();
    return;
  }
  if (button.dataset.clientLoan) {
    openClientLoanDetails(button.dataset.clientLoan, button.dataset.clientInstallment == null ? null : Number(button.dataset.clientInstallment));
    return;
  }
  if (button.hasAttribute("data-client-new-loan")) {
    openLoanForClient();
    return;
  }
  if (button.hasAttribute("data-return-client")) {
    const clientId = returnToClientId;
    if (modalStack.at(-2) === "clientProfileModal") closeTopModal();
    else {
      closeModals();
      openClientProfile(clientId, true);
    }
    return;
  }
  if (button.dataset.page) {
    event.preventDefault();
    setPage(button.dataset.page);
    return;
  }
  if (button.id === "viewOverdueButton") {
    renderDueLoans(true);
    requestAnimationFrame(() =>
      $("#duePanel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    return;
  }
  if (button.dataset.paidView) {
    selectPaidView(button.dataset.paidView);
    return;
  }
  if (button.dataset.passwordToggle) {
    const input = $(`#${button.dataset.passwordToggle}`),
      show = input.type === "password";
    input.type = show ? "text" : "password";
    button.classList.toggle("is-visible", show);
    button.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    button.setAttribute("aria-pressed", String(show));
    return;
  }
  if (button.classList.contains("add-loan")) openLoan();
  if (button.hasAttribute("data-close")) requestClose();
  if (button.dataset.pageLink) setPage(button.dataset.pageLink);
  if (button.dataset.details) {
    returnToClientId = null;
    details(button.dataset.details);
  }
  if (button.dataset.whatsapp)
    openWhatsApp(button.dataset.whatsapp, button.dataset.installment);
  if (button.dataset.contractWhatsapp)
    openContractWhatsApp(button.dataset.contractWhatsapp);
  if (button.dataset.editClient) {
    openClient(button.dataset.editClient);
  }
  if (button.dataset.deleteClient)
    requestDeleteClient(button.dataset.deleteClient);
  if (button.dataset.editLoan) {
    openLoan(button.dataset.editLoan);
  }
  if (button.dataset.payment)
    updatePayment(
      button.dataset.loan,
      button.dataset.installment,
      button.dataset.payment,
      button,
    );
  if (button.dataset.postpone)
    openPostpone(button.dataset.postpone, button.dataset.installment);
  if (button.dataset.partial)
    openPartialPayment(button.dataset.partial, button.dataset.installment);
  if (button.dataset.toggleInstallment)
    toggleInstallment(
      button.dataset.toggleInstallment,
      Number(button.dataset.installment),
    );
  if (button.dataset.toggleBlacklist)
    toggleBlacklist(
      button.dataset.toggleBlacklist,
      button.dataset.loanContext || null,
    );
  if (button.hasAttribute("data-toggle-details-actions"))
    toggleDetailsActions(button);
  if (button.dataset.archiveLoan) archiveLoan(button.dataset.archiveLoan);
  if (button.dataset.deleteLoan) requestDeleteLoan(button.dataset.deleteLoan);
  if (button.hasAttribute("data-open-client")) openClient();
});
document.addEventListener("click", (event) => {
  const sidebar = $(".sidebar"),
    menuButton = $("#menuBtn");
  if (
    sidebar.classList.contains("open") &&
    !sidebar.contains(event.target) &&
    !menuButton.contains(event.target)
  )
    sidebar.classList.remove("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $(".sidebar").classList.remove("open");
  requestClose();
});
window.addEventListener("resize", syncModalViewport);
window.visualViewport?.addEventListener("resize", () => {
  syncModalViewport();
  requestAnimationFrame(keepFocusedModalFieldVisible);
});
window.visualViewport?.addEventListener("scroll", syncModalViewport);
document.addEventListener("focusin", (event) => {
  const modal = event.target.closest?.(".modal");
  if (!modal || modal.hidden || !event.target.matches("input, select, textarea"))
    return;
  window.setTimeout(() => {
    syncModalViewport();
    requestAnimationFrame(keepFocusedModalFieldVisible);
  }, 320);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden)
    void refreshFromCloud({ notify: true, allowWhileModalOpen: true });
});
window.addEventListener("online", () => {
  void refreshFromCloud({ notify: true, allowWhileModalOpen: true });
});
window.addEventListener("offline", () => {
  if (state.user?.id)
    void refreshFromCloud({ notify: true, allowWhileModalOpen: true });
});
window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);
  if ($(`#${page}Page`)) setPage(page);
});
window.addEventListener("storage", (event) => {
  if (!state.user || hasOpenModal()) return;
  if (localStorage.getItem("credmais_cache_owner") !== state.user.id) return;
  if (event.key === "credmais_clients")
    state.clients = JSON.parse(event.newValue || "[]");
  else if (event.key === "credmais_loans")
    state.loans = JSON.parse(event.newValue || "[]");
  else if (event.key === "credmais_history")
    state.history = JSON.parse(event.newValue || "[]");
  else return;
  render();
  toast("Dados atualizados em outra aba.");
});
setInterval(() => {
  if (state.user && renderedMonthKey && monthKey(new Date()) !== renderedMonthKey)
    renderStats();
}, 60000);
const savedTheme = localStorage.getItem("credmais_theme");
applyTheme(
  savedTheme
    ? savedTheme === "dark"
    : window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  false,
);
setupPWA();
function finishInitialLoading() {
  const loader = $("#appLoader");
  if (!loader) return;
  const delay = Math.max(0, 650 - performance.now());
  setTimeout(() => {
    loader.classList.add("is-hiding");
    setTimeout(() => {
      loader.hidden = true;
    }, 320);
  }, delay);
}
(async () => {
  try {
    if (window.credmaisBridge?.enabled) {
      const user = await window.credmaisBridge.currentUser();
      if (user) {
        const cachedUser = state.user;
        state.user =
          cachedUser?.email?.toLowerCase() === user.email?.toLowerCase()
            ? {
                ...cachedUser,
                ...user,
                pixKey: user.pixKey || cachedUser.pixKey || "",
                pixType:
                  user.pixType || cachedUser.pixType || "Chave aleatória",
                pixRecipientName:
                  user.pixRecipientName || cachedUser.pixRecipientName || "",
              }
            : user;
        localStorage.setItem("credmais_user", JSON.stringify(state.user));
        await showApp();
      }
    } else if (state.user) {
      await showApp();
    }
  } catch (error) {
    console.error("Falha ao restaurar a sessão:", error);
    if (
      state.user &&
      window.credmaisBridge?.authProvider !== "firebase"
    )
      await showApp();
    else localStorage.removeItem("credmais_user");
  } finally {
    finishInitialLoading();
  }
})();
