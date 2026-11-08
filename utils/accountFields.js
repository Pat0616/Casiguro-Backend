// backend/utils/accountFields.js
// Account field rules shared by self-registration, password change/reset (authController) and the create-admin script.

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CONTACT_PATTERN = /^\+?[\d\s()-]{7,20}$/;
export const PASSWORD_ERROR = "Password must be at least 8 characters and include a letter and a number.";

// Used for registration, change password and reset. Returns an error message or null.
export function validatePassword(password) {
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return PASSWORD_ERROR;
  return null;
}

export function parseRegistration(body = {}) {
  const full_name = String(body.full_name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const contact_number = String(body.contact_number || "").trim();
  const password = String(body.password || "");

  if (full_name.length < 2 || full_name.length > 150) return { error: "Enter your full name." };
  if (!EMAIL_PATTERN.test(email) || email.length > 150) return { error: "Enter a valid email address." };
  if (!CONTACT_PATTERN.test(contact_number)) return { error: "Enter a valid contact number." };
  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };
  return { fields: { full_name, email, contact_number, password } };
}
