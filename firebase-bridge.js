(() => {
  const config = window.CREDMAIS_FIREBASE || {};
  const requiredKeys = ["apiKey", "authDomain", "projectId", "appId"];
  const configured = requiredKeys.every(
    (key) => typeof config[key] === "string" && config[key].trim(),
  );
  let auth = null;
  let initializationError = null;

  const errorMessages = {
    "auth/admin-restricted-operation":
      "O cadastro por e-mail ainda não foi liberado no Firebase.",
    "auth/email-already-in-use": "Este e-mail já possui uma conta.",
    "auth/email-not-verified":
      "Confirme seu e-mail antes de entrar. Enviamos um novo link para sua caixa de entrada.",
    "auth/expired-action-code":
      "Este link expirou. Solicite um novo e-mail para continuar.",
    "auth/invalid-action-code":
      "Este link é inválido ou já foi utilizado. Solicite um novo e-mail.",
    "auth/invalid-api-key":
      "A configuração do Firebase está inválida. Revise a chave do aplicativo.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/invalid-email": "Informe um e-mail válido.",
    "auth/network-request-failed":
      "Não foi possível conectar. Confira sua internet e tente novamente.",
    "auth/operation-not-allowed":
      "Ative o acesso por E-mail/Senha no Firebase Authentication.",
    "auth/requires-recent-login":
      "Por segurança, saia e entre novamente antes de alterar a senha.",
    "auth/too-many-requests":
      "Muitas tentativas foram feitas. Aguarde alguns minutos e tente novamente.",
    "auth/user-disabled": "Esta conta foi desativada.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/weak-password": "Use uma senha com pelo menos 6 caracteres.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
  };

  function friendlyError(error, fallback = "Não foi possível concluir a autenticação.") {
    const translated = new Error(errorMessages[error?.code] || fallback);
    translated.code = error?.code || "auth/unknown";
    translated.original = error;
    return translated;
  }

  function continueUrl() {
    const url = new URL("./", window.location.href);
    url.search = "?email=confirmado";
    url.hash = "";
    return url.href;
  }

  function emailActionSettings() {
    return { url: continueUrl(), handleCodeInApp: false };
  }

  function userData(user) {
    if (!user) return null;
    return {
      id: user.uid,
      name: user.displayName || user.email?.split("@")[0] || "Usuário",
      email: user.email || "",
      emailVerified: Boolean(user.emailVerified),
      provider: "firebase",
    };
  }

  let ready = Promise.resolve(null);
  if (configured && window.firebase?.initializeApp) {
    try {
      const app =
        window.firebase.apps?.find((item) => item.name === "credmais") ||
        window.firebase.initializeApp(config, "credmais");
      auth = app.auth();
      auth.languageCode = "pt-BR";
      ready = auth
        .setPersistence(window.firebase.auth.Auth.Persistence.LOCAL)
        .then(
          () =>
            new Promise((resolve, reject) => {
              const unsubscribe = auth.onAuthStateChanged(
                (user) => {
                  unsubscribe();
                  resolve(user);
                },
                (error) => {
                  unsubscribe();
                  reject(error);
                },
              );
            }),
        );
    } catch (error) {
      initializationError = error;
      console.error("Falha ao iniciar Firebase Authentication:", error);
    }
  }

  const enabled = Boolean(auth && !initializationError);
  const requireAuth = async () => {
    if (!enabled)
      throw friendlyError(
        initializationError,
        "Firebase ainda não foi configurado neste ambiente.",
      );
    await ready;
    return auth;
  };

  window.credmaisFirebase = {
    configured,
    enabled,
    projectId: config.projectId || "",
    friendlyError,
    async currentUser({ allowUnverified = false } = {}) {
      const instance = await requireAuth();
      const user = instance.currentUser;
      if (!user) return null;
      await user.reload();
      if (!allowUnverified && !instance.currentUser.emailVerified) {
        await instance.signOut();
        return null;
      }
      return userData(instance.currentUser);
    },
    async signIn(email, password) {
      const instance = await requireAuth();
      try {
        const credential = await instance.signInWithEmailAndPassword(
          email.trim(),
          password,
        );
        if (!credential.user.emailVerified) {
          try {
            await credential.user.sendEmailVerification(emailActionSettings());
          } catch (verificationError) {
            if (verificationError?.code === "auth/too-many-requests")
              console.warn("Reenvio de confirmação limitado pelo Firebase.");
          }
          await instance.signOut();
          const error = new Error(errorMessages["auth/email-not-verified"]);
          error.code = "auth/email-not-verified";
          throw error;
        }
        await credential.user.getIdToken(true);
        return userData(credential.user);
      } catch (error) {
        if (error?.code === "auth/email-not-verified") throw error;
        throw friendlyError(error, "Não foi possível entrar.");
      }
    },
    async signUp(name, email, password) {
      const instance = await requireAuth();
      try {
        const credential = await instance.createUserWithEmailAndPassword(
          email.trim(),
          password,
        );
        await credential.user.updateProfile({ displayName: name.trim() });
        await credential.user.sendEmailVerification(emailActionSettings());
        const createdUser = userData(credential.user);
        await instance.signOut();
        return {
          user: createdUser,
          hasSession: false,
          requiresVerification: true,
        };
      } catch (error) {
        throw friendlyError(error, "Não foi possível criar a conta.");
      }
    },
    async sendPasswordReset(email) {
      const instance = await requireAuth();
      try {
        await instance.sendPasswordResetEmail(
          email.trim(),
          emailActionSettings(),
        );
      } catch (error) {
        throw friendlyError(
          error,
          "Não foi possível enviar o e-mail de recuperação.",
        );
      }
    },
    async resendVerification(email, password) {
      const instance = await requireAuth();
      try {
        const credential = await instance.signInWithEmailAndPassword(
          email.trim(),
          password,
        );
        if (credential.user.emailVerified) {
          await instance.signOut();
          return { alreadyVerified: true };
        }
        await credential.user.sendEmailVerification(emailActionSettings());
        await instance.signOut();
        return { alreadyVerified: false };
      } catch (error) {
        await instance.signOut().catch(() => {});
        throw friendlyError(
          error,
          "Não foi possível reenviar o e-mail de confirmação.",
        );
      }
    },
    async changePassword(newPassword) {
      const instance = await requireAuth();
      if (!instance.currentUser)
        throw new Error("Entre novamente para alterar a senha.");
      try {
        await instance.currentUser.updatePassword(newPassword);
      } catch (error) {
        throw friendlyError(error, "Não foi possível alterar a senha.");
      }
    },
    async signOut() {
      if (enabled) await auth.signOut();
    },
    async getAccessToken(forceRefresh = false) {
      const instance = await requireAuth();
      return instance.currentUser
        ? instance.currentUser.getIdToken(forceRefresh)
        : null;
    },
  };
})();
