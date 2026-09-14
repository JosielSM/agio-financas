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
          emailVerified: Boolean(user.email_confirmed_at),
          providers: Array.from(
            new Set(
              [
                ...(user.app_metadata?.providers || []),
                user.app_metadata?.provider,
              ].filter(Boolean),
            ),
          ),
          createdAt: user.created_at || "",
          lastSignInAt: user.last_sign_in_at || "",
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
  const missingFunction = (error) =>
    ["42883", "PGRST202"].includes(error?.code);
  const accessSchemaError = (error) =>
    ["42703", "PGRST204"].includes(error?.code) ||
    /expiry_notified_at|access_type|access_amount/i.test(error?.message || "");
  const accessError = (error) => {
    if (missingFunction(error))
      return new Error(
        "A atualização segura das assinaturas ainda não foi instalada no banco.",
      );
    if (accessSchemaError(error))
      return new Error(
        "A estrutura de assinaturas está sendo atualizada. Atualize o painel e tente novamente.",
      );
    return error;
  };
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
    custom_dates: {
      ...(loan.customDates || {}),
      _interestMode: loan.interestMode || undefined,
      _businessDays: loan.businessDays || undefined,
    },
    archived: Boolean(loan.archived),
    created_at: loan.createdAt,
  });
  const fromLoanRow = (row) => {
    const customDates = { ...(row.custom_dates || {}) },
      interestMode = customDates._interestMode,
      businessDays = Boolean(customDates._businessDays);
    delete customDates._interestMode;
    delete customDates._businessDays;
    return {
      id: row.id,
      contract: row.contract,
      clientId: row.client_id,
      amount: Number(row.amount),
      rate: Number(row.rate),
      interestMode,
      businessDays,
      installments: row.installments,
      frequency: row.frequency,
      lateFee: Number(row.late_fee || 0),
      total: Number(row.total),
      installment: Number(row.installment),
      dueDate: row.due_date,
      paymentStates: row.payment_states || {},
      customDates,
      archived: row.archived,
      createdAt: row.created_at,
    };
  };

  window.credmaisBridge = {
    enabled: authProvider !== "local",
    cloudEnabled,
    authProvider,
    async currentUser() {
      return loadProfile(await currentAuthUser());
    },
    async signIn(email, password) {
      if (firebaseAuth)
        return loadProfile(await firebaseAuth.signIn(email, password));
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
      return loadProfile(await firebaseAuth.signInWithGoogle());
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
    async platformAccess(user, phone = "") {
      if (!client)
        return { enabled: false, status: "active" };
      const { data, error } = await client.rpc("ensure_platform_account", {
        p_display_name: user?.name || "",
        p_phone: phone || null,
      });
      if (missingFunction(error))
        return { enabled: false, status: "active" };
      if (error) throw error;
      return data;
    },
    async requestPlatformAccess(user, phone) {
      if (!client)
        throw new Error("A gestão de assinaturas ainda não está disponível.");
      const { data, error } = await client.rpc("request_platform_access", {
        p_display_name: user?.name || "",
        p_phone: phone || "",
      });
      if (missingFunction(error))
        throw new Error("O painel de assinaturas ainda precisa ser ativado no banco.");
      if (error) throw error;
      return data;
    },
    async isPlatformAdmin() {
      if (!client) return false;
      const { data, error } = await client.rpc("is_platform_admin");
      if (missingFunction(error)) return false;
      if (error) throw error;
      return Boolean(data);
    },
    async bootstrapPlatformAdmin(code) {
      if (!client)
        throw new Error("O banco do painel ainda não está conectado.");
      const { data, error } = await client.rpc("bootstrap_platform_admin", {
        p_activation_code: String(code || "").trim(),
      });
      if (missingFunction(error))
        throw new Error("Execute a migração do painel administrativo no Supabase.");
      if (error) throw error;
      return Boolean(data);
    },
    async loadPlatformAdmin() {
      if (!client) throw new Error("O banco do painel não está conectado.");
      const expirySyncResult = await client.rpc(
        "admin_sync_expired_platform_accounts",
      );
      if (expirySyncResult.error && !missingFunction(expirySyncResult.error))
        throw expirySyncResult.error;
      const [accountsResult, settingsResult, logResult, adminsResult] = await Promise.all([
        client.from("platform_accounts").select("*").order("created_at"),
        client.from("platform_settings").select("*").eq("id", 1).single(),
        client
          .from("platform_access_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(12),
        client.from("platform_admins").select("user_id"),
      ]);
      const error =
        accountsResult.error || settingsResult.error || logResult.error || adminsResult.error;
      if (error) {
        if (missingRelation(error))
          throw new Error("Execute a migração do painel administrativo no Supabase.");
        throw error;
      }
      return {
        accounts: accountsResult.data || [],
        settings: settingsResult.data,
        log: logResult.data || [],
        adminIds: (adminsResult.data || []).map((admin) => admin.user_id),
        expirySync: expirySyncResult.error
          ? { available: false, count: 0, accounts: [] }
          : { available: true, ...(expirySyncResult.data || {}) },
      };
    },
    async savePlatformSettings(settings) {
      const { data, error } = await client
        .from("platform_settings")
        .update({
          default_monthly_fee: settings.defaultMonthlyFee,
          billing_recipient: settings.billingRecipient,
          billing_pix_key: settings.billingPixKey,
          billing_pix_type: settings.billingPixType,
          billing_message: settings.billingMessage,
          support_phone: settings.supportPhone,
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    async grantPlatformAccess(
      userId,
      periodValue,
      periodUnit,
      monthlyFee,
      accessType = "paid",
      accessAmount = 0,
      accountDetails = {},
    ) {
      const { data, error } = await client.rpc("admin_grant_platform_access_v3", {
        p_user_id: userId,
        p_period_value: Number(periodValue),
        p_period_unit: periodUnit,
        p_monthly_fee: Number(monthlyFee),
        p_access_type: accessType,
        p_access_amount: Number(accessAmount),
        p_phone: accountDetails.phone || "",
        p_notes: accountDetails.notes || "",
      });
      if (missingFunction(error)) {
        const compatible = await client.rpc("admin_grant_platform_access_v2", {
          p_user_id: userId,
          p_period_value: Number(periodValue),
          p_period_unit: periodUnit,
          p_monthly_fee: Number(monthlyFee),
          p_access_type: accessType,
          p_access_amount: Number(accessAmount),
        });
        if (!compatible.error) return compatible.data;
        if (!missingFunction(compatible.error)) throw accessError(compatible.error);
      }
      if (missingFunction(error) && periodUnit === "months" && accessType === "paid") {
        const fallback = await client.rpc("admin_grant_platform_access", {
          p_user_id: userId,
          p_months: Number(periodValue),
          p_monthly_fee: Number(monthlyFee),
        });
        if (fallback.error) throw accessError(fallback.error);
        return fallback.data;
      }
      if (error) throw accessError(error);
      return data;
    },
    async grantPlatformLifetime(userId, accountDetails = {}) {
      const { data, error } = await client.rpc("admin_grant_platform_lifetime_v2", {
        p_user_id: userId,
        p_phone: accountDetails.phone || "",
        p_notes: accountDetails.notes || "",
      });
      if (missingFunction(error)) {
        const compatible = await client.rpc("admin_grant_platform_lifetime", {
          p_user_id: userId,
        });
        if (compatible.error) throw accessError(compatible.error);
        return compatible.data;
      }
      if (error) throw accessError(error);
      return data;
    },
    async setPlatformAccountStatus(userId, status) {
      const { data, error } = await client.rpc("admin_set_platform_status", {
        p_user_id: userId,
        p_status: status,
      });
      if (error) throw error;
      return data;
    },
    async updatePlatformAccount(userId, values) {
      const { data, error } = await client
        .from("platform_accounts")
        .update({
          phone: values.phone || "",
          notes: values.notes || "",
          monthly_fee: Number(values.monthlyFee),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .select("*")
        .single();
      if (error) throw error;
      return data;
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
    async linkGoogle() {
      if (firebaseAuth) return firebaseAuth.linkGoogle();
      throw new Error("O vínculo com Google requer a autenticação pelo Firebase.");
    },
    async deleteAccount(password = "") {
      if (!client || !firebaseAuth)
        throw new Error(
          "A exclusão completa requer conexão com a conta Firebase.",
        );
      const user = await currentAuthUser();
      if (!user?.id)
        throw new Error("Entre novamente antes de apagar sua conta.");
      await firebaseAuth.reauthenticateForDeletion(password);
      const { error } = await client.rpc("delete_my_account_data");
      if (["PGRST202", "42883"].includes(error?.code))
        throw new Error(
          "A exclusão segura ainda precisa ser ativada no banco de dados.",
        );
      if (error) throw error;
      try {
        await firebaseAuth.deleteAccount();
      } catch (error) {
        const partialError = new Error(
          "Os dados financeiros foram apagados, mas o acesso ainda não foi removido. Tente apagar a conta novamente.",
        );
        partialError.original = error;
        throw partialError;
      }
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
