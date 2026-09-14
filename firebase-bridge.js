(() => {
  const config = window.CREDMAIS_FIREBASE || {};
  const requiredKeys = ["apiKey", "authDomain", "projectId", "appId"];
  const configured = requiredKeys.every(
    (key) => typeof config[key] === "string" && config[key].trim(),
  );
  let auth = null;
  let initializationError = null;

  const errorMessages = {
    "auth/account-exists-with-different-credential":
      "Já existe uma conta com este e-mail. Use “Esqueci minha senha” uma vez e depois tente entrar com o Google novamente.",
    "auth/admin-restricted-operation":
      "O cadastro por e-mail ainda não foi liberado no Firebase.",
    "auth/cancelled-popup-request": "A tentativa anterior de entrar com o Google foi cancelada.",
    "auth/email-already-in-use": "Este e-mail já possui uma conta.",
    "auth/email-not-verified":
      "Confirme seu e-mail antes de entrar. Enviamos um novo link para sua caixa de entrada.",
    "auth/expired-action-code":
      "Este link expirou. Solicite um novo e-mail para continuar.",
    "auth/invalid-action-code":
      "Este link é inválido ou já foi utilizado. Solicite um novo e-mail.",
    "auth/invalid-api-key":
      "A configuração do Firebase está inválida. Revise a chave do aplicativo.",
    "auth/invalid-credential":
      "E-mail ou senha incorretos. Se sua conta foi migrada, use “Esqueci minha senha” ou entre com o Google.",
    "auth/invalid-email": "Informe um e-mail válido.",
    "auth/network-request-failed":
      "Não foi possível conectar. Confira sua internet e tente novamente.",
    "auth/operation-not-allowed":
      "Este método de acesso ainda não foi ativado no Firebase.",
    "auth/operation-not-supported-in-this-environment":
      "Abra o CredMais no navegador para entrar com o Google.",
    "auth/popup-blocked":
      "O navegador bloqueou a janela do Google. Permita pop-ups para o CredMais e tente novamente.",
    "auth/popup-closed-by-user": "O acesso com o Google foi cancelado.",
    "auth/credential-already-in-use":
      "Esta conta Google já está vinculada a outro usuário do CredMais.",
    "auth/provider-already-linked":
      "Esta conta já está vinculada ao Google.",
    "auth/requires-recent-login":
      "Por segurança, saia e entre novamente antes de alterar a senha.",
    "auth/too-many-requests":
      "Muitas tentativas foram feitas. Aguarde alguns minutos e tente novamente.",
    "auth/unauthorized-domain":
      "Este endereço do CredMais ainda não está autorizado no Firebase.",
    "auth/user-mismatch":
      "Selecione a mesma conta Google vinculada a este perfil.",
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
      photoURL: user.photoURL || "",
      providers: Array.from(
        new Set(
          (user.providerData || [])
            .map((provider) => provider?.providerId)
            .filter(Boolean),
        ),
      ),
      createdAt: user.metadata?.creationTime || "",
      lastSignInAt: user.metadata?.lastSignInTime || "",
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
      try {
        await user.reload();
      } catch (error) {
        if (error?.code !== "auth/network-request-failed" || !user.emailVerified)
          throw friendlyError(error, "Não foi possível restaurar sua sessão.");
      }
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
    async signInWithGoogle() {
      const instance = await requireAuth();
      try {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const credential = await instance.signInWithPopup(provider);
        await credential.user.getIdToken(true);
        return userData(credential.user);
      } catch (error) {
        throw friendlyError(error, "Não foi possível entrar com o Google.");
      }
    },
    async linkGoogle() {
      const instance = await requireAuth();
      if (!instance.currentUser)
        throw new Error("Entre novamente para vincular sua conta Google.");
      if (
        instance.currentUser.providerData?.some(
          (provider) => provider.providerId === "google.com",
        )
      )
        return userData(instance.currentUser);
      try {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const credential = await instance.currentUser.linkWithPopup(provider);
        await credential.user.getIdToken(true);
        return userData(credential.user);
      } catch (error) {
        throw friendlyError(
          error,
          "Não foi possível vincular a conta Google.",
        );
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
    async reauthenticateForDeletion(password = "") {
      const instance = await requireAuth(),
        user = instance.currentUser;
      if (!user)
        throw new Error("Entre novamente antes de apagar sua conta.");
      const providers = (user.providerData || []).map(
        (provider) => provider.providerId,
      );
      try {
        if (providers.includes("google.com")) {
          const provider = new window.firebase.auth.GoogleAuthProvider(),
            parameters = { prompt: "select_account" };
          if (user.email) parameters.login_hint = user.email;
          provider.setCustomParameters(parameters);
          await user.reauthenticateWithPopup(provider);
        } else {
          if (!password)
            throw new Error("Informe sua senha atual para confirmar.");
          const credential =
            window.firebase.auth.EmailAuthProvider.credential(
              user.email,
              password,
            );
          await user.reauthenticateWithCredential(credential);
        }
        await user.getIdToken(true);
        return userData(user);
      } catch (error) {
        if (!error?.code) throw error;
        throw friendlyError(
          error,
          "Não foi possível confirmar sua identidade.",
        );
      }
    },
    async deleteAccount() {
      const instance = await requireAuth();
      if (!instance.currentUser)
        throw new Error("Entre novamente antes de apagar sua conta.");
      try {
        await instance.currentUser.delete();
      } catch (error) {
        throw friendlyError(error, "Não foi possível apagar a conta.");
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
