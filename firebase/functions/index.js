const {
  beforeUserCreated,
  beforeUserSignedIn,
} = require("firebase-functions/v2/identity");

const authenticatedRole = () => ({
  customClaims: { role: "authenticated" },
});

// O Supabase usa esta claim para aplicar as políticas RLS aos tokens Firebase.
exports.beforeUserCreated = beforeUserCreated(authenticatedRole);
exports.beforeUserSignedIn = beforeUserSignedIn(authenticatedRole);
