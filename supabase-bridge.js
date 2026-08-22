(() => {
  const config = window.CREDMAIS_SUPABASE || {};
  const enabled = Boolean(
    config.url && config.publishableKey && window.supabase,
  );
  const client = enabled
    ? window.supabase.createClient(config.url, config.publishableKey)
    : null;
  const userData = (user) =>
    user
      ? {
          id: user.id,
          name:
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuário",
          email: user.email,
          pixKey: user.user_metadata?.pix_key || "",
          pixType: user.user_metadata?.pix_key_type || "Chave aleatória",
          pixRecipientName: user.user_metadata?.pix_recipient_name || "",
        }
      : null;
  const toLoanRow = (loan, ownerId) => ({
    id: loan.id,
    owner_id: ownerId,
    contract: loan.contract,
    client_id: loan.clientId,
    amount: loan.amount,
    rate: loan.rate,
    installments: loan.installments,
    frequency: loan.frequency,
    late_fee: loan.lateFee || 0,
    total: loan.total,
    installment: loan.installment,
    due_date: loan.dueDate,
    payment_states: loan.paymentStates || {},
    custom_dates: loan.customDates || {},
    archived: Boolean(loan.archived),
    created_at: loan.createdAt,
  });
  const fromLoanRow = (row) => ({
    id: row.id,
    contract: row.contract,
    clientId: row.client_id,
    amount: Number(row.amount),
    rate: Number(row.rate),
    installments: row.installments,
    frequency: row.frequency,
    lateFee: Number(row.late_fee || 0),
    total: Number(row.total),
    installment: Number(row.installment),
    dueDate: row.due_date,
    paymentStates: row.payment_states || {},
    customDates: row.custom_dates || {},
    archived: row.archived,
    createdAt: row.created_at,
  });
  window.credmaisBridge = {
    enabled,
    async currentUser() {
      if (!client) return null;
      const { data } = await client.auth.getUser();
      return userData(data.user);
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      return userData(data.user);
    },
    async signUp(name, email, password) {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      });
      if (error) throw error;
      return { user: userData(data.user), hasSession: Boolean(data.session) };
    },
    async updatePix(pixKey, pixType, pixRecipientName) {
      const { data, error } = await client.auth.updateUser({
        data: {
          pix_key: pixKey,
          pix_key_type: pixType,
          pix_recipient_name: pixRecipientName,
        },
      });
      if (error) throw error;
      return userData(data.user);
    },
    async signOut() {
      if (client) await client.auth.signOut();
    },
    async load() {
      if (!client) return { clients: [], loans: [] };
      const [clientsResult, loansResult] = await Promise.all([
        client.from("clients").select("*").order("created_at"),
        client.from("loans").select("*").order("created_at"),
      ]);
      if (clientsResult.error) throw clientsResult.error;
      if (loansResult.error) throw loansResult.error;
      return {
        clients: clientsResult.data.map((row) => ({
          id: row.id,
          name: row.name,
          cpf: row.cpf,
          phone: row.phone,
          email: row.email || "",
          note: row.note || "",
          blacklisted: row.blacklisted,
        })),
        loans: loansResult.data.map(fromLoanRow),
      };
    },
    async sync(user, clients, loans) {
      if (!client || !user?.id) return;
      const clientRows = clients.map((item) => ({
        ...item,
        owner_id: user.id,
      }));
      const loanRows = loans.map((item) => toLoanRow(item, user.id));
      if (clientRows.length) {
        const { error } = await client.from("clients").upsert(clientRows);
        if (error) throw error;
      }
      if (loanRows.length) {
        const { error } = await client.from("loans").upsert(loanRows);
        if (error) throw error;
      }
    },
  };
})();
