const $ = (selector) => document.querySelector(selector);
const state = {
  user: JSON.parse(localStorage.getItem("credmais_user") || "null"),
  clients: JSON.parse(localStorage.getItem("credmais_clients") || "[]"),
  loans: JSON.parse(localStorage.getItem("credmais_loans") || "[]"),
  history: JSON.parse(localStorage.getItem("credmais_history") || "[]"),
};
if (state.user?.id && !localStorage.getItem("credmais_cache_owner"))
  localStorage.setItem("credmais_cache_owner", state.user.id);
let pendingModalId = null;
let expandedInstallment = null;
let pendingDelete = null;
let toastTimer = null;
let autoRefreshTimer = null;
let renderedMonthKey = null;
let refreshingFromCloud = false;
let deferredInstallPrompt = null;
const submissionLocks = new Set();
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
const initials = (name) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const save = async () => {
  localStorage.setItem("credmais_clients", JSON.stringify(state.clients));
  localStorage.setItem("credmais_loans", JSON.stringify(state.loans));
  localStorage.setItem("credmais_history", JSON.stringify(state.history));
  if (state.user?.id) localStorage.setItem("credmais_cache_owner", state.user.id);
  if (!window.credmaisBridge?.enabled) return true;
  try {
    await window.credmaisBridge.sync(
      state.user,
      state.clients,
      state.loans,
      state.history,
    );
    clearPendingSync(state.user.id);
    return true;
  } catch (error) {
    rememberPendingSync(state.user.id);
    console.error("Falha ao sincronizar Supabase:", error.message);
    return false;
  }
};
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
});
async function restoreSnapshot(snapshot, page = null, loanId = null) {
  state.clients = structuredClone(snapshot.clients);
  state.loans = structuredClone(snapshot.loans);
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
  resetButton.disabled = !usesFirebase || !user.email;
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
    await save();
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
async function sendProfilePasswordReset() {
  const button = $("#profileResetPasswordButton");
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
      `O link de recuperação foi enviado para ${state.user.email}.`,
    );
    await save();
    toast("E-mail de recuperação enviado. Confira também a pasta Spam.");
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
  closeModals();
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
  clearPendingSync(userId);
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
  $("#passwordChangeForm").reset();
  setFeedback("passwordChangeFeedback");
  $(".sidebar").classList.remove("open");
  openModal("securityModal");
}
async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget,
    newPassword = $("#newPassword").value,
    confirmation = $("#confirmNewPassword").value;
  if (newPassword.length < 6)
    return setFeedback(
      "passwordChangeFeedback",
      "A nova senha precisa ter pelo menos 6 caracteres.",
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
    await save();
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
  const enough = password.length >= 6,
    matches = Boolean(confirm) && password === confirm;
  $("#passwordRule").classList.toggle("valid", enough);
  $("#passwordRule").textContent =
    `${enough ? "✓" : "○"} Use pelo menos 6 caracteres`;
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
async function showApp() {
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
  }
  $("#authView").hidden = true;
  $("#appView").hidden = false;
  $("#userName").textContent = state.user.name;
  $("#greetingName").textContent = state.user.name.split(" ")[0];
  $("#initials").textContent = initials(state.user.name);
  const requestedPage = location.hash.slice(1);
  if ($(`#${requestedPage}Page`)) setPage(requestedPage);
  else setPage("dashboard");
  startAutoRefresh();
}
function hasOpenModal() {
  return Array.from(document.querySelectorAll(".modal")).some(
    (modal) => !modal.hidden,
  );
}
async function refreshFromCloud({ notify = false } = {}) {
  if (
    refreshingFromCloud ||
    !window.credmaisBridge?.enabled ||
    !state.user?.id ||
    document.hidden ||
    hasOpenModal()
  )
    return false;
  refreshingFromCloud = true;
  try {
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
      if (notify && hadPendingSync)
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
    if (notify)
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
      '<p>No iPhone, a instalação é concluída pelo menu do navegador:</p><ol class="install-steps"><li>Toque no botão <b>Compartilhar</b>.</li><li>Escolha <b>Adicionar à Tela de Início</b>.</li><li>Confirme tocando em <b>Adicionar</b>.</li></ol>';
    confirmButton.hidden = true;
  } else {
    instructions.innerHTML =
      "<p>Abra o menu do navegador e escolha <b>Instalar aplicativo</b> ou <b>Adicionar à tela inicial</b>.</p>";
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
  if (isStandalone()) $("#installAppBtn").hidden = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installAppBtn").hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    $("#installAppBtn").hidden = true;
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
function openModal(id) {
  if (id === "loanModal" && !state.clients.length) {
    toast("Cadastre um cliente antes de criar um empréstimo.");
    return openClient();
  }
  document.body.classList.add("modal-open");
  $("#modalBackdrop").hidden = false;
  $(`#${id}`).hidden = false;
  rememberModalState(id);
}
function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.hidden = true;
  });
  $("#modalBackdrop").hidden = true;
  document.body.classList.remove("modal-open");
  pendingModalId = null;
}
function requestClose() {
  if (!$("#confirmDeleteModal").hidden) return cancelDelete();
  if (!$("#discardModal").hidden) return keepEditing();
  const modal = Array.from(document.querySelectorAll(".modal")).find(
    (item) => !item.hidden && item.id !== "discardModal",
  );
  if (!modal) return closeModals();
  const form = modal.querySelector("form");
  if (
    form &&
    !form.hasAttribute("data-passive-form") &&
    modal.dataset.initialState !== formSnapshot(modal)
  ) {
    pendingModalId = modal.id;
    $("#discardModal").hidden = false;
    return;
  }
  closeModals();
}
function keepEditing() {
  $("#discardModal").hidden = true;
  pendingModalId = null;
}
function discardChanges() {
  if (pendingModalId) $(`#${pendingModalId}`).hidden = true;
  $("#discardModal").hidden = true;
  $("#modalBackdrop").hidden = true;
  document.body.classList.remove("modal-open");
  pendingModalId = null;
}
function askDelete({ title, message, action }) {
  pendingDelete = action;
  $("#confirmDeleteTitle").textContent = title;
  $("#confirmDeleteMessage").textContent = message;
  document.body.classList.add("modal-open");
  $("#modalBackdrop").hidden = false;
  $("#confirmDeleteModal").hidden = false;
}
function cancelDelete() {
  pendingDelete = null;
  $("#confirmDeleteModal").hidden = true;
  const anotherModal = Array.from(document.querySelectorAll(".modal")).some(
    (modal) => !modal.hidden && modal.id !== "confirmDeleteModal",
  );
  if (!anotherModal) {
    $("#modalBackdrop").hidden = true;
    document.body.classList.remove("modal-open");
  }
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
  resetClientForm();
  if (id) {
    const client = state.clients.find((item) => item.id === id);
    if (!client) return;
    $("#clientId").value = client.id;
    $("#clientName").value = client.name;
    $("#clientCpf").value = client.cpf;
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
  if (!state.clients.length) return openModal("loanModal");
  document.body.classList.add("modal-open");
  $("#modalBackdrop").hidden = false;
  $("#loanModal").hidden = false;
  prepareLoan(id);
  rememberModalState("loanModal");
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
  renderLoans();
  renderPaid();
  renderHistory();
  renderBlacklist();
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
    },
  ];
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
function renderStats() {
  const now = new Date();
  renderedMonthKey = monthKey(now);
  const activeLoans = state.loans.filter(
    (loan) => !loan.archived && !isLoanFullyPaid(loan),
  ),
    activeClientIds = new Set(activeLoans.map((loan) => loan.clientId)),
    activeClients = state.clients.filter((client) =>
      activeClientIds.has(client.id),
    ).length;
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
    received = receivedInMonth(now);
  const interest = Math.max(0, receivable - lent);
  $("#statLent").textContent = money(lent);
  $("#statReceivable").textContent = money(receivable);
  $("#statReceived").textContent = money(received);
  $("#statReceived").previousElementSibling.textContent =
    `Recebido em ${now.toLocaleDateString("pt-BR", { month: "long" })}`;
  $("#statClients").textContent = state.clients.length;
  $("#statActiveClients").textContent = activeClients;
  $("#statLoans").textContent = activeLoans.length;
  $("#chartTotal").textContent = money(receivable);
  $("#legendLent").textContent = money(lent);
  $("#legendInterest").textContent = money(interest);
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
function renderDueLoans() {
  const pending = state.loans
    .filter((loan) => !loan.archived)
    .flatMap((loan) =>
      Array.from({ length: loan.installments }, (_, index) => ({
        loan,
        index,
        date: dateFor(loan, index),
      })),
    )
    .filter(
      (item) =>
        installmentStatus(item.loan, item.index, item.date) !== "Quitada" &&
        dueStatus(item.date) !== "A vencer",
    )
    .sort((a, b) => b.date - a.date)
    .slice(0, 4);
  $("#dueLoans").innerHTML = pending.length
    ? pending
        .map(({ loan, index, date }) => {
          const client = state.clients.find(
              (item) => item.id === loan.clientId,
            ),
            late = lateCharge(loan, date);
          return `<div class="due-item"><div><b>${escapeHtml(client?.name || "Cliente removido")}</b><span>${installmentStatus(loan, index, date)}${late.value ? ` · +${money(late.value)}` : ""}</span></div><button class="whatsapp" data-whatsapp="${escapeHtml(loan.id)}" data-installment="${index}">Cobrar</button></div>`;
        })
        .join("")
    : '<div class="empty compact"><span>✓</span><h4>Tudo em dia</h4><p>Não há cobranças vencidas ou para hoje.</p></div>';
}
function renderClients() {
  const term = ($("#clientSearch")?.value || "").toLowerCase();
  const clients = state.clients.filter((client) =>
    [client.name, client.cpf, client.phone]
      .join(" ")
      .toLowerCase()
      .includes(term),
  );
  $("#clientCount").textContent =
    `${clients.length} cliente${clients.length === 1 ? "" : "s"}`;
  $("#clientsList").innerHTML = clients.length
    ? clients
        .map((client) => {
          const count = state.loans.filter(
            (loan) => loan.clientId === client.id,
          ).length;
          return `<article class="client-card"><div class="client-card-head"><div class="client-avatar">${escapeHtml(initials(client.name))}</div><div class="card-actions"><button class="edit-button" data-edit-client="${escapeHtml(client.id)}" aria-label="Editar ${escapeHtml(client.name)}">✎</button><button class="edit-button delete-button" data-delete-client="${escapeHtml(client.id)}" aria-label="Excluir ${escapeHtml(client.name)}">⌫</button></div></div><h3>${escapeHtml(client.name)}</h3><p>${escapeHtml(client.phone || client.email || "Sem contato informado")}</p><footer><span>${count} empréstimo${count === 1 ? "" : "s"}</span><span class="badge ${client.blacklisted ? "danger" : ""}">${client.blacklisted ? "Lista negra" : "Ativo"}</span></footer></article>`;
        })
        .join("")
    : '<div class="empty"><span>♙</span><h4>Nenhum cliente encontrado</h4><p>Cadastre seu primeiro cliente para começar.</p><button class="outline" data-open-client>Novo cliente</button></div>';
}
function renderBlacklist() {
  const clients = state.clients.filter((client) => client.blacklisted);
  $("#blacklistList").innerHTML = clients.length
    ? clients
        .map(
          (client) =>
            `<article class="client-card"><div class="client-card-head"><div class="client-avatar">${escapeHtml(initials(client.name))}</div><button class="edit-button" data-toggle-blacklist="${escapeHtml(client.id)}" aria-label="Remover ${escapeHtml(client.name)} da lista negra">✓</button></div><h3>${escapeHtml(client.name)}</h3><p>${escapeHtml(client.phone || "Sem telefone")}</p><footer><span>Marcado para atenção</span><span class="badge danger">Lista negra</span></footer></article>`,
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
  const activeLoans = state.loans.filter(
    (loan) => !loan.archived && !isLoanFullyPaid(loan),
  );
  $("#loansList").innerHTML = activeLoans.length
    ? activeLoans.slice().reverse().map(loanRow).join("")
    : '<div class="empty"><span>◫</span><h4>Nenhum empréstimo ativo</h4><p>Crie uma operação quando estiver pronto.</p><button class="outline add-loan">Criar empréstimo</button></div>';
}
function renderPaid() {
  const paidInstallments = state.loans
    .flatMap((loan) =>
      Array.from({ length: loan.installments }, (_, index) => ({
        loan,
        index,
        status: paymentStateFor(loan, index),
        payment: loan.paymentStates?.[index],
      })),
    )
    .filter((item) => item.status === "paid")
    .sort((a, b) => {
      const dateA = a.payment?.createdAt || dateFor(a.loan, a.index).toISOString(),
        dateB = b.payment?.createdAt || dateFor(b.loan, b.index).toISOString();
      return dateB.localeCompare(dateA);
    });
  $("#paidList").innerHTML = paidInstallments.length
    ? paidInstallments
        .map(({ loan, index, payment }) => {
          const client = state.clients.find((item) => item.id === loan.clientId),
            info = installmentInfo(loan, index),
            received = Number(
              payment?.receivedTotal ?? payment?.lastPayment ?? info.due ?? 0,
            ),
            paidAt = payment?.createdAt
              ? new Date(payment.createdAt).toLocaleDateString("pt-BR")
              : dateFor(loan, index).toLocaleDateString("pt-BR");
          return `<article class="paid-card"><span class="paid-check">✓</span><div><span class="eyebrow">${escapeHtml(loan.contract)}</span><h3>${escapeHtml(client?.name || "Cliente removido")}</h3><p>Parcela ${index + 1} de ${loan.installments} · quitada em ${paidAt}</p></div><strong>${money(received)}</strong><button class="outline small" data-details="${escapeHtml(loan.id)}">Ver empréstimo</button></article>`;
        })
        .join("")
    : '<div class="empty"><span>✓</span><h4>Nenhuma parcela quitada</h4><p>As parcelas marcadas como quitadas aparecerão aqui.</p></div>';
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
  const form = event.currentTarget;
  const snapshot = stateSnapshot();
  const cpf = digits($("#clientCpf").value),
    phone = digits($("#clientPhone").value);
  if (cpf.length !== 11) return toast("Informe um CPF com 11 números.");
  if (phone.length < 10 || phone.length > 11)
    return toast("Informe um telefone válido com DDD.");
  if (!beginSubmission(form, "client")) return;
  const previous = state.clients.find(
    (item) => item.id === $("#clientId").value,
  );
  const client = {
    id: $("#clientId").value || crypto.randomUUID(),
    name: $("#clientName").value.trim(),
    cpf: formatCpf(cpf),
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
  const synced = await save();
  endSubmission(form, "client");
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
}
async function saveLoan(event) {
  event.preventDefault();
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
  const synced = await save();
  endSubmission(form, "loan");
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
    return `<article class="installment-card ${visualStatus} ${expanded ? "expanded" : ""}" data-installment-card="${index}"><button class="installment-summary" data-toggle-installment="${loan.id}" data-installment="${index}" aria-expanded="${expanded}"><span><b>Parcela ${index + 1} de ${loan.installments}</b><small>📅 ${date.toLocaleDateString("pt-BR")}${charge ? ` · ${charge}` : ""}</small></span><span class="installment-side"><em class="due ${visualStatus}">${status}</em><strong>${money(value)}</strong><i>${expanded ? "⌃" : "⌄"}</i></span></button>${expanded ? `<div class="installment-body"><p class="installment-help">${status === "Pagamento parcial" ? partialGuide : status === "Só juros" ? index < loan.installments - 1 ? `💡 Juros recebidos: ${money(info.interestOnlyValue)}. O próximo pagamento passa a ser ${money(info.nextDue)}.` : `💡 Juros recebidos: ${money(info.interestOnlyValue)}. Esta última parcela foi renovada e o saldo principal continua em aberto.` : interestGuide}</p><div class="installment-main-action"><button class="whatsapp" data-whatsapp="${loan.id}" data-installment="${index}">Enviar mensagem no WhatsApp</button></div><div class="payment-actions"><button data-payment="paid" data-loan="${loan.id}" data-installment="${index}">✓ Quitado</button><button data-payment="interest" data-loan="${loan.id}" data-installment="${index}">◔ Só juros</button><button class="partial-button" data-partial="${loan.id}" data-installment="${index}">◑ Pagamento parcial</button><button data-postpone="${loan.id}" data-installment="${index}">◷ Adiar</button><button class="danger-button" data-payment="missed" data-loan="${loan.id}" data-installment="${index}">✕ Não pagou</button><button class="open-button" data-payment="open" data-loan="${loan.id}" data-installment="${index}" ${loan.paymentStates?.[index] ? "" : 'disabled title="A parcela já está em aberto"'}>↶ Deixar em aberto</button></div></div>` : ""}</article>`;
  }).join("");
  $("#loanDetails").innerHTML =
    `<div class="details-head"><div><span class="eyebrow">${escapeHtml(loan.contract || "EMP-S/CONTRATO")}</span><h2>${escapeHtml(client?.name || "Cliente")}</h2><p class="muted">${formatFrequency(loan.frequency || 30, loan.businessDays)} · ${interestDescription(loan)}</p></div><button class="outline small details-actions-trigger" data-toggle-details-actions aria-expanded="false">Ações ⋮</button></div><div class="details-actions-menu" data-details-actions-menu hidden><button class="outline small contract-message-action" data-contract-whatsapp="${escapeHtml(loan.id)}"><span>◉</span> Enviar resumo do contrato no WhatsApp</button><button class="outline small" data-edit-loan="${escapeHtml(loan.id)}"><span>✎</span> Editar empréstimo</button><button class="outline small" data-edit-client="${escapeHtml(client?.id || "")}"><span>♙</span> Editar cliente</button><button class="outline small" data-toggle-blacklist="${escapeHtml(client?.id || "")}" data-loan-context="${escapeHtml(loan.id)}"><span>⚑</span> ${client?.blacklisted ? "Remover da lista negra" : "Adicionar à lista negra"}</button><button class="outline small" data-archive-loan="${escapeHtml(loan.id)}"><span>◷</span> ${loan.archived ? "Restaurar empréstimo" : "Arquivar empréstimo"}</button><button class="outline small delete-button" data-delete-loan="${escapeHtml(loan.id)}"><span>⌫</span> Excluir empréstimo</button></div><div class="details-summary"><div><span>Valor emprestado</span><b>${money(loan.amount)}</b></div><div><span>Saldo a receber</span><b>${money(financials.receivable)}</b></div><div><span>Valor recebido</span><b>${money(financials.received)}</b></div></div><p class="details-late-fee">Juros no atraso: ${money(loan.lateFee || 0)} por ${loan.businessDays ? "dia útil" : "dia"}.</p><h3>Parcelas</h3><p class="muted charge-note">Toque em uma parcela para ver as ações e a explicação do pagamento.</p><div class="installment-list">${items}</div>`;
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
          { amount: remainingPayment, createdAt: paymentCreatedAt, type: "paid" },
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
    await save();
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
    await save();
    render();
    if (!$("#detailsModal").hidden) details(loanId);
    toast(error.message || "Não foi possível registrar o pagamento parcial.");
  } finally {
    endSubmission(form, "partial-payment");
  }
}
async function savePostpone(event) {
  event.preventDefault();
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
    render();
    toast(error.message || "Não foi possível atualizar o vencimento.");
  } finally {
    endSubmission(form, actionKey);
  }
}
async function toggleBlacklist(clientId, loanContext = null) {
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
  [$("#headerTheme"), $("#authTheme")].filter(Boolean).forEach((button) => {
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
$("#login").addEventListener("submit", login);
$("#googleSignInButton").addEventListener("click", loginWithGoogle);
$("#register").addEventListener("submit", register);
$("#forgotPassword").addEventListener("submit", requestPasswordReset);
$("#clientForm").addEventListener("submit", saveClient);
$("#loanForm").addEventListener("submit", saveLoan);
$("#postponeForm").addEventListener("submit", savePostpone);
$("#partialForm").addEventListener("submit", savePartialPayment);
$("#monthlyReportForm").addEventListener("submit", downloadMonthlyReport);
$("#passwordChangeForm").addEventListener("submit", changePassword);
[$("#loanAmount"), $("#loanLateFee"), $("#partialPaidAmount")].forEach(
  (input) => input.addEventListener("input", maskCurrencyInput),
);
$("#partialPaidAmount").addEventListener("input", calculatePartialPayment);
$("#partialInterest").addEventListener("input", calculatePartialPayment);
$("#clientCpf").addEventListener("input", (event) => {
  event.target.value = formatCpf(event.target.value);
});
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
$("#addClientBtn").onclick = () => openClient();
$("#menuBtn").onclick = () => $(".sidebar").classList.toggle("open");
$("#monthlyReportBtn").onclick = openMonthlyReport;
$("#securityBtn").onclick = openSecurity;
$("#profileGoogleButton").onclick = linkProfileGoogle;
$("#profileSecurityButton").onclick = () => {
  closeModals();
  openSecurity();
};
$("#profileResetPasswordButton").onclick = sendProfilePasswordReset;
$("#profilePixButton").onclick = () => {
  closeModals();
  openPix();
};
$("#profileLogoutButton").onclick = () => {
  closeModals();
  $("#logoutBtn").click();
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
$("#installAppBtn").onclick = openInstall;
$("#confirmInstallBtn").onclick = installPWA;
$("#logoutBtn").onclick = async () => {
  if (window.credmaisBridge?.enabled) await window.credmaisBridge.signOut();
  localStorage.removeItem("credmais_user");
  location.reload();
};
$("#modalBackdrop").onclick = closeModals;
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
  if (button.dataset.page) {
    event.preventDefault();
    setPage(button.dataset.page);
    return;
  }
  if (button.dataset.passwordToggle) {
    const input = $(`#${button.dataset.passwordToggle}`),
      show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "◉" : "◌";
    button.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    return;
  }
  if (button.classList.contains("add-loan")) openLoan();
  if (button.dataset.close) closeModals();
  if (button.dataset.pageLink) setPage(button.dataset.pageLink);
  if (button.dataset.details) details(button.dataset.details);
  if (button.dataset.whatsapp)
    openWhatsApp(button.dataset.whatsapp, button.dataset.installment);
  if (button.dataset.contractWhatsapp)
    openContractWhatsApp(button.dataset.contractWhatsapp);
  if (button.dataset.editClient) {
    closeModals();
    openClient(button.dataset.editClient);
  }
  if (button.dataset.deleteClient)
    requestDeleteClient(button.dataset.deleteClient);
  if (button.dataset.editLoan) {
    closeModals();
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
  if (event.key === "Escape") $(".sidebar").classList.remove("open");
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshFromCloud({ notify: true });
});
window.addEventListener("online", () => refreshFromCloud({ notify: true }));
window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);
  if ($(`#${page}Page`)) setPage(page);
});
window.addEventListener("storage", (event) => {
  if (!state.user || hasOpenModal()) return;
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
