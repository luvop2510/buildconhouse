export const MIN_PASSWORD_LENGTH = 6;

// Count Unicode characters consistently with the API, including on native.
export function hasMinimumPasswordLength(password: string): boolean {
  return Array.from(password).length >= MIN_PASSWORD_LENGTH;
}
