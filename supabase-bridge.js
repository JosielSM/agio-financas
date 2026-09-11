(() => {
  const config = window.CREDMAIS_SUPABASE || {};
  const firebaseAuth = window.credmaisFirebase?.configured
    ? window.credmaisFirebase
    : null;
  const cloudEnabled = Boolean(
    config.url && config.publishableKey && window.supabase,
  );
  const client = cloudEnabled
    ? window.supabase.createClient(
        config.url,
        config.publishableKey,
        firebaseAuth?.enabled
          ? { accessToken: () => firebaseAuth.getAccessToken(false) }
          : undefined,
      )
    : null;
  const authProvider = firebaseAuth
    ? "firebase"
    : cloudEnabled
      ? "supabase"
      : "local";

  const supabaseUserData = (user) =>
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
          provider: "supabase",
        }
      : null;
  const withProfile = (user, profile) =>
    user
      ? {
          ...user,
          name: profile?.display_name || user.name,
          pixKey: profile?.pix_key || user.pixKey || "",
          pixType:
            profile?.pix_key_type || user.pixType || "Chave aleatória",
          pixRecipientName:
            profile?.pix_recipient_name || user.pixRecipientName || "",
        }
      : null;
  const missingRelation = (error) =>
    ["42P01", "PGRST205"].includes(error?.code);
  async function loadProfile(user) {
    if (!client || !user?.id) return user;
    const { data, error } = await client
      .from("profiles")
      .select("*")
      .eq("owner_id", user.id)
      .maybeSingle();
    if (error && !missingRelation(error)) throw error;
    return withProfile(user, data);
  }
  async function currentAuthUser() {
    if (firebaseAuth) return firebaseAuth.currentUser();
    if (!client) return null;
    const { data: sessionData, error: sessionError } =
      await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session?.user) return null;
    const { data, error } = await client.auth.getUser();
    if (error) throw error;
    return supabaseUserData(data.user);
  }
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
    enabled: authProvider !== "local",
    cloudEnabled,
    authProvider,
    async currentUser() {
      return loadProfile(await currentAuthUser());
    },
    async signIn(email, password) {
      if (firebaseAuth) return firebaseAuth.signIn(email, password);
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      return loadProfile(supabaseUserData(data.user));
    },
    async signInWithGoogle() {
      if (!firebaseAuth)
        throw new Error("O acesso com Google depende do Firebase.");
      return firebaseAuth.signInWithGoogle();
    },
    async signUp(name, email, password) {
      if (firebaseAuth) return firebaseAuth.signUp(name, email, password);
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      });
      if (error) throw error;
      return {
        user: supabaseUserData(data.user),
        hasSession: Boolean(data.session),
      };
    },
    async sendPasswordReset(email) {
      if (firebaseAuth) return firebaseAuth.sendPasswordReset(email);
      throw new Error(
        "A recuperação por e-mail será ativada quando a migração para o Firebase for concluída.",
      );
    },
    async resendVerification(email, password) {
      if (firebaseAuth)
        return firebaseAuth.resendVerification(email, password);
      throw new Error(
        "A confirmação por e-mail será ativada quando a migração para o Firebase for concluída.",
      );
    },
    async updatePix(pixKey, pixType, pixRecipientName) {
      if (firebaseAuth) {
        const user = await firebaseAuth.currentUser();
        if (!user) throw new Error("Entre novamente para atualizar seus dados.");
        const profile = {
          owner_id: user.id,
          display_name: user.name,
          pix_key: pixKey,
          pix_key_type: pixType,
          pix_recipient_name: pixRecipientName,
          updated_at: new Date().toISOString(),
        };
        if (client) {
          const { error } = await client.from("profiles").upsert(profile);
          if (error) throw error;
        }
        return withProfile(user, profile);
      }
      const { data, error } = await client.auth.updateUser({
        data: {
          pix_key: pixKey,
          pix_key_type: pixType,
          pix_recipient_name: pixRecipientName,
        },
      });
      if (error) throw error;
      return supabaseUserData(data.user);
    },
    async changePassword(newPassword) {
      if (firebaseAuth) return firebaseAuth.changePassword(newPassword);
      const { error } = await client.auth.updateUser({ password: newPassword });
      if (error) throw error;
    },
    async signOut() {
      if (firebaseAuth) await firebaseAuth.signOut();
      else if (client) await client.auth.signOut();
    },
    async load() {
      if (!client)
        return { clients: [], loans: [], history: [], profile: null };
      const user = await currentAuthUser();
      const [clientsResult, loansResult, historyResult, profileResult] =
        await Promise.all([
          client.from("clients").select("*").order("created_at"),
          client.from("loans").select("*").order("created_at"),
          client.from("activity_history").select("*").order("created_at"),
          user?.id
            ? client
                .from("profiles")
                .select("*")
                .eq("owner_id", user.id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
      if (clientsResult.error) throw clientsResult.error;
      if (loansResult.error) throw loansResult.error;
      if (profileResult.error && !missingRelation(profileResult.error))
        throw profileResult.error;
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
        history: historyResult.error
          ? null
          : historyResult.data.map((row) => ({
              id: row.id,
              category: row.category,
              title: row.title,
              description: row.description || "",
              createdAt: row.created_at,
            })),
        profile: profileResult.data
          ? withProfile(user, profileResult.data)
          : null,
      };
    },
    async deleteLoan(loanId) {
      if (!client) return;
      const { error } = await client.from("loans").delete().eq("id", loanId);
      if (error) throw error;
    },
    async deleteClient(clientId) {
      if (!client) return;
      const { error } = await client.from("clients").delete().eq("id", clientId);
      if (error?.code === "23503")
        throw new Error(
          "A atualização de exclusão segura ainda precisa ser aplicada no banco.",
        );
      if (error) throw error;
    },
    async sync(user, clients, loans, history = []) {
      if (!client || !user?.id) return;
      const clientRows = clients.map((item) => ({
        ...item,
        owner_id: user.id,
      }));
      const loanRows = loans.map((item) => toLoanRow(item, user.id));
      const historyRows = history.map((item) => ({
        id: item.id,
        owner_id: user.id,
        category: item.category,
        title: item.title,
        description: item.description || "",
        created_at: item.createdAt,
      }));
      if (firebaseAuth) {
        const { error } = await client.from("profiles").upsert({
          owner_id: user.id,
          display_name: user.name,
          pix_key: user.pixKey || "",
          pix_key_type: user.pixType || "Chave aleatória",
          pix_recipient_name: user.pixRecipientName || "",
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      }
      if (clientRows.length) {
        const { error } = await client.from("clients").upsert(clientRows);
        if (error) throw error;
      }
      if (loanRows.length) {
        const { error } = await client.from("loans").upsert(loanRows);
        if (error) throw error;
      }
      if (historyRows.length) {
        const { error } = await client
          .from("activity_history")
          .upsert(historyRows);
        if (error && error.code !== "PGRST205")
          console.warn(
            "Histórico ainda não configurado no Supabase:",
            error.message,
          );
      }
    },
  };
})();
