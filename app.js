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
let refreshingFromCloud = false;
const money = (value) =>
  Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
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
    localStorage.removeItem("credmais_sync_pending");
    return true;
  } catch (error) {
    localStorage.setItem("credmais_sync_pending", state.user.id);
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
const dateFor = (loan, installment) => {
  if (loan.customDates?.[installment])
    return new Date(`${loan.customDates[installment]}T12:00`);
  const date = new Date(`${loan.dueDate}T12:00`);
  date.setDate(date.getDate() + Number(loan.frequency || 30) * installment);
  return date;
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
const formatFrequency = (days) =>
  Number(days) === 30 ? "Mensal" : `A cada ${days} dias`;
const installmentStatus = (loan, index, date) =>
  loan.paymentStates?.[index] === "paid"
    ? "Quitada"
    : loan.paymentStates?.[index] === "interest"
      ? "Só juros"
      : loan.paymentStates?.[index] === "missed"
        ? "Não pagou"
        : dueStatus(date);
const lateCharge = (loan, date) => {
  const days = Math.max(
    0,
    Math.floor(
      (new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) /
        86400000,
    ),
  );
  return { days, value: days * Number(loan.lateFee || 0) };
};
function toast(message, undoAction = null) {
  const element = $("#toast");
  clearTimeout(toastTimer);
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
function openPix() {
  $("#pixRecipientName").value =
    state.user?.pixRecipientName || state.user?.name || "";
  $("#pixKey").value = state.user?.pixKey || "";
  $("#pixType").value = state.user?.pixType || "Chave aleatória";
  openModal("pixModal");
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
  $("#loginForm").hidden = view !== "login";
  $("#registerForm").hidden = view !== "register";
}
async function showApp() {
  if (window.credmaisBridge?.enabled) {
    const ownsCache =
      localStorage.getItem("credmais_cache_owner") === state.user.id;
    if (!ownsCache) {
      state.clients = [];
      state.loans = [];
    }
    try {
      if (localStorage.getItem("credmais_sync_pending") === state.user.id) {
        await window.credmaisBridge.sync(
          state.user,
          state.clients,
          state.loans,
          state.history,
        );
        localStorage.removeItem("credmais_sync_pending");
      }
      const cloud = await window.credmaisBridge.load();
      state.clients = cloud.clients;
      state.loans = cloud.loans;
      state.history = cloud.history ?? state.history;
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
  render();
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
    hasOpenModal() ||
    localStorage.getItem("credmais_sync_pending") === state.user.id
  )
    return false;
  refreshingFromCloud = true;
  try {
    const cloud = await window.credmaisBridge.load();
    const nextHistory = cloud.history ?? state.history;
    const changed =
      JSON.stringify(state.clients) !== JSON.stringify(cloud.clients) ||
      JSON.stringify(state.loans) !== JSON.stringify(cloud.loans) ||
      JSON.stringify(state.history) !== JSON.stringify(nextHistory);
    if (!changed) {
      render();
      return false;
    }
    state.clients = cloud.clients;
    state.loans = cloud.loans;
    state.history = nextHistory;
    localStorage.setItem("credmais_clients", JSON.stringify(state.clients));
    localStorage.setItem("credmais_loans", JSON.stringify(state.loans));
    localStorage.setItem("credmais_history", JSON.stringify(state.history));
    render();
    if (notify) toast("Dados atualizados automaticamente.");
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
      state.user = await window.credmaisBridge.signIn(email, password);
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
  $("#loanInterest").value = "10";
  $("#loanFrequency").value = "30";
  $("#loanLateFee").value = "0";
  $("#loanInstallments").value = "6";
  const date = new Date();
  date.setDate(date.getDate() + 30);
  $("#loanDueDate").value = date.toISOString().slice(0, 10);
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
  const modal = $(`#${id}`);
  if (modal?.querySelector("form"))
    modal.dataset.initialState = formSnapshot(modal);
}
function openModal(id) {
  if (id === "loanModal" && !state.clients.length) {
    toast("Cadastre um cliente antes de criar um empréstimo.");
    return openClient();
  }
  $("#modalBackdrop").hidden = false;
  $(`#${id}`).hidden = false;
  rememberModalState(id);
}
function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.hidden = true;
  });
  $("#modalBackdrop").hidden = true;
  pendingModalId = null;
}
function requestClose() {
  if (!$("#confirmDeleteModal").hidden) return cancelDelete();
  if (!$("#discardModal").hidden) return keepEditing();
  const modal = Array.from(document.querySelectorAll(".modal")).find(
    (item) => !item.hidden && item.id !== "discardModal",
  );
  if (!modal) return closeModals();
  if (
    modal.querySelector("form") &&
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
  pendingModalId = null;
}
function askDelete({ title, message, action }) {
  pendingDelete = action;
  $("#confirmDeleteTitle").textContent = title;
  $("#confirmDeleteMessage").textContent = message;
  $("#modalBackdrop").hidden = false;
  $("#confirmDeleteModal").hidden = false;
}
function cancelDelete() {
  pendingDelete = null;
  $("#confirmDeleteModal").hidden = true;
  const anotherModal = Array.from(document.querySelectorAll(".modal")).some(
    (modal) => !modal.hidden && modal.id !== "confirmDeleteModal",
  );
  if (!anotherModal) $("#modalBackdrop").hidden = true;
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
    $("#loanAmount").value = loan.amount;
    $("#loanInterest").value = loan.rate * 100;
    $("#loanInstallments").value = loan.installments;
    $("#loanFrequency").value = loan.frequency || 30;
    $("#loanLateFee").value = loan.lateFee || 0;
    $("#loanDueDate").value = loan.dueDate;
    $("#loanModalEyebrow").textContent = "EDITAR OPERAÇÃO";
    $("#loanModalTitle").textContent = "Atualizar empréstimo";
    $("#loanSaveBtn").textContent = "Salvar alterações";
  }
  calc();
}
function openLoan(id) {
  if (!state.clients.length) return openModal("loanModal");
  $("#modalBackdrop").hidden = false;
  $("#loanModal").hidden = false;
  prepareLoan(id);
  rememberModalState("loanModal");
}
function setPage(page) {
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
    history: "Histórico",
    blacklist: "Lista negra",
  }[page];
  $(".sidebar").classList.remove("open");
  render();
}
function render() {
  renderStats();
  renderClients();
  renderLoans();
  renderHistory();
  renderBlacklist();
}
function renderStats() {
  const activeLoans = state.loans.filter((loan) => !loan.archived);
  const lent = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
  const receivable = activeLoans.reduce((sum, loan) => sum + loan.total, 0);
  const interest = Math.max(0, receivable - lent);
  $("#statLent").textContent = money(lent);
  $("#statReceivable").textContent = money(receivable);
  $("#statClients").textContent = state.clients.length;
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
  };
  return `<article class="loan-row"><div><h3>${escapeHtml(client.name)}</h3><p>${loan.installments}x de ${money(loan.installment)} · ${formatFrequency(loan.frequency || 30)}</p></div><div class="loan-extra"><p>Emprestado</p><b>${money(loan.amount)}</b></div><div class="loan-extra"><p>1º vencimento</p><b>${dateFor(loan, 0).toLocaleDateString("pt-BR")}</b></div><div class="loan-value">${money(loan.total)}</div><button data-details="${escapeHtml(loan.id)}">Detalhes →</button></article>`;
}
function renderLoans() {
  const activeLoans = state.loans.filter((loan) => !loan.archived);
  $("#loansList").innerHTML = activeLoans.length
    ? activeLoans.slice().reverse().map(loanRow).join("")
    : '<div class="empty"><span>◫</span><h4>Nenhum empréstimo ativo</h4><p>Crie uma operação quando estiver pronto.</p><button class="outline add-loan">Criar empréstimo</button></div>';
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
  const amount = Number($("#loanAmount").value) || 0;
  const rate = (Number($("#loanInterest").value) || 0) / 100;
  const periods = Number($("#loanInstallments").value) || 1;
  const total = amount * Math.pow(1 + rate, periods);
  $("#calcInterest").textContent = money(total - amount);
  $("#calcTotal").textContent = money(total);
  $("#calcInstallment").textContent = money(total / periods);
  return { amount, rate, periods, total };
}
async function saveClient(event) {
  event.preventDefault();
  const snapshot = stateSnapshot();
  const cpf = digits($("#clientCpf").value),
    phone = digits($("#clientPhone").value);
  if (cpf.length !== 11) return toast("Informe um CPF com 11 números.");
  if (phone.length < 10 || phone.length > 11)
    return toast("Informe um telefone válido com DDD.");
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
  const snapshot = stateSnapshot();
  const calculation = calc();
  if (!calculation.amount) return toast("Informe o valor emprestado.");
  const previous = state.loans.find((item) => item.id === $("#loanId").value);
  const loan = {
    id: $("#loanId").value || crypto.randomUUID(),
    contract: previous?.contract || `EMP-${String(Date.now()).slice(-5)}`,
    clientId: $("#loanClient").value,
    amount: calculation.amount,
    rate: calculation.rate,
    installments: calculation.periods,
    frequency: Number($("#loanFrequency").value),
    lateFee: Number($("#loanLateFee").value) || 0,
    total: calculation.total,
    installment: calculation.total / calculation.periods,
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
    `${loan.contract} · ${loanClient?.name || "Cliente"} · ${money(loan.amount)}.`,
  );
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
    if (index < 0 && window.credmaisBridge?.enabled)
      await window.credmaisBridge.deleteLoan(loan.id);
    await restoreSnapshot(snapshot, "loans");
  });
}
function installmentInfo(loan, index) {
  let carry = 0;
  const interestOnlyValue = Math.min(loan.installment, loan.amount * loan.rate);
  for (let current = 0; current < index; current += 1) {
    const due = loan.installment + carry,
      previousState = loan.paymentStates?.[current];
    carry = previousState === "interest" ? due - interestOnlyValue : 0;
  }
  const due = loan.installment + carry,
    state = loan.paymentStates?.[index];
  return {
    due,
    interestOnlyValue: Math.min(interestOnlyValue, due),
    deferred: Math.max(0, due - interestOnlyValue),
    nextDue:
      index < loan.installments - 1
        ? loan.installment + Math.max(0, due - interestOnlyValue)
        : 0,
    state,
  };
}
function toggleInstallment(loanId, index) {
  const key = `${loanId}:${index}`;
  expandedInstallment = expandedInstallment === key ? null : key;
  details(loanId);
}
function details(id) {
  const loan = state.loans.find((item) => item.id === id),
    client = state.clients.find((item) => item.id === loan.clientId);
  const items = Array.from({ length: loan.installments }, (_, index) => {
    const date = dateFor(loan, index),
      status = installmentStatus(loan, index, date),
      late = lateCharge(loan, date),
      info = installmentInfo(loan, index),
      expanded = expandedInstallment === `${loan.id}:${index}`,
      lateValue =
        status === "Vencida" || status === "Não pagou" ? late.value : 0,
      value =
        status === "Só juros" ? info.interestOnlyValue : info.due + lateValue,
      charge = lateValue
        ? `${late.days} dia(s) de atraso · +${money(lateValue)}`
        : "",
      interestGuide =
        index < loan.installments - 1
          ? `Pagar somente ${money(info.interestOnlyValue)} agora. O saldo de ${money(info.deferred)} será somado à próxima parcela, que ficará em ${money(info.nextDue)}.`
          : "Só juros não está disponível na última parcela; use Adiar para negociar uma nova data.";
    return `<article class="installment-card ${expanded ? "expanded" : ""}"><button class="installment-summary" data-toggle-installment="${loan.id}" data-installment="${index}" aria-expanded="${expanded}"><span><b>Parcela ${index + 1} de ${loan.installments}</b><small>📅 ${date.toLocaleDateString("pt-BR")}${charge ? ` · ${charge}` : ""}</small></span><span class="installment-side"><em class="due ${status === "A vencer" || status === "Quitada" ? "future" : "late"}">${status}</em><strong>${money(value)}</strong><i>${expanded ? "⌃" : "⌄"}</i></span></button>${expanded ? `<div class="installment-body"><p class="installment-help">${status === "Só juros" ? `💡 Juros recebidos: ${money(info.interestOnlyValue)}. O próximo pagamento passa a ser ${money(info.nextDue)}.` : interestGuide}</p><div class="installment-main-action"><button class="whatsapp" data-whatsapp="${loan.id}" data-installment="${index}">Enviar mensagem no WhatsApp</button></div><div class="payment-actions"><button data-payment="paid" data-loan="${loan.id}" data-installment="${index}">✓ Quitado</button>${index < loan.installments - 1 ? `<button data-payment="interest" data-loan="${loan.id}" data-installment="${index}">◔ Só juros</button>` : ""}<button data-postpone="${loan.id}" data-installment="${index}">◷ Adiar</button><button class="danger-button" data-payment="missed" data-loan="${loan.id}" data-installment="${index}">✕ Não pagou</button>${loan.paymentStates?.[index] ? `<button class="open-button" data-payment="open" data-loan="${loan.id}" data-installment="${index}">↶ Deixar em aberto</button>` : ""}</div></div>` : ""}</article>`;
  }).join("");
  $("#loanDetails").innerHTML =
    `<div class="details-head"><div><span class="eyebrow">${escapeHtml(loan.contract || "EMP-S/CONTRATO")}</span><h2>${escapeHtml(client?.name || "Cliente")}</h2><p class="muted">${formatFrequency(loan.frequency || 30)} · juros de ${(loan.rate * 100).toLocaleString("pt-BR")}% por período</p></div><button class="outline small" data-edit-loan="${escapeHtml(loan.id)}">Editar</button></div><div class="details-summary"><div><span>Valor emprestado</span><b>${money(loan.amount)}</b></div><div><span>Juros diários no atraso</span><b>${money(loan.lateFee || 0)}</b></div><div><span>Total a receber</span><b>${money(loan.total)}</b></div></div><div class="details-tools"><button class="outline small" data-toggle-blacklist="${escapeHtml(client?.id || "")}">${client?.blacklisted ? "Remover da lista negra" : "Adicionar à lista negra"}</button><button class="outline small" data-edit-client="${escapeHtml(client?.id || "")}">Editar cliente</button><button class="outline small" data-archive-loan="${escapeHtml(loan.id)}">${loan.archived ? "Restaurar empréstimo" : "Arquivar empréstimo"}</button><button class="outline small delete-button" data-delete-loan="${escapeHtml(loan.id)}">Excluir empréstimo</button></div><h3>Parcelas</h3><p class="muted charge-note">Toque em uma parcela para ver as ações e a explicação do pagamento.</p><div class="installment-list">${items}</div>`;
  openModal("detailsModal");
}
async function updatePayment(loanId, installment, status) {
  const loan = state.loans.find((item) => item.id === loanId);
  if (status === "interest" && Number(installment) === loan.installments - 1)
    return toast(
      "Na última parcela, adie a data ou registre o pagamento completo.",
    );
  const snapshot = stateSnapshot();
  loan.paymentStates = loan.paymentStates || {};
  if (status === "open") delete loan.paymentStates[installment];
  else loan.paymentStates[installment] = status;
  const paymentLabels = {
    paid: "marcada como quitada",
    interest: "marcada como somente juros",
    missed: "marcada como não paga",
    open: "deixada em aberto novamente",
  };
  addHistory(
    "payment",
    `Parcela ${Number(installment) + 1} alterada`,
    `${loan.contract}: parcela ${paymentLabels[status]}.`,
  );
  const synced = await save();
  render();
  expandedInstallment = `${loanId}:${installment}`;
  details(loanId);
  const message =
    !synced
      ? "Alteração salva neste dispositivo. A sincronização será tentada novamente."
      : status === "paid"
      ? "Parcela marcada como quitada."
      : status === "interest"
        ? "Juros registrados; o saldo foi levado para a próxima parcela."
        : status === "open"
          ? "Parcela deixada em aberto novamente."
          : "Parcela marcada como não paga.";
  toast(message, () => restoreSnapshot(snapshot, null, loanId));
}
function openPostpone(loanId, installment) {
  const loan = state.loans.find((item) => item.id === loanId),
    client = state.clients.find((item) => item.id === loan.clientId),
    date = dateFor(loan, installment);
  $("#postponeLoanId").value = loanId;
  $("#postponeInstallment").value = installment;
  $("#postponeDate").value = date.toISOString().slice(0, 10);
  $("#postponeSummary").innerHTML =
    `<span>Cliente</span><b>${escapeHtml(client?.name || "Cliente")}</b><span>Parcela</span><b>${Number(installment) + 1} de ${loan.installments} · ${money(loan.installment)}</b><span>Data atual</span><b>${date.toLocaleDateString("pt-BR")}</b>`;
  openModal("postponeModal");
}
async function savePostpone(event) {
  event.preventDefault();
  const snapshot = stateSnapshot();
  const loanId = $("#postponeLoanId").value,
    installment = $("#postponeInstallment").value,
    next = $("#postponeDate").value;
  if (!next) return toast("Escolha uma nova data.");
  const loan = state.loans.find((item) => item.id === loanId);
  loan.customDates = loan.customDates || {};
  const previousDate = dateFor(loan, Number(installment)).toLocaleDateString("pt-BR");
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
      ? "Data da parcela atualizada."
      : "Data salva neste dispositivo. A sincronização será tentada novamente.",
    () => restoreSnapshot(snapshot, null, loanId),
  );
}
async function toggleBlacklist(clientId) {
  const client = state.clients.find((item) => item.id === clientId);
  if (!client) return;
  const snapshot = stateSnapshot();
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
  const message =
    !synced
      ? "Alteração salva neste dispositivo. A sincronização será tentada novamente."
      : client.blacklisted
      ? "Cliente adicionado à lista negra."
      : "Cliente removido da lista negra.";
  toast(message, () => restoreSnapshot(snapshot));
}
async function archiveLoan(loanId) {
  const loan = state.loans.find((item) => item.id === loanId);
  const snapshot = stateSnapshot();
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
  const message =
    !synced
      ? "Alteração salva neste dispositivo. A sincronização será tentada novamente."
      : loan.archived
        ? "Empréstimo arquivado."
        : "Empréstimo restaurado.";
  toast(message, () => restoreSnapshot(snapshot, loan.archived ? "loans" : "history"));
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
  const loan = state.loans.find((item) => item.id === loanId),
    client = state.clients.find((item) => item.id === loan.clientId),
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
      status === "Só juros" ? info.interestOnlyValue : info.due + lateValue,
    pixKey = state.user?.pixKey?.trim(),
    pixRecipientName =
      state.user?.pixRecipientName?.trim() || state.user?.name?.trim(),
    pixPayment = pixKey
      ? `\n\n💠 *PAGAMENTO VIA PIX*\n👤 Recebedor: *${pixRecipientName || "Não informado"}*\n🔑 Chave (${state.user.pixType || "PIX"}):\n${pixKey}`
      : "\n\n💳 Para efetuar o pagamento, solicite a chave PIX pelo WhatsApp.",
    action =
      status === "Quitada"
        ? `✅ Confirmamos o pagamento de *${money(value)}*. Esta parcela está quitada.`
        : status === "Só juros"
          ? `◔ Recebemos *${money(info.interestOnlyValue)}* referentes aos juros. O saldo de *${money(info.deferred)}* foi levado para a próxima parcela, que ficará em *${money(info.nextDue)}*.`
          : status === "Não pagou"
            ? `⚠️ Esta parcela está em aberto. O valor atualizado para pagamento é *${money(value)}*.`
            : `💰 *Valor para pagamento*\n${money(value)}`;
  const title =
    status === "Quitada"
      ? "CONFIRMAÇÃO DE PAGAMENTO"
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
$("#register").addEventListener("submit", register);
$("#clientForm").addEventListener("submit", saveClient);
$("#loanForm").addEventListener("submit", saveLoan);
$("#postponeForm").addEventListener("submit", savePostpone);
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
["loanAmount", "loanInterest", "loanInstallments"].forEach((id) =>
  $(`#${id}`).addEventListener("input", calc),
);
$("#clientSearch").addEventListener("input", renderClients);
$("#addClientBtn").onclick = () => openClient();
$("#menuBtn").onclick = () => $(".sidebar").classList.toggle("open");
$("#headerTheme").onclick = toggleTheme;
$("#authTheme").onclick = toggleTheme;
$("#logoutBtn").onclick = async () => {
  if (window.credmaisBridge?.enabled) await window.credmaisBridge.signOut();
  localStorage.removeItem("credmais_user");
  location.reload();
};
$("#modalBackdrop").onclick = closeModals;
document.querySelectorAll("[data-auth]").forEach((button) => {
  button.onclick = () => setAuth(button.dataset.auth);
});
document
  .querySelectorAll(".nav-link[data-page], .bottom-link[data-page]")
  .forEach((button) => {
    button.onclick = () => setPage(button.dataset.page);
  });
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
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
  if (button.dataset.editClient) openClient(button.dataset.editClient);
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
    );
  if (button.dataset.postpone)
    openPostpone(button.dataset.postpone, button.dataset.installment);
  if (button.dataset.toggleBlacklist)
    toggleBlacklist(button.dataset.toggleBlacklist);
  if (button.dataset.archiveLoan) archiveLoan(button.dataset.archiveLoan);
  if (button.dataset.deleteLoan) requestDeleteLoan(button.dataset.deleteLoan);
  if (button.hasAttribute("data-open-client")) openClient();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshFromCloud({ notify: true });
});
window.addEventListener("online", () => refreshFromCloud({ notify: true }));
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
const savedTheme = localStorage.getItem("credmais_theme");
applyTheme(
  savedTheme
    ? savedTheme === "dark"
    : window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  false,
);
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
        state.user = user;
        localStorage.setItem("credmais_user", JSON.stringify(user));
        await showApp();
      }
    } else if (state.user) {
      await showApp();
    }
  } catch (error) {
    console.error("Falha ao restaurar a sessão:", error);
    if (state.user) await showApp();
  } finally {
    finishInitialLoading();
  }
})();
