const local = () => {
  if (!globalThis.localStorage) throw new Error("Lead recovery storage is unavailable");
  return globalThis.localStorage;
};
export const leadRecoveryStorage = {
  read: async (key: string) => local().getItem(key),
  write: async (key: string, value: string) => { local().setItem(key, value); },
  remove: async (key: string) => { local().removeItem(key); },
};
