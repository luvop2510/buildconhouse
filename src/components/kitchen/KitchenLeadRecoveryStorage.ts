import AsyncStorage from "@react-native-async-storage/async-storage";
// Unlike general preferences, an unreadable recovery entry must fail closed.
export const leadRecoveryStorage = {
  read: (key: string) => AsyncStorage.getItem(key),
  write: (key: string, value: string) => AsyncStorage.setItem(key, value),
  remove: (key: string) => AsyncStorage.removeItem(key),
};
