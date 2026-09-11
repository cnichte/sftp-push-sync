const DEFAULT_SERVICE = "de.carsten-nichte.velosync";

let keytarPromise;

async function getKeytar() {
  keytarPromise ||= import("keytar").then((module) => module.default || module);
  return keytarPromise;
}

function requireCredentialRef(credentialRef) {
  if (!credentialRef || typeof credentialRef !== "string") {
    throw new TypeError("credentialRef must be a non-empty string");
  }
  return credentialRef;
}

export function getCredentialService() {
  return DEFAULT_SERVICE;
}

export async function getPassword(credentialRef, { service = DEFAULT_SERVICE } = {}) {
  const keytar = await getKeytar();
  return keytar.getPassword(service, requireCredentialRef(credentialRef));
}

export async function setPassword(credentialRef, password, { service = DEFAULT_SERVICE } = {}) {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }
  const keytar = await getKeytar();
  await keytar.setPassword(service, requireCredentialRef(credentialRef), password);
}

export async function deletePassword(credentialRef, { service = DEFAULT_SERVICE } = {}) {
  const keytar = await getKeytar();
  return keytar.deletePassword(service, requireCredentialRef(credentialRef));
}

export async function hasPassword(credentialRef, options = {}) {
  return (await getPassword(credentialRef, options)) !== null;
}
